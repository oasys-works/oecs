/***
 * Relations — first-class `(relation, target)` pairs on the sparse storage class.
 *
 * A **relation** is a *kind* (one `RelationDef` handle), not a per-target
 * component: `a --LinksTo--> b` registers ONE relation, regardless of
 * how many distinct `b`s get linked. Pairs are stored out of the archetype
 * identity, on the sparse storage class, so add / remove /
 * re-target cause **no** archetype transition and consume **no** identity bit —
 * a measurement of the encoding shows that this property is decisive for pairs
 * that change frequently.
 *
 * Two cardinalities, chosen at registration:
 *
 *   - **exclusive** (default) — one target per source. The target `EntityID`
 *     lives directly in a **sparse field** (`{ target: f64 }`), so the forward
 *     index *is* the sparse store row. This is the load-bearing reason
 *     exclusive relations inherit determinism + snapshot/restore + query
 *     membership *for free*: everything written through the sparse store is
 *     folded into `Store.stateHash()` and round-trips via `snapshotSparse`,
 * and matches `Query.withSparse(R)`. Adding a second
 *     target overwrites the first (engine-enforced one-per-source).
 *
 *   - **multi** — a set of targets per source. A set can't fit a fixed-width
 *     sparse row, so membership uses a sparse **tag** (still free query
 *     integration + destroy-purge + `has`) and the target set lives in a side
 *     `Map<source index, Set<target EntityID>>` this module owns. Because that
 *     side map is *not* in the sparse store, the target-set *values* are folded
 *     into `stateHash` and serialized through `snapshotRelations` /
 *     `restoreRelations` explicitly (the sparse store carries only multi
 *     membership). Both cardinalities are now fully determinism-covered.
 *
 * The **reverse index** (target → sources) is a side `Map` for both
 * cardinalities, since the sparse store is keyed by source and can't answer
 * "who points at T". It is keyed by the **full target `EntityID`** (index *and*
 * generation), not the bare index: a destroyed target's slot recycles with a
 * fresh generation, so an `EntityID` key can never alias the new occupant —
 * `sourcesOf` on a recycled slot returns its own (empty) source set, never the
 * dead target's. This is what lets destroy-purge clean only the **source** role
 * and still keep the reverse index consistent (see `RelationRegistry.purge`):
 * a destroyed *target* leaves a dangling forward link (`targetOf` returns a
 * dead handle) until the source re-targets or is removed, which is the
 * dangling-target class that configurable `OnDeleteTarget` cleanup owns,
 * deliberately out of scope here.
 *
 * **Cardinality is polymorphic, not branched.** The exclusive-vs-multi
 * split used to be an open-coded `if (rs.exclusive)` at ~12 mutation / read
 * sites in `Store`, every one of which had to keep forward link + reverse index
 * + sparse membership in lockstep — a missed site silently corrupted the
 * reverse index. It is now **virtual dispatch** on `RelationStore`: an abstract
 * base owns the cardinality-agnostic reverse index, and `ExclusiveRelationStore`
 * / `MultiRelationStore` (built by `makeRelationStore`) each own their forward
 * representation *and* the backing `SparseComponentStore` interaction for it.
 * The registry level keeps the things that are genuinely its own — entity
 * liveness (`Store`), relation/sparse registration and destroy *orchestration*
 * (purge ordering, `OnDeleteTarget` policy — `RelationService`,
 * relation_service.ts) — and drives a relation through `link` / `unlink` /
 * `purgeSource` / `forEachCanonicalPair`, with no cardinality branch. Each
 * cardinality's lockstep bookkeeping lives in exactly one method on one class,
 * so there is no scattered site to miss. The cardinality-free reclaim primitive
 * (`pruneDeadReverse`) rides the shared base unchanged.
 ***/

import { Brand, unsafeCast } from "../../type_primitives";
import { type EntityID, getEntityIndex, MAX_ENTITY_ID, MAX_INDEX } from "./entity";
import {
	type SparseComponentDef,
	type SparseComponentStore,
	SparseRestoreError
} from "./sparse_store";

