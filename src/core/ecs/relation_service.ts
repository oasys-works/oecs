/***
 * RelationService — relation registry, traversal, and hierarchy query ordering.
 *
 * `RelationStore` (relation.ts) owns one relation kind's storage mechanics;
 * this service owns the registry-level algorithms that used to live directly
 * on `Store`: registration, the pair mutators/readers, the `(R, *)` / `(*, T)`
 * wildcard drivers, parent-chain traversal, destroy-path cleanup, and the
 * hierarchy depth-ordering query driver. `Store` keeps one-line delegations so
 * `ecs.ts` and the query internals are untouched.
 *
 * The service reaches back into `Store` only through the narrow
 * `RelationServiceHost` seam below.
 ***/

import type { BitSet, TypedArrayTag } from "../../type_primitives";
import { unsafeCast } from "../../type_primitives";
import type { Archetype } from "./archetype";
import { type EntityID, createEntityId, getEntityIndex } from "./entity";
// Value import (the hierarchy driver, #581, reuses the canonical eid radix);
// observer.ts imports only *types* from the ECS core, so this is a one-way
// edge with no runtime cycle.
import { radixSortByIndex } from "./observer";
import {
	DEFAULT_ON_DELETE_TARGET,
	RELATION_TARGET_FIELD,
	makeRelationStore,
	type RelationDef,
	type RelationID,
	type RelationOptions,
	type RelationStore
} from "./relation";
import {
	type SparseComponentDef,
	type SparseComponentID,
	type SparseComponentStore
} from "./sparse_store";
import { ECS_ERROR, ECSError } from "./utils/error";
import { UNASSIGNED } from "./utils/constants";
import { DEV } from "../../dev_flag";

/** What the relation service needs from `Store` — nothing more. The accessor
 * members re-read the live field on every call, so capacity growth that
 * reallocates `entityGenerations` / `entityArchetype` / `entityRow` is always
 * observed; never cache their return values across mutations. */
export interface RelationServiceHost {
	isAlive(id: EntityID): boolean;
	hasSparse(entityId: EntityID, def: SparseComponentDef): boolean;
	pushSparseStore(fieldNames: string[], fieldTypes: TypedArrayTag[]): SparseComponentDef;
	sparseStoreOf(def: SparseComponentDef): SparseComponentStore;
	sparseStores(): readonly SparseComponentStore[];
	entityGenerations(): Int32Array;
	entityArchetype(): Int32Array;
	entityRow(): Int32Array;
	archetypes(): readonly Archetype[];
	forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includeDisabled: boolean
	): void;
}

export class RelationService {
	// Parallel array indexed by RelationID. Each entry owns a backing sparse
	// component (membership + the target field when exclusive) plus the reverse
	// index and multi-target forward sets. Layered on the sparse storage class,
	// so add/remove/re-target of a pair cause no archetype transition.
	private readonly relations: RelationStore[] = [];
	// True once any relation registers a non-`orphan` `onDeleteTarget` policy
	// (#473). Gates the target-role cleanup branch in both of the Store's
	// destroy paths so the common case (no cleanup policies) leaves the destroy
	// hot path untouched — mirrors the Store's `count > 0` / sparse-store gates.
	private _hasTargetCleanup = false;

	// Reused radix scratch for the hierarchy depth-ordering driver (#581 follow-up).
	// The motivating use case — transform propagation — is a per-tick depth-ordered
	// pass, so `forEachHierarchyMatch` allocating two 1024-entry histograms + an
	// `out` array per call would be per-tick GC churn. These three are
	// **fully consumed by `radixSortByIndex` before any `cb` fires**, so unlike
	// the call-local `matched` / `buckets` / `depthMemo` / `visiting` (which stay
	// live across the emit loop and would corrupt under a re-entrant callback) they
	// are safe to share as instance state. Mirrors the observer's `_radix_*` scratch,
	// which `ObserverRegistry` owns privately and so is not reachable from here.
	private readonly _hierarchyRadixOut: number[] = [];
	private readonly _hierarchyRadixC0 = new Int32Array(1024);
	private readonly _hierarchyRadixC1 = new Int32Array(1024);

