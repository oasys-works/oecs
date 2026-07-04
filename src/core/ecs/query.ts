/***
 * Query, QueryBuilder, SystemContext — System-facing ECS interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. Iterate with forEach(), which yields non-empty
 * archetypes. Use arch.getColumnRead() to access SoA columns, then
 * write the inner loop over arch.entityCount.
 *
 * QueryBuilder is the entry point for creating queries inside
 * registerSystem(fn, qb => qb.every(Pos, Vel)).
 *
 * SystemContext wraps Store for use inside system functions, exposing
 * only deferred operations (add/remove component, destroy entity) that
 * buffer changes until the phase flush. This prevents iterator
 * invalidation during system execution.
 *
 * Usage (inside a system):
 *
 *   q.forEach((arch) => {
 *     const px = arch.getColumnRead(Pos, "x");
 *     const py = arch.getColumnRead(Pos, "y");
 *     const vx = arch.getColumnRead(Vel, "vx");
 *     const vy = arch.getColumnRead(Vel, "vy");
 *     for (let i = 0; i < arch.entityCount; i++) {
 *       // reads only; mutate via ctx.ref / ctx.setField (bumps change tick)
 *       sum += px[i] + py[i] + vx[i] + vy[i];
 *     }
 *   });
 *
 * Queries compose via chaining:
 *
 *   q.and(Energy)          — extend required components
 *   q.not(Frozen)          — exclude archetypes with Frozen
 *   q.anyOf(Sprite, Mesh) — require at least one of these
 *   q.optional(Vel)        — fetch Vel if present; still iterate without it
 *
 * An optional term (Bevy `Option<&T>` / flecs `?`, #575) does NOT narrow the
 * matched set — it stays at the required terms, spanning archetypes with and
 * without `T`. Read the column per archetype span via
 * `arch.getOptionalColumnRead(T, field)`, which returns the column or
 * `undefined` (absent span). Like the sparse terms, it doesn't touch the dense
 * mask, so the derived query reuses this one's live archetype list.
 *
 ***/

import type { Store } from "./store";
import type { FrameTraceSink } from "./frame_trace";
import type { Archetype, ArchetypeView } from "./archetype";
import { _setIterAllRows } from "./archetype";
import type { EntityID } from "./entity";
import type {
	ComponentDef,
	ComponentID,
	ComponentSchema,
	CompleteFieldValues,
	MutableColumnsForSchema,
	ColumnsForSchema,
	BundleOrDef
} from "./component";
import { bundleDef, bundleValues } from "./component";
import type { SparseComponentDef, SparseComponentID } from "./sparse_store";
import type { RelationDef } from "./relation";
import { createRef, type ComponentRef, type ReadonlyComponentRef } from "./ref";
import type {
	EmptyEventSchema,
	EventDef,
	EventKey,
	EventReader,
	EventSchema,
	SignalKey
} from "./event";
import type { ResourceKey } from "./resource";
import { BitSet, unsafeCast } from "../../type_primitives";
import { EMPTY_VALUES } from "./utils/constants";
import { ECSError, ECS_ERROR } from "./utils/error";
import { dispatchTrace } from "./dispatch_trace";
import { accessCheck } from "./access_check";

export interface QueryCacheEntry {
	includeMask: BitSet;
	excludeMask: BitSet | null;
	anyOfMask: BitSet | null;
	query: Query<any>; // any: heterogeneous cache — different queries have different Defs tuples
}

export interface QueryResolver {
	_resolveQuery(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		defs: readonly ComponentDef[]
	): Query<any>; // any: heterogeneous cache — callers downcast to their specific Query<Defs>
	_getLastRunTick(): number;
	/** Current ECS write tick — the tick `eachChunk` stamps via `cols.mut` (§eachChunk). */
	_getCurrentTick(): number;
	_getQueryDirtyEpoch(): number;
	_nextQueryId(): number;
	// Shared single-component composition caches, keyed by
	// (parent_id << 16) | cid. One Map per direction lives on the resolver
	// instead of four nullable Maps per Query, dropping the per-Query footprint
	// from O(#queries × 4) to O(4).
	_andSingleCache: Map<number, Query<any>>;
	_notSingleCache: Map<number, Query<any>>;
	_anyOfSingleCache: Map<number, Query<any>>;
	_changedSingleCache: Map<number, ChangedQuery<any>>;
	// Optional fetch-if-present composition cache (#575), same dense
	// (parent_id << 16) | cid keying as the dense single caches above — an
	// optional term is a dense ComponentID (cid <= 128), distinct from the
	// sparse id space below.
	_optionalSingleCache: Map<number, Query<any>>;
	// Sparse-membership composition caches (#469), same (parent_id << 16) | id
	// keying as the dense single caches — except the id is a SparseComponentID
	// (a separate id space), so these never collide with the dense maps.
	_withSparseSingleCache: Map<number, Query<any>>;
	_withoutSparseSingleCache: Map<number, Query<any>>;
	// Relation-wildcard `(R, *)` composition caches (#579), keyed
	// (parent_id << 16) | relation_id — a separate id space from the sparse caches
	// (and a separate Map because a `withRelation(R)` query also carries the
	// relation id for its access check, so it can't share the sparse cache).
	_withRelationSingleCache: Map<number, Query<any>>;
	_withoutRelationSingleCache: Map<number, Query<any>>;
	// Include-disabled composition cache (#577), keyed by the parent query id so
	// `q.includeDisabled()` returns a stable instance on repeated calls (no
	// query-id climb) — same rationale as the sparse caches.
	_includeDisabledSingleCache: Map<number, Query<any>>;
	// Hierarchy depth-ordering composition cache (#581), keyed
	// (parent_id << 16) | relation_id. Only the unbounded form
	// (`maxDepth === HIERARCHY_UNBOUNDED`) is cached — a `maxDepth`-limited term
	// adds a third key dimension and is the rarer shape, so it mints fresh (a
	// hierarchy query is built once at system registration, not per tick, so the
	// churn is negligible). Same id space as the relation caches above; a dedicated
	// Map because a `.hierarchy(R)` query also records R for its access check.
	_hierarchySingleCache: Map<number, Query<any>>;
	/** Second query-match path (#469 / ADR-0011): drive iteration by sparse
	 * membership rather than the archetype mask, yielding entities — sparse
	 * members are scattered across archetypes, so there is no archetype-column
	 * span to hand back. With a sparse require term, drive from the smallest
	 * required store and filter; with only sparse excludes, drive the dense
	 * archetype list and skip excluded rows; with neither, walk dense entities.
	 * Only entered via `Query.forEachEntity`, so dense `forEach` never pays.
	 * `includeDisabled` widens the per-archetype row scan from enabled rows to
	 * all rows (#577). */
	_forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includeDisabled: boolean
	): void;
	/** Backing sparse id of a relation — resolves a `(R, *)` wildcard term
	 * (`withRelation`, #579) to the membership store the sparse-match path
	 * already drives. */
	_relationBackingSparseId(def: RelationDef): SparseComponentID;
	/** Third query-match path (#579): `(*, T)` — drive iteration from the union of
	 * every relation's `sourcesOf(target)` (dedup + canonical sort), intersected
	 * with the dense mask + sparse terms + the enabled-row filter. Only entered via
	 * `Query.forEachRelatedTo`. */
	_forEachRelationTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		includeDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void;
	/** Fourth query-match path (#581): yield the matched entities (dense mask +
	 * sparse terms + enabled-row filter, exactly the `_forEachSparseMatch`
	 * intersection) in canonical **hierarchy depth order** over exclusive relation
	 * `relation` — depth ascending (parents before children), entity index
	 * ascending within a depth band. Entities deeper than `maxDepth` are skipped
	 * (`HIERARCHY_UNBOUNDED` = no limit). Only entered via `Query.forEachEntity`
	 * on a query carrying a `.hierarchy(R)` term. */
	_forEachHierarchyMatch(
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
	): void;
}

// Frozen empty sparse-term list — shared by every dense-only Query so the
// common path allocates no per-query arrays (#469).
const NO_SPARSE_TERMS: readonly SparseComponentID[] = Object.freeze([]);

// Frozen empty optional-term list — shared by every Query without an optional
// fetch term (#575), same zero-alloc rationale as NO_SPARSE_TERMS.
const NO_OPTIONAL_TERMS: readonly ComponentID[] = Object.freeze([]);

// Frozen empty relation-wildcard-term list — shared by every Query without a
// `(R, *)` term (#579), same zero-alloc rationale. These lists exist only for the
// `__DEV__` `relationReads` access check (`_checkRelationAccess`); the driver
// reads the relation's backing sparse id off `_sparseInclude`, never this.
const NO_RELATION_TERMS: readonly RelationDef[] = Object.freeze([]);

/** No depth limit on a `.hierarchy(R)` term (#581) — yield every matched entity
 * regardless of its depth in the tree. The default `maxDepth`. */
export const HIERARCHY_UNBOUNDED = Number.POSITIVE_INFINITY;

/** A `.hierarchy(R)` depth-ordering term (#581). Records the exclusive relation
 * whose tree defines the order and the (optional) max depth to yield. Stored on
 * the Query and consumed by the `forEachEntity` hierarchy match path; absent
 * (`null`) for the common case. */
export interface HierarchyTerm {
	/** The exclusive relation whose chain/tree defines the depth ordering. */
	readonly relation: RelationDef;
	/** Inclusive max depth to yield (root = 0); entities deeper than this are
	 * skipped. `HIERARCHY_UNBOUNDED` for no limit (bitECS `Hierarchy()` depth arg). */
	readonly maxDepth: number;
}