/** Relation handle id. A separate id space from `ComponentID` and
 * `SparseComponentID` — it indexes the `RelationService` registry. The numeric
 * value is the registration order, stable for the lifetime of the ECS. */
export type RelationID = Brand<number, "relation_id">;

// Phantom brand so a RelationDef can't be passed to the component / sparse
// surfaces (and vice-versa) — the relation API is its own thing.
declare const __relationBrand: unique symbol;

/** A relation's registration-time cardinality: `exclusive` = one target per
 * source (re-add replaces), `multi` = a target set per source. */
export type RelationCardinality = "exclusive" | "multi";

// Phantom cardinality slot: `registerRelation`'s overloads
// stamp the literal cardinality into the handle type, and the exclusive-only
// surfaces (`targetOf`, `ancestorsOf` / `rootOf` / `cascadeOf`,
// `Query.hierarchy`) accept only `RelationDef<"exclusive">` — turning the
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
 * instead; `accessCheck.checkRelationReadAny` honors it. The numeric value is a
 * reserved sentinel far past any real registration-order relation id (relations are
 * minted from 0 upward), so it can never collide with a registered relation. */
export const ANY_RELATION: RelationDef = unsafeCast<RelationDef>(0x7fff_ffff);

/** Cleanup policy applied to a relation's **sources** when one of its
 * **targets** is destroyed. Chosen per-relation at registration, run at
 * destroy-flush (and the immediate-destroy path) off the reverse index:
 *
 *   - **`delete`** — cascade: destroy every source of the dead target too,
 *     recursively for chains/trees (the canonical ChildOf case).
 *   - **`clear`** — remove the relation from every source; the sources survive.
 *   - **`orphan`** — leave the link intact but dangling. Reads stay safe (the
 *     reverse index is `EntityID`-keyed, so the dead handle never aliases a
 *     recycled slot); `targetOf` returns a dead handle until the source
 *     re-targets or is removed. This is the original behaviour and the default.
 */
export type OnDeleteTarget = "delete" | "clear" | "orphan";

/** Default on-target-delete policy: leave the link dangling (the original
 * behaviour, zero change for callers that don't opt in). */
export const DEFAULT_ON_DELETE_TARGET: OnDeleteTarget = "orphan";

/** Registration options. `exclusive` (one target per source) is the default;
 * pass `{ multi: true }` for a multi-target relation. The two are mutually
 * exclusive — the union makes `{ exclusive: true, multi: true }` a compile
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

/** Empty field-value row for a multi relation's membership **tag** — its
 * backing sparse component has no fields, so any `setRow` value object yields
 * the empty positional row `[]`. Shared frozen literal; never mutated. */
const EMPTY_TAG_VALUES: Readonly<Record<string, number>> = Object.freeze({});

/** Receives one canonical `(source index, sorted targets)` set during a fold
 * over a multi relation's forward sets. Targets are ascending by id; empty sets
 * are never yielded (see `forEachCanonicalTargetSet`). */
export type CanonicalTargetSetFn = (sourceIndex: number, targets: readonly EntityID[]) => void;

/** Receives one canonical `(source, target)` pair during a fold over a
 * relation's forward links. Sources ascend by entity index, each source's
 * targets ascend by id — the determinism order. */
export type CanonicalPairFn = (source: EntityID, target: EntityID) => void;

/** Maps a source entity **index** to its full `EntityID` (generation from the
 * live slot). Supplied by `Store`, which owns entity generations. */
export type MakeSourceID = (index: number) => EntityID;

/** One relation's derived side state. **Abstract over cardinality:** the
 * base owns the cardinality-agnostic **reverse index** (target → sources, keyed
 * by full `EntityID` so a recycled slot can't alias a dead target's sources) and
 * a handle on the backing `SparseComponentStore`; the forward representation and
 * its sparse interaction are owned by the concrete `ExclusiveRelationStore` /
 * `MultiRelationStore` (built by `makeRelationStore`).
 *
 * The registry level (`Store` + `RelationService`) owns what is genuinely its
 * own — entity liveness, registration, and destroy orchestration — and drives
 * a relation through the virtual `link` /
 * `unlink` / `purgeSource` / `forEachCanonicalPair` / … without ever
 * branching on cardinality. Each cardinality keeps forward link + reverse index
 * + sparse membership in lockstep inside one method on one class, so the
 * lockstep can't be broken by missing a scattered `if (rs.exclusive)` site. */