	constructor(private readonly host: RelationServiceHost) {}

	/** The registry, indexed by RelationID — the read-only view the Store's
	 * `stateHash` / snapshot / restore paths iterate. */
	public get stores(): readonly RelationStore[] {
		return this.relations;
	}

	/** Number of registered relations. */
	public get count(): number {
		return this.relations.length;
	}

	/** Whether any relation registered a non-`orphan` `onDeleteTarget` policy —
	 * the destroy paths' gate for `cleanupTarget` (#473). */
	public get hasTargetCleanup(): boolean {
		return this._hasTargetCleanup;
	}

	/** Register a relation kind. `exclusive` (the default) → one target per
	 * source, stored in a backing `{ target: f64 }` sparse component, so the
	 * forward index rides the sparse store and inherits query membership (#469),
	 * `stateHash` + snapshot/restore (#470) for free. `multi` → a set of
	 * targets per source, backed by a sparse tag for membership plus a side
	 * forward index the relation owns. The two cardinalities are mutually
	 * exclusive. `onDeleteTarget` selects the cleanup policy run when a target
	 * is destroyed — `delete` (cascade-destroy sources), `clear` (drop the link,
	 * sources survive), or `orphan` (default: leave it dangling, #473). See
	 * ADR-0011 and `relation.ts`.
	 *
	 * The backing sparse store is resolved and handed to the relation so it can
	 * drive forward/membership rows directly — the cardinality-specific
	 * interaction is `ExclusiveRelationStore` / `MultiRelationStore`'s, not a
	 * branch here (#498). */
	public registerRelation(opts?: RelationOptions): RelationDef {
		const wantMulti = opts?.multi === true;
		const wantExclusive = opts?.exclusive === true;
		if (wantMulti && wantExclusive) {
			throw new ECSError(
				ECS_ERROR.RELATION_MODE_INVALID,
				`register_relation: a relation cannot be both exclusive and multi-target`
			);
		}
		const exclusive = !wantMulti;
		const onDeleteTarget = opts?.onDeleteTarget ?? DEFAULT_ON_DELETE_TARGET;
		// The exclusive `{ target: f64 }` slot holds an exact-integer EntityID, so
		// it bypasses the #777 float guard (see `Store._pushSparseStore`); a
		// deterministic world must be free to use relations. Multi is a
		// membership tag (no fields).
		const sparse: SparseComponentDef = exclusive
			? this.host.pushSparseStore([RELATION_TARGET_FIELD], ["f64"])
			: this.host.pushSparseStore([], []);
		const id = this.relations.length as RelationID;
		this.relations.push(
			makeRelationStore(exclusive, sparse, this.host.sparseStoreOf(sparse), onDeleteTarget)
		);
		if (onDeleteTarget !== "orphan") this._hasTargetCleanup = true;
		return unsafeCast<RelationDef>(id);
	}

	private relationOf(def: RelationDef): RelationStore {
		const id = def as number;
		const rs = this.relations[id];
		if (rs === undefined) {
			throw new ECSError(ECS_ERROR.RELATION_NOT_REGISTERED, `relation ${id} is not registered`);
		}
		return rs;
	}