// The single-term sparse caches key on `(queryId << 16) | sparseId`, which
// is injective only while both halves fit 16 bits. Dense component ids are
// hard-capped at 128, but sparse ids are deliberately uncapped (they escape the
// 128 identity cap) and the query-id counter is unbounded — so nothing
// structurally guarantees the bound the packing assumes. Assert it in `__DEV__`
// so an overflow surfaces as a loud error at the (astronomically unlikely) pack
// site rather than a silent wrong-cache-hit. 2^16 = 65536 distinct sparse
// components or live queries in one ECS is the trigger; realistic counts are
// in the tens. The dense caches share the same packing and the same (smaller,
// since cid <= 128) latent risk on the query-id half.
const CACHE_KEY_HALF_LIMIT = 0x10000;
function sparseCacheKey(queryId: number, sparseId: number): number {
	if (__DEV__ && (queryId >= CACHE_KEY_HALF_LIMIT || sparseId >= CACHE_KEY_HALF_LIMIT)) {
		throw new ECSError(
			ECS_ERROR.SPARSE_CACHE_KEY_OVERFLOW,
			`sparse query cache key would overflow: query_id=${queryId}, sparse_id=${sparseId} (each must be < ${CACHE_KEY_HALF_LIMIT})`
		);
	}
	return ((queryId << 16) | sparseId) >>> 0;
}

// Append a sparse id to a term list, de-duplicating. Returns the same list
// (no allocation) when the id is already present — so `q.withSparse(R)`
// twice resolves to the identical term set. Term lists are tiny (a query has
// a handful of sparse terms at most), so the linear scan is free.
function appendSparse(
	list: readonly SparseComponentID[],
	id: number
): readonly SparseComponentID[] {
	for (let i = 0; i < list.length; i++) {
		if ((list[i] as number) === id) return list;
	}
	return [...list, id as SparseComponentID];
}

// Append a dense component id to an optional-term list, de-duplicating (#575).
// Same shape as `appendSparse` but in the dense ComponentID space; the lists
// are tiny so the linear scan is free.
function appendOptional(list: readonly ComponentID[], id: number): readonly ComponentID[] {
	for (let i = 0; i < list.length; i++) {
		if ((list[i] as number) === id) return list;
	}
	return [...list, id as ComponentID];
}

// Append a relation id to a `(R, *)` access-term list, de-duplicating (#579).
// Same shape as `appendSparse`; tiny lists, free linear scan.
function appendRelation(list: readonly RelationDef[], def: RelationDef): readonly RelationDef[] {
	for (let i = 0; i < list.length; i++) {
		if ((list[i] as number) === (def as number)) return list;
	}
	return [...list, def];
}

/**
 * eachChunk cursor (§eachChunk). One instance is allocated per `eachChunk`
 * pass and reused across every matched archetype in that pass — only `_arch`/
 * `_tick` are re-pointed per archetype, so the inner loop allocates nothing.
 * Per-call (not cached on the query) so a nested `eachChunk` on the same query
 * gets its own cursor and can't re-point an outer pass's position. `.mut(def)` /
 * `.read(def)` resolve a whole component's columns at once into a field-keyed
 * object (a per-archetype-per-component cache refreshed in place), hiding the
 * change tick. Destructure the group immediately; don't retain it across calls.
 */
export class ChunkColumns {
	/** @internal */ _arch!: Archetype;
	/** @internal */ _tick = 0;

	/** Mutable column group — `const { x, y } = cols.mut(Pos)`. Stamps the tick. */
	public mut<S extends ComponentSchema>(def: ComponentDef<S>): MutableColumnsForSchema<S> {
		return this._arch.columnGroupMut(def, this._tick);
	}

	/** Read-only column group — `const { vx, vy } = cols.read(Vel)`. No tick bump. */
	public read<S extends ComponentSchema>(def: ComponentDef<S>): ColumnsForSchema<S> {
		return this._arch.columnGroupRead(def);
	}
}

export class Query<Defs extends readonly ComponentDef[]> {
	private readonly _archetypes: Archetype[];
	// Public-readonly (consistent with `_include` / `_id` below) so a run
	// condition built via `runIfAnyMatch(query)` can declare the query's
	// component defs as its read surface (#576). Not part of the documented API.
	public readonly _defs: Defs;
	private readonly _resolver: QueryResolver;
	public readonly _include: BitSet;
	private readonly _exclude: BitSet | null;
	private readonly _anyOf: BitSet | null;
	private _nonEmptyArchetypes: Archetype[] = [];
	// Epoch counter rather than a dirty bit (#327). The Store bumps its
	// `_queryDirtyEpoch` on every membership change; this query rebuilds
	// when its observed epoch is stale. Lets `Store._mark_queries_dirty`
	// coalesce O(num_queries) walks into a single increment — startup that
	// does N immediate `addComponent` calls used to write N×Q dirty bits,
	// now writes N integers.
	private _lastSeenEpoch: number = -1;
	// Stable id minted by the resolver. Combined with a component id into
	// (id << 16) | cid to key the resolver's shared single-component caches.
	public readonly _id: number;
	// Sparse-membership terms (#469). Empty for a dense-only query (the common
	// case), in which they share the frozen NO_SPARSE_TERMS singleton and the
	// sparse match path is never consulted. `withSparse` / `withoutSparse`
	// don't touch the dense mask, so a derived query reuses the parent's live
	// `_archetypes` array — the store keeps pushing new archetypes into it, so
	// both queries stay live without a second `registerQuery`.
	public readonly _sparseInclude: readonly SparseComponentID[];
	public readonly _sparseExclude: readonly SparseComponentID[];
	// Optional fetch-if-present terms (#575). Empty for the common case (shares
	// the frozen NO_OPTIONAL_TERMS singleton). An optional term does NOT narrow
	// the matched set — it leaves the dense mask untouched, so a derived query
	// reuses the parent's live `_archetypes` array (same as the sparse terms).
	// The term is *consumed*, not decorative (#592): `forEach` publishes it as
	// the active optional scope, and `getOptionalColumnRead` rejects (in
	// `__DEV__`) a fetch of any component not listed here — so `.optional(T)` is
	// the declaration that authorizes the fetch, the read-side analog of
	// `reads:[T]`. It is carried symmetrically through `and`/`not`/`anyOf` (see
	// `_carryNondense`), so term order never drops it.
	public readonly _optional: readonly ComponentID[];
	// Include-disabled opt-in (#577). False by default — queries exclude disabled
	// entities (the archetype iteration bound `entityCount` is `enabled_count`).
	// `.includeDisabled()` derives a query with this true; it widens the
	// non-empty filter, `count`, and `forEachEntity` to span disabled rows, and
	// makes `forEach` publish the all-rows iteration flag so the SoA loop reads
	// `entityCount === length`. Like the sparse/optional terms it doesn't touch
	// the dense mask, so the derived query reuses the parent's live archetype list
	// and is carried through `and`/`not`/`anyOf` (`_carryNondense`).
	public readonly _includeDisabled: boolean;
	// Relation-wildcard `(R, *)` terms (#579). Empty for the common case (shares
	// the frozen NO_RELATION_TERMS singleton). `withRelation(R)` /
	// `withoutRelation(R)` push R's *backing sparse id* onto `_sparseInclude` /
	// `_sparseExclude` (so iteration reuses the sparse-match driver unchanged) AND
	// record R here purely so `forEachEntity` / `forEachRelatedTo` can assert
	// `relationReads: [R]` under `__DEV__` (`_checkRelationAccess`). Carried
	// through `and`/`not`/`anyOf` like the sparse terms (`_carryNondense`).
	public readonly _relationIncludes: readonly RelationDef[];
	public readonly _relationExcludes: readonly RelationDef[];
	// Hierarchy depth-ordering term (#581). `null` for the common case (no
	// ordering). A `.hierarchy(R)` term does NOT narrow the matched set or touch
	// the dense mask — it reorders the matched entities into depth order (parents
	// before children) and optionally drops those past `maxDepth`. So the derived
	// query reuses this one's live archetype list and is carried through
	// `and`/`not`/`anyOf` like the sparse/optional terms (`_carryNondense`). It
	// reaches the store only via `forEachEntity` (members scatter across
	// archetypes — there is no SoA span — so `forEach` rejects it, like a sparse
	// term); `accessCheck` validates `relationReads: [R]` at iteration time.
	public readonly _hierarchy: HierarchyTerm | null;

	constructor(
		archetypes: Archetype[],
		defs: Defs,
		resolver: QueryResolver,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		id: number,
		sparseInclude: readonly SparseComponentID[] = NO_SPARSE_TERMS,
		sparseExclude: readonly SparseComponentID[] = NO_SPARSE_TERMS,
		optional: readonly ComponentID[] = NO_OPTIONAL_TERMS,
		includeDisabled: boolean = false,
		relationIncludes: readonly RelationDef[] = NO_RELATION_TERMS,
		relationExcludes: readonly RelationDef[] = NO_RELATION_TERMS,
		hierarchy: HierarchyTerm | null = null
	) {
		this._archetypes = archetypes;
		this._defs = defs;
		this._resolver = resolver;
		this._include = include;
		this._exclude = exclude;
		this._anyOf = anyOf;
		this._id = id;
		this._sparseInclude = sparseInclude;
		this._sparseExclude = sparseExclude;
		this._optional = optional;
		this._includeDisabled = includeDisabled;
		this._relationIncludes = relationIncludes;
		this._relationExcludes = relationExcludes;
		this._hierarchy = hierarchy;
	}