export abstract class RelationStore {
	/** `true` → one target per source (target in the sparse field); `false` →
	 * a set of targets per source. The cardinality discriminant survives as a
	 * field because it is part of the snapshot header and the traversal/`targetOf`
	 * mode guards — but the forward *mechanics* are virtual, not branched on it. */
	public readonly exclusive: boolean;
	/** Backing sparse component def: `{ target: f64 }` when exclusive, a tag when
	 * multi. Carries membership (and the target, when exclusive). */
	public readonly sparse: SparseComponentDef;
	/** Cleanup policy applied to this relation's sources when a target is
	 * destroyed. `orphan` (the default) is a no-op — the link dangles
	 * safely. `Store` reads this at destroy-flush off `sourcesOf`. */
	public readonly onDeleteTarget: OnDeleteTarget;
	/** The backing sparse store instance. Owned for registration/liveness by
	 * `Store`, but the relation drives the forward/membership rows on it directly
	 * — that is the cardinality interaction this class now encapsulates. */
	protected readonly _store: SparseComponentStore;
	/** target `EntityID` → set of source `EntityID`s. Keyed by the full id, not
	 * the index, so a recycled target slot can't alias a dead target's sources.
	 * An entry is dropped the moment its set empties (`unlinkReverse`). */
	private readonly _reverse = new Map<number, Set<number>>();

	constructor(
		exclusive: boolean,
		sparse: SparseComponentDef,
		store: SparseComponentStore,
		onDeleteTarget: OnDeleteTarget
	) {
		this.exclusive = exclusive;
		this.sparse = sparse;
		this._store = store;
		this.onDeleteTarget = onDeleteTarget;
	}

	// --- shared reverse index (cardinality-agnostic) ---

	/** Record that `src` points at `tgt` in the reverse index. */
	protected linkReverse(tgt: EntityID, src: EntityID): void {
		let set = this._reverse.get(tgt as number);
		if (set === undefined) {
			set = new Set<number>();
			this._reverse.set(tgt as number, set);
		}
		set.add(src as number);
	}

	/** Drop the `src → tgt` edge from the reverse index, removing the target's
	 * entry entirely once its last source is gone (so a dead-target key doesn't
	 * linger with an empty set). */
	protected unlinkReverse(tgt: EntityID, src: EntityID): void {
		const set = this._reverse.get(tgt as number);
		if (set === undefined) return;
		set.delete(src as number);
		if (set.size === 0) this._reverse.delete(tgt as number);
	}

	/** Drop every reverse-index entry whose **target** is no longer alive,
	 * returning the count dropped. The `orphan` policy intentionally
	 * leaves a destroyed target's reverse entry intact (the link dangles
	 * safely), so a long-lived source that orphan-points at a stream of
	 * short-lived targets and never re-targets/dies accumulates dead-target keys
	 * without bound. This is the reclaim primitive behind `Store.compactRelations`
	 * — a cold path the host calls at scene/snapshot boundaries. It is
	 * cardinality-free (reverse-index only), so it lives on the base unchanged.
	 *
	 * Pure index reclaim: the **forward** links (the exclusive sparse target
	 * field, the multi forward set) are left untouched, so `targetOf` /
	 * `targetsOf` still return the dangling dead handle exactly as `orphan`
	 * promises. The reverse index is derived, so dropping a dead-target entry
	 * changes nothing observable except `sourcesOf` on that dead handle (which
	 * goes from the dangling sources to `[]` — meaningless either way, the target
	 * is gone) and is faithfully rebuilt by snapshot/restore from the surviving
	 * forward links. Only the **target** role can leak here: a destroyed *source*
	 * is already unlinked from every reverse set by `purgeSource`, so a live
	 * target's set never holds a dead source. `isAlive` is supplied by `Store`,
	 * which owns entity liveness. Deleting during `Map` key iteration is
	 * well-defined — already-visited and not-yet-reached keys are unaffected. */
	public pruneDeadReverse(isAlive: (id: EntityID) => boolean): number {
		let dropped = 0;
		for (const tgt of this._reverse.keys()) {
			if (!isAlive(unsafeCast<EntityID>(tgt))) {
				this._reverse.delete(tgt);
				dropped++;
			}
		}
		return dropped;
	}

