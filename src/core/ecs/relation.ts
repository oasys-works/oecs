/***
 * The relation seam. What the world core knows about relations, and no more.
 *
 * A **relation** is a *kind* (one `RelationDef` handle), not a per-target
 * component: `a --LinksTo--> b` registers one relation, regardless of how many
 * distinct `b`s get linked. Pairs live out of the archetype identity, on the
 * sparse storage class, so add, remove and re-target cause no archetype
 * transition and consume no identity bit.
 *
 * The storage, the registry and the traversal live in the relations plugin.
 * This file holds the handle types the query, the system declaration and the
 * access check spell, the sentinel the `(*, T)` wildcard reads, and the two
 * interfaces the seam needs: `RelationServiceHost`, what `Store` hands the
 * service, and `RelationHooks`, what the world calls on the service it did
 * not build.
 *
 * A world that installs no relations plugin holds `null` where the service
 * goes, and every destroy path keeps the branch it already took.
 *
 * Cold path. Registration is world setup, and the hooks are per-entity at
 * destroy.
 ***/

import { Brand, unsafeCast } from "../../type_primitives";
import type { BitSet, TypedArrayTag } from "../../type_primitives";
import type { EntityID } from "./entity";
import type { Archetype } from "./archetype";
import type { QueryTerms } from "./query";
import type {
	SparseComponentDef,
	SparseComponentID,
	SparseComponentStore
} from "./sparse_store";

export type RelationID = Brand<number, "relation_id">;

// Phantom brand so a RelationDef can't be passed to the component and sparse
// surfaces (and vice-versa), the relation API is its own thing.
declare const __relationBrand: unique symbol;

/** A relation's registration-time cardinality: `exclusive` = one target per
 * source (re-add replaces), `multi` = a target set per source. */
export type RelationCardinality = "exclusive" | "multi";

// Phantom cardinality slot: `registerRelation`'s overloads
// stamp the literal cardinality into the handle type, and the exclusive-only
// surfaces (`targetOf`, `ancestorsOf`, `rootOf`, `cascadeOf` and
// `Query.hierarchy`) accept only `RelationDef<"exclusive">`, turning the
// dev-mode RELATION_MODE_MISMATCH throw into a compile error. Optional +
// covariant (a tuple, like ComponentDef's schema slot) so a stamped handle
// still erases to the bare `RelationDef` union that declaration lists and
// cardinality-agnostic APIs use. A dynamically-registered relation (options
// not statically known) is the bare union and must go through the runtime
// check instead.
declare const __relationCardinality: unique symbol;

export type RelationDef<C extends RelationCardinality = RelationCardinality> = RelationID & {
	readonly [__relationBrand]: "relation";
	readonly [__relationCardinality]?: [C];
};

/** Access sentinel for the `(*, T)` wildcard query iteration
 * (`Query.forEachRelatedTo`). A `(*, T)` term reads **every** registered
 * relation's reverse index to find sources of `T`, so it can't name a specific
 * relation in `relationReads` the way `withRelation(R)` (`(R, *)`) can. A
 * system that iterates a `(*, T)` wildcard lists `ANY_RELATION` in `relationReads`
 * instead. `accessCheck.assertRelationReadAny` honors it. The numeric value is a
 * reserved sentinel far past any real registration-order relation id (relations are
 * minted from 0 upward), so it can never collide with a registered relation. */
export const ANY_RELATION: RelationDef = unsafeCast<RelationDef>(0x7fff_ffff);

/** Cleanup policy applied to a relation's **sources** when one of its
 * **targets** is destroyed. Chosen per-relation at registration, run at
 * destroy-flush (and the immediate-destroy path) off the reverse index:
 *
 *   - **`delete`**, cascade: destroy every source of the dead target too,
 *     recursively for chains and trees (the canonical ChildOf case).
 *   - **`clear`**, remove the relation from every source. The sources survive.
 *   - **`orphan`**, leave the link intact but dangling. Reads stay safe (the
 *     reverse index is `EntityID`-keyed, so the dead handle never aliases a
 *     recycled slot); `targetOf` returns a dead handle until the source
 *     re-targets or is removed. This is the original behaviour and the default.
 */
export type OnDeleteTarget = "delete" | "clear" | "orphan";

/** Default on-target-delete policy: leave the link dangling (the original
 * behaviour, zero change for callers that don't opt in). */
export const DEFAULT_ON_DELETE_TARGET: OnDeleteTarget = "orphan";

/** Registration options. `exclusive` (one target per source) is the default
 * pass `{ multi: true }` for a multi-target relation. The two are mutually
 * exclusive, the union makes `{ exclusive: true, multi: true }` a compile
 * error (it also throws at runtime, for JS callers). `onDeleteTarget` selects
 * the cleanup policy applied to sources when a target is destroyed (default
 * `orphan`). */
export type RelationOptions =
	| {
			readonly exclusive?: true;
			readonly multi?: false;
			readonly onDeleteTarget?: OnDeleteTarget;
	  }
	| {
			readonly multi: true;
			readonly exclusive?: false;
			readonly onDeleteTarget?: OnDeleteTarget;
	  };

/** Field name carrying the target `EntityID` on an exclusive relation's backing
 * sparse component. Field 0 of a single-field schema. */
export const RELATION_TARGET_FIELD = "target";

/** Receives one canonical `(source index, sorted targets)` set during a fold
 * over a multi relation's forward sets. Targets are ascending by id. Empty sets
 * are never yielded (see `forEachCanonicalTargetSet`). */
export type CanonicalTargetSetFn = (sourceIndex: number, targets: readonly EntityID[]) => void;