	/** Guard the dense-only methods (`count` / `forEach` / `archetype_count`)
	 * against a query carrying sparse terms. These walk the dense archetype
	 * list and never consult `_sparseInclude` / `_sparseExclude`, so on a
	 * sparse-derived query they'd **fail open** — returning the unfiltered dense
	 * result instead of the sparse-filtered one. Throw in `__DEV__` (compiled
	 * out of prod) steering the caller to `forEachEntity`, the only path that
	 * honors sparse membership (#469). Mirrors `ChangedQuery`'s dev-guard on its
	 * include-mask invariant. */
	private _assertDenseOnly(method: string): void {
		if (
			this._sparseInclude.length > 0 ||
			this._sparseExclude.length > 0 ||
			this._relationIncludes.length > 0 ||
			this._relationExcludes.length > 0 ||
			this._hierarchy !== null
		) {
			throw new ECSError(
				ECS_ERROR.SPARSE_QUERY_DENSE_PATH,
				`Query.${method} ignores sparse / relation-wildcard / hierarchy terms (withSparse / withoutSparse / withRelation / withoutRelation / hierarchy) — it walks only the dense archetype list and would return the wrong result (a hierarchy term has no per-archetype span — its order spans archetypes). Iterate this query with forEachEntity instead.`
			);
		}
	}

	/** Number of matching archetypes (including empty ones). */
	public get archetypeCount(): number {
		if (__DEV__) this._assertDenseOnly("archetypeCount");
		return this._archetypes.length;
	}

	/** Total entity count across all matching archetypes — enabled rows only by
	 * default, or all rows when `includeDisabled()` (#577). Reads the partition
	 * fields directly (not the flag-dependent `entityCount` getter). */
	public count(): number {
		if (__DEV__) this._assertDenseOnly("count");
		const archs = this._nonEmpty();
		let total = 0;
		if (this._includeDisabled) {
			for (let i = 0; i < archs.length; i++) total += archs[i].totalCount;
		} else {
			for (let i = 0; i < archs.length; i++) total += archs[i].enabledCount;
		}
		return total;
	}
	public get archetypes(): readonly ArchetypeView[] {
		return this._archetypes;
	}

	/** Carry this query's non-dense terms — optional fetch-if-present (#575) and
	 * sparse membership (#469) — onto a freshly composed dense query. `and` /
	 * `not` / `anyOf` build the new dense mask via `_resolveQuery`, which is
	 * keyed on the mask alone and so hands back a query carrying NONE of these
	 * terms; before #592 that silently dropped them, making composition
	 * order-dependent (`q.optional(V).and(H)` lost `V`; `q.and(H).optional(V)`
	 * kept it). When this query carries no non-dense terms (the common case)
	 * `base` is already correct and returned as-is, preserving the mask-cached
	 * singleton with zero allocation. Otherwise re-derive on top of `base`'s dense
	 * state, threading the terms forward so composition is symmetric regardless of
	 * order. Reading `base`'s private fields is allowed — same-class instance. */
	private _carryNondense(base: Query<any>): Query<any> {
		if (
			this._optional.length === 0 &&
			this._sparseInclude.length === 0 &&
			this._sparseExclude.length === 0 &&
			!this._includeDisabled &&
			this._relationIncludes.length === 0 &&
			this._relationExcludes.length === 0 &&
			this._hierarchy === null
		) {
			return base;
		}
		return new Query(
			base._archetypes,
			base._defs,
			this._resolver,
			base._include,
			base._exclude,
			base._anyOf,
			this._resolver._nextQueryId(),
			this._sparseInclude,
			this._sparseExclude,
			this._optional,
			this._includeDisabled,
			this._relationIncludes,
			this._relationExcludes,
			this._hierarchy
		);
	}