	/** Sources that point at `tgt`, ascending by id (deterministic, cold-path
	 * sort) — empty when none. */
	public sourcesOf(tgt: EntityID): EntityID[] {
		const set = this._reverse.get(tgt as number);
		if (set === undefined || set.size === 0) return [];
		const out: EntityID[] = new Array(set.size);
		let i = 0;
		set.forEach((s) => {
			out[i++] = unsafeCast<EntityID>(s);
		});
		out.sort((a, b) => (a as number) - (b as number));
		return out;
	}

	/** Drop every derived side index — the reverse index and (for multi) the
	 * forward target sets. Restore path only (`restoreRelations`): the side
	 * indices are rebuilt from scratch, so they're cleared first to stay
	 * idempotent when restoring into a dirty world. The backing sparse store is
	 * cleared separately by `restoreSparseStores`. */
	public resetIndices(): void {
		this._reverse.clear();
		this._resetForward();
	}

	// --- virtual forward-link ops (own the cardinality + sparse interaction) ---

	/** Clear this relation's forward representation (multi: the side map;
	 * exclusive: nothing — its forward links live in the sparse store, cleared by
	 * `restoreSparseStores`). */
	protected abstract _resetForward(): void;

	/** Add a `(R, tgt)` link from `src`, keeping forward link + membership +
	 * reverse index in lockstep. Exclusive: replaces any existing target
	 * (idempotent if `tgt` is already the target). Multi: adds to the set
	 * (idempotent on a duplicate), establishing the membership tag on the first
	 * target. `src` must be live — `Store` checks before delegating. */
	public abstract link(src: EntityID, tgt: EntityID): void;

	/** Remove `(R, tgt)` from `src` — or, when `tgt` is omitted, every target of
	 * `src` — keeping forward link + membership + reverse index in lockstep. A
	 * no-op when the link isn't present. */
	public abstract unlink(src: EntityID, tgt?: EntityID): void;

	/** Purge a destroyed **source**: drop its forward link(s) and unlink it from
	 * every target's reverse set, but leave the sparse **membership** row alone —
	 * `Store._purgeSparse` drops that (for every store) right after, so this
	 * runs first and must not double-remove. */
	public abstract purgeSource(src: EntityID): void;

	/** The single target of source `index`, or `undefined`. Exclusive reads the
	 * sparse field; multi has no single target and returns `undefined` (matching
	 * the production `targetOf`-on-multi read, which the `DEV` guard rejects). */
	public abstract singleTarget(index: number): EntityID | undefined;

	/** All targets of source `index`, ascending by id — one or zero for
	 * exclusive, the full sorted set for multi. The symmetric counterpart to
	 * `sourcesOf`. */
	public abstract targetsOf(index: number): EntityID[];

	/** Whether source `index` holds any target under this relation (sparse
	 * membership). */
	public abstract has(index: number): boolean;

	/** Fold `cb` over this relation's **multi** forward target sets in canonical
	 * order (sources ascending by index, each source's targets ascending by id),
	 * skipping empty sets. The single source of truth for the canonical multi
	 * traversal shared by `stateHash`, `snapshotRelations`, and `pairsOf`.
	 * Exclusive relations contribute via the sparse store, so this
	 * is a no-op for them. */
	public abstract forEachCanonicalTargetSet(cb: CanonicalTargetSetFn): void;

	/** Fold `cb` over every `(source, target)` pair of this relation in canonical
	 * order — the `(R, *)` wildcard drive order. `makeId` maps a source
	 * index to its full `EntityID`. Exclusive rides the backing store's
	 * `canonicalIndices`; multi rides `forEachCanonicalTargetSet`. */
	public abstract forEachCanonicalPair(makeId: MakeSourceID, cb: CanonicalPairFn): void;