/** Receives one canonical `(source, target)` pair during a fold over a
 * relation's forward links. Sources ascend by entity index, each source's
 * targets ascend by id, the determinism order. */
export type CanonicalPairFn = (source: EntityID, target: EntityID) => void;

/** Maps a source entity **index** to its full `EntityID` (generation from the
 * live slot). Supplied by `Store`, which owns entity generations. */
export type MakeSourceID = (index: number) => EntityID;

/** One relation's side state, as the digest and the snapshot codec see it.
 *
 * The relations plugin owns the class. Two core-adjacent readers walk it and
 * neither needs the forward mutators: `Store.stateHash` folds the multi target
 * sets, and the snapshot service serializes and rebuilds them. The narrow view
 * is what lets those two speak about a relation store without the plugin. */
export interface RelationStoreView {
	/** `true` → one target per source, and the target rides the backing sparse
	 * field. `false` → a target set per source, held beside the sparse tag. */
	readonly exclusive: boolean;
	/** Fold `cb` over the multi forward target sets in canonical order, and do
	 * nothing for an exclusive relation. */
	forEachCanonicalTargetSet(cb: CanonicalTargetSetFn): void;
	/** Drop every derived side index. The restore path clears before it
	 * rebuilds, so restoring into a dirty world is idempotent. */
	resetIndices(): void;
	/** Restore one decoded multi forward edge and its reverse edge. */
	restoreAddTarget(index: number, tgt: EntityID, src: EntityID): void;
	/** Rebuild the reverse index from the forward links after a restore. */
	rebuildReverse(createId: MakeSourceID): void;
}

/** What the relation service needs from `Store`, nothing more. The accessor
 * members re-read the live field on every call, so capacity growth that
 * reallocates `generations`, `entityArchetypes` or `entityRows` is always
 * observed. Never cache their return values across mutations. */
export interface RelationServiceHost {
	isAlive(id: EntityID): boolean;
	hasSparse(entityId: EntityID, def: SparseComponentDef): boolean;
	pushSparseStore(fieldNames: string[], fieldTypes: TypedArrayTag[]): SparseComponentDef;
	sparseStoreOf(def: SparseComponentDef): SparseComponentStore;
	sparseStores(): readonly SparseComponentStore[];
	generations(): Int32Array;
	entityArchetypes(): Int32Array;
	entityRows(): Int32Array;
	archetypes(): readonly Archetype[];
	forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void
	): void;
}

/** The relation service, as everything outside the plugin sees it.
 *
 * `Store.relations` is public, so this is the whole crossing surface and not
 * the world's half alone. The plugin's class implements it, and the compiler
 * holds the two in step.
 *
 * `purgeSource` and `cleanupTarget` are the one hot coupling: a dying entity
 * loses its source role, and a target-death policy may cascade. Both sit
 * behind a null test the destroy loop hoists, so a world without the plugin
 * pays neither. Everything else is registration, a query driver or a `ctx`
 * call, and cold. */
export interface RelationHooks {
	/** The registry, in registration order. `Store.stateHash` and the snapshot
	 * service walk it. */
	readonly stores: readonly RelationStoreView[];
	/** Registered relation kinds. The destroy paths gate on this. */
	readonly count: number;
	/** Whether any relation registered a non-`orphan` `onDeleteTarget`. The
	 * destroy paths gate the reverse-index walk on it. */
	readonly hasTargetCleanup: boolean;
	/** Drop a destroyed entity's forward links and its reverse edges, and leave
	 * the sparse membership row to `Store`. Runs before the sparse purge. */
	purgeSource(entityId: EntityID): void;
	/** Apply each relation's target-death policy to the sources of a destroyed
	 * target. A `delete` policy appends the doomed sources to `cascade`. */
	cleanupTarget(targetId: EntityID, cascade: EntityID[]): void;
	/** Register a relation kind. The facade's typed overloads sit on top. */
	registerRelation(opts?: RelationOptions): RelationDef;
	addRelation(src: EntityID, def: RelationDef, tgt: EntityID): void;
	removeRelation(src: EntityID, def: RelationDef, tgt?: EntityID): void;
	targetOf(src: EntityID, def: RelationDef): EntityID | undefined;
	targetsOf(src: EntityID, def: RelationDef): EntityID[];
	sourcesOf(tgt: EntityID, def: RelationDef): EntityID[];
	hasRelation(src: EntityID, def: RelationDef): boolean;
	/** Every `(source, target)` pair of one relation, the `(R, *)` wildcard. */
	pairsOf(def: RelationDef): readonly (readonly [EntityID, EntityID])[];
	/** Every `(relation, source)` pointing at `tgt`, the `(*, T)` wildcard. */
	sourcesOfAny(tgt: EntityID): readonly (readonly [RelationDef, EntityID])[];
	/** The chain from `src` up to its root, nearest ancestor first. */
	ancestorsOf(src: EntityID, def: RelationDef): EntityID[];
	/** The root of the chain `src` sits on. */
	rootOf(src: EntityID, def: RelationDef): EntityID;
	/** The subtree under `root`, breadth-first, parents before children. */
	cascadeOf(root: EntityID, def: RelationDef): EntityID[];
	/** Drop every reverse entry whose target died, and report the count. */
	compactRelations(): number;
	/** The backing sparse component of a relation, which the query terms
	 * compose against. */
	relationBackingSparseId(def: RelationDef): SparseComponentID;
	/** Drive a `(*, T)` wildcard query. */
	forEachTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		cb: (entityId: EntityID) => void
	): void;
	/** Drive a `hierarchy(R)` query, parents before children. */
	forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		cb: (entityId: EntityID) => void
	): void;
}