	/** Add a `(R, tgt)` pair to `src`. No archetype transition. Exclusive:
	 * replaces any existing target (engine-enforced one-per-source), a no-op if
	 * `tgt` is already the target. Multi: adds `tgt` to the set, a no-op if
	 * already present. A dead `src` *or* `tgt` is caller error: it throws in
	 * `DEV` and is a no-op in production — symmetric, so a production build
	 * never links a reverse-index entry keyed by a destroyed handle (#495). */
	public addRelation(src: EntityID, def: RelationDef, tgt: EntityID): void {
		const rs = this.relationOf(def);
		// Liveness must be checked for BOTH ends symmetrically before any
		// linking: a dead `src` or `tgt` throws in `DEV` and is a silent
		// no-op in production, so a prod build never seeds a reverse-index entry
		// keyed by a destroyed handle (#495). The forward + reverse + membership
		// lockstep is the relation's (cardinality).
		if (!this.host.isAlive(src)) {
			if (DEV) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE, `add_relation: source not alive`);
			return;
		}
		if (!this.host.isAlive(tgt)) {
			if (DEV) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE, `add_relation: target not alive`);
			return;
		}
		rs.link(src, tgt);
	}

	/** Remove a `(R, tgt)` pair from `src`. No archetype transition. Exclusive:
	 * `tgt` is optional and the removal is a no-op when it names a target other
	 * than the current one. Multi: omitting `tgt` removes *all* of `src`'s
	 * targets; passing one removes just that pair (dropping membership when the
	 * set empties). */
	public removeRelation(src: EntityID, def: RelationDef, tgt?: EntityID): void {
		const rs = this.relationOf(def);
		if (!this.host.isAlive(src)) {
			if (DEV) {
				throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE, `remove_relation: source not alive`);
			}
			return;
		}
		rs.unlink(src, tgt);
	}

	/** The single target of `src` under an exclusive relation, or `undefined`.
	 * Throws in `DEV` on a multi-target relation (use `targetsOf`). */
	public targetOf(src: EntityID, def: RelationDef): EntityID | undefined {
		const rs = this.relationOf(def);
		if (DEV) {
			// Traversal/single-target reads are exclusive-only by contract; the mode
			// guard stays at the API boundary. The forward read is virtual.
			if (!rs.exclusive) {
				throw new ECSError(
					ECS_ERROR.RELATION_MODE_MISMATCH,
					`target_of: relation is multi-target — use targets_of`
				);
			}
			if (!this.host.isAlive(src)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		return rs.singleTarget(getEntityIndex(src));
	}

	/** All targets of `src` under `R` — one or zero for exclusive, the full set
	 * for multi — ascending by id. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		const rs = this.relationOf(def);
		if (DEV && !this.host.isAlive(src)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		return rs.targetsOf(getEntityIndex(src));
	}

	/** Sources that point at `tgt` under `R` (the reverse index), ascending by
	 * id; empty when none. */
	public sourcesOf(def: RelationDef, tgt: EntityID): EntityID[] {
		return this.relationOf(def).sourcesOf(tgt);
	}

	/** Whether `src` holds any pair under `R`. */
	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this.host.hasSparse(src, this.relationOf(def).sparse);
	}

	/** All `(source, target)` pairs of relation `R` — the `(R, *)` wildcard
	 * (#472). Sources are emitted in **canonical entity-index order** (the #470
	 * determinism convention): exclusive relations ride the backing sparse
	 * store's `canonicalIndices`, multi relations ride the same
	 * `forEachCanonicalTargetSet` traversal `stateHash` / `snapshotRelations`
	 * use; a multi source's targets follow ascending by id. Empty when the
	 * relation holds no pairs. Cold path — allocates the result array (and, for
	 * multi, sorts each source's target set); not for per-tick use. The
	 * point-query forms are `targetOf` / `targetsOf`. */
	public pairsOf(def: RelationDef): [EntityID, EntityID][] {
		const rs = this.relationOf(def);
		const out: [EntityID, EntityID][] = [];
		const gens = this.host.entityGenerations();
		rs.forEachCanonicalPair(
			(idx) => createEntityId(idx, gens[idx]),
			(src, tgt) => out.push([src, tgt])
		);
		return out;
	}

	/** Every `(relation, source)` pointing at `tgt`, across **all** registered
	 * relation kinds — the `(*, T)` wildcard (#472). Walks the relation registry
	 * in id order (each relation's reverse index already returns sources
	 * ascending by id), so the result is ordered by relation id then source id.
	 * Empty when nothing targets `tgt`. The single-relation form is
	 * `sourcesOf(def, tgt)`. */
	public sourcesOfAny(tgt: EntityID): [RelationDef, EntityID][] {
		const out: [RelationDef, EntityID][] = [];
		const rels = this.relations;
		for (let id = 0; id < rels.length; id++) {
			const def = unsafeCast<RelationDef>(id);
			const sources = rels[id].sourcesOf(tgt);
			for (let i = 0; i < sources.length; i++) out.push([def, sources[i]]);
		}
		return out;
	}

	// --- Wildcard query terms (#579) ---
	// `(R, *)` and `(*, T)` as composable query terms (vs the cold materializing
	// helpers `pairsOf` / `sourcesOfAny` above). Membership semantics: each
	// matching SOURCE is yielded once; fetch its targets on demand with
	// `targetsOf`. Insertion order, consistent with the `withSparse` path
	// (deterministic by construction across lockstep peers; canonical sorting is
	// reserved for `stateHash`/snapshot, PATTERNS §70) — the bench showed canonical
	// ordering costs 4–5× per iteration for no determinism benefit
	// (docs/reports/bench/relations/wildcard-query-iteration-2026-06-04.md).

	/** The backing sparse component id of relation `R` — the membership store a
	 * `(R, *)` wildcard term (`Query.withRelation`) drives through the shared
	 * sparse-match path. Exclusive relations back a `{ target: f64 }` sparse
	 * component, multi a tag; both carry per-source membership, so "has any
	 * `(R, *)` pair" is exactly membership in this store (including an
	 * orphan-dangling source, whose membership row persists — consistent with
	 * `pairsOf`). The def is engine-owned and never handed to callers; this hands
	 * the query builder only its erased id for the `sparseInclude` list. */
	public relationBackingSparseId(def: RelationDef): SparseComponentID {
		return this.relationOf(def).sparse;
	}

	/** Drive a `(*, T)` wildcard query (`Query.forEachRelatedTo`): every source
	 * related to `target` under **any** relation, intersected with the query's
	 * dense mask + sparse require/exclude terms + the default enabled-row filter,
	 * each source yielded once. Unions `sourcesOf(R, target)` across every
	 * relation into a `Set` (dedup by full `EntityID` — a source related to `T`
	 * via two relations is yielded once), then sorts ascending: the cross-relation
	 * union has no inherent order, so one cold sort gives a deterministic,
	 * canonical `(*, T)` order matching `sourcesOf` / `sourcesOfAny` (which sort
	 * the same way). Cold/structural — not a per-tick hot loop over many targets.
	 * `sparseInclude`/`sparseExclude` carry both raw sparse terms and the backing
	 * stores of any composed `(R, *)` terms, so it intersects with them uniformly. */
	public forEachRelationTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		const rels = this.relations;
		if (rels.length === 0) return;
		const seen = new Set<number>();
		for (let r = 0; r < rels.length; r++) {
			const sources = rels[r].sourcesOf(target);
			for (let s = 0; s < sources.length; s++) seen.add(sources[s] as number);
		}
		if (seen.size === 0) return;
		const out = Array.from(seen).sort((a, b) => a - b);
		const stores = this.host.sparseStores();
		const entArch = this.host.entityArchetype();
		const entRow = this.host.entityRow();
		const archetypes = this.host.archetypes();
		for (let i = 0; i < out.length; i++) {
			const id = unsafeCast<EntityID>(out[i]);
			const idx = getEntityIndex(id);
			const archId = entArch[idx];
			if (archId === UNASSIGNED) continue;
			const arch = archetypes[archId];
			const mask = arch.mask;
			if (!mask.contains(include)) continue;
			if (exclude !== null && mask.overlaps(exclude)) continue;
			if (anyOf !== null && !mask.overlaps(anyOf)) continue;
			let ok = true;
			for (let j = 0; j < sparseInclude.length; j++) {
				if (!stores[sparseInclude[j] as number].has(idx)) {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			for (let j = 0; j < sparseExclude.length; j++) {
				if (stores[sparseExclude[j] as number].has(idx)) {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			if (!includeDisabled) {
				const row = entRow[idx];
				if (row !== UNASSIGNED && row >= arch.enabledCount) continue;
			}
			cb(id);
		}
	}

	/** Reclaim reverse-index memory: drop every relation's reverse entries whose
	 * **target** has been destroyed, returning the total dropped across all
	 * relations (#491). Under the default `orphan` policy a destroyed target
	 * leaves its reverse entry intact until each source re-targets or dies, so a
	 * long-lived source that orphan-points at a churn of short-lived targets and
	 * never re-targets accumulates dead-target keys without bound. This cold-path
	 * hook drops them on demand — call it at scene or snapshot boundaries.
	 *
	 * Purely a memory reclaim with no observable state change: forward links stay
	 * dangling (so `orphan`'s `targetOf`-returns-the-dead-handle contract is
	 * unchanged), `stateHash` is unaffected (the reverse index is derived, never
	 * folded), and the dropped entries are faithfully rebuilt by snapshot/restore
	 * from the surviving forward links (`Store._rebuildRelationIndices`). The only
	 * difference a caller can see is `sourcesOf(R, deadHandle)` going from the
	 * dangling sources to `[]` — both meaningless once the target is gone.
	 * No-op (returns 0) when no relations are registered. */
	public compactRelations(): number {
		const rels = this.relations;
		if (rels.length === 0) return 0;
		const isAlive = (id: EntityID): boolean => this.host.isAlive(id);
		let dropped = 0;
		for (let r = 0; r < rels.length; r++) dropped += rels[r].pruneDeadReverse(isAlive);
		return dropped;
	}

	// --- Traversal (parent / IsA chains over an exclusive relation, #474) ---
	// Traversal is **exclusive-only**: an exclusive relation gives each source at
	// most one target ("parent"), so the forward direction is a chain and the
	// reverse index (`sourcesOf`) gives children — together a proper tree. A
	// multi relation is a DAG with no single parent chain, so these throw
	// `RELATION_MODE_MISMATCH` in `DEV` (mirroring `targetOf`). Acyclicity
	// is assumed; every walk carries a visited set so a malformed (cyclic) chain
	// is a loud `RELATION_CYCLE` in `DEV` and a safe early-out (never a hang)
	// in production. Cold path — allocates the result array; not for per-tick use.

	/** Walk exclusive relation `R` from `src` toward the root, returning the
	 * **up**-chain `[src, parent, grandparent, …, root]` (nearest-ancestor-first,
	 * inclusive of both endpoints). A source with no target returns `[src]`. The
	 * root is the first entity in the chain with no `R`-target, **or** a dangling
	 * dead target handle (see below). Throws `RELATION_MODE_MISMATCH` on a multi
	 * relation and `RELATION_CYCLE` on a cycle (both `DEV`-only; in production
	 * a cycle stops at the repeated node).
	 *
	 * **Dangling links terminate the chain.** Under the `orphan` policy a source
	 * keeps pointing at a destroyed target (a dead handle). The walk must *not*
	 * advance through such a handle: the backing store is keyed by entity
	 * **index**, so reading the dead handle's index would return whatever now
	 * occupies that recycled slot — splicing the chain onto an unrelated entity
	 * (the ABA the `EntityID`-keyed reverse index avoids for `cascadeOf`). So a
	 * dead next-hop is appended as the chain's (dangling) terminus and the walk
	 * stops; the caller can detect it with `isAlive`, exactly as `targetOf`
	 * returns a dead handle. */
	public ancestorsOf(src: EntityID, def: RelationDef): EntityID[] {
		const rs = this.relationOf(def);
		if (DEV) {
			if (!rs.exclusive) {
				throw new ECSError(
					ECS_ERROR.RELATION_MODE_MISMATCH,
					`ancestors_of: relation is multi-target — traversal needs an exclusive (parent) chain`
				);
			}
			if (!this.host.isAlive(src)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const store = this.host.sparseStoreOf(rs.sparse);
		const out: EntityID[] = [src];
		const seen = new Set<number>([getEntityIndex(src)]);
		let cur = src;
		for (;;) {
			const next = store.getField(getEntityIndex(cur), 0);
			if (next === undefined) break;
			const nextId = unsafeCast<EntityID>(next);
			// A dangling (dead) target handle ends the chain: following it by
			// index would read its recycled slot's current occupant. Record the
			// dead handle as the terminus, then stop — never advance past it.
			if (!this.host.isAlive(nextId)) {
				out.push(nextId);
				break;
			}
			const nextIdx = getEntityIndex(nextId);
			if (seen.has(nextIdx)) {
				if (DEV) {
					throw new ECSError(
						ECS_ERROR.RELATION_CYCLE,
						`ancestors_of: cycle in relation chain at entity index ${nextIdx}`
					);
				}
				break;
			}
			seen.add(nextIdx);
			cur = nextId;
			out.push(cur);
		}
		return out;
	}

	/** The root of `src`'s exclusive-relation chain — the last entity of
	 * `ancestorsOf` (the one with no `R`-target). `src` itself when it has no
	 * target. If the chain ends in a dangling dead target handle (orphan policy),
	 * that handle is the root — `isAlive`-check the result if dangling links are
	 * possible. Same `DEV` guards as `ancestorsOf`. */
	public rootOf(src: EntityID, def: RelationDef): EntityID {
		const chain = this.ancestorsOf(src, def);
		return chain[chain.length - 1];
	}

	/** Walk exclusive relation `R` **down** from `root` over the reverse index,
	 * returning the subtree (including `root`) breadth-first — **parents before
	 * children** (the `cascade` order). Children of each node come from
	 * `sourcesOf` (ascending by id), so the traversal is deterministic. Throws
	 * `RELATION_MODE_MISMATCH` on a multi relation and `RELATION_CYCLE` on a cycle
	 * (both `DEV`-only; in production an already-visited node is skipped, so
	 * it never hangs). */
	public cascadeOf(root: EntityID, def: RelationDef): EntityID[] {
		const rs = this.relationOf(def);
		if (DEV) {
			if (!rs.exclusive) {
				throw new ECSError(
					ECS_ERROR.RELATION_MODE_MISMATCH,
					`cascade_of: relation is multi-target — traversal needs an exclusive (parent) chain`
				);
			}
			if (!this.host.isAlive(root)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const out: EntityID[] = [root];
		const seen = new Set<number>([getEntityIndex(root)]);
		// Breadth-first: a node is emitted before any of its children are
		// expanded, so parents always precede children.
		for (let head = 0; head < out.length; head++) {
			const children = rs.sourcesOf(out[head]);
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				const childIdx = getEntityIndex(child);
				if (seen.has(childIdx)) {
					if (DEV) {
						throw new ECSError(
							ECS_ERROR.RELATION_CYCLE,
							`cascade_of: cycle in relation chain at entity index ${childIdx}`
						);
					}
					continue;
				}
				seen.add(childIdx);
				out.push(child);
			}
		}
		return out;
	}

	/** Purge a destroyed entity from the relation indices — its **source** role
	 * only: drop its forward target(s) and unlink it from every target's reverse
	 * set. The backing sparse membership row is dropped separately by the Store's
	 * `_purgeSparse`, so this must run *before* it (it reads the sparse target
	 * field for exclusive relations). The entity's **target** role is left
	 * intact: the reverse index is keyed by full `EntityID`, so a recycled slot
	 * never aliases the dead target's sources. The destroyed entity's **target**
	 * role is handled separately by `cleanupTarget` per each relation's
	 * `OnDeleteTarget` policy (#473). Gated by the caller on `count > 0`. */
	public purgeSource(entityId: EntityID): void {
		const rels = this.relations;
		for (let r = 0; r < rels.length; r++) rels[r].purgeSource(entityId);
	}

	/** Apply each relation's `OnDeleteTarget` policy for a destroyed **target**
	 * `targetId` (#473). Walks the registry; for every relation whose reverse
	 * index has sources pointing at the dead target:
	 *
	 *  - **`delete`** — append each source to `cascade`; the caller destroys them
	 *    through the same path, so chains/trees cascade recursively. The sources'
	 *    own source-role purge (`purgeSource`) drops their forward link and
	 *    unlinks them from `targetId`'s reverse set, so no reverse entry leaks.
	 *  - **`clear`** — drop each source's link to the dead target in place via
	 *    `rs.unlink(src, targetId)` (exclusive drops the row; multi removes the
	 *    target from the set, dropping membership when it empties). Sources
	 *    survive — the cardinality bookkeeping is the relation's, not branched here.
	 *  - **`orphan`** — skipped (the link is left dangling; safe because the
	 *    reverse key carries the generation).
	 *
	 * `sourcesOf` returns a fresh snapshot, so mutating the reverse index while
	 * iterating is safe. Gated by the caller on `hasTargetCleanup`, so the
	 * whole walk is skipped when no relation opts into a non-`orphan` policy. */
	public cleanupTarget(targetId: EntityID, cascade: EntityID[]): void {
		const rels = this.relations;
		for (let r = 0; r < rels.length; r++) {
			const rs = rels[r];
			if (rs.onDeleteTarget === "orphan") continue;
			const sources = rs.sourcesOf(targetId);
			if (sources.length === 0) continue;
			if (rs.onDeleteTarget === "delete") {
				for (let i = 0; i < sources.length; i++) cascade.push(sources[i]);
				continue;
			}
			// clear: sources survive, but their link to the dead target is removed.
			for (let i = 0; i < sources.length; i++) rs.unlink(sources[i], targetId);
		}
	}

	/** Fourth query-match path (#581): yield the matched entities — the exact
	 * sparse-match intersection (dense mask + sparse require/exclude + the
	 * default enabled-row filter) — in canonical **hierarchy depth order** over
	 * exclusive relation `R`: depth ascending (parents before children), **entity
	 * index ascending within each depth band**. Entities deeper than `maxDepth`
	 * are skipped (`Infinity` = unbounded). Only reached via `Query.forEachEntity`
	 * on a query carrying a `.hierarchy(R)` term.
	 *
	 * `.hierarchy(R)` does not narrow the matched set — it reorders it — so an
	 * entity with no `R`-parent is a root (depth 0) and is yielded first. Depth is a
	 * structural property of the *full* tree (an ancestor outside the matched set
	 * still counts toward depth), computed by a memoised upward walk shared across
	 * the whole batch, so a shared/deep chain costs O(nodes), not O(nodes²).
	 *
	 * The canonical order is produced without a comparator sort (which the observer
	 * bench measured at 2–4× — `observer.ts`): (1) collect the matched ids via
	 * the host's `forEachSparseMatch`; (2) `radixSortByIndex` → entity-index
	 * ascending; (3) stable-bucket by depth — since the input is index-ascending
	 * and the bucket append is stable, each depth band stays index-ascending.
	 * Tuned for the motivating per-tick case (transform propagation): the radix
	 * scratch is reused instance state (`_hierarchyRadix*`), so a per-tick pass
	 * churns no histograms; the working set (`matched` / `buckets` / `depthMemo` /
	 * `visiting`) is still allocated per call, as it must stay call-local for
	 * re-entrancy.
	 *
	 * Exclusive-only — a multi relation throws `RELATION_MODE_MISMATCH` in `DEV`
	 * (mirrors `cascadeOf` / `ancestorsOf`); a cycle is a loud `RELATION_CYCLE` in
	 * `DEV` and a safe break in production. */
	public forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void {
		const rs = this.relationOf(relation);
		if (DEV && !rs.exclusive) {
			throw new ECSError(
				ECS_ERROR.RELATION_MODE_MISMATCH,
				`hierarchy(): relation is multi-target — depth ordering needs an exclusive (parent) chain`
			);
		}
		// 1. Collect the matched set, reusing the full sparse-match intersection so
		//    dense mask + sparse require/exclude (which carries any composed `(R, *)`
		//    backing ids) + the enabled-row filter all apply identically.
		const matched: number[] = [];
		this.host.forEachSparseMatch(
			include,
			exclude,
			anyOf,
			sparseInclude,
			sparseExclude,
			denseArchetypes,
			(e) => matched.push(e as number),
			includeDisabled
		);
		if (matched.length === 0) return;
		// 2. Sort by entity index — the canonical within-band (secondary) order.
		//    Reuses instance radix scratch (`_hierarchyRadix*`): it is fully
		//    consumed here, before any `cb` fires, so it is safe to share across
		//    calls even under a re-entrant callback (unlike `matched` / `buckets` /
		//    `depthMemo` / `visiting` below, which stay call-local).
		radixSortByIndex(
			matched,
			this._hierarchyRadixOut,
			this._hierarchyRadixC0,
			this._hierarchyRadixC1
		);
		// 3. Bucket by depth (the primary order). Stable append over an
		//    index-ascending input keeps each band index-ascending. Depth is memoised
		//    across the whole batch (`depthMemo`); `visiting` is the per-walk cycle
		//    guard, emptied after each walk so it is safe to share.
		const store = this.host.sparseStoreOf(rs.sparse);
		const depthMemo = new Map<number, number>();
		const visiting = new Set<number>();
		const buckets: number[][] = [];
		for (let i = 0; i < matched.length; i++) {
			const id = matched[i];
			const d = this._hierarchyDepthOf(
				getEntityIndex(id as EntityID),
				store,
				depthMemo,
				visiting
			);
			if (d > maxDepth) continue;
			let bucket = buckets[d];
			if (bucket === undefined) {
				bucket = [];
				buckets[d] = bucket;
			}
			bucket.push(id);
		}
		// 4. Emit depth band 0, 1, 2, … in order (a band may be empty — a depth with
		//    no matched member but a deeper one present — hence the undefined skip).
		for (let d = 0; d < buckets.length; d++) {
			const bucket = buckets[d];
			if (bucket === undefined) continue;
			for (let i = 0; i < bucket.length; i++) cb(bucket[i] as EntityID);
		}
	}

	/** Depth of entity index `idx` in the exclusive-relation tree backing `store`
	 * (root = 0), for `forEachHierarchyMatch`. Memoised across the batch (`memo`),
	 * so a shared ancestor chain is walked once. Walks upward via the backing store's
	 * target field 0 (mirroring `ancestorsOf`), stopping at: a root (no target), an
	 * already-memoised node, or a dangling/dead parent (the child is then treated as
	 * a root — never advance through a recycled slot, the ABA `ancestorsOf` guards).
	 * `visiting` flags the nodes on the current upward path to catch a cycle —
	 * `RELATION_CYCLE` in `DEV`, treated as a root in production — and is emptied
	 * on the way back down so it can be reused for the next entity. */
	private _hierarchyDepthOf(
		idx: number,
		store: SparseComponentStore,
		memo: Map<number, number>,
		visiting: Set<number>
	): number {
		const path: number[] = [];
		let cur = idx;
		let base = 0; // depth of `cur` once the walk stops
		for (;;) {
			const known = memo.get(cur);
			if (known !== undefined) {
				base = known;
				break;
			}
			// Live parent index, or -1 (root / dead-dangling parent → `cur` is a root).
			const next = store.getField(cur, 0);
			let parent = -1;
			if (next !== undefined) {
				const nextId = unsafeCast<EntityID>(next);
				if (this.host.isAlive(nextId)) parent = getEntityIndex(nextId);
			}
			if (parent === -1) {
				memo.set(cur, 0);
				base = 0;
				break;
			}
			if (visiting.has(parent)) {
				if (DEV) {
					throw new ECSError(
						ECS_ERROR.RELATION_CYCLE,
						`hierarchy(): cycle in relation chain at entity index ${parent}`
					);
				}
				// Production: break the cycle — treat `cur` as a root.
				memo.set(cur, 0);
				base = 0;
				break;
			}
			path.push(cur);
			visiting.add(cur);
			cur = parent;
		}
		// Unwind: `cur` (the stop node) has depth `base`; `path` is
		// [start, …, child-of-cur], so the last entry is base+1, the next base+2, …
		let d = base;
		for (let k = path.length - 1; k >= 0; k--) {
			d += 1;
			memo.set(path[k], d);
			visiting.delete(path[k]);
		}
		// ! safe: `idx` is now memoised — either it was the stop node, or it was
		// pushed onto `path` and assigned in the unwind above.
		return memo.get(idx)!;
	}
}