	/** Rebuild the reverse index from the forward links after a restore.
	 * Exclusive reads it back from the just-restored sparse target field (the
	 * reverse index is never serialized); multi already rebuilt its reverse edges
	 * in `restoreAddTarget`, so this is a no-op for it. `makeId` maps a source
	 * index to its full `EntityID`. */
	public abstract rebuildReverseFromForward(makeId: MakeSourceID): void;

	/** Restore one decoded multi forward edge `(source index → tgt)` plus its
	 * reverse edge (the source's full `EntityID` is `src`). Multi only — the
	 * snapshot header guards exclusive relations out before this is reached, so
	 * the exclusive override throws defensively. */
	public abstract restoreAddTarget(index: number, tgt: EntityID, src: EntityID): void;
}

/** Exclusive relation (one target per source): the forward link **is** the
 * `{ target: f64 }` backing sparse row, so this class drives that row directly
 * and inherits query membership + `stateHash`/snapshot for free. */
class ExclusiveRelationStore extends RelationStore {
	constructor(sparse: SparseComponentDef, store: SparseComponentStore, policy: OnDeleteTarget) {
		super(true, sparse, store, policy);
	}

	protected _resetForward(): void {
		// Exclusive forward links live in the sparse store, cleared separately.
	}

	public link(src: EntityID, tgt: EntityID): void {
		const idx = getEntityIndex(src);
		const prev = this._store.getField(idx, 0);
		if (prev !== undefined) {
			if (prev === (tgt as number)) return; // idempotent — same target
			this.unlinkReverse(unsafeCast<EntityID>(prev), src);
		}
		this._store.setRow(idx, { [RELATION_TARGET_FIELD]: tgt as number });
		this.linkReverse(tgt, src);
	}

	public unlink(src: EntityID, tgt?: EntityID): void {
		const idx = getEntityIndex(src);
		const cur = this._store.getField(idx, 0);
		if (cur === undefined) return;
		if (tgt !== undefined && cur !== (tgt as number)) return;
		this.unlinkReverse(unsafeCast<EntityID>(cur), src);
		this._store.remove(idx);
	}

	public purgeSource(src: EntityID): void {
		const idx = getEntityIndex(src);
		const cur = this._store.getField(idx, 0);
		if (cur !== undefined) this.unlinkReverse(unsafeCast<EntityID>(cur), src);
		// Membership row dropped by `Store._purgeSparse`.
	}

	public singleTarget(index: number): EntityID | undefined {
		const cur = this._store.getField(index, 0);
		return cur === undefined ? undefined : unsafeCast<EntityID>(cur);
	}

	public targetsOf(index: number): EntityID[] {
		const cur = this._store.getField(index, 0);
		return cur === undefined ? [] : [unsafeCast<EntityID>(cur)];
	}

	public has(index: number): boolean {
		return this._store.has(index);
	}

	public forEachCanonicalTargetSet(_cb: CanonicalTargetSetFn): void {
		// Exclusive targets are folded via the backing sparse store, not here.
	}

	public forEachCanonicalPair(makeId: MakeSourceID, cb: CanonicalPairFn): void {
		const idxs = this._store.canonicalIndices();
		for (let i = 0; i < idxs.length; i++) {
			const idx = idxs[i];
			cb(makeId(idx), unsafeCast<EntityID>(this._store.getField(idx, 0)!));
		}
	}

	public rebuildReverseFromForward(makeId: MakeSourceID): void {
		// Every member row holds `(source index → target EntityID)` — exactly one
		// reverse edge, reconstructed from the just-restored sparse store.
		const idxs = this._store.indices;
		for (let i = 0; i < idxs.length; i++) {
			const idx = idxs[i];
			this.linkReverse(unsafeCast<EntityID>(this._store.getField(idx, 0)!), makeId(idx));
		}
	}

	public restoreAddTarget(): void {
		throw new SparseRestoreError(
			"exclusive relation has no multi forward sources to restore (snapshot header should have guarded this)"
		);
	}
}

/** Multi-target relation (a set of targets per source): a set can't fit a
 * fixed-width sparse row, so membership is a sparse **tag** on the backing store
 * and the target set lives in this side `Map<source index, Set<target>>`. The
 * set *values* are not in the sparse store, so they are folded into `stateHash`
 * and serialized via `snapshotRelations` / `restoreRelations` explicitly. */