	/** Extend required component set. Returns a new (cached) Query. */
	public and<D extends ComponentDef[]>(...comps: D): Query<[...Defs, ...D]> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this._id << 16) | cid) >>> 0;
			const cached = this._resolver._andSingleCache.get(key);
			if (cached !== undefined) return cached as Query<[...Defs, ...D]>;
			return this._andMiss(comps[0], cid, key) as Query<[...Defs, ...D]>;
		}
		// Multi-arg: fold through the single-arg cached path one id at a time, so
		// every prefix is cached and `and(A, B)` is the same instance as the chained
		// `and(A).and(B)`. Without the fold a receiver carrying non-dense terms
		// (optional/sparse) mints a fresh Query + query-id on every call via
		// `_carryNondense` — the GC-churn / query-id climb toward
		// `CACHE_KEY_HALF_LIMIT` that #497 fixed for `withSparse` (#594).
		let q: Query<any> = this;
		for (let i = 0; i < comps.length; i++) q = q.and(comps[i]);
		return q as Query<[...Defs, ...D]>;
	}

	/** @internal — cold cache-miss path for single-arg `and`, split out (#649) so
	 * the hot `and` body is just key-compute + cache hit. The miss path runs once
	 * per unique composition, then every repeat is a cache hit; keeping it out of
	 * line shrinks `and`'s inlined footprint when several composes share one hot
	 * function (the `query_compose` shape). Same rationale for `_notMiss` /
	 * `_anyOfMiss` / `_changedMiss`. */
	private _andMiss(def: ComponentDef, cid: number, key: number): Query<any> {
		const newInclude = this._include.copy();
		const newDefs = this._defs.slice() as ComponentDef[];
		if (!newInclude.has(cid)) {
			newInclude.set(cid);
			newDefs.push(def);
		}
		const result = this._carryNondense(
			this._resolver._resolveQuery(newInclude, this._exclude, this._anyOf, newDefs)
		);
		this._resolver._andSingleCache.set(key, result);
		return result;
	}

	/** Exclude archetypes that have any of these components. */
	public without(...comps: ComponentDef[]): Query<Defs> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this._id << 16) | cid) >>> 0;
			const cached = this._resolver._notSingleCache.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._notMiss(cid, key);
		}
		// Fold through the single-arg cached path (#594), mirroring `and` — keeps the
		// result stable and avoids minting query-ids on a non-dense receiver.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.without(comps[i]);
		return q;
	}

	/** @internal — cold cache-miss path for single-arg `not` (#649); see `_andMiss`. */
	private _notMiss(cid: number, key: number): Query<Defs> {
		const newExclude = this._exclude ? this._exclude.copy() : new BitSet();
		newExclude.set(cid);
		const result = this._carryNondense(
			this._resolver._resolveQuery(this._include, newExclude, this._anyOf, this._defs)
		) as Query<Defs>;
		this._resolver._notSingleCache.set(key, result);
		return result;
	}

	/** Require a sparse component (#469): match only entities that hold it,
	 * across every archetype. A sparse term doesn't touch the dense mask, so
	 * the returned (cached) query reuses this one's live archetype list; it is
	 * iterated via `forEachEntity`, never `forEach` (sparse members are
	 * scattered within archetypes, so there is no SoA column span to yield). */
	public withSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._withSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache one id at a time, so every
		// prefix is cached. A repeated `withSparse(A, B)` then returns the
		// identical Query (#497) — the multi-arg form used to bypass the cache and
		// mint a fresh Query + id + term arrays on every call (GC churn on the hot
		// path, and an unbounded climb toward the SPARSE_CACHE_KEY_OVERFLOW bound).
		// The fold also makes `withSparse(A, B)` the same instance as the chained
		// `withSparse(A).withSparse(B)`.
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withSparseOne(defs[i] as unknown as number);
		return q;
	}

	/** One-id `withSparse` composition, cached on `(parent_id, sparseId)` in
	 * the resolver's shared single-term map. Both the single- and multi-arg public
	 * forms fold over this, so all sparse-require composition is deduplicated. */
	private _withSparseOne(sid: number): Query<Defs> {
		const key = sparseCacheKey(this._id, sid);
		const cache = this._resolver._withSparseSingleCache;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			appendSparse(this._sparseInclude, sid),
			this._sparseExclude
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude a sparse component (#469): drop entities that hold it. Same
	 * dense-list reuse and `forEachEntity` iteration as `withSparse`. */
	public withoutSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._withoutSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache, same as `withSparse`
		// (#497) — each prefix is cached, so a repeated `withoutSparse(A, B)`
		// returns the identical Query instead of allocating one per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withoutSparseOne(defs[i] as unknown as number);
		return q;
	}

	/** One-id `withoutSparse` composition, cached on `(parent_id, sparseId)`. The
	 * multi-arg form folds over this (#497) — mirrors `_withSparseOne`. */
	private _withoutSparseOne(sid: number): Query<Defs> {
		const key = sparseCacheKey(this._id, sid);
		const cache = this._resolver._withoutSparseSingleCache;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			this._sparseInclude,
			appendSparse(this._sparseExclude, sid)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new sparse terms. Reuses this query's
	 * dense state by reference — the masks are never mutated in place (`and` /
	 * `not` / `anyOf` copy before mutating), and `_archetypes` is the same
	 * live array the store appends to, so the derived query stays live too.
	 * Carries the existing `_optional` terms through unchanged (the two axes
	 * compose). */
	private _deriveSparse(
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[]
	): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this._defs,
			this._resolver,
			this._include,
			this._exclude,
			this._anyOf,
			this._resolver._nextQueryId(),
			sparseInclude,
			sparseExclude,
			this._optional,
			this._includeDisabled,
			this._relationIncludes,
			this._relationExcludes,
			this._hierarchy
		);
	}

	/** Require the `(R, *)` wildcard (#579): match only sources that hold **any**
	 * target under relation `R`. "Has any `(R, *)` pair" is exactly membership in
	 * R's backing sparse store (exclusive `{target}` row / multi tag), so this is a
	 * relation-typed front door over `withSparse` — it pushes R's backing sparse
	 * id onto `_sparseInclude` and reuses the `forEachEntity` sparse-match path
	 * (insertion order; canonical sorting is reserved for `stateHash`/snapshot, and
	 * costs 4–5× here for no determinism benefit — see the §579 bench report).
	 * Membership semantics: each source once; fetch its targets with
	 * `ctx.targetsOf(e, R)`. Requires `relationReads: [R]` (checked at iteration).
	 * Cached per `(parent_id, relation_id)` like the sparse terms (#497). */
	public withRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._withRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withRelationOne(defs[i]);
		return q;
	}

	private _withRelationOne(def: RelationDef): Query<Defs> {
		const key = sparseCacheKey(this._id, def as unknown as number);
		const cache = this._resolver._withRelationSingleCache;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver._relationBackingSparseId(def);
		const result = this._deriveRelation(
			appendSparse(this._sparseInclude, sid as unknown as number),
			this._sparseExclude,
			appendRelation(this._relationIncludes, def),
			this._relationExcludes
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude the `(R, *)` wildcard (#579): drop sources that hold any target
	 * under `R`. Mirror of `withRelation` on the exclude side (pushes R's
	 * backing sparse id onto `_sparseExclude`). */
	public withoutRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._withoutRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withoutRelationOne(defs[i]);
		return q;
	}

	private _withoutRelationOne(def: RelationDef): Query<Defs> {
		const key = sparseCacheKey(this._id, def as unknown as number);
		const cache = this._resolver._withoutRelationSingleCache;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver._relationBackingSparseId(def);
		const result = this._deriveRelation(
			this._sparseInclude,
			appendSparse(this._sparseExclude, sid as unknown as number),
			this._relationIncludes,
			appendRelation(this._relationExcludes, def)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new relation-wildcard terms. Threads the
	 * backing-sparse ids (which the driver actually consumes) plus the relation
	 * ids (which only the `__DEV__` access check consumes), reusing the dense /
	 * optional / disabled state by reference — same rationale as `_deriveSparse`. */
	private _deriveRelation(
		sparseInclude: readonly SparseComponentID[],
		sparseExclude: readonly SparseComponentID[],
		relationIncludes: readonly RelationDef[],
		relationExcludes: readonly RelationDef[]
	): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this._defs,
			this._resolver,
			this._include,
			this._exclude,
			this._anyOf,
			this._resolver._nextQueryId(),
			sparseInclude,
			sparseExclude,
			this._optional,
			this._includeDisabled,
			relationIncludes,
			relationExcludes,
			this._hierarchy
		);
	}

	/** Order this query's matched entities in **hierarchy depth order** over the
	 * exclusive relation `R` — parents before children — and (optionally) drop any
	 * deeper than `maxDepth` (#581; flecs `cascade` / bitECS `Hierarchy()`). The
	 * matched *set* is unchanged (still the dense mask + sparse + `(R, *)` + disabled
	 * terms); `.hierarchy(R)` only **reorders** + depth-limits it, so an entity with
	 * no `R`-parent is a root at depth 0 and still yielded (first). The canonical
	 * order is depth ascending, then **entity index ascending within each depth
	 * band** — a total, insertion-order-independent order (identical across lockstep
	 * peers), produced by an O(K) radix on the entity index, never a comparator sort.
	 *
	 * Iterate with `forEachEntity`: members scatter across archetypes, so there is
	 * no SoA column span — `forEach` / `count` reject a hierarchy query (like a
	 * sparse term). **Exclusive relations only** (matches the traversal constraint
	 * #474); a multi relation throws `RELATION_MODE_MISMATCH` at iteration, and a
	 * cycle is a loud `RELATION_CYCLE` in `__DEV__` (a safe break in production).
	 * Requires `relationReads: [R]` (checked at iteration). Carried through
	 * `and`/`not`/`anyOf` like the sparse terms (`_carryNondense`).
	 *
	 * `Defs` is unchanged — `R` is an ordering, not a required component (like
	 * `not` / `anyOf`). Returns a new query; the unbounded form is cached. */
	public hierarchy(relation: RelationDef, maxDepth: number = HIERARCHY_UNBOUNDED): Query<Defs> {
		if (__DEV__) {
			if (this._hierarchy !== null) {
				throw new ECSError(
					ECS_ERROR.HIERARCHY_ALREADY_SET,
					`hierarchy() is already set on this query — a query carries a single depth ordering`
				);
			}
			// `maxDepth` is a depth (root = 0), so it must be `HIERARCHY_UNBOUNDED` or
			// a non-negative integer. Catch a caller typo (`-1` silently yields nothing;
			// a fractional limit floors oddly in the `d > maxDepth` band test) loudly
			// here rather than as mystifying empty/odd output. Prod is a no-op.
			if (maxDepth !== HIERARCHY_UNBOUNDED && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
				throw new ECSError(
					ECS_ERROR.HIERARCHY_INVALID_MAX_DEPTH,
					`hierarchy() max_depth must be HIERARCHY_UNBOUNDED or a non-negative integer, got ${maxDepth}`
				);
			}
		}
		// Cache only the unbounded form (the common case): a `maxDepth`-limited
		// term adds a third key dimension to the `(parent_id, relation_id)` packing,
		// and is the rarer shape — a hierarchy query is built once at system
		// registration (not per tick), so minting a bounded one fresh costs nothing.
		if (maxDepth === HIERARCHY_UNBOUNDED) {
			const key = sparseCacheKey(this._id, relation as unknown as number);
			const cache = this._resolver._hierarchySingleCache;
			const cached = cache.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			const result = this._deriveHierarchy({ relation, maxDepth });
			cache.set(key, result);
			return result;
		}
		return this._deriveHierarchy({ relation, maxDepth });
	}

	/** Build a derived query carrying a hierarchy ordering term. Reuses this
	 * query's dense / sparse / optional / disabled / relation-wildcard state by
	 * reference (the matched set is unchanged) — same rationale as `_deriveSparse`. */
	private _deriveHierarchy(hierarchy: HierarchyTerm): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this._defs,
			this._resolver,
			this._include,
			this._exclude,
			this._anyOf,
			this._resolver._nextQueryId(),
			this._sparseInclude,
			this._sparseExclude,
			this._optional,
			this._includeDisabled,
			this._relationIncludes,
			this._relationExcludes,
			hierarchy
		);
	}

	/** Assert every `(R, *)` wildcard term on this query was declared in the
	 * system's `relationReads` (#579 / #496). Iteration-time (`forEachEntity` /
	 * `forEachRelatedTo`), not construction-time, so it is robust to queries
	 * built outside a system — same rationale as the data-op checks. `__DEV__` only;
	 * outside a system `checkRelationRead` is a no-op. */
	private _checkRelationAccess(): void {
		for (let i = 0; i < this._relationIncludes.length; i++) {
			accessCheck.checkRelationRead(this._relationIncludes[i]);
		}
		for (let i = 0; i < this._relationExcludes.length; i++) {
			accessCheck.checkRelationRead(this._relationExcludes[i]);
		}
	}

	/** Iterate every source related to `target` under **any** relation — the
	 * `(*, T)` wildcard (#579) — intersected with this query's dense + sparse +
	 * `(R, *)` + disabled predicate, each source yielded once in ascending-EntityID
	 * order (the `sourcesOf` / `sourcesOfAny` convention). `target` is supplied
	 * here rather than as a chained term because it is a runtime `EntityID`: baking
	 * it into a cached `Query` would key the cache on a recycled value and churn
	 * query-ids, and `(*, T)` is the rare/cold shape. Composes with
	 * `withRelation` / `withSparse` / dense terms on the receiver. Reads
	 * every relation's reverse index, so the system must declare
	 * `relationReads: [ANY_RELATION]` (plus `[R]` for any composed `withRelation`).
	 * Cold/structural — not a per-tick hot loop over many targets. */
	public forEachRelatedTo(target: EntityID, cb: (entityId: EntityID) => void): void {
		if (__DEV__) {
			accessCheck.checkRelationReadAny();
			this._checkRelationAccess();
		}
		this._resolver._forEachRelationTargetMatch(
			target,
			this._include,
			this._exclude,
			this._anyOf,
			this._sparseInclude,
			this._sparseExclude,
			this._includeDisabled,
			cb
		);
	}

	/** Add optional fetch-if-present terms (#575). Does NOT narrow the matched
	 * set — the dense mask is untouched, so iteration still spans archetypes with
	 * and without each `T`. Read each column per archetype span via
	 * `arch.getOptionalColumnRead(T, field)` (column when present, `undefined`
	 * when absent). `.optional(T)` is the *declaration* that authorizes that fetch:
	 * inside `forEach`, `getOptionalColumnRead` throws in `__DEV__` if `T` was
	 * not declared here (#592) — the read-side analog of `reads:[T]`, which is also
	 * still required for access coverage (both checks fire, even on the absent
	 * span). The term is carried through `and`/`not`/`anyOf` (see
	 * `_carryNondense`), so it survives composition in any order. Returns a new
	 * (cached) Query.
	 *
	 * `Defs` is unchanged (the optional `T` is not a required component, like
	 * `not` / `anyOf`); column types come from the accessor's own generics. */
	public optional(...defs: ComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._optionalOne(defs[0].id);
		// Multi-arg folds through the single-term cache one id at a time, so every
		// prefix is cached and `optional(A, B)` is the same instance as the chained
		// `optional(A).optional(B)` (mirrors `and` / `withSparse`).
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._optionalOne(defs[i].id);
		return q;
	}

	/** One-id `optional` composition, cached on `(parent_id << 16) | cid` in the
	 * resolver's shared single-term map (dense cid <= 128, same packing as the
	 * `and` / `not` / `anyOf` caches). */
	private _optionalOne(cid: number): Query<Defs> {
		const key = ((this._id << 16) | cid) >>> 0;
		const cache = this._resolver._optionalSingleCache;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveOptional(appendOptional(this._optional, cid));
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new optional terms. Reuses this query's
	 * dense state by reference (the matched set is unchanged) and carries the
	 * existing sparse terms through unchanged — same rationale as `_deriveSparse`. */
	private _deriveOptional(optional: readonly ComponentID[]): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this._defs,
			this._resolver,
			this._include,
			this._exclude,
			this._anyOf,
			this._resolver._nextQueryId(),
			this._sparseInclude,
			this._sparseExclude,
			optional,
			this._includeDisabled,
			this._relationIncludes,
			this._relationExcludes,
			this._hierarchy
		);
	}

	/** Opt this query back in to disabled entities (#577). By default a query
	 * excludes disabled entities (the iteration bound `arch.entityCount` is the
	 * enabled-row count). The returned (cached) query spans disabled rows too:
	 * `forEach` publishes the all-rows flag so the SoA loop's `arch.entityCount`
	 * reports `length`, and `count`/`forEachEntity` widen accordingly. Does NOT
	 * touch the dense mask, so it reuses this query's live archetype list and is
	 * carried through `and`/`not`/`anyOf` like the sparse/optional terms. */
	public includeDisabled(): Query<Defs> {
		if (this._includeDisabled) return this;
		const cache = this._resolver._includeDisabledSingleCache;
		const cached = cache.get(this._id);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = new Query<Defs>(
			this._archetypes,
			this._defs,
			this._resolver,
			this._include,
			this._exclude,
			this._anyOf,
			this._resolver._nextQueryId(),
			this._sparseInclude,
			this._sparseExclude,
			this._optional,
			true,
			this._relationIncludes,
			this._relationExcludes,
			this._hierarchy
		);
		cache.set(this._id, result);
		return result;
	}

	public forEach(cb: (arch: ArchetypeView) => void): void {
		// Include-disabled iteration (#577): publish the all-rows flag so the SoA
		// loop's `arch.entityCount` spans disabled rows, restoring the previous
		// flag after (re-entrancy-safe). Kept off the default hot path entirely.
		if (this._includeDisabled) {
			this._forEachIncludeDisabled(cb);
			return;
		}
		// Default path: inline `_forEachInner`'s body rather than delegate (#608).
		// `forEach` is a megamorphic call site (every system passes a distinct
		// `cb`), so V8 will not inline the delegate — the extra stack frame is a
		// real per-call cost on `forEach`-call-bound loops. Keep this body
		// byte-identical to `_forEachInner`; do NOT "DRY it up" back into a
		// delegate hop (that hop is exactly the #577 regression this restores).
		if (__DEV__) {
			this._assertDenseOnly("forEach");
			// Publish this query's optional terms as the active scope so
			// `getOptionalColumnRead` can verify each fetch was declared via
			// `.optional(T)` (#592). Dev-only — prod runs the bare loop below
			// byte-for-byte. The try/finally keeps the scope balanced if `cb` throws.
			accessCheck.enterOptionalScope(this._optional);
			try {
				const archs = this._nonEmpty();
				for (let i = 0; i < archs.length; i++) cb(archs[i]);
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this._nonEmpty();
		for (let i = 0; i < archs.length; i++) {
			cb(archs[i]);
		}
	}

	/** @internal — cold `includeDisabled` wrapper for `forEach` (#577), split out
	 * (#649) so the all-rows flag dance (`_setIterAllRows` + try/finally) stays
	 * out of `forEach`'s inlined hot body. The default (enabled-only) query never
	 * reaches here, so V8 leaves this uninlined and `forEach` shrinks accordingly. */
	private _forEachIncludeDisabled(cb: (arch: ArchetypeView) => void): void {
		const prev = _setIterAllRows(true);
		try {
			this._forEachInner(cb);
		} finally {
			_setIterAllRows(prev);
		}
	}

	/**
	 * Per-archetype destructured column iteration (§eachChunk) — the flecs
	 * `run()` / koota `useStores` model, and the recommended hot-path default for
	 * mutating systems:
	 *
	 *   q.eachChunk((cols, count) => {
	 *     const { x, y }   = cols.mut(Pos);   // whole group, tick stamped inside
	 *     const { vx, vy } = cols.read(Vel);  // read-only group
	 *     for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
	 *   });
	 *
	 * vs the raw path it replaces (per-field `getColumn` + manual `ecsTick`
	 * thread + `entityCount` loop). It folds away: per-field fetches (one call
	 * per component), the `getColumn`/`getColumnRead` choice (→ `.mut`/`.read`),
	 * the manual tick arg (hidden in `.mut`), and the `.length`-vs-`entityCount`
	 * corruption trap (`count` is `entityCount`). It is also the only mutable
	 * column accessor reachable through the iteration path — the read-only
	 * `ArchetypeView` from `forEach` deliberately omits the mutable `getColumn`.
	 * The SoA inner loop is byte-identical, and the per-archetype group objects
	 * are cached (zero per-archetype allocation). One `ChunkColumns` cursor is
	 * allocated per pass and reused across that pass's archetypes. Honours
	 * `includeDisabled()` exactly like `forEach` (the bound widens to the
	 * disabled tail); dense-only like `forEach` (sparse/relation/hierarchy terms
	 * throw in `__DEV__` — iterate those with `forEachEntity`).
	 */
	public eachChunk(cb: (cols: ChunkColumns, count: number) => void): void {
		// Include-disabled iteration (#577): publish the all-rows flag so each
		// archetype's `entityCount` spans its disabled tail, then restore it
		// (re-entrancy-safe). Mirrors `forEach` / `forEachUntil` — every dense
		// iterator honours `includeDisabled()`. Kept off the default hot path.
		if (this._includeDisabled) {
			const prev = _setIterAllRows(true);
			try {
				this._eachChunkInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
			return;
		}
		this._eachChunkInner(cb);
	}

	/** @internal — shared body for `eachChunk`'s default and `includeDisabled`
	 * paths. The `ChunkColumns` cursor is allocated per call (a 2-field object whose
	 * cost doesn't scale with the per-row work) rather than cached on the query, so
	 * a nested `eachChunk` on the SAME query gets its own cursor instead of
	 * re-pointing the outer pass's `_arch`/`_tick`. The per-(archetype, component)
	 * column-group caches that actually matter for allocation live on the
	 * `Archetype`, untouched. */
	private _eachChunkInner(cb: (cols: ChunkColumns, count: number) => void): void {
		const view = new ChunkColumns();
		view._tick = this._resolver._getCurrentTick();
		if (__DEV__) {
			this._assertDenseOnly("eachChunk");
			accessCheck.enterOptionalScope(this._optional);
			try {
				const archs = this._nonEmpty();
				for (let i = 0; i < archs.length; i++) {
					view._arch = archs[i];
					cb(view, archs[i].entityCount);
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this._nonEmpty();
		for (let i = 0; i < archs.length; i++) {
			view._arch = archs[i];
			cb(view, archs[i].entityCount);
		}
	}

	/**
	 * Early-exit iteration: like `forEach`, but stops as soon as `cb` returns
	 * `true`, and returns whether any callback did. The predicate analog for
	 * "does any matching row satisfy X?" — without it, callers hand-rolled a
	 * `query.archetypes` walk (re-implementing the empty-archetype skip) just
	 * to be able to `return` mid-scan. Deliberately a separate method:
	 * honouring return values on `forEach`'s existing `=> void` callback
	 * would silently change behaviour for arrow-expression bodies that happen
	 * to return a truthy value.
	 */
	public forEachUntil(cb: (arch: ArchetypeView) => boolean): boolean {
		if (this._includeDisabled) {
			const prev = _setIterAllRows(true);
			try {
				return this._forEachUntilInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
		}
		return this._forEachUntilInner(cb);
	}

	/** @internal — shared body for `forEachUntil`'s default and
	 * `includeDisabled` paths. Same dev-mode optional-term scope as
	 * `forEach` (#592). */
	private _forEachUntilInner(cb: (arch: ArchetypeView) => boolean): boolean {
		if (__DEV__) {
			this._assertDenseOnly("forEachUntil");
			accessCheck.enterOptionalScope(this._optional);
			try {
				const archs = this._nonEmpty();
				for (let i = 0; i < archs.length; i++) {
					if (cb(archs[i])) return true;
				}
				return false;
			} finally {
				accessCheck.leaveOptionalScope();
			}
		}
		const archs = this._nonEmpty();
		for (let i = 0; i < archs.length; i++) {
			if (cb(archs[i])) return true;
		}
		return false;
	}

	/** @internal — the `includeDisabled` delegate for `forEach` (#577). The
	 * default (enabled-only) path inlines this body directly into `forEach`
	 * (#608) to dodge a megamorphic delegate hop; this copy survives only for the
	 * rare all-rows path, which needs the `_setIterAllRows` try/finally wrap. */
	private _forEachInner(cb: (arch: ArchetypeView) => void): void {
		if (__DEV__) {
			this._assertDenseOnly("forEach");
			// Publish this query's optional terms as the active scope so
			// `getOptionalColumnRead` can verify each fetch was declared via
			// `.optional(T)` (#592). Dev-only — prod runs the bare loop below
			// byte-for-byte. The try/finally keeps the scope balanced if `cb` throws.
			accessCheck.enterOptionalScope(this._optional);
			try {
				const archs = this._nonEmpty();
				for (let i = 0; i < archs.length; i++) cb(archs[i]);
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this._nonEmpty();
		for (let i = 0; i < archs.length; i++) {
			cb(archs[i]);
		}
	}

	/** Iterate the entities this query matches, yielding each `EntityID`
	 * (#469 — the sparse-membership match path). Use this whenever the query
	 * carries a `withSparse` / `withoutSparse` term: members are scattered
	 * across archetypes, so there is no SoA column span to hand back — read
	 * fields via `ctx.getField` (dense) or `ctx.getSparseField` (sparse) on
	 * the yielded entity. A dense-only query also works here (it walks its
	 * archetypes' entity ids), but prefer `forEach` for the SoA hot loop.
	 *
	 * Iteration is read-mostly: mutating the *driving* sparse component's
	 * membership mid-iteration is unsafe. The walk drives off the store's live
	 * key array, so **adding** the driving component (the store `push`es a new
	 * key, which the `i < length` loop then visits) and **removing** it (the
	 * store swap-pops, shifting the index list under the walk) both corrupt the
	 * traversal. This is sharper than for dense `forEach`: `ctx.addSparse` /
	 * `ctx.addRelation` apply *immediately* (no archetype transition to defer),
	 * so unlike a deferred dense `addComponent` the mutation lands in the live
	 * array at once. Buffer such edits and apply them after the walk. */
	public forEachEntity(cb: (entityId: EntityID) => void): void {
		// A `(R, *)` term reads relation structure — assert `relationReads: [R]`
		// (#579). `__DEV__` only; prod runs the bare match below byte-for-byte.
		if (__DEV__) this._checkRelationAccess();
		// A `.hierarchy(R)` term (#581) reorders the matched set into depth order
		// over R, so it routes to the dedicated depth-ordered driver rather than the
		// insertion-order sparse-match path. The relation is read, so it needs the
		// same `relationReads: [R]` assertion as a `(R, *)` term.
		if (this._hierarchy !== null) {
			if (__DEV__) accessCheck.checkRelationRead(this._hierarchy.relation);
			this._resolver._forEachHierarchyMatch(
				this._include,
				this._exclude,
				this._anyOf,
				this._sparseInclude,
				this._sparseExclude,
				this._nonEmpty(),
				this._hierarchy.relation,
				this._hierarchy.maxDepth,
				this._includeDisabled,
				cb
			);
			return;
		}
		this._resolver._forEachSparseMatch(
			this._include,
			this._exclude,
			this._anyOf,
			this._sparseInclude,
			this._sparseExclude,
			this._nonEmpty(),
			cb,
			this._includeDisabled
		);
	}

	/** @internal — used by ChangedQuery. Rebuild non-empty archetype list if the
	 * Store has bumped its dirty epoch since our last rebuild, return cached result.
	 *
	 * Rebuild allocates a *fresh* array and swaps it in rather than truncating
	 * the cached one in place (#431). `forEach`/`count`/`ChangedQuery.forEach`
	 * bind the returned array once and walk it; an in-place `dst.length = 0` +
	 * re-push would corrupt that walk if the query is re-entrantly iterated —
	 * i.e. the callback runs an immediate-mode mutation that crosses a
	 * 0↔non-zero entity boundary on the *same* Query (bumping the epoch) and
	 * then re-enters here via a nested `forEach`/`count`. Building fresh hands
	 * the inner call its own array and leaves the outer iterator's snapshot
	 * intact, so each archetype is visited exactly once. Cost is one array
	 * allocation per epoch advance (rare — only on boundary crossings); the
	 * steady-state path returns the cached array with zero allocation. In-system
	 * iteration never triggers a rebuild mid-loop: deferred mutations settle the
	 * epoch during `flushStructural`, between systems. */
	public _nonEmpty(): Archetype[] {
		const epoch = this._resolver._getQueryDirtyEpoch();
		if (this._lastSeenEpoch !== epoch) this._rebuildNonEmpty(epoch);
		return this._nonEmptyArchetypes;
	}

	/** @internal — cold rebuild path for `_nonEmpty`, split out (#649) so the
	 * hot `_nonEmpty` body is just an epoch check + cached return. Keeping the
	 * filter loops here shrinks `_nonEmpty`'s inlined bytecode footprint, which
	 * matters when several composed queries iterate inside one hot function (the
	 * `query_compose` shape): the leaner `_nonEmpty` keeps `forEach` under V8's
	 * per-function cumulative inlining budget. */
	private _rebuildNonEmpty(epoch: number): void {
		const src = this._archetypes;
		const dst: Archetype[] = [];
		// Filter on the partition field directly, not the flag-dependent
		// `entityCount` getter (#577): a default query keeps archetypes with
		// ≥1 *enabled* row; an `includeDisabled` query keeps any with ≥1 row
		// (so an all-disabled archetype still iterates). Order-/flag-independent.
		if (this._includeDisabled) {
			for (let i = 0; i < src.length; i++) {
				if (src[i].totalCount > 0) dst.push(src[i]);
			}
		} else {
			for (let i = 0; i < src.length; i++) {
				if (src[i].enabledCount > 0) dst.push(src[i]);
			}
		}
		this._nonEmptyArchetypes = dst;
		this._lastSeenEpoch = epoch;
	}

	/** Require at least one of these components. */
	public anyOf(...comps: ComponentDef[]): Query<Defs> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this._id << 16) | cid) >>> 0;
			const cached = this._resolver._anyOfSingleCache.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._anyOfMiss(cid, key);
		}
		// Fold through the single-arg cached path (#594). Successive `anyOf` calls
		// union into one anyOf mask (single-arg copies the mask and adds the bit),
		// so `anyOf(A, B)` ≡ `anyOf(A).anyOf(B)` — "match at least one of {A,B}" —
		// and is now cached/stable instead of minting a query-id per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.anyOf(comps[i]);
		return q;
	}

	/** @internal — cold cache-miss path for single-arg `anyOf` (#649); see `_andMiss`. */
	private _anyOfMiss(cid: number, key: number): Query<Defs> {
		const newAnyOf = this._anyOf ? this._anyOf.copy() : new BitSet();
		newAnyOf.set(cid);
		const result = this._carryNondense(
			this._resolver._resolveQuery(this._include, this._exclude, newAnyOf, this._defs)
		) as Query<Defs>;
		this._resolver._anyOfSingleCache.set(key, result);
		return result;
	}

	/** Create a ChangedQuery that filters archetypes by change tick.
	 *
	 *  Granularity is **archetype**, not row: the `_changedTick[cid]` is
	 *  bumped per archetype on any write into that component's column
	 *  (`Archetype._changedTick` in archetype.ts). A 1-row write in a
	 *  1000-row archetype trips `forEach` on the whole archetype next tick.
	 *  Use cases that need row-level granularity should compare per-row
	 *  state explicitly inside the callback.
	 *
	 *  The returned ChangedQuery is composable (M6): `and`/`without`/`anyOf`/
	 *  `optional` refine it further, so `q.changed(Pos).without(Dead)` works — and
	 *  is the same set as `q.without(Dead).changed(Pos)`. */
	public changed(...defs: ComponentDef[]): ChangedQuery<Defs> {
		if (defs.length === 1) {
			const cid = defs[0].id;
			const key = ((this._id << 16) | cid) >>> 0;
			const cached = this._resolver._changedSingleCache.get(key);
			if (cached !== undefined) return cached as ChangedQuery<Defs>;
			return this._changedMiss(cid, key);
		}
		const ids: number[] = new Array(defs.length);
		for (let i = 0; i < defs.length; i++) ids[i] = defs[i].id;
		return new ChangedQuery(this, ids);
	}

	/** @internal — cold cache-miss path for single-arg `changed` (#649); see `_andMiss`. */
	private _changedMiss(cid: number, key: number): ChangedQuery<Defs> {
		const result = new ChangedQuery<Defs>(this, [cid]);
		this._resolver._changedSingleCache.set(key, result);
		return result;
	}

	/** @internal — reads lastRunTick from the resolver (ECS). */
	public _ctxLastRunTick(): number {
		return this._resolver._getLastRunTick();
	}
}

export class QueryBuilder {
	constructor(private readonly _resolver: QueryResolver) {}

	public with<T extends ComponentDef[]>(...defs: T): Query<T> {
		const mask = new BitSet();
		for (let i = 0; i < defs.length; i++) mask.set(defs[i].id);
		return this._resolver._resolveQuery(mask, null, null, defs);
	}
}

/**
 * Deferred structural-command facade (§ctx.commands — Bevy `Commands`).
 * Namespaces the deferred structural ops so the call site is self-documenting:
 * `ctx.commands.add(e, …)` is *always* deferred (applied at the phase flush),
 * ending the collision where `ecs.addComponent` (immediate) and the bare
 * `ctx.addComponent` (deferred) share a name with opposite timing. Takes
 * varargs callable bundles, so one shape — `commands.spawn(bundle(Pos,{x,y}), bundle(Vel,{vx:1}))`
 * — serves spawn and add. The legacy `ctx.addComponent`/etc. stay for now;
 * the intent is for `ctx.commands.*` to become the only deferred surface.
 */
export class Commands {
	constructor(private readonly store: Store) {}

	/** Spawn from bundles. Create is immediate (the id is returned now); the
	 *  component attaches are deferred to the phase flush — so until that flush the
	 *  entity exists in its empty/partial archetype and a query running later in
	 *  the same phase can observe it half-built. (Same semantics as
	 *  `ctx.createEntity` + `ctx.addComponent`; fully-deferred id-reservation
	 *  spawn, à la Bevy, is a separate follow-up.) */
	public spawn(...items: BundleOrDef[]): EntityID {
		const e = this.store.createEntity();
		if (__DEV__) this.store._trace?.commandQueued("spawn", e, null);
		for (let i = 0; i < items.length; i++) {
			const def = bundleDef(items[i]);
			if (__DEV__) accessCheck.checkAdd(def);
			this.store.addComponentDeferred(e, def, bundleValues(items[i]));
		}
		return e;
	}

	/** Attach bundles to an existing entity (deferred). */
	public add(entityId: EntityID, ...items: BundleOrDef[]): this {
		for (let i = 0; i < items.length; i++) {
			const def = bundleDef(items[i]);
			if (__DEV__) accessCheck.checkAdd(def);
			this.store.addComponentDeferred(entityId, def, bundleValues(items[i]));
			if (__DEV__) this.store._trace?.commandQueued("add", entityId, def.id);
		}
		return this;
	}

	/** Remove a component (deferred). */
	public remove(entityId: EntityID, def: ComponentDef): this {
		if (__DEV__) accessCheck.checkRemove(def);
		this.store.removeComponentDeferred(entityId, def);
		if (__DEV__) this.store._trace?.commandQueued("remove", entityId, def.id);
		return this;
	}

	/** Destroy an entity (deferred). */
	public despawn(entityId: EntityID): this {
		if (__DEV__) accessCheck.checkDestroy();
		this.store.destroyEntityDeferred(entityId);
		if (__DEV__) this.store._trace?.commandQueued("despawn", entityId, null);
		return this;
	}

	/** Disable an entity (deferred). */
	public disable(entityId: EntityID): this {
		this.store.disableEntityDeferred(entityId);
		if (__DEV__) this.store._trace?.commandQueued("disable", entityId, null);
		return this;
	}

	/** Re-enable an entity (deferred). */
	public enable(entityId: EntityID): this {
		this.store.enableEntityDeferred(entityId);
		if (__DEV__) this.store._trace?.commandQueued("enable", entityId, null);
		return this;
	}
}

export class SystemContext {
	public lastRunTick: number = 0;

	/** Deferred structural-command facade (§ctx.commands). */
	public readonly commands: Commands;

	/** Current ECS tick. Use this for write ticks in getColumn. */
	public get ecsTick(): number {
		return this.store._tick;
	}

	/** The world's frame-trace sink (ADR-0030), or `null`. Lets the schedule
	 * fire `systemStart`/`flush*` without reaching into the private store.
	 * Read only under `if (__DEV__)`; the seam is dead-code-eliminated in prod. */
	public get _trace(): FrameTraceSink | null {
		return this.store._trace;
	}

	constructor(private readonly store: Store) {
		this.commands = new Commands(store);
	}

	public createEntity(): EntityID {
		return this.store.createEntity();
	}

	public isAlive(entityId: EntityID): boolean {
		return this.store.isAlive(entityId);
	}

	public hasComponent(entityId: EntityID, def: ComponentDef): boolean {
		return this.store.hasComponent(entityId, def);
	}

	public getField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S
	): number {
		if (__DEV__) {
			accessCheck.checkRead(def);
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		return arch.readField(row, def.id, field);
	}

	public setField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		if (__DEV__) {
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		// `getColumn` (mutable) invokes `accessCheck.checkWrite` under __DEV__,
		// so setField doesn't need a separate check.
		const col = arch.getColumn(def, field, this.store._tick);
		col[row] = value;
		// Per-entity onSet: record the changed row for components with a dirty-list
		// observer (#531). Gated so the common no-onSet path pays nothing.
		if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
	}

	/** Read-modify-write one field: `updateField(e, Gold, "value", v => v - cost)`
	 * is the one-line form of the `getField` → compute → `setField` round trip.
	 * Returns the written value. Same access-check and observer semantics as the
	 * two calls it composes. */
	public updateField<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		field: string & keyof S,
		fn: (current: number) => number
	): number {
		const next = fn(this.getField(entityId, def, field));
		this.setField(entityId, def, field, next);
		return next;
	}

	/**
	 * Record an entity as changed for a component's per-entity `onSet` observer
	 * (#517 §1 / ADR-0013). The SoA write idiom — `const col = arch.getColumn(D,
	 * f, tick); col[i] = v` in a tight loop — bypasses the deferred buffer and the
	 * engine never sees the per-element writes, so a per-entity `onSet` consumer
	 * pushes the row here (the bench's winning `tick+list`: raw write + an int
	 * push, fired batched at the post-update detection point — never a per-element
	 * observable setter). No-op for components without a per-entity onSet observer.
	 * `setField` records automatically; this is for the hot `getColumn` loop.
	 */
	public markChanged(entityId: EntityID, def: ComponentDef): void {
		if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
	}

	/**
	 * Create a cached component reference for a single entity. Marks the
	 * component as changed (the mutable default — see `refRead` for the
	 * read-only variant to reach for when you are not mutating). See ref.ts.
	 */
	public ref<S extends ComponentSchema>(
		def: ComponentDef<S>,
		entityId: EntityID
	): ComponentRef<S> {
		if (__DEV__) {
			accessCheck.checkWrite(def);
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		arch._changedTick[def.id] = this.store._tick;
		// ! safe: columnGroups is populated for all components with fields in this archetype
		return createRef<S>(arch.columnGroups[def.id]!, row);
	}

	/**
	 * Create a cached read-only component reference for a single entity. Use
	 * this when you are not mutating. The returned `ReadonlyComponentRef<S>`
	 * is an *advisory* compile-time barrier (no `_changedTick` bump): the
	 * `readonly` typing blocks field writes at the type layer, but the
	 * underlying accessor shares its prototype with `ref()` and can still be
	 * written through a §10c-policed cast. See ref.ts.
	 */
	public refRead<S extends ComponentSchema>(
		def: ComponentDef<S>,
		entityId: EntityID
	): ReadonlyComponentRef<S> {
		if (__DEV__) {
			accessCheck.checkRead(def);
			if (!this.store.isAlive(entityId)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		}
		const arch = this.store.getEntityArchetype(entityId);
		const row = this.store.getEntityRow(entityId);
		// ! safe: columnGroups is populated for all components with fields in this archetype
		return createRef<S>(arch.columnGroups[def.id]!, row);
	}

	/** Buffer an entity for deferred destruction (applied at phase flush). */
	public destroyEntity(id: EntityID): this {
		if (__DEV__) accessCheck.checkDestroy();
		this.store.destroyEntityDeferred(id);
		return this;
	}

	public addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): this;
	public addComponent<S extends ComponentSchema>(
		entityId: EntityID,
		def: ComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public addComponent(
		entityId: EntityID,
		def: ComponentDef,
		values?: Record<string, number>
	): this {
		if (__DEV__) accessCheck.checkAdd(def);
		this.store.addComponentDeferred(entityId, def, values ?? EMPTY_VALUES);
		return this;
	}

	public removeComponent(entityId: EntityID, def: ComponentDef): this {
		if (__DEV__) accessCheck.checkRemove(def);
		this.store.removeComponentDeferred(entityId, def);
		return this;
	}

	// --- Entity enable/disable (#577) ---
	// Deferred to the phase flush: a toggle is an in-archetype row swap, which
	// would corrupt a `forEach` SoA loop iterating that archetype if applied
	// mid-system (it reorders the dense columns being read). `isDisabled` is an
	// immediate read. A disabled entity is excluded from default queries; opt back
	// in per query with `.includeDisabled()`.

	/** Buffer `entityId` to be disabled at the phase flush (idempotent). */
	public disable(entityId: EntityID): this {
		this.store.disableEntityDeferred(entityId);
		return this;
	}

	/** Buffer `entityId` to be re-enabled at the phase flush (idempotent). */
	public enable(entityId: EntityID): this {
		this.store.enableEntityDeferred(entityId);
		return this;
	}

	/** Whether `entityId` is currently disabled (immediate read). */
	public isDisabled(entityId: EntityID): boolean {
		return this.store.isDisabled(entityId);
	}

	// --- Sparse (out-of-identity) component operations (#468) ---
	// Immediate, not deferred: a sparse add/remove causes no archetype
	// transition and no row reallocation, so it's safe to apply mid-system —
	// it can't invalidate a *dense* query's iteration the way a structural
	// change would. Field reads/writes mirror `getField` / `setField`.
	//
	// Sharp edge of the immediacy: it is NOT safe during `forEachEntity` over
	// a query whose driving sparse term is the one being mutated — the immediate
	// add/remove edits the live key array under the walk (see `forEachEntity`).
	// Buffer such edits and apply after.
	//
	// Access-checked under `__DEV__` against the system's `sparseReads` /
	// `sparseWrites` declarations (#496): add/remove/set_field require a write
	// term, getField a read term (a write implies a read). `hasSparse` is
	// unchecked, mirroring `hasComponent`. Sparse ids live in their own id
	// space, so the check keys the dedicated sparse sets, never the dense ones.

	public addSparse(entityId: EntityID, def: SparseComponentDef<Record<string, never>>): this;
	public addSparse<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		values: CompleteFieldValues<S>
	): this;
	public addSparse(
		entityId: EntityID,
		def: SparseComponentDef,
		values?: Record<string, number>
	): this {
		if (__DEV__) accessCheck.checkSparseWrite(def);
		this.store.addSparse(entityId, def, values);
		return this;
	}

	public removeSparse(entityId: EntityID, def: SparseComponentDef): this {
		if (__DEV__) accessCheck.checkSparseWrite(def);
		this.store.removeSparse(entityId, def);
		return this;
	}

	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		return this.store.hasSparse(entityId, def);
	}

	public getSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S
	): number {
		if (__DEV__) accessCheck.checkSparseRead(def);
		return this.store.getSparseField(entityId, def, field);
	}

	public setSparseField<S extends ComponentSchema>(
		entityId: EntityID,
		def: SparseComponentDef<S>,
		field: string & keyof S,
		value: number
	): void {
		if (__DEV__) accessCheck.checkSparseWrite(def);
		this.store.setSparseField(entityId, def, field, value);
	}

	// --- Relations (sparse (relation, target) pairs, #471) ---
	// Immediate like the sparse ops — no archetype transition, safe mid-system.
	// Registration is host-side (`ECS.registerRelation`), so it is not mirrored
	// here; systems add/remove/query pairs.
	//
	// Access-checked under `__DEV__` against `relationReads` / `relationWrites`
	// (#496): add/remove require a write term, target_of/targets_of/sources_of a
	// read term (write implies read). `hasRelation` is unchecked, mirroring
	// `hasComponent`. Relation ids are their own id space — the check keys the
	// dedicated relation sets.

	/** Add a `(R, tgt)` pair to `src` (exclusive replaces, multi adds). */
	public addRelation(src: EntityID, def: RelationDef, tgt: EntityID): this {
		if (__DEV__) accessCheck.checkRelationWrite(def);
		this.store.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`; for multi, omitting `tgt` removes all. */
	public removeRelation(src: EntityID, def: RelationDef, tgt?: EntityID): this {
		if (__DEV__) accessCheck.checkRelationWrite(def);
		this.store.removeRelation(src, def, tgt);
		return this;
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf(src: EntityID, def: RelationDef): EntityID | undefined {
		if (__DEV__) accessCheck.checkRelationRead(def);
		return this.store.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		if (__DEV__) accessCheck.checkRelationRead(def);
		return this.store.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id. */
	public sourcesOf(def: RelationDef, tgt: EntityID): EntityID[] {
		if (__DEV__) accessCheck.checkRelationRead(def);
		return this.store.sourcesOf(def, tgt);
	}

	/** Whether `src` holds any pair under `R`. */
	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this.store.hasRelation(src, def);
	}

	/** Flush all deferred changes: structural (add/remove) first, then
	 *  destructions. Republishes archetype row counts into the SAB
	 *  descriptor at the end so any WASM scan running in the next phase
	 *  sees fresh `row_count` fields. This is one of two publish sites —
	 *  `ECS.update()` also republishes once at tick start (see PATTERNS.md
	 *  §60), covering host-side mutations between updates. The publish walks
	 *  descriptors only — it doesn't touch column data — and benches at
	 *  sub-microsecond per archetype, so paying it once per phase boundary
	 *  is materially cheaper than the pre-#306 pattern of paying it per
	 *  WASM-using system per tick. After #336 the descriptor walk is gated
	 *  on a dirty flag, so read-only phases skip the walk entirely. */
	public flush(): void {
		this.store.flushStructural();
		this.store.flushDestroyed();
		this.store.publishRowCountsToDescriptor();
	}

	// =======================================================
	// Events
	// =======================================================

	public emit(key: SignalKey): void;
	public emit<S extends EventSchema>(key: EventKey<S>, values: S): void;
	public emit(key: EventKey, values?: Record<string, number>): void {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordEmit(key.description ?? "");
		}
		if (__DEV__) this.store._trace?.eventEmitted(key.description ?? "");
		const def = this.store.getEventDefByKey(key);
		if (values === undefined) {
			this.store.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			this.store.emitEvent(def, values);
		}
	}

	public read<S extends EventSchema>(key: EventKey<S>): EventReader<S> {
		if (__DEV__ && dispatchTrace.isActive()) {
			dispatchTrace.recordRead(key.description ?? "");
		}
		const def = this.store.getEventDefByKey(key);
		const reader = this.store.getEventReader(def) as EventReader<S>;
		if (__DEV__) this.store._trace?.eventRead(key.description ?? "", reader.length);
		return reader;
	}

	// =======================================================
	// Resources
	// =======================================================

	public resource<T>(key: ResourceKey<T>): T {
		if (__DEV__) {
			accessCheck.checkResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<T>(this.store.getResource(key));
	}

	public setResource<T>(key: ResourceKey<T>, value: T): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this.store.setResource(key, value);
	}

	/** Drop a resource mid-tick (#798). A lifecycle mutation, so it is access-
	 * checked as a *write* — the system must declare the key in `resourceWrites`,
	 * which serialises it against readers/writers of the same resource. Fails
	 * closed on a missing key. */
	public removeResource<T>(key: ResourceKey<T>): void {
		if (__DEV__) {
			accessCheck.checkResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this.store.removeResource(key);
	}

	public hasResource<T>(key: ResourceKey<T>): boolean {
		return this.store.hasResource(key);
	}
}

export class ChangedQuery<Defs extends readonly ComponentDef[]> {
	private readonly _query: Query<Defs>;
	private readonly _changedIds: number[];

	constructor(query: Query<Defs>, changedIds: number[]) {
		this._query = query;
		this._changedIds = changedIds;
		if (__DEV__) {
			for (let i = 0; i < changedIds.length; i++) {
				if (!query._include.has(changedIds[i])) {
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`changed() component ${changedIds[i]} is not in query's include mask`
					);
				}
			}
		}
	}

	// --- Composition (M6) — a ChangedQuery is a chainable filter, not a dead end.
	// Each verb refines the UNDERLYING query and re-wraps, so the dense mask and
	// query-cache identity are reused (the base derive is cached, #649); only the
	// thin wrapper is freshly allocated. `_changedIds` carry through unchanged and
	// stay ⊆ the include mask (which only ever grows, via `and`), so the
	// constructor's dev guard always still holds. Same set result as refining
	// before `changed()` — `q.changed(P).without(D)` ≡ `q.without(D).changed(P)` —
	// but it no longer matters which order you write it.

	/** Also require these components (mirrors `Query.and`). */
	public and<D extends ComponentDef[]>(...comps: D): ChangedQuery<[...Defs, ...D]> {
		return new ChangedQuery(this._query.and(...comps), this._changedIds);
	}

	/** Exclude archetypes holding any of these (mirrors `Query.without`). */
	public without(...comps: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.without(...comps), this._changedIds);
	}

	/** Require at least one of these (mirrors `Query.anyOf`). */
	public anyOf(...comps: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.anyOf(...comps), this._changedIds);
	}

	/** Permit optional-component data access in the loop (mirrors `Query.optional`). */
	public optional(...defs: ComponentDef[]): ChangedQuery<Defs> {
		return new ChangedQuery(this._query.optional(...defs), this._changedIds);
	}

	public forEach(cb: (arch: ArchetypeView) => void): void {
		// Mirror Query.forEach's include-disabled handling (#577): publish the
		// all-rows flag so the SoA loop's `arch.entityCount` spans disabled rows.
		// Cold branch split out (#649) to keep the flag dance off the inlined hot body.
		if (this._query._includeDisabled) {
			this._forEachIncludeDisabled(cb);
			return;
		}
		// Default path: inline `_forEachInner`'s body rather than delegate (#608),
		// for the same reason as `Query.forEach` — this is a megamorphic call site
		// V8 will not inline through, so the delegate hop is a real per-call cost.
		// Keep byte-identical to `_forEachInner`; do NOT re-introduce the hop.
		const lastTick = this._query._ctxLastRunTick();
		const archs = this._query._nonEmpty();
		const ids = this._changedIds;
		if (__DEV__) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does — otherwise
			// `getOptionalColumnRead` falls into `checkOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here (#594 Task 1).
			// Dev-only; prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query._optional);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch._changedTick[ids[j]] >= lastTick) {
							cb(arch);
							break;
						}
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			for (let j = 0; j < ids.length; j++) {
				if (arch._changedTick[ids[j]] >= lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}

	/** @internal — cold `includeDisabled` wrapper (#577), split out of `forEach`
	 * (#649) so the all-rows flag dance stays out of the inlined hot body. */
	private _forEachIncludeDisabled(cb: (arch: ArchetypeView) => void): void {
		const prev = _setIterAllRows(true);
		try {
			this._forEachInner(cb);
		} finally {
			_setIterAllRows(prev);
		}
	}

	/** @internal — the `includeDisabled` delegate for `forEach` (#577). The
	 * default path inlines this body directly into `forEach` (#608) to dodge a
	 * megamorphic delegate hop; this copy survives only for the rare all-rows
	 * path, which needs the `_setIterAllRows` try/finally wrap. */
	private _forEachInner(cb: (arch: ArchetypeView) => void): void {
		const lastTick = this._query._ctxLastRunTick();
		const archs = this._query._nonEmpty();
		const ids = this._changedIds;
		if (__DEV__) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does — otherwise
			// `getOptionalColumnRead` falls into `checkOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here (#594 Task 1).
			// Dev-only; prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query._optional);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch._changedTick[ids[j]] >= lastTick) {
							cb(arch);
							break;
						}
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		for (let i = 0; i < archs.length; i++) {
			const arch = archs[i];
			for (let j = 0; j < ids.length; j++) {
				if (arch._changedTick[ids[j]] >= lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}
}