class MultiRelationStore extends RelationStore {
	/** source entity **index** → set of target `EntityID`s. Keyed by source index
	 * so destroy-purge — which has the freed index — can drop it in O(1). An
	 * entry is removed the moment its set empties. */
	private readonly _forward = new Map<number, Set<number>>();

	constructor(sparse: SparseComponentDef, store: SparseComponentStore, policy: OnDeleteTarget) {
		super(false, sparse, store, policy);
	}

	protected _resetForward(): void {
		this._forward.clear();
	}

	public link(src: EntityID, tgt: EntityID): void {
		const idx = getEntityIndex(src);
		let set = this._forward.get(idx);
		if (set === undefined) {
			set = new Set<number>();
			this._forward.set(idx, set);
			this._store.setRow(idx, EMPTY_TAG_VALUES); // first target → membership tag
		}
		set.add(tgt as number);
		this.linkReverse(tgt, src);
	}

	public unlink(src: EntityID, tgt?: EntityID): void {
		const idx = getEntityIndex(src);
		const set = this._forward.get(idx);
		if (set === undefined) return;
		if (tgt === undefined) {
			this._forward.delete(idx);
			set.forEach((t) => this.unlinkReverse(unsafeCast<EntityID>(t), src));
			this._store.remove(idx);
			return;
		}
		if (!set.has(tgt as number)) return;
		set.delete(tgt as number);
		this.unlinkReverse(tgt, src);
		if (set.size === 0) {
			this._forward.delete(idx);
			this._store.remove(idx);
		}
	}

	public purgeSource(src: EntityID): void {
		const idx = getEntityIndex(src);
		const set = this._forward.get(idx);
		if (set === undefined) return;
		this._forward.delete(idx);
		set.forEach((t) => this.unlinkReverse(unsafeCast<EntityID>(t), src));
		// Membership tag dropped by `Store._purgeSparse`.
	}

	public singleTarget(): EntityID | undefined {
		return undefined; // multi has no single target (matches prod targetOf read)
	}

	public targetsOf(index: number): EntityID[] {
		const set = this._forward.get(index);
		if (set === undefined || set.size === 0) return [];
		const out: EntityID[] = new Array(set.size);
		let i = 0;
		set.forEach((t) => {
			out[i++] = unsafeCast<EntityID>(t);
		});
		out.sort((a, b) => (a as number) - (b as number));
		return out;
	}

	public has(index: number): boolean {
		return this._store.has(index);
	}

	public forEachCanonicalTargetSet(cb: CanonicalTargetSetFn): void {
		// Canonical source order = ascending index; canonical target order =
		// ascending id (in `targetsOf`); empty sets are skipped. This is the
		// ONE place that ordering + skip-empty lives — `stateHash`,
		// `snapshotRelations`, and `pairsOf` all fold through here, so they can
		// no longer disagree on the empty-set branch (a latent divergence:
		// `snapshotRelations` used to emit a 0-target record).
		const idxs = Array.from(this._forward.keys()).sort((a, b) => a - b);
		for (let i = 0; i < idxs.length; i++) {
			const targets = this.targetsOf(idxs[i]);
			if (targets.length === 0) continue;
			cb(idxs[i], targets);
		}
	}

	public forEachCanonicalPair(makeId: MakeSourceID, cb: CanonicalPairFn): void {
		this.forEachCanonicalTargetSet((idx, targets) => {
			const src = makeId(idx);
			for (let t = 0; t < targets.length; t++) cb(src, targets[t]);
		});
	}

	public rebuildReverseFromForward(): void {
		// Multi reverse edges were rebuilt alongside the forward set in
		// `restoreAddTarget`, so there is nothing left to reconstruct.
	}

	public restoreAddTarget(index: number, tgt: EntityID, src: EntityID): void {
		let set = this._forward.get(index);
		if (set === undefined) {
			set = new Set<number>();
			this._forward.set(index, set);
		}
		set.add(tgt as number);
		this.linkReverse(tgt, src);
	}
}

/** Build the right `RelationStore` for a cardinality. The only construction
 * site is `Store.registerRelation`, which resolves the backing sparse store and
 * hands it in so the relation can drive forward/membership rows directly. */
export function makeRelationStore(
	exclusive: boolean,
	sparse: SparseComponentDef,
	store: SparseComponentStore,
	onDeleteTarget: OnDeleteTarget
): RelationStore {
	return exclusive
		? new ExclusiveRelationStore(sparse, store, onDeleteTarget)
		: new MultiRelationStore(sparse, store, onDeleteTarget);
}

/** Per-relation snapshot header: `u32 isMulti` (1 = multi, 0 = exclusive — a
 * shape check against the registered relation on restore). */
const RELATION_HEADER_BYTES = 4;
/** Multi source header: `u32 sourceCount`. */
const MULTI_SOURCE_COUNT_BYTES = 4;
/** Per multi source: `u32 sourceIndex` + `u32 targetCount` (the f64 targets
 * follow). */
const MULTI_SOURCE_PREFIX_BYTES = 8;
const F64_BYTES = 8;

/** Serialize the relation side data that does **not** live in the sparse store
 * — i.e. each **multi** relation's forward target sets (`Map<source index,
 * Set<target>>`). Exclusive relations store their target in the backing sparse
 * field, so they ride `snapshotSparseStores` and contribute only a header
 * here. The reverse index is fully derivable (from the sparse store for
 * exclusive, from these sets for multi), so it is never serialized — it is
 * rebuilt by `restoreRelations` + the caller's exclusive-reverse pass.
 *
 * Members are emitted in canonical order (sources ascending by entity index,
 * each source's targets ascending by id) so the bytes are independent of
 * add/remove history — the same byte-level determinism invariant the sparse
 * snapshot holds. Layout (integers little-endian):
 *
 *   u32 relationCount
 *   repeat relationCount times (registration / id order):
 *     u32 isMulti
 *     if multi:
 *       u32 sourceCount
 *       repeat sourceCount times (ascending source index):
 *         u32 sourceIndex
 *         u32 targetCount
 *         f64 × targetCount   (target EntityIDs, ascending) */
export function snapshotRelations(relations: readonly RelationStore[]): Uint8Array {
	// Materialize each multi relation's canonical `(source index, targets)` sets
	// once, so the size and write passes read the *same* list rather than folding
	// the canonical traversal twice and risking divergence. The ordering and the
	// empty-set skip both live in `forEachCanonicalTargetSet` —
	// exclusive relations yield nothing (they ride the sparse snapshot), so an
	// exclusive relation contributes only its header here.
	const perRelation: ([number, readonly EntityID[]][] | null)[] = new Array(relations.length);
	let total = 4; // relationCount
	for (let r = 0; r < relations.length; r++) {
		total += RELATION_HEADER_BYTES;
		const rs = relations[r];
		if (rs.exclusive) {
			perRelation[r] = null;
			continue;
		}
		const sets: [number, readonly EntityID[]][] = [];
		rs.forEachCanonicalTargetSet((idx, targets) => sets.push([idx, targets]));
		perRelation[r] = sets;
		total += MULTI_SOURCE_COUNT_BYTES;
		for (let i = 0; i < sets.length; i++) {
			total += MULTI_SOURCE_PREFIX_BYTES + sets[i][1].length * F64_BYTES;
		}
	}

	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	let off = 0;
	view.setUint32(off, relations.length, true);
	off += 4;

	for (let r = 0; r < relations.length; r++) {
		view.setUint32(off, relations[r].exclusive ? 0 : 1, true);
		off += 4;
		const sets = perRelation[r];
		if (sets === null) continue;
		view.setUint32(off, sets.length, true);
		off += 4;
		for (let i = 0; i < sets.length; i++) {
			const idx = sets[i][0];
			const targets = sets[i][1];
			view.setUint32(off, idx, true);
			off += 4;
			view.setUint32(off, targets.length, true);
			off += 4;
			for (let t = 0; t < targets.length; t++) {
				view.setFloat64(off, targets[t] as number, true);
				off += F64_BYTES;
			}
		}
	}

	return bytes;
}

/** Rebuild every relation's side indices from a `snapshotRelations` buffer and
 * the already-restored sparse stores. Each relation's indices are reset first
 * (idempotent into a dirty world), then:
 *
 *  - **multi** — forward target sets and their reverse edges are rebuilt from
 *    `bytes` (the sets aren't in the sparse store, so the bytes are the only
 *    source). `makeId` maps a source entity index to its full `EntityID`
 *    (generation from the live slot) so reverse edges key correctly.
 *  - **exclusive** — only the reset happens here; the reverse index is rebuilt
 *    by the caller from the backing sparse store (which already round-tripped
 *    through `restoreSparseStores`), since this function can't read it.
 *
 * Throws `SparseRestoreError` on any shape mismatch (relation count, an
 * exclusive/multi flag that disagrees with the registered relation, a multi
 * source index past `MAX_INDEX`, or a truncated / over-long buffer) rather than
 * silently building a corrupt index. */
export function restoreRelations(
	relations: readonly RelationStore[],
	bytes: Uint8Array,
	makeId: (index: number) => EntityID
): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.byteLength;
	let off = 0;
	const need = (n: number): void => {
		if (off + n > end) {
			throw new SparseRestoreError(
				`relation snapshot truncated: need ${n} more bytes at offset ${off}, have ${end - off}`
			);
		}
	};

	for (let r = 0; r < relations.length; r++) relations[r].resetIndices();

	need(4);
	const relationCount = view.getUint32(off, true);
	off += 4;
	if (relationCount !== relations.length) {
		throw new SparseRestoreError(
			`relation count mismatch: snapshot=${relationCount}, registered=${relations.length}`
		);
	}

	for (let r = 0; r < relations.length; r++) {
		const rs = relations[r];
		need(RELATION_HEADER_BYTES);
		const isMulti = view.getUint32(off, true);
		off += 4;
		if ((isMulti === 1) === rs.exclusive) {
			throw new SparseRestoreError(
				`relation ${r} cardinality mismatch: snapshot ${isMulti ? "multi" : "exclusive"}, registered ${rs.exclusive ? "exclusive" : "multi"}`
			);
		}
		if (rs.exclusive) continue;
		need(MULTI_SOURCE_COUNT_BYTES);
		const sourceCount = view.getUint32(off, true);
		off += 4;
		for (let s = 0; s < sourceCount; s++) {
			need(MULTI_SOURCE_PREFIX_BYTES);
			const idx = view.getUint32(off, true);
			off += 4;
			const targetCount = view.getUint32(off, true);
			off += 4;
			if (idx > MAX_INDEX) {
				// Same crafted-index hazard as the sparse store: `idx` keys the
				// forward `Map` and feeds `makeId` → `createEntityId(idx, …)`,
				// which reads `gens[idx]` out of bounds for a wild index. Reject
				// before that, against the 20-bit entity-index ceiling.
				throw new SparseRestoreError(
					`relation ${r} source index ${idx} exceeds MAX_INDEX (${MAX_INDEX})`
				);
			}
			need(targetCount * F64_BYTES);
			const src = makeId(idx);
			for (let t = 0; t < targetCount; t++) {
				const tgt = unsafeCast<EntityID>(view.getFloat64(off, true));
				off += F64_BYTES;
				// Validate the decoded TARGET the same way the source `idx` is guarded
				// above: a crafted / truncated snapshot can decode a target whose bits
				// fall outside the 31-bit packed layout, and `getEntityIndex` would
				// then mask it (`& INDEX_MASK`) onto an unrelated live slot — the ABA
				// mis-binding the source-index guard exists to prevent.
				const tgtN = tgt as number;
				if (!Number.isInteger(tgtN) || tgtN < 0 || tgtN > MAX_ENTITY_ID) {
					throw new SparseRestoreError(
						`relation ${r} target ${tgtN} is not a well-formed packed EntityID (expected an integer in [0, ${MAX_ENTITY_ID}])`
					);
				}
				rs.restoreAddTarget(idx, tgt, src);
			}
		}
	}

	if (off !== end) {
		throw new SparseRestoreError(
			`relation snapshot has ${end - off} trailing bytes after the last relation (not a canonical encoding)`
		);
	}
}
