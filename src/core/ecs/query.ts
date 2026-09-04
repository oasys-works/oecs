/***
 * Query, QueryBuilder, SystemContext. System-facing ECS interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. Iterate with forEach(), which yields non-empty
 * archetypes. Use arch.getColumnRead() to access SoA columns, then
 * write the inner loop over arch.entityCount.
 *
 * QueryBuilder is the entry point for creating queries inside
 * registerSystem(fn, qb => qb.with(Pos, Vel)).
 *
 * SystemContext wraps Store for use inside system functions, exposing
 * only deferred operations (add and remove component, destroy entity) that
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
 *       // reads only. Mutate via ctx.ref / ctx.setField (bumps change tick)
 *       sum += px[i] + py[i] + vx[i] + vy[i];
 *     }
 *   });
 *
 * Queries compose via chaining:
 *
 *   q.and(Energy)           extend required components
 *   q.without(Frozen)       exclude archetypes with Frozen
 *   q.anyOf(Sprite, Mesh)   require at least one of these
 *   q.optional(Vel)         fetch Vel if present. Still iterate without it
 *
 * An optional term (Bevy `Option<&T>` / flecs `?`) does not narrow the
 * matched set. It stays at the required terms, spanning archetypes with and
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
import { entityNotAliveError } from "./entity";
import { componentLabel } from "./debug_names";
import type {
	ComponentDef,
	ComponentHandle,
	ComponentID,
	MutableColumnsForSchema,
	ColumnsForSchema,
	AttachValuesArg,
	BundleOrDef,
	SchemaOf,
	FieldValues,
	DeclaredQueryTerm
} from "./component";
import { bundleDef, bundleValues } from "./component";
import type { SparseComponentDef, SparseComponentID, SparseSchemaOf } from "./sparse_store";
import type { RelationDef } from "./relation";
import type {
	SystemAccess,
	DeclaredRead,
	DeclaredWrite,
	DeclaredAdd,
	DeclaredRemove,
	DeclaredSparseRead,
	DeclaredSparseWrite,
	DeclaredRelationRead,
	DeclaredRelationWrite,
	DeclaredResourceRead,
	DeclaredResourceWrite,
	DespawnArg
} from "./system";
import {
	createCursor,
	createRef,
	createSparseCursor,
	type ComponentCursor,
	type ComponentRef,
	type ReadonlyComponentCursor,
	type ReadonlyComponentRef
} from "./ref";
import type {
	EmptyEventSchema,
	EventDef,
	EventKey,
	EventReader,
	EventShape,
	SignalKey
} from "./event";
import type { ResourceKey, ResourceValueOf } from "./resource";
import { BitSet, unsafeCast } from "../../type_primitives";
import { bucketPush } from "./utils/arrays";
import { ECSError, ECS_ERROR } from "./utils/error";
import { dispatchTrace } from "./dispatch_trace";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

/** The query-driver seam on `Store`, the typed contract behind the
 * underscore members `ecs.ts` and the query internals reach. `Store`
 * implements this. When the cache and driver layer is extracted the
 * interface retargets at the collaborator without touching consumers.
 * `tick` / `trace` are deliberately mutable: `ECS.update()` sets the frame
 * tick and `ECS.setTrace` installs the sink through this seam. */
export interface QueryHost {
	/** Frame tick, set by `ECS.update()` each frame. `ctx.ecsTick` reads it. */
	tick: number;
	/** Change tick, the stamp every write makes. Advanced before each system
	 * run, so a consumer can order a write against its own last run. */
	readonly changeTick: number;
	/** Advance the change tick and return the new value. The schedule calls
	 * it before each system run and before each phase flush. */
	advanceChangeTick(): number;
	/** Dev-only frame-trace sink (`ECS.setTrace`); always null in prod. */
	trace: FrameTraceSink | null;
	/** True once any component observer opted into per-entity dirty tracking,
	 * gates `noteSet` at every write site. */
	readonly anyDirtyTracked: boolean;
	/** Bumped when an archetype crosses empty↔non-empty, cached query
	 * archetype lists rebuild when their observed epoch is stale. */
	readonly queryDirtyEpoch: number;
	/** Record a row for the entity-level onSet of `cid` from a path that has
	 * resolved the archetype and the row (gated by `anyDirtyTracked` at the
	 * call site). */
	noteSet(cid: number, arch: Archetype, row: number, eid: EntityID): void;
	/** `noteSet` for a caller that holds the entity alone (`markChanged`). */
	noteSetEntity(def: ComponentHandle, eid: EntityID): void;
	/** A chunk loop took the row tick column of `cid` (`cols.ticks`). */
	noteScan(cid: number): void;
	/** Dev-only: buffered event count across dirty channels (mid-update emit
	 * detection in `ECS.update()`). */
	readonly devBufferedEventCount: number;
	/** Second query-match path: sparse-term intersection. */
	forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includesDisabled: boolean
	): void;
	/** Third query-match path: the `(*, T)` wildcard. */
	forEachTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		includesDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void;
	/** Fourth query-match path: hierarchy depth ordering. */
	forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		includesDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void;
}

export interface QueryCacheEntry {
	includeMask: BitSet;
	excludeMask: BitSet | null;
	anyOfMask: BitSet | null;
	query: Query<any>; // any: heterogeneous cache, different queries have different Defs tuples
}

/** One owner for every query-resolution cache. Previously the dedup
 * bucket map lived on `ECS` while `Query` populated eleven composition maps
 * declared on the resolver interface, ownership split across two modules.
 * All entries are structural (a query is minted once per unique term set and
 * lives for the world's lifetime. Components and queries are never
 * unregistered), so there is no invalidation lifecycle, the maps are
 * append-only. Key encodings are unchanged from the pre-extraction fields.
 *
 * The composition maps are exposed as readonly fields (not per-kind accessor
 * pairs): the mutation protocol is uniform (`get` → miss → build → `set`) and
 * hot enough that composition sites keep direct map access. The invariant
 * this class carries is single ownership, not access mediation. */
export class QueryCache {
	// Query deduplication: hash(include, exclude, anyOf) → bucket of cache
	// entries. Multiple term sets can share a hash (collision), so each bucket
	// is an array. `findDedup` equality-checks masks within the bucket.
	private readonly _dedup = new Map<number, QueryCacheEntry[]>();

	// Shared single-component composition caches. One Map per direction
	// keyed by (parent_query_id << 16) | cid, replacing four nullable Maps per
	// Query. Drops the per-Query Map footprint from O(#queries × 4) to O(4).
	public readonly andSingle: Map<number, Query<any>> = new Map();
	public readonly withoutSingle: Map<number, Query<any>> = new Map();
	public readonly anyOfSingle: Map<number, Query<any>> = new Map();
	public readonly changedSingle: Map<number, ChangedQuery<any>> = new Map();
	// Optional fetch-if-present composition cache, dense cid keying,
	// same shape as the dense single caches above.
	public readonly optionalSingle: Map<number, Query<any>> = new Map();
	// Sparse-membership composition caches, same (parent_id << 16) | id
	// keying, the id is a SparseComponentID (a separate id space), so these
	// never collide with the dense maps.
	public readonly withSparseSingle: Map<number, Query<any>> = new Map();
	public readonly withoutSparseSingle: Map<number, Query<any>> = new Map();
	// Relation-wildcard `(R, *)` composition caches, keyed
	// (parent_id << 16) | relation_id, a separate Map from the sparse caches
	// because a `withRelation(R)` query also carries the relation id for its
	// `relationReads` access check.
	public readonly withRelationSingle: Map<number, Query<any>> = new Map();
	public readonly withoutRelationSingle: Map<number, Query<any>> = new Map();
	// Include-disabled composition cache, keyed by parent query id so
	// `q.includeDisabled()` returns a stable instance on repeated calls.
	public readonly includeDisabledSingle: Map<number, Query<any>> = new Map();
	// Hierarchy depth-ordering composition cache, keyed
	// (parent_id << 16) | relation_id. Only the unbounded form is cached, a
	// `maxDepth`-limited term adds a third key dimension and is the rarer
	// shape, so it mints fresh (hierarchy queries are built at registration,
	// not per tick).
	public readonly hierarchySingle: Map<number, Query<any>> = new Map();

	/** Dedup lookup: bucket scan with full mask equality (buckets are
	 * typically 1 or 2 entries). */
	public findDedup(
		key: number,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null
	): QueryCacheEntry | undefined {
		const bucket = this._dedup.get(key);
		if (!bucket) return undefined;
		for (let i = 0; i < bucket.length; i++) {
			const e = bucket[i];
			if (!e.includeMask.equals(include)) continue;
			const excOk =
				exclude === null
					? e.excludeMask === null
					: e.excludeMask !== null && e.excludeMask.equals(exclude);
			if (!excOk) continue;
			const anyOk =
				anyOf === null
					? e.anyOfMask === null
					: e.anyOfMask !== null && e.anyOfMask.equals(anyOf);
			if (!anyOk) continue;
			return e;
		}
		return undefined;
	}

	/** Record a freshly minted query under its dedup key. */
	public addDedup(key: number, entry: QueryCacheEntry): void {
		bucketPush(this._dedup, key, entry);
	}
}

export interface QueryResolver {
	resolveQuery(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		defs: readonly ComponentDef[]
	): Query<any>; // any: heterogeneous cache, callers downcast to their specific Query<Defs>
	getLastRunTick(): number;
	/** The change tick, the stamp `forEachChunk` makes via `cols.mut`. */
	getChangeTick(): number;
	/** A chunk loop took the row tick column of `cid` (`cols.ticks`), so the
	 * entity-level onSet drain scans the plane this frame. */
	noteScan(cid: number): void;
	getQueryDirtyEpoch(): number;
	nextQueryId(): number;
	/** All query-resolution caches, dedup + composition. One owner. See
	 * `QueryCache` for the per-map keying and id-space notes. */
	readonly caches: QueryCache;
	/** Second query-match path: drive iteration by sparse
	 * membership rather than the archetype mask, yielding entities, sparse
	 * members are scattered across archetypes, so there is no archetype-column
	 * span to hand back. With a sparse require term, drive from the smallest
	 * required store and filter. With only sparse excludes, drive the dense
	 * archetype list and skip excluded rows. With neither, walk dense entities.
	 * Only entered via `Query.forEachEntity`, so dense `forEach` never pays.
	 * `includeDisabled` widens the per-archetype row scan from enabled rows to
	 * all rows. */
	forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void,
		includesDisabled: boolean
	): void;
	/** Backing sparse id of a relation, resolves a `(R, *)` wildcard term
	 * (`withRelation`) to the membership store the sparse-match path
	 * already drives. */
	relationBackingSparseId(def: RelationDef): SparseComponentID;
	/** Third query-match path: `(*, T)`, drive iteration from the union of
	 * every relation's `sourcesOf(target)` (dedup + canonical sort), intersected
	 * with the dense mask + sparse terms + the enabled-row filter. Only entered via
	 * `Query.forEachRelatedTo`. */
	forEachTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		includesDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void;
	/** Fourth query-match path: yield the matched entities (dense mask +
	 * sparse terms + enabled-row filter, exactly the `forEachSparseMatch`
	 * intersection) in canonical **hierarchy depth order** over exclusive relation
	 * `relation`, depth ascending (parents before children), entity index
	 * ascending within a depth band. Entities deeper than `maxDepth` are skipped
	 * (`HIERARCHY_UNBOUNDED` = no limit). Only entered via `Query.forEachEntity`
	 * on a query carrying a `.hierarchy(R)` term. */
	forEachHierarchyMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		includesDisabled: boolean,
		cb: (entityId: EntityID) => void
	): void;
}

// Frozen empty sparse-term list, shared by every dense-only Query so the
// common path allocates no per-query arrays.
const NO_SPARSE_TERMS: readonly SparseComponentID[] = Object.freeze([]);

// Frozen empty optional-term list, shared by every Query without an optional
// fetch term, same zero-alloc rationale as NO_SPARSE_TERMS.
const NO_OPTIONAL_TERMS: readonly ComponentID[] = Object.freeze([]);

// Frozen empty relation-wildcard-term list, shared by every Query without a
// `(R, *)` term, same zero-alloc rationale. These lists exist only for the
// `DEV` `relationReads` access check (`_assertRelationAccess`); the driver
// reads the relation's backing sparse id off `sparseIncludes`, never this.
const NO_RELATION_TERMS: readonly RelationDef[] = Object.freeze([]);

/** No depth limit on a `.hierarchy(R)` term, yield every matched entity
 * regardless of its depth in the tree. The default `maxDepth`. */
export const HIERARCHY_UNBOUNDED = Number.POSITIVE_INFINITY;

/** A `.hierarchy(R)` depth-ordering term. Records the exclusive relation
 * whose tree defines the order and the (optional) max depth to yield. Stored on
 * the Query and consumed by the `forEachEntity` hierarchy match path. Absent
 * (`null`) for the common case. */
export interface HierarchyTerm {
	/** The exclusive relation whose chain and tree defines the depth ordering. */
	readonly relation: RelationDef;
	/** Inclusive max depth to yield (root = 0); entities deeper than this are
	 * skipped. `HIERARCHY_UNBOUNDED` for no limit (bitECS `Hierarchy()` depth arg). */
	readonly maxDepth: number;
}

// The single-term sparse caches key on `(queryId << 16) | sparseId`, which
// is injective only while both halves fit 16 bits. Dense component ids are
// hard-capped at 128, but sparse ids are deliberately uncapped (they escape the
// 128 identity cap) and the query-id counter is unbounded, so nothing
// structurally guarantees the bound the packing assumes. Assert it in `DEV`
// so an overflow surfaces as a loud error at the (astronomically unlikely) pack
// site rather than a silent wrong-cache-hit. 2^16 = 65536 distinct sparse
// components or live queries in one ECS is the trigger. Realistic counts are
// in the tens. The dense caches share the same packing and the same (smaller,
// since cid <= 128) latent risk on the query-id half.
const CACHE_KEY_HALF_LIMIT = 0x10000;
function termCacheKey(queryId: number, sparseId: number): number {
	if (DEV && (queryId >= CACHE_KEY_HALF_LIMIT || sparseId >= CACHE_KEY_HALF_LIMIT)) {
		throw new ECSError(
			ECS_ERROR.SPARSE_CACHE_KEY_OVERFLOW,
			`sparse query cache key would overflow: queryId=${queryId}, sparseId=${sparseId} (each must be < ${CACHE_KEY_HALF_LIMIT})`
		);
	}
	return ((queryId << 16) | sparseId) >>> 0;
}

// Append a sparse id to a term list, de-duplicating. Returns the same list
// (no allocation) when the id is already present, so `q.withSparse(R)`
// twice resolves to the identical term set. Term lists are tiny (a query has
// a handful of sparse terms at most), so the linear scan is free.
function appendSparse(
	terms: readonly SparseComponentID[],
	id: number
): readonly SparseComponentID[] {
	for (let i = 0; i < terms.length; i++) {
		if ((terms[i] as number) === id) return terms;
	}
	return [...terms, id as SparseComponentID];
}

// Append a dense component id to an optional-term list, de-duplicating.
// Same shape as `appendSparse` but in the dense ComponentID space. The lists
// are tiny so the linear scan is free.
function appendOptional(terms: readonly ComponentID[], id: number): readonly ComponentID[] {
	for (let i = 0; i < terms.length; i++) {
		if ((terms[i] as number) === id) return terms;
	}
	return [...terms, id as ComponentID];
}

// Append a relation id to a `(R, *)` access-term list, de-duplicating.
// Same shape as `appendSparse`. Tiny lists, free linear scan.
function appendRelation(terms: readonly RelationDef[], def: RelationDef): readonly RelationDef[] {
	for (let i = 0; i < terms.length; i++) {
		if ((terms[i] as number) === (def as number)) return terms;
	}
	return [...terms, def];
}

/**
 * forEachChunk cursor. One instance is allocated per `forEachChunk`
 * pass and reused across every matched archetype in that pass, only `arch`/
 * `tick` are re-pointed per archetype, so the inner loop allocates nothing.
 * Per-call (not cached on the query) so a nested `forEachChunk` on the same query
 * gets its own cursor and can't re-point an outer pass's position. `.mut(def)` /
 * `.read(def)` resolve a whole component's columns at once into a field-keyed
 * object (a per-archetype-per-component cache refreshed in place), hiding the
 * change tick. Destructure the group immediately. Don't retain it across calls.
 */
export class ChunkColumns<out Defs extends readonly ComponentDef<any>[] = readonly ComponentDef<any>[]> {
	/** @internal */ arch!: Archetype
	/** The change tick this pass stamps. Store it into a row of `ticks(def)`
	 * to record that row for an entity-level `onSet`. */
	tick = 0;
	/** The change tick of the previous run of the system this pass runs in,
	 * and 0 on its first run or on the host. A row of `ticksRead(def)` above it
	 * changed since that run. */
	since = 0;
	/** @internal */ resolver!: QueryResolver;

	/** Mutable column group, `const { x, y } = cols.mut(Pos)`. Stamps the tick.
	 * `def` must be a term of the iterating query. */
	public mut<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): MutableColumnsForSchema<SchemaOf<D>> {
		return this.arch.columnGroupMut(def, this.tick);
	}

	/** Read-only column group, `const { vx, vy } = cols.read(Vel)`. No tick bump.
	 * `def` must be a term of the iterating query. */
	public read<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): ColumnsForSchema<SchemaOf<D>> {
		return this.arch.columnGroupRead(def);
	}

	/** The row tick column of `def` for this archetype, the record a raw column
	 * loop makes for an entity-level `onSet`: `t[i] = cols.tick` beside the
	 * write of row `i`. One typed-array store per row, where `ctx.markChanged`
	 * is a call and a list push. Taking the column marks the archetype changed
	 * and asks the drain of this frame to scan every archetype of `def` that a
	 * writer stamped, so take it only in a loop that stores into it. Throws
	 * when no entity-level `onSet` observer tracks `def`, because the column
	 * exists for tracked components only. `def` must be a term of the
	 * iterating query. */
	public ticks<D extends ComponentDef<any>>(def: D & DeclaredQueryTerm<Defs, D>): Uint32Array {
		const arch = this.arch;
		const cid = def.id as number;
		const t = arch.rowTicks[cid];
		if (t === undefined) throw rowTicksNotTrackedError("cols.ticks", def, cid);
		if (DEV) accessCheck.assertWrite(def);
		arch.changedTick[cid] = this.tick;
		this.resolver.noteScan(cid);
		return t;
	}

	/** The row tick column of `def` for this archetype, read-only: the row
	 * grain of change detection. A row `i` with `t[i] > cols.since` changed
	 * since the previous run of this system, through any write path that
	 * records (`setField`, `ref`, a cursor, `markChanged`, or a store into
	 * `ticks(def)`). No stamp, no scan request. Throws when `def` has no row
	 * ticks: `ecs.trackRows(def)` turns them on. `def` must be a term of the
	 * iterating query. */
	public ticksRead<D extends ComponentDef<any>>(
		def: D & DeclaredQueryTerm<Defs, D>
	): Readonly<Uint32Array> {
		const arch = this.arch;
		const cid = def.id as number;
		const t = arch.rowTicks[cid];
		if (t === undefined) throw rowTicksNotTrackedError("cols.ticksRead", def, cid);
		if (DEV) accessCheck.assertRead(def);
		return t;
	}
}

function rowTicksNotTrackedError(op: string, def: ComponentDef<any>, cid: number): ECSError {
	return new ECSError(
		ECS_ERROR.ROW_TICKS_NOT_TRACKED,
		`${op}: ${componentLabel(def)} has no row ticks. Call ecs.trackRows(def), or register an onSet observer with granularity "entity", before the loop`,
		{ component: cid }
	);
}

export class Query<Defs extends readonly ComponentDef[]> {
	private readonly _archetypes: Archetype[];
	// Public-readonly (consistent with `include` / `id` below) so a run
	// condition built via `runIfAnyMatch(query)` can declare the query's
	// component defs as its read surface. Not part of the documented API.
	public readonly defs: Defs;
	private readonly _resolver: QueryResolver;
	public readonly include: BitSet;
	private readonly _exclude: BitSet | null;
	private readonly _anyOf: BitSet | null;
	private _nonEmptyArchetypes: Archetype[] = [];
	// Epoch counter rather than a dirty bit. The Store bumps its
	// `_queryDirtyEpoch` on every membership change. This query rebuilds
	// when its observed epoch is stale. Lets `Store._mark_queries_dirty`
	// coalesce O(num_queries) walks into a single increment, startup that
	// does N immediate `addComponent` calls used to write N×Q dirty bits,
	// now writes N integers.
	private _lastSeenEpoch: number = -1;
	// Stable id minted by the resolver. Combined with a component id into
	// (id << 16) | cid to key the resolver's shared single-component caches.
	public readonly id: number;
	// Sparse-membership terms. Empty for a dense-only query (the common
	// case), in which they share the frozen NO_SPARSE_TERMS singleton and the
	// sparse match path is never consulted. `withSparse` / `withoutSparse`
	// don't touch the dense mask, so a derived query reuses the parent's live
	// `_archetypes` array, the store keeps pushing new archetypes into it, so
	// both queries stay live without a second `registerQuery`.
	public readonly sparseIncludes: readonly SparseComponentID[];
	public readonly sparseExcludes: readonly SparseComponentID[];
	// Optional fetch-if-present terms. Empty for the common case (shares
	// the frozen NO_OPTIONAL_TERMS singleton). An optional term does not narrow
	// the matched set. It leaves the dense mask untouched, so a derived query
	// reuses the parent's live `_archetypes` array (same as the sparse terms).
	// The term is *consumed*, not decorative: `forEach` publishes it as
	// the active optional scope, and `getOptionalColumnRead` rejects (in
	// `DEV`) a fetch of any component not listed here, so `.optional(T)` is
	// the declaration that authorizes the fetch, the read-side analog of
	// `reads:[T]`. It is carried symmetrically through `and`, `not` and `anyOf` (see
	// `_carryNondense`), so term order never drops it.
	public readonly optionalTerms: readonly ComponentID[];
	// Include-disabled opt-in. False by default, queries exclude disabled
	// entities (the archetype iteration bound `entityCount` is `enabled_count`).
	// `.includeDisabled()` derives a query with this true. It widens the
	// non-empty filter, `count`, and `forEachEntity` to span disabled rows, and
	// makes `forEach` publish the all-rows iteration flag so the SoA loop reads
	// `entityCount === length`. Like the sparse and optional terms it doesn't touch
	// the dense mask, so the derived query reuses the parent's live archetype list
	// and is carried through `and`, `not` and `anyOf` (`_carryNondense`).
	public readonly includesDisabled: boolean;
	// Relation-wildcard `(R, *)` terms. Empty for the common case (shares
	// the frozen NO_RELATION_TERMS singleton). `withRelation(R)` /
	// `withoutRelation(R)` push R's *backing sparse id* onto `sparseIncludes` /
	// `sparseExcludes` (so iteration reuses the sparse-match driver unchanged) and
	// record R here purely so `forEachEntity` / `forEachRelatedTo` can assert
	// `relationReads: [R]` under `DEV` (`_assertRelationAccess`). Carried
	// through `and`, `not` and `anyOf` like the sparse terms (`_carryNondense`).
	public readonly relationIncludes: readonly RelationDef[];
	public readonly relationExcludes: readonly RelationDef[];
	// Hierarchy depth-ordering term. `null` for the common case (no
	// ordering). A `.hierarchy(R)` term does not narrow the matched set or touch
	// the dense mask. It reorders the matched entities into depth order (parents
	// before children) and optionally drops those past `maxDepth`. So the derived
	// query reuses this one's live archetype list and is carried through
	// `and`, `not` or `anyOf` like the sparse or optional terms (`_carryNondense`). It
	// reaches the store only via `forEachEntity` (members scatter across
	// archetypes. There is no SoA span, so `forEach` rejects it, like a sparse
	// term); `accessCheck` validates `relationReads: [R]` at iteration time.
	public readonly hierarchyTerm: HierarchyTerm | null;

	constructor(
		archetypes: Archetype[],
		defs: Defs,
		resolver: QueryResolver,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		id: number,
		sparseIncludes: readonly SparseComponentID[] = NO_SPARSE_TERMS,
		sparseExcludes: readonly SparseComponentID[] = NO_SPARSE_TERMS,
		optionalTerms: readonly ComponentID[] = NO_OPTIONAL_TERMS,
		includesDisabled: boolean = false,
		relationIncludes: readonly RelationDef[] = NO_RELATION_TERMS,
		relationExcludes: readonly RelationDef[] = NO_RELATION_TERMS,
		hierarchyTerm: HierarchyTerm | null = null
	) {
		this._archetypes = archetypes;
		this.defs = defs;
		this._resolver = resolver;
		this.include = include;
		this._exclude = exclude;
		this._anyOf = anyOf;
		this.id = id;
		this.sparseIncludes = sparseIncludes;
		this.sparseExcludes = sparseExcludes;
		this.optionalTerms = optionalTerms;
		this.includesDisabled = includesDisabled;
		this.relationIncludes = relationIncludes;
		this.relationExcludes = relationExcludes;
		this.hierarchyTerm = hierarchyTerm;
	}

	/** Guard the dense-only methods (`count` / `forEach` / `archetype_count`)
	 * against a query carrying sparse terms. These walk the dense archetype
	 * list and never consult `sparseIncludes` / `sparseExcludes`, so on a
	 * sparse-derived query they'd **fail open**, returning the unfiltered dense
	 * result instead of the sparse-filtered one. Throw in `DEV` (compiled
	 * out of prod) steering the caller to `forEachEntity`, the only path that
	 * honors sparse membership. Mirrors `ChangedQuery`'s dev-guard on its
	 * include-mask invariant. */
	private _assertDenseOnly(method: string): void {
		if (
			this.sparseIncludes.length > 0 ||
			this.sparseExcludes.length > 0 ||
			this.relationIncludes.length > 0 ||
			this.relationExcludes.length > 0 ||
			this.hierarchyTerm !== null
		) {
			throw new ECSError(
				ECS_ERROR.SPARSE_QUERY_DENSE_PATH,
				`Query.${method} ignores sparse / relation-wildcard / hierarchy terms (withSparse / withoutSparse / withRelation / withoutRelation / hierarchy). It walks only the dense archetype list and would return the wrong result (a hierarchy term has no per-archetype span, its order spans archetypes). Iterate this query with forEachEntity instead.`
			);
		}
	}

	/** Whether this query carries only dense terms, the precondition for the
	 * archetype-walk fast paths (`entityCount`, `firstEntity`, `singleEntity`). */
	private _isDenseOnly(): boolean {
		return (
			this.sparseIncludes.length === 0 &&
			this.sparseExcludes.length === 0 &&
			this.relationIncludes.length === 0 &&
			this.relationExcludes.length === 0 &&
			this.hierarchyTerm === null
		);
	}

	/** First matching entity, or `undefined` when the query matches none, the
	 * singleton read (`player`, `camera`) without hand-rolling a forEach +
	 * closure capture. Dense-only queries answer from the
	 * first non-empty archetype in O(archetypes); queries with sparse /
	 * relation and hierarchy terms fall back to a full `forEachEntity` walk.
	 * "First" is iteration order, not spawn order, with more than one match
	 * the pick is arbitrary (use `singleEntity` to assert uniqueness). */
	public firstEntity(): EntityID | undefined {
		if (this._isDenseOnly()) {
			const archs = this.nonEmptyArchs();
			for (let i = 0; i < archs.length; i++) {
				const bound = this.includesDisabled ? archs[i].totalCount : archs[i].enabledCount;
				if (bound > 0) return archs[i].entityIds[0];
			}
			return undefined;
		}
		let found: EntityID | undefined;
		this.forEachEntity((e) => {
			if (found === undefined) found = e;
		});
		return found;
	}

	/** The query's one matching entity. Dev-throws `QUERY_NOT_SINGLETON` when
	 * the match count is 0 or >1, the singleton assertion for entities that
	 * must be unique (player, camera). Prod skips the count and returns the
	 * first match (`undefined` if none). */
	public singleEntity(): EntityID {
		if (DEV) {
			const n = this._isDenseOnly() ? this.entityCount : this._countViaWalk();
			if (n !== 1) {
				throw new ECSError(
					ECS_ERROR.QUERY_NOT_SINGLETON,
					`Query.singleEntity: expected exactly 1 matching entity, found ${n}`,
					{ count: n }
				);
			}
		}
		return this.firstEntity() as EntityID;
	}

	/** Count for non-dense queries, full `forEachEntity` walk. */
	private _countViaWalk(): number {
		let n = 0;
		this.forEachEntity(() => {
			n++;
		});
		return n;
	}

	/** Number of matching archetypes (including empty ones). */
	public get archetypeCount(): number {
		if (DEV) this._assertDenseOnly("archetypeCount");
		return this._archetypes.length;
	}

	/** Total entity count across all matching archetypes, enabled rows only by
	 * default, or all rows when `includeDisabled`. Reads the partition
	 * fields directly (not the archetype's flag-dependent `entityCount`
	 * getter). */
	public get entityCount(): number {
		if (DEV) this._assertDenseOnly("entityCount");
		const archs = this.nonEmptyArchs();
		let total = 0;
		if (this.includesDisabled) {
			for (let i = 0; i < archs.length; i++) total += archs[i].totalCount;
		} else {
			for (let i = 0; i < archs.length; i++) total += archs[i].enabledCount;
		}
		return total;
	}
	public get archetypes(): readonly ArchetypeView<Defs>[] {
		return this._archetypes;
	}

	/** Carry this query's non-dense terms, optional fetch-if-present and
	 * sparse membership, onto a freshly composed dense query. `and` /
	 * `not` / `anyOf` build the new dense mask via `resolveQuery`, which is
	 * keyed on the mask alone and so hands back a query carrying none of these
	 * terms. An earlier version silently dropped them, which made composition
	 * order-dependent (`q.optional(V).and(H)` lost `V`, `q.and(H).optional(V)`
	 * kept it). When this query carries no non-dense terms (the common case)
	 * `base` is already correct and returned as-is, preserving the mask-cached
	 * singleton with zero allocation. Otherwise re-derive on top of `base`'s dense
	 * state, threading the terms forward so composition is symmetric regardless of
	 * order. Reading `base`'s private fields is allowed, same-class instance. */
	private _carryNondense(base: Query<any>): Query<any> {
		if (
			this.optionalTerms.length === 0 &&
			this.sparseIncludes.length === 0 &&
			this.sparseExcludes.length === 0 &&
			!this.includesDisabled &&
			this.relationIncludes.length === 0 &&
			this.relationExcludes.length === 0 &&
			this.hierarchyTerm === null
		) {
			return base;
		}
		return new Query(
			base._archetypes,
			base.defs,
			this._resolver,
			base.include,
			base._exclude,
			base._anyOf,
			this._resolver.nextQueryId(),
			this.sparseIncludes,
			this.sparseExcludes,
			this.optionalTerms,
			this.includesDisabled,
			this.relationIncludes,
			this.relationExcludes,
			this.hierarchyTerm
		);
	}

	/** Extend required component set. Returns a new (cached) Query. */
	public and<D extends ComponentDef[]>(...comps: D): Query<[...Defs, ...D]> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.andSingle.get(key);
			if (cached !== undefined) return cached as Query<[...Defs, ...D]>;
			return this._andMiss(comps[0], cid, key) as Query<[...Defs, ...D]>;
		}
		// Multi-arg: fold through the single-arg cached path one id at a time, so
		// every prefix is cached and `and(A, B)` is the same instance as the chained
		// `and(A).and(B)`. Without the fold a receiver carrying non-dense terms
		// (optional and sparse) mints a fresh Query + query-id on every call via
		// `_carryNondense`, the GC-churn / query-id climb toward
		// `CACHE_KEY_HALF_LIMIT` already fixed for `withSparse`.
		let q: Query<any> = this;
		for (let i = 0; i < comps.length; i++) q = q.and(comps[i]);
		return q as Query<[...Defs, ...D]>;
	}

	/** @internal, cold cache-miss path for single-arg `and`, split out so
	 * the hot `and` body is only key-compute + cache hit. The miss path runs once
	 * per unique composition, then every repeat is a cache hit. Keeping it out of
	 * line shrinks `and`'s inlined footprint when several composes share one hot
	 * function (the `query_compose` shape). Same rationale for `_withoutMiss` /
	 * `_anyOfMiss` / `_changedMiss`. */
	private _andMiss(def: ComponentDef, cid: number, key: number): Query<any> {
		const newInclude = this.include.copy();
		const newDefs = this.defs.slice() as ComponentDef[];
		if (!newInclude.has(cid)) {
			newInclude.set(cid);
			newDefs.push(def);
		}
		const result = this._carryNondense(
			this._resolver.resolveQuery(newInclude, this._exclude, this._anyOf, newDefs)
		);
		this._resolver.caches.andSingle.set(key, result);
		return result;
	}

	/** Exclude archetypes that have any of these components. */
	public without(...comps: ComponentDef[]): Query<Defs> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.withoutSingle.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._withoutMiss(cid, key);
		}
		// Fold through the single-arg cached path, mirroring `and`, keeps the
		// result stable and avoids minting query-ids on a non-dense receiver.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.without(comps[i]);
		return q;
	}

	/** @internal, cold cache-miss path for single-arg `not`. See `_andMiss`. */
	private _withoutMiss(cid: number, key: number): Query<Defs> {
		const newExclude = this._exclude ? this._exclude.copy() : new BitSet();
		newExclude.set(cid);
		const result = this._carryNondense(
			this._resolver.resolveQuery(this.include, newExclude, this._anyOf, this.defs)
		) as Query<Defs>;
		this._resolver.caches.withoutSingle.set(key, result);
		return result;
	}

	/** Require a sparse component: match only entities that hold it,
	 * across every archetype. A sparse term doesn't touch the dense mask, so
	 * the returned (cached) query reuses this one's live archetype list. It is
	 * iterated via `forEachEntity`, never `forEach` (sparse members are
	 * scattered within archetypes, so there is no SoA column span to yield). */
	public withSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._withSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache one id at a time, so every
		// prefix is cached. A repeated `withSparse(A, B)` then returns the
		// identical Query, the multi-arg form used to bypass the cache and
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
		const key = termCacheKey(this.id, sid);
		const cache = this._resolver.caches.withSparseSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			appendSparse(this.sparseIncludes, sid),
			this.sparseExcludes
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude a sparse component: drop entities that hold it. Same
	 * dense-list reuse and `forEachEntity` iteration as `withSparse`. */
	public withoutSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._withoutSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache, same as `withSparse`.
		// Each prefix is cached, so a repeated `withoutSparse(A, B)`
		// returns the identical Query instead of allocating one per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withoutSparseOne(defs[i] as unknown as number);
		return q;
	}

	/** One-id `withoutSparse` composition, cached on `(parent_id, sparseId)`. The
	 * multi-arg form folds over this, mirrors `_withSparseOne`. */
	private _withoutSparseOne(sid: number): Query<Defs> {
		const key = termCacheKey(this.id, sid);
		const cache = this._resolver.caches.withoutSparseSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			this.sparseIncludes,
			appendSparse(this.sparseExcludes, sid)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new sparse terms. Reuses this query's
	 * dense state by reference, the masks are never mutated in place (`and` /
	 * `not` / `anyOf` copy before mutating), and `_archetypes` is the same
	 * live array the store appends to, so the derived query stays live too.
	 * Carries the existing `optionalTerms` terms through unchanged (the two axes
	 * compose). */
	private _deriveSparse(
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[]
	): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			sparseIncludes,
			sparseExcludes,
			this.optionalTerms,
			this.includesDisabled,
			this.relationIncludes,
			this.relationExcludes,
			this.hierarchyTerm
		);
	}

	/** Require the `(R, *)` wildcard: match only sources that hold **any**
	 * target under relation `R`. "Has any `(R, *)` pair" is exactly membership in
	 * R's backing sparse store (exclusive `{target}` row and multi tag), so this is a
	 * relation-typed front door over `withSparse`. It pushes R's backing sparse
	 * id onto `sparseIncludes` and reuses the `forEachEntity` sparse-match path
	 * (insertion order, canonical sorting is reserved for `stateHash`/snapshot, and
	 * costs much more here for no determinism benefit).
	 * Membership semantics: each source once. Fetch its targets with
	 * `ctx.targetsOf(e, R)`. Requires `relationReads: [R]` (checked at iteration).
	 * Cached per `(parent_id, relation_id)` like the sparse terms. */
	public withRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._withRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withRelationOne(defs[i]);
		return q;
	}

	private _withRelationOne(def: RelationDef): Query<Defs> {
		const key = termCacheKey(this.id, def as unknown as number);
		const cache = this._resolver.caches.withRelationSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver.relationBackingSparseId(def);
		const result = this._deriveRelation(
			appendSparse(this.sparseIncludes, sid as unknown as number),
			this.sparseExcludes,
			appendRelation(this.relationIncludes, def),
			this.relationExcludes
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude the `(R, *)` wildcard: drop sources that hold any target
	 * under `R`. Mirror of `withRelation` on the exclude side (pushes R's
	 * backing sparse id onto `sparseExcludes`). */
	public withoutRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._withoutRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._withoutRelationOne(defs[i]);
		return q;
	}

	private _withoutRelationOne(def: RelationDef): Query<Defs> {
		const key = termCacheKey(this.id, def as unknown as number);
		const cache = this._resolver.caches.withoutRelationSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver.relationBackingSparseId(def);
		const result = this._deriveRelation(
			this.sparseIncludes,
			appendSparse(this.sparseExcludes, sid as unknown as number),
			this.relationIncludes,
			appendRelation(this.relationExcludes, def)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new relation-wildcard terms. Threads the
	 * backing-sparse ids (which the driver actually consumes) plus the relation
	 * ids (which only the `DEV` access check consumes), reusing the dense /
	 * optional and disabled state by reference, same rationale as `_deriveSparse`. */
	private _deriveRelation(
		sparseIncludes: readonly SparseComponentID[],
		sparseExcludes: readonly SparseComponentID[],
		relationIncludes: readonly RelationDef[],
		relationExcludes: readonly RelationDef[]
	): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			sparseIncludes,
			sparseExcludes,
			this.optionalTerms,
			this.includesDisabled,
			relationIncludes,
			relationExcludes,
			this.hierarchyTerm
		);
	}

	/** Order this query's matched entities in **hierarchy depth order** over the
	 * exclusive relation `R`, parents before children, and (optionally) drop any
	 * deeper than `maxDepth` (flecs `cascade` / bitECS `Hierarchy()`). The
	 * matched *set* is unchanged (still the dense mask + sparse + `(R, *)` + disabled
	 * terms); `.hierarchy(R)` only **reorders** + depth-limits it, so an entity with
	 * no `R`-parent is a root at depth 0 and still yielded (first). The canonical
	 * order is depth ascending, then **entity index ascending within each depth
	 * band**, a total, insertion-order-independent order (identical across lockstep
	 * peers), produced by an O(K) radix on the entity index, never a comparator sort.
	 *
	 * Iterate with `forEachEntity`: members scatter across archetypes, so there is
	 * no SoA column span, `forEach` / `count` reject a hierarchy query (like a
	 * sparse term). **Exclusive relations only** (matches the traversal
	 * constraint); a multi relation throws `RELATION_MODE_MISMATCH` at iteration, and a
	 * cycle is a loud `RELATION_CYCLE` in `DEV` (a safe break in production).
	 * Requires `relationReads: [R]` (checked at iteration). Carried through
	 * `and`, `not` and `anyOf` like the sparse terms (`_carryNondense`).
	 *
	 * `Defs` is unchanged, `R` is an ordering, not a required component (like
	 * `not` / `anyOf`). Returns a new query. The unbounded form is cached. */
	public hierarchy(
		relation: RelationDef<"exclusive">,
		maxDepth: number = HIERARCHY_UNBOUNDED
	): Query<Defs> {
		if (DEV) {
			if (this.hierarchyTerm !== null) {
				throw new ECSError(
					ECS_ERROR.HIERARCHY_ALREADY_SET,
					`hierarchy() is already set on this query, a query carries a single depth ordering`
				);
			}
			// `maxDepth` is a depth (root = 0), so it must be `HIERARCHY_UNBOUNDED` or
			// a non-negative integer. Catch a caller typo (`-1` silently yields nothing
			// a fractional limit floors oddly in the `d > maxDepth` band test) loudly
			// here rather than as mystifying empty or odd output. Prod is a no-op.
			if (maxDepth !== HIERARCHY_UNBOUNDED && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
				throw new ECSError(
					ECS_ERROR.HIERARCHY_INVALID_MAX_DEPTH,
					`hierarchy() maxDepth must be HIERARCHY_UNBOUNDED or a non-negative integer, got ${maxDepth}`
				);
			}
		}
		// Cache only the unbounded form (the common case): a `maxDepth`-limited
		// term adds a third key dimension to the `(parent_id, relation_id)` packing,
		// and is the rarer shape, a hierarchy query is built once at system
		// registration (not per tick), so minting a bounded one fresh costs nothing.
		if (maxDepth === HIERARCHY_UNBOUNDED) {
			const key = termCacheKey(this.id, relation as unknown as number);
			const cache = this._resolver.caches.hierarchySingle;
			const cached = cache.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			const result = this._deriveHierarchy({ relation, maxDepth });
			cache.set(key, result);
			return result;
		}
		return this._deriveHierarchy({ relation, maxDepth });
	}

	/** Build a derived query carrying a hierarchy ordering term. Reuses this
	 * query's dense, sparse, optional and disabled / relation-wildcard state by
	 * reference (the matched set is unchanged), same rationale as `_deriveSparse`. */
	private _deriveHierarchy(hierarchyTerm: HierarchyTerm): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			this.sparseIncludes,
			this.sparseExcludes,
			this.optionalTerms,
			this.includesDisabled,
			this.relationIncludes,
			this.relationExcludes,
			hierarchyTerm
		);
	}

	/** Assert every `(R, *)` wildcard term on this query was declared in the
	 * system's `relationReads`. Iteration-time (`forEachEntity` /
	 * `forEachRelatedTo`), not construction-time, so it is robust to queries
	 * built outside a system, same rationale as the data-op checks. `DEV` only
	 * outside a system `assertRelationRead` is a no-op. */
	private _assertRelationAccess(): void {
		for (let i = 0; i < this.relationIncludes.length; i++) {
			accessCheck.assertRelationRead(this.relationIncludes[i]);
		}
		for (let i = 0; i < this.relationExcludes.length; i++) {
			accessCheck.assertRelationRead(this.relationExcludes[i]);
		}
	}

	/** Iterate every source related to `target` under **any** relation, the
	 * `(*, T)` wildcard, intersected with this query's dense + sparse +
	 * `(R, *)` + disabled predicate, each source yielded once in ascending-EntityID
	 * order (the `sourcesOf` / `sourcesOfAny` convention). `target` is supplied
	 * here rather than as a chained term because it is a runtime `EntityID`: baking
	 * it into a cached `Query` would key the cache on a recycled value and churn
	 * query-ids, and `(*, T)` is the rare or cold shape. Composes with
	 * `withRelation` / `withSparse` / dense terms on the receiver. Reads
	 * every relation's reverse index, so the system must declare
	 * `relationReads: [ANY_RELATION]` (plus `[R]` for any composed `withRelation`).
	 * Cold and structural, not a per-tick hot loop over many targets. */
	public forEachRelatedTo(target: EntityID, cb: (entityId: EntityID) => void): void {
		if (DEV) {
			accessCheck.assertRelationReadAny();
			this._assertRelationAccess();
		}
		this._resolver.forEachTargetMatch(
			target,
			this.include,
			this._exclude,
			this._anyOf,
			this.sparseIncludes,
			this.sparseExcludes,
			this.includesDisabled,
			cb
		);
	}

	/** Add optional fetch-if-present terms. Does not narrow the matched
	 * set, the dense mask is untouched, so iteration still spans archetypes with
	 * and without each `T`. Read each column per archetype span via
	 * `arch.getOptionalColumnRead(T, field)` (column when present, `undefined`
	 * when absent). `.optional(T)` is the *declaration* that authorizes that fetch:
	 * inside `forEach`, `getOptionalColumnRead` throws in `DEV` if `T` was
	 * not declared here, the read-side analog of `reads:[T]`, which is also
	 * still required for access coverage (both checks fire, even on the absent
	 * span). The term is carried through `and`, `not` and `anyOf` (see
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
		const key = ((this.id << 16) | cid) >>> 0;
		const cache = this._resolver.caches.optionalSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveOptional(appendOptional(this.optionalTerms, cid));
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new optional terms. Reuses this query's
	 * dense state by reference (the matched set is unchanged) and carries the
	 * existing sparse terms through unchanged, same rationale as `_deriveSparse`. */
	private _deriveOptional(optionalTerms: readonly ComponentID[]): Query<Defs> {
		return new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			this.sparseIncludes,
			this.sparseExcludes,
			optionalTerms,
			this.includesDisabled,
			this.relationIncludes,
			this.relationExcludes,
			this.hierarchyTerm
		);
	}

	/** Opt this query back in to disabled entities. By default a query
	 * excludes disabled entities (the iteration bound `arch.entityCount` is the
	 * enabled-row count). The returned (cached) query spans disabled rows too:
	 * `forEach` publishes the all-rows flag so the SoA loop's `arch.entityCount`
	 * reports `length`, and `count` and `forEachEntity` widen accordingly. Does not
	 * touch the dense mask, so it reuses this query's live archetype list and is
	 * carried through `and`, `not` or `anyOf` like the sparse or optional terms. */
	public includeDisabled(): Query<Defs> {
		if (this.includesDisabled) return this;
		const cache = this._resolver.caches.includeDisabledSingle;
		const cached = cache.get(this.id);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			this.sparseIncludes,
			this.sparseExcludes,
			this.optionalTerms,
			true,
			this.relationIncludes,
			this.relationExcludes,
			this.hierarchyTerm
		);
		cache.set(this.id, result);
		return result;
	}

	public forEach(cb: (arch: ArchetypeView<Defs>) => void): void {
		// Include-disabled iteration: publish the all-rows flag so the SoA
		// loop's `arch.entityCount` spans disabled rows, restoring the previous
		// flag after (re-entrancy-safe). Kept off the default hot path entirely.
		if (this.includesDisabled) {
			this._forEachIncludeDisabled(cb);
			return;
		}
		// Default path: inline `_forEachInner`'s body rather than delegate.
		// `forEach` is a megamorphic call site (every system passes a distinct
		// `cb`), so V8 will not inline the delegate, the extra stack frame is a
		// real per-call cost on `forEach`-call-bound loops. Keep this body
		// byte-identical to `_forEachInner`. Do not "dry it up" back into a
		// delegate hop (that hop is exactly the regression this restores).
		if (DEV) {
			this._assertDenseOnly("forEach");
			// Publish this query's optional terms as the active scope so
			// `getOptionalColumnRead` can verify each fetch was declared via
			// `.optional(T)`. Dev-only, prod runs the bare loop below
			// byte-for-byte. The `finally` keeps the scope balanced if `cb` throws.
			accessCheck.enterOptionalScope(this.optionalTerms);
			try {
				const archs = this.nonEmptyArchs();
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					arch.iterDepth++;
					try {
						cb(arch);
					} finally {
						arch.iterDepth--;
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this.nonEmptyArchs();
		for (let i = 0; i < archs.length; i++) {
			cb(archs[i]);
		}
	}

	/** @internal, cold `includeDisabled` wrapper for `forEach`, split out
	 * so the all-rows flag dance (`_setIterAllRows` inside a `finally`) stays
	 * out of `forEach`'s inlined hot body. The default (enabled-only) query never
	 * reaches here, so V8 leaves this uninlined and `forEach` shrinks accordingly. */
	private _forEachIncludeDisabled(cb: (arch: ArchetypeView<Defs>) => void): void {
		const prev = _setIterAllRows(true);
		try {
			this._forEachInner(cb);
		} finally {
			_setIterAllRows(prev);
		}
	}

	/**
	 * Per-archetype destructured column iteration, the flecs
	 * `run()` / koota `useStores` model, and the recommended hot-path default for
	 * mutating systems:
	 *
	 *   q.forEachChunk((cols, count) => {
	 *     const { x, y }   = cols.mut(Pos);   // whole group, tick stamped inside
	 *     const { vx, vy } = cols.read(Vel);  // read-only group
	 *     for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
	 *   });
	 *
	 * vs the raw path it replaces (per-field `getColumnMut` + manual `ecsTick`
	 * thread + `entityCount` loop). It folds away: per-field fetches (one call
	 * per component), the `getColumnMut` and `getColumnRead` choice (→ `.mut` and `.read`),
	 * the manual tick arg (hidden in `.mut`), and the `.length`-vs-`entityCount`
	 * corruption trap (`count` is `entityCount`). It is also the only mutable
	 * column accessor reachable through the iteration path, the read-only
	 * `ArchetypeView` from `forEach` deliberately omits the mutable `getColumnMut`.
	 * The SoA inner loop is byte-identical, and the per-archetype group objects
	 * are cached (zero per-archetype allocation). One `ChunkColumns` cursor is
	 * allocated per pass and reused across that pass's archetypes. Honours
	 * `includeDisabled()` exactly like `forEach` (the bound widens to the
	 * disabled tail); dense-only like `forEach` (sparse, relation and hierarchy terms
	 * throw in `DEV`, iterate those with `forEachEntity`).
	 */
	public forEachChunk(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		// Include-disabled iteration: publish the all-rows flag so each
		// archetype's `entityCount` spans its disabled tail, then restore it
		// (re-entrancy-safe). Mirrors `forEach` / `some`, every dense
		// iterator honours `includeDisabled()`. Kept off the default hot path.
		if (this.includesDisabled) {
			const prev = _setIterAllRows(true);
			try {
				this._forEachChunkInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
			return;
		}
		this._forEachChunkInner(cb);
	}

	/** @internal, shared body for `forEachChunk`'s default and `includeDisabled`
	 * paths. The `ChunkColumns` cursor is allocated per call (a 2-field object whose
	 * cost doesn't scale with the per-row work) rather than cached on the query, so
	 * a nested `forEachChunk` on the same query gets its own cursor instead of
	 * re-pointing the outer pass's `arch` and `tick`. The per-(archetype, component)
	 * column-group caches that actually matter for allocation live on the
	 * `Archetype`, untouched. */
	private _forEachChunkInner(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		const view = new ChunkColumns<Defs>();
		view.tick = this._resolver.getChangeTick();
		view.since = this._resolver.getLastRunTick();
		view.resolver = this._resolver;
		if (DEV) {
			this._assertDenseOnly("forEachChunk");
			accessCheck.enterOptionalScope(this.optionalTerms);
			try {
				const archs = this.nonEmptyArchs();
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					view.arch = arch;
					arch.iterDepth++;
					try {
						cb(view, arch.entityCount);
					} finally {
						arch.iterDepth--;
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this.nonEmptyArchs();
		for (let i = 0; i < archs.length; i++) {
			view.arch = archs[i];
			cb(view, archs[i].entityCount);
		}
	}

	/**
	 * Early-exit iteration: like `forEach`, but stops as soon as `cb` returns
	 * `true`, and returns whether any callback did. The predicate analog for
	 * "does any matching row satisfy X?", without it, callers hand-rolled a
	 * `query.archetypes` walk (re-implementing the empty-archetype skip) only
	 * to be able to `return` mid-scan. Deliberately a separate method:
	 * honouring return values on `forEach`'s existing `=> void` callback
	 * would silently change behaviour for arrow-expression bodies that happen
	 * to return a truthy value.
	 */
	public some(cb: (arch: ArchetypeView<Defs>) => boolean): boolean {
		if (this.includesDisabled) {
			const prev = _setIterAllRows(true);
			try {
				return this._someInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
		}
		return this._someInner(cb);
	}

	/** @internal, shared body for `some`'s default and
	 * `includeDisabled` paths. Same dev-mode optional-term scope as
	 * `forEach`. */
	private _someInner(cb: (arch: ArchetypeView<Defs>) => boolean): boolean {
		if (DEV) {
			this._assertDenseOnly("some");
			accessCheck.enterOptionalScope(this.optionalTerms);
			try {
				const archs = this.nonEmptyArchs();
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					arch.iterDepth++;
					try {
						if (cb(arch)) return true;
					} finally {
						arch.iterDepth--;
					}
				}
				return false;
			} finally {
				accessCheck.leaveOptionalScope();
			}
		}
		const archs = this.nonEmptyArchs();
		for (let i = 0; i < archs.length; i++) {
			if (cb(archs[i])) return true;
		}
		return false;
	}

	/** @internal, the `includeDisabled` delegate for `forEach`. The
	 * default (enabled-only) path inlines this body directly into `forEach`
	 * to dodge a megamorphic delegate hop. This copy survives only for the
	 * rare all-rows path, which needs the `_setIterAllRows` `finally` wrap. */
	private _forEachInner(cb: (arch: ArchetypeView<Defs>) => void): void {
		if (DEV) {
			this._assertDenseOnly("forEach");
			// Publish this query's optional terms as the active scope so
			// `getOptionalColumnRead` can verify each fetch was declared via
			// `.optional(T)`. Dev-only, prod runs the bare loop below
			// byte-for-byte. The `finally` keeps the scope balanced if `cb` throws.
			accessCheck.enterOptionalScope(this.optionalTerms);
			try {
				const archs = this.nonEmptyArchs();
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					arch.iterDepth++;
					try {
						cb(arch);
					} finally {
						arch.iterDepth--;
					}
				}
			} finally {
				accessCheck.leaveOptionalScope();
			}
			return;
		}
		const archs = this.nonEmptyArchs();
		for (let i = 0; i < archs.length; i++) {
			cb(archs[i]);
		}
	}

	/** Iterate the entities this query matches, yielding each `EntityID`
	 * (the sparse-membership match path). Use this whenever the query
	 * carries a `withSparse` / `withoutSparse` term: members are scattered
	 * across archetypes, so there is no SoA column span to hand back, read
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
		// A `(R, *)` term reads relation structure, assert `relationReads: [R]`.
		// `DEV` only. Prod runs the bare match below byte-for-byte.
		if (DEV) this._assertRelationAccess();
		// A `.hierarchy(R)` term reorders the matched set into depth order
		// over R, so it routes to the dedicated depth-ordered driver rather than the
		// insertion-order sparse-match path. The relation is read, so it needs the
		// same `relationReads: [R]` assertion as a `(R, *)` term.
		if (this.hierarchyTerm !== null) {
			if (DEV) accessCheck.assertRelationRead(this.hierarchyTerm.relation);
			this._resolver.forEachHierarchyMatch(
				this.include,
				this._exclude,
				this._anyOf,
				this.sparseIncludes,
				this.sparseExcludes,
				this.nonEmptyArchs(),
				this.hierarchyTerm.relation,
				this.hierarchyTerm.maxDepth,
				this.includesDisabled,
				cb
			);
			return;
		}
		this._resolver.forEachSparseMatch(
			this.include,
			this._exclude,
			this._anyOf,
			this.sparseIncludes,
			this.sparseExcludes,
			this.nonEmptyArchs(),
			cb,
			this.includesDisabled
		);
	}

	/** @internal, used by ChangedQuery. Rebuild non-empty archetype list if the
	 * Store has bumped its dirty epoch since our last rebuild, return cached result.
	 *
	 * Rebuild allocates a *fresh* array and swaps it in rather than truncating
	 * the cached one in place. `forEach`, `count` and `ChangedQuery.forEach`
	 * bind the returned array once and walk it. An in-place `dst.length = 0` +
	 * re-push would corrupt that walk if the query is re-entrantly iterated,
	 * i.e. the callback runs an immediate-mode mutation that crosses a
	 * 0↔non-zero entity boundary on the *same* Query (bumping the epoch) and
	 * then re-enters here via a nested `forEach` and `count`. Building fresh hands
	 * the inner call its own array and leaves the outer iterator's snapshot
	 * intact, so each archetype is visited exactly once. Cost is one array
	 * allocation per epoch advance (rare, only on boundary crossings); the
	 * steady-state path returns the cached array with zero allocation. In-system
	 * iteration never triggers a rebuild mid-loop: deferred mutations settle the
	 * epoch during `flushStructural`, between systems. */
	public nonEmptyArchs(): Archetype[] {
		const epoch = this._resolver.getQueryDirtyEpoch();
		if (this._lastSeenEpoch !== epoch) this._rebuildNonEmpty(epoch);
		return this._nonEmptyArchetypes;
	}

	/** @internal, cold rebuild path for `nonEmptyArchs`, split out so the
	 * hot `nonEmptyArchs` body is only an epoch check + cached return. Keeping the
	 * filter loops here shrinks `nonEmptyArchs`'s inlined bytecode footprint, which
	 * matters when several composed queries iterate inside one hot function (the
	 * `query_compose` shape): the leaner `nonEmptyArchs` keeps `forEach` under V8's
	 * per-function cumulative inlining budget. */
	private _rebuildNonEmpty(epoch: number): void {
		const src = this._archetypes;
		const dst: Archetype[] = [];
		// Filter on the partition field directly, not the flag-dependent
		// `entityCount` getter: a default query keeps archetypes with
		// ≥1 *enabled* row. An `includeDisabled` query keeps any with ≥1 row
		// (so an all-disabled archetype still iterates). Independent of order and of the flag.
		if (this.includesDisabled) {
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
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.anyOfSingle.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._anyOfMiss(cid, key);
		}
		// Fold through the single-arg cached path. Successive `anyOf` calls
		// union into one anyOf mask (single-arg copies the mask and adds the bit),
		// so `anyOf(A, B)` ≡ `anyOf(A).anyOf(B)`, "match at least one of {A,B}",
		// and is now cached and stable instead of minting a query-id per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.anyOf(comps[i]);
		return q;
	}

	/** @internal, cold cache-miss path for single-arg `anyOf`. See `_andMiss`. */
	private _anyOfMiss(cid: number, key: number): Query<Defs> {
		const newAnyOf = this._anyOf ? this._anyOf.copy() : new BitSet();
		newAnyOf.set(cid);
		const result = this._carryNondense(
			this._resolver.resolveQuery(this.include, this._exclude, newAnyOf, this.defs)
		) as Query<Defs>;
		this._resolver.caches.anyOfSingle.set(key, result);
		return result;
	}

	/** Create a ChangedQuery that filters archetypes by change tick.
	 *
	 *  Granularity is **archetype**, not row: the `changedTick[cid]` is
	 *  stamped per archetype on any write into that component's column
	 *  (`Archetype.changedTick` in archetype.ts). A 1-row write in a
	 *  1000-row archetype trips `forEach` on the whole archetype next tick.
	 *  Use cases that need row-level granularity should compare per-row
	 *  state explicitly inside the callback.
	 *
	 *  A stamp is reported once. The change tick advances before every
	 *  system run, so a stamp made by an earlier system this frame is above
	 *  the reader's last run, and a stamp the reader already saw is not.
	 *
	 *  The returned ChangedQuery is composable: `and`, `without` and `anyOf`/
	 *  `optional` refine it further, so `q.changed(Pos).without(Dead)` works, and
	 *  is the same set as `q.without(Dead).changed(Pos)`. */
	public changed(...defs: ComponentDef[]): ChangedQuery<Defs> {
		if (defs.length === 1) {
			const cid = defs[0].id;
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.changedSingle.get(key);
			if (cached !== undefined) return cached as ChangedQuery<Defs>;
			return this._changedMiss(cid, key);
		}
		const ids: number[] = new Array(defs.length);
		for (let i = 0; i < defs.length; i++) ids[i] = defs[i].id;
		return new ChangedQuery(this, ids);
	}

	/** @internal, cold cache-miss path for single-arg `changed`. See `_andMiss`. */
	private _changedMiss(cid: number, key: number): ChangedQuery<Defs> {
		const result = new ChangedQuery<Defs>(this, [cid]);
		this._resolver.caches.changedSingle.set(key, result);
		return result;
	}

	/** @internal, reads lastRunTick from the resolver (ECS). */
	public lastRunTick(): number {
		return this._resolver.getLastRunTick();
	}

	/** @internal, the change tick, for a `ChangedQuery` chunk pass. */
	public changeTick(): number {
		return this._resolver.getChangeTick();
	}

	/** @internal, the resolver, for a `ChangedQuery` chunk pass. */
	public resolver(): QueryResolver {
		return this._resolver;
	}

	/** @internal, the dense-only guard, for a `ChangedQuery` chunk pass. */
	public assertDenseOnly(op: string): void {
		this._assertDenseOnly(op);
	}
}

export class QueryBuilder {
	constructor(private readonly _resolver: QueryResolver) {}

	public with<T extends ComponentDef[]>(...defs: T): Query<T> {
		const mask = new BitSet();
		for (let i = 0; i < defs.length; i++) mask.set(defs[i].id);
		return this._resolver.resolveQuery(mask, null, null, defs);
	}
}

/**
 * A `BundleOrDef` whose def is constrained to the enclosing system's declared
 * add surface (system.ts). The bundle branch restates `Bundle`'s shape with
 * the def slot narrowed, intersecting `Bundle<any> & { def: … }` instead
 * would put two `ComponentDef` instantiations in one intersection, which TS
 * relates leniently (see the access-typing notes in system.ts).
 *
 * The outer conditional is a deliberate no-op (`[D] extends [unknown]` is
 * always true): it makes the variance of `D`, and therefore of the access
 * param `A` threaded through `Commands` / `SystemContext`. Unmeasurable to
 * the compiler. A measurable (plain-union) definition here gets `A` marked
 * reliably contravariant, variance-based comparison then rejects
 * `SystemContext<Narrow> → SystemContext` without the structural fallback,
 * and every helper taking a bare `SystemContext` stops accepting typed
 * contexts. Unmeasurable variance forces the structural path, where class
 * methods compare bivariantly and the conversion holds.
 *
 * The inner `D extends ComponentDef ? … : never` Distributes over the declared
 * add-set union, so each raw-literal branch carries its own def's schema
 * (`Partial<FieldValues<SchemaOf<D>>>`) rather than the erased
 * `Partial<Record<string, number>>`. A hand-written `{ def: Vel, values: { x }}`
 * whose fields don't match its def is then rejected in a declared-access system,
 * matching the `StrictBundles` guarantee on the `ecs.*` surface. A permissive
 * context (`add: ComponentDef<any>`, i.e. an unnarrowed / `exclusive` system)
 * keeps the loose shape, which is the point of opting out of narrowing. The
 * outer no-op is preserved, so the variance invariant above still holds
 * (verified: the `permissiveHelper(ctx)` assertion still compiles).
 */
export type DeclaredBundleOrDef<D> = [D] extends [unknown]
	? D extends ComponentDef
		? D | { readonly def: D; readonly values: Readonly<Partial<FieldValues<SchemaOf<D>>>> }
		: never
	: never;

/**
 * Deferred structural-command facade (Bevy `Commands`).
 * Namespaces the deferred structural ops so the call site is self-documenting:
 * `ctx.commands.add(e, …)` is *always* deferred (applied at the phase flush),
 * ending the collision where `ecs.addComponent` (immediate) and a bare
 * `ctx.addComponent` (deferred) would share a name with opposite timing. Takes
 * varargs callable bundles, so one shape, `commands.spawn(bundle(Pos,{x,y}), bundle(Vel,{vx:1}))`,
 * serves spawn and add. This is the only deferred surface: the bare
 * `ctx.addComponent` / `ctx.removeComponent` / `ctx.disable` / `ctx.enable`
 * duplicates were removed in 0.5.0, completing the receiver-implies-timing
 * rule (`ecs.*` immediate, `ctx.commands.*` deferred) that 0.5.0 started for
 * spawn/despawn.
 *
 * `A` narrows the def-taking methods to the enclosing system's declared access
 * (system.ts). The default is fully permissive.
 *
 * `out A` (declared covariance) is deliberate: every use of `A` sits inside a
 * declared-access conditional, whose variance the compiler cannot measure,
 * left unannotated, the measured verdict rejects `Commands<Narrow> →
 * Commands` (the direction every permissive consumer needs). Covariance is
 * the honest direction: a context with more declared access is usable where
 * one with less is expected. The checks themselves are per-instantiation, so
 * the annotation does not weaken them.
 */
export class Commands<out A extends SystemAccess = SystemAccess> {
	constructor(private readonly _store: Store) {}

	/** Spawn from bundles. Create is immediate (the id is returned now); the
	 *  component attaches are deferred to the phase flush, so until that flush the
	 *  entity exists in its empty and partial archetype and a query running later in
	 *  the same phase can observe it half-built. (Same semantics as
	 *  `ctx.commands.spawn()` + `ctx.addComponent`. Fully-deferred id-reservation
	 *  spawn, à la Bevy, is a separate follow-up.) */
	public spawn(...items: DeclaredBundleOrDef<A["add"]>[]): EntityID {
		const e = this._store.createEntity();
		if (DEV) this._store.trace?.commandQueued("spawn", e, null);
		for (let i = 0; i < items.length; i++) {
			const def = bundleDef(items[i]);
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(e, def, bundleValues(items[i]));
			// Trace each attach like `add` does, the queued adds are what the
			// flush drains, so a sink reconstructing the frame sees all of them.
			if (DEV) this._store.trace?.commandQueued("add", e, def.id);
		}
		return e;
	}

	/** Attach bundles to an existing entity (deferred). Bundles zero-fill
	 * omitted fields. */
	public add(entityId: EntityID, ...items: DeclaredBundleOrDef<A["add"]>[]): this;
	/** Explicit complete-values attach (deferred), the compile-checked shape
	 * where a typo'd or missing field is a compile error, mirroring the
	 * immediate `ecs.addComponent(e, def, values)`. Tags take no values
	 * argument (`AttachValuesArg`). */
	public add<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredAdd<A, D>,
		...values: AttachValuesArg<SchemaOf<D>>
	): this;
	public add(entityId: EntityID, ...items: (BundleOrDef | Record<string, number>)[]): this {
		// (def, values) shape: a callable def followed by a values record. A
		// bundle always carries a *callable* `def` property, so a plain record,
		// even one whose schema has a field literally named "def" (a number
		// there, not a function), can never be mistaken for one.
		if (
			items.length === 2 &&
			typeof items[0] === "function" &&
			items[1] !== null &&
			typeof items[1] === "object" &&
			typeof (items[1] as { def?: unknown }).def !== "function"
		) {
			const def = items[0] as ComponentDef;
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(entityId, def, items[1] as Record<string, number>);
			if (DEV) this._store.trace?.commandQueued("add", entityId, def.id);
			return this;
		}
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as BundleOrDef;
			const def = bundleDef(item);
			if (DEV) accessCheck.assertAdd(def);
			this._store.addComponentDeferred(entityId, def, bundleValues(item));
			if (DEV) this._store.trace?.commandQueued("add", entityId, def.id);
		}
		return this;
	}

	/** Remove a component (deferred). */
	public remove<D extends ComponentDef<any>>(entityId: EntityID, def: D & DeclaredRemove<A, D>): this {
		if (DEV) accessCheck.assertRemove(def);
		this._store.removeComponentDeferred(entityId, def);
		if (DEV) this._store.trace?.commandQueued("remove", entityId, def.id);
		return this;
	}

	/** Destroy an entity (deferred). */
	public despawn(entityId: DespawnArg<A>): this {
		if (DEV) accessCheck.assertDespawn();
		// The conditional argument type is `EntityID` whenever this compiles
		// (the false branch is uninhabited); the cast recovers it for a body
		// where `A` is still generic.
		const id = entityId as EntityID;
		this._store.destroyEntityDeferred(id);
		if (DEV) this._store.trace?.commandQueued("despawn", id, null);
		return this;
	}

	/** Buffer `entityId` to be disabled at the phase flush (idempotent).
	 * Deferred because a toggle is an in-archetype row swap, which would corrupt
	 * a `forEach` SoA loop iterating that archetype if applied mid-system (it
	 * reorders the dense columns being read). A disabled entity is excluded from
	 * default queries. Opt back in per query with `.includeDisabled()`. The
	 * immediate read is `ctx.isDisabled`. */
	public disable(entityId: EntityID): this {
		this._store.disableEntityDeferred(entityId);
		if (DEV) this._store.trace?.commandQueued("disable", entityId, null);
		return this;
	}

	/** Buffer `entityId` to be re-enabled at the phase flush (idempotent).
	 * Deferred for the same row-swap reason as `disable`. */
	public enable(entityId: EntityID): this {
		this._store.enableEntityDeferred(entityId);
		if (DEV) this._store.trace?.commandQueued("enable", entityId, null);
		return this;
	}
}

/**
 * The per-system world facade. `A` is the system's declared access surface
 * (system.ts): the config-form `registerSystem` computes it from
 * the literal `reads` and `writes`/… declarations and every guarded method below
 * checks its handle argument against the matching union at compile time,
 * the same rules `accessCheck` enforces at runtime in `DEV`. The default
 * `A = SystemAccess` is fully permissive, so a bare `SystemContext` (helper
 * functions, host-side code, explicitly-annotated escape hatches) behaves
 * exactly as before, and every narrowed `SystemContext<…>` is assignable to
 * it.
 *
 * `out A` (declared covariance) is deliberate, see `Commands` above: the
 * declared-access conditionals are unmeasurable to the compiler, and the
 * unannotated verdict rejects exactly the `SystemContext<Narrow> →
 * SystemContext` conversion the whole design depends on.
 */
export class SystemContext<out A extends SystemAccess = SystemAccess> {
	public lastRunTick: number = 0;

	/** Deferred structural-command facade. */
	public readonly commands: Commands<A>;

	/** The frame tick: the count of `update()` calls so far. Run conditions
	 * read it. The change tick that a write stamps is a separate counter that
	 * advances before every system run, so it does not equal this value. */
	public get ecsTick(): number {
		return this._store.tick;
	}

	/** @internal Advance the change tick for the run that follows and return
	 * the new value. The schedule calls it before each system run and before
	 * each phase flush. Not for a system body. */
	public advanceChangeTick(): number {
		return this._store.advanceChangeTick();
	}

	/** The world's frame-trace sink, or `null`. Lets the schedule
	 * fire `systemBegin` and `flush*` without reaching into the private store.
	 * Read only under `if (DEV)`. The seam is dead-code-eliminated in prod. */
	public get trace(): FrameTraceSink | null {
		return this._store.trace;
	}

	constructor(private readonly _store: Store) {
		this.commands = new Commands<A>(_store);
	}

	public isAlive(entityId: EntityID): boolean {
		return this._store.isAlive(entityId);
	}

	public hasComponent(entityId: EntityID, def: ComponentDef): boolean {
		return this._store.hasComponent(entityId, def);
	}

	public getField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredRead<A, D>,
		field: string & keyof SchemaOf<D>
	): number {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.getField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		return arch.readField(row, def.id, field);
	}

	/** Total sibling of {@link getField}, mirroring `ecs.tryGetField`
	 *: `undefined` when the entity is dead or doesn't hold
	 * the component, instead of a dev throw or a prod garbage read. The safe way
	 * to probe-and-read in one call: `ctx.tryGetField(e, Health, "current") ?? 0`. */
	public tryGetField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredRead<A, D>,
		field: string & keyof SchemaOf<D>
	): number | undefined {
		if (DEV) accessCheck.assertRead(def);
		if (!this._store.hasComponent(entityId, def)) return undefined;
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		return arch.readField(row, def.id, field);
	}

	public setField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredWrite<A, D>,
		field: string & keyof SchemaOf<D>,
		value: number
	): void {
		if (DEV) {
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.setField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		// `getColumnMut` (mutable) invokes `accessCheck.assertWrite` under DEV,
		// so setField doesn't need a separate check.
		const col = arch.getColumnMut(def, field, this._store.changeTick);
		col[row] = value;
		// Per-entity onSet: record the changed row for components with a dirty-list
		// observer. Gated so the common no-onSet path pays nothing.
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
	}

	/** Read-modify-write one field: `updateField(e, Gold, "value", v => v - cost)`
	 * is the one-line form of the `getField` → compute → `setField` round trip.
	 * Returns the written value. Same access-check and observer semantics as the
	 * two calls it composes (inlined here: the declared-access conditionals on
	 * those methods only resolve per `A` instantiation, so a body where `A` is
	 * still generic cannot call them without casts). */
	public updateField<D extends ComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredWrite<A, D>,
		field: string & keyof SchemaOf<D>,
		fn: (current: number) => number
	): number {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.updateField", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		const next = fn(arch.readField(row, def.id, field));
		const col = arch.getColumnMut(def, field, this._store.changeTick);
		col[row] = next;
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
		return next;
	}

	/**
	 * Record an entity as changed for a component's per-entity `onSet` observer.
	 * The SoA write idiom, `const { x } = cols.mut(D); x[i] = v` in a tight
	 * loop, bypasses the engine, which never sees the per-element writes, so a
	 * per-entity `onSet` consumer records the row by hand. This is the by-id
	 * form: a call, a resolve and a list push per row. The row form,
	 * `cols.ticks(D)[i] = cols.tick`, is one store per row, and the one to
	 * reach for inside a chunk loop. No-op for components without a
	 * per-entity onSet observer. `setField`, `ref` and a cursor record on
	 * their own.
	 */
	public markChanged(entityId: EntityID, def: ComponentDef): void {
		if (this._store.anyDirtyTracked) this._store.noteSetEntity(def, entityId);
	}

	/**
	 * Create a cached component reference for a single entity. Marks the
	 * component as changed (the mutable default, see `refRead` for the
	 * read-only variant to reach for when you are not mutating), and records
	 * the entity for a per-entity onSet observer. Both happen here, at
	 * creation: the accessor's setters write raw columns and cannot record,
	 * so the record is conservative, as the archetype stamp is. See ref.ts.
	 */
	public ref<D extends ComponentDef<any>>(
		def: D & DeclaredWrite<A, D>,
		entityId: EntityID
	): ComponentRef<SchemaOf<D>> {
		if (DEV) {
			accessCheck.assertWrite(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.ref", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		if (DEV && arch.accessorColumns[def.id] === undefined)
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`ctx.ref: ${componentLabel(def)} has no columns in this archetype, the entity doesn't hold it, or it is a tag (no fields to ref)`,
				{ component: def.id, entity: entityId }
			);
		arch.changedTick[def.id] = this._store.changeTick;
		if (this._store.anyDirtyTracked) this._store.noteSet(def.id as number, arch, row, entityId);
		// ! safe in prod (dev guard above): _accCols is populated for all components with fields in this archetype
		return createRef<SchemaOf<D>>(arch.accessorColumns[def.id]!, row);
	}

	/**
	 * Create a cached read-only component reference for a single entity. Use
	 * this when you are not mutating. The returned `ReadonlyComponentRef<S>`
	 * is an *advisory* compile-time barrier (no `_changedTick` bump): the
	 * `readonly` typing blocks field writes at the type layer, but the
	 * underlying accessor shares its prototype with `ref()` and can still be
	 * written through a deliberate cast. See ref.ts.
	 */
	public refRead<D extends ComponentDef<any>>(
		def: D & DeclaredRead<A, D>,
		entityId: EntityID
	): ReadonlyComponentRef<SchemaOf<D>> {
		if (DEV) {
			accessCheck.assertRead(def);
			if (!this._store.isAlive(entityId)) throw entityNotAliveError("ctx.refRead", entityId, componentLabel(def));
		}
		const arch = this._store.resolveEntity(entityId);
		const row = this._store.resolvedRow;
		if (DEV && arch.accessorColumns[def.id] === undefined)
			throw new ECSError(
				ECS_ERROR.COMPONENT_NOT_REGISTERED,
				`ctx.refRead: ${componentLabel(def)} has no columns in this archetype, the entity doesn't hold it, or it is a tag (no fields to ref)`,
				{ component: def.id, entity: entityId }
			);
		// ! safe in prod (dev guard above): _accCols is populated for all components with fields in this archetype
		return createRef<SchemaOf<D>>(arch.accessorColumns[def.id]!, row);
	}

	/**
	 * A re-pointable single-entity cursor over `def`, the in-system twin of
	 * {@link ECS.cursor}, and the accessor to reach for when a system touches many
	 * entities **by id** rather than by query span.
	 *
	 * `ctx.ref` allocates one accessor for each entity. That allocation is the
	 * largest part of the cost of a read of one field by id, because to make an
	 * accessor costs much more than to move one. Make the cursor one time,
	 * outside the loop:
	 *
	 *   const p = ctx.cursor(Pos);
	 *   for (const e of hits) { p.at(e); p.x += p.y * dt; }
	 *
	 * Mutable: every `at()` stamps the change tick. Still prefer `forEachChunk` when
	 * a query can express the entity set, a cursor removes the per-entity
	 * allocation, not the per-entity archetype resolution.
	 */
	public cursor<D extends ComponentDef<any>>(
		def: D & DeclaredWrite<A, D>
	): ComponentCursor<SchemaOf<D>> {
		if (DEV) accessCheck.assertWrite(def);
		return createCursor<SchemaOf<D>>(
			this._store.componentFieldNames(def),
			this._store.cursorBinder(def, true)
		);
	}

	/** Read-only {@link cursor}: no change-tick stamp on `at()`. Advisory only,
	 * same caveat as `ctx.refRead`. */
	public cursorRead<D extends ComponentDef<any>>(
		def: D & DeclaredRead<A, D>
	): ReadonlyComponentCursor<SchemaOf<D>> {
		if (DEV) accessCheck.assertRead(def);
		return createCursor<SchemaOf<D>>(
			this._store.componentFieldNames(def),
			this._store.cursorBinder(def, false)
		) as ReadonlyComponentCursor<SchemaOf<D>>;
	}

	// --- Deferred structural ops live on `ctx.commands` ---
	// The bare `ctx.addComponent` / `ctx.removeComponent` / `ctx.disable` /
	// `ctx.enable` duplicates were removed in 0.5.0 (same break that removed
	// `ctx.createEntity` / `ctx.destroyEntity`): one deferred surface, one
	// timing rule per receiver. `isDisabled` stays here. It is an immediate
	// *read*, not a buffered structural op.

	/** Whether `entityId` is currently disabled (immediate read). Toggling is
	 * deferred, `ctx.commands.disable` / `ctx.commands.enable`. */
	public isDisabled(entityId: EntityID): boolean {
		return this._store.isDisabled(entityId);
	}

	// --- Sparse (out-of-identity) component operations ---
	// Immediate, not deferred: a sparse add and remove causes no archetype
	// transition and no row reallocation, so it's safe to apply mid-system.
	// It can't invalidate a *dense* query's iteration the way a structural
	// change would. Field reads and writes mirror `getField` / `setField`.
	//
	// Sharp edge of the immediacy: it is not safe during `forEachEntity` over
	// a query whose driving sparse term is the one being mutated, the immediate
	// add and remove edits the live key array under the walk (see `forEachEntity`).
	// Buffer such edits and apply after.
	//
	// Access-checked under `DEV` against the system's `sparseReads` /
	// `sparseWrites` declarations: add, remove and set_field require a write
	// term, getField a read term (a write implies a read). `hasSparse` is
	// unchecked, mirroring `hasComponent`. Sparse ids live in their own id
	// space, so the check keys the dedicated sparse sets, never the dense ones.

	/** Tags take no values argument. Valued schemas require a complete one. */
	public addSparse<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>,
		...values: AttachValuesArg<SparseSchemaOf<D>>
	): this {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.addSparse(entityId, def, values[0] as Record<string, number> | undefined);
		return this;
	}

	public removeSparse<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>
	): this {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.removeSparse(entityId, def);
		return this;
	}

	public hasSparse(entityId: EntityID, def: SparseComponentDef): boolean {
		return this._store.hasSparse(entityId, def);
	}

	public getSparseField<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseRead<A, D>,
		field: string & keyof SparseSchemaOf<D>
	): number {
		if (DEV) accessCheck.assertSparseRead(def);
		return this._store.getSparseField(entityId, def, field);
	}

	public setSparseField<D extends SparseComponentDef<any>>(
		entityId: EntityID,
		def: D & DeclaredSparseWrite<A, D>,
		field: string & keyof SparseSchemaOf<D>,
		value: number
	): void {
		if (DEV) accessCheck.assertSparseWrite(def);
		this._store.setSparseField(entityId, def, field, value);
	}

	/** A cursor over a sparse component, the sparse sibling of {@link cursor}
	 * and the fastest read by id in a system: `at()` writes the entity index and
	 * a field access is one load. Mutable. Declare the component in
	 * `sparseWrites`. See `ECS.sparseCursor`. */
	public sparseCursor<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseWrite<A, D>
	): ComponentCursor<SparseSchemaOf<D>> {
		if (DEV) accessCheck.assertSparseWrite(def);
		return createSparseCursor<SparseSchemaOf<D>>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, true),
			this._store.sparseTickPlane(def),
			this._store
		);
	}

	/** Whether the sparse component of `entityId` changed since the previous
	 * run of this system: its row tick is above `lastRunTick`. The row grain
	 * of change detection for a sparse component, as a pull. Needs row ticks
	 * (`ecs.trackRows(def)`, or an entity-level `onSet`), and throws
	 * `ROW_TICKS_NOT_TRACKED` without them. A non-member reads `false`. */
	public sparseChanged<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseRead<A, D>,
		entityId: EntityID
	): boolean {
		if (DEV) accessCheck.assertSparseRead(def);
		return this._store.sparseTickOf(def, entityId) > this.lastRunTick;
	}

	/** Read-only {@link sparseCursor}; declare the component in `sparseReads`.
	 * Advisory only, same caveat as `ctx.cursorRead`. */
	public sparseCursorRead<D extends SparseComponentDef<any>>(
		def: D & DeclaredSparseRead<A, D>
	): ReadonlyComponentCursor<SparseSchemaOf<D>> {
		if (DEV) accessCheck.assertSparseRead(def);
		return createSparseCursor<SparseSchemaOf<D>>(
			this._store.sparseFieldNames(def),
			this._store.sparseAccessorColumns(def),
			this._store.sparseCursorCheck(def, false)
		) as ReadonlyComponentCursor<SparseSchemaOf<D>>;
	}

	// --- Relations (sparse (relation, target) pairs) ---
	// Immediate like the sparse ops, no archetype transition, safe mid-system.
	// Registration is host-side (`ECS.registerRelation`), so it is not mirrored
	// here. Systems add, remove and query pairs.
	//
	// Access-checked under `DEV` against `relationReads` / `relationWrites`:
	// add and remove require a write term, target_of, targets_of and sources_of a
	// read term (write implies read). `hasRelation` is unchecked, mirroring
	// `hasComponent`. Relation ids are their own id space, the check keys the
	// dedicated relation sets.

	/** Add a `(R, tgt)` pair to `src` (exclusive replaces, multi adds). */
	public addRelation<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationWrite<A, D>, tgt: EntityID): this {
		if (DEV) accessCheck.assertRelationWrite(def);
		this._store.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes all. */
	public removeRelation<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationWrite<A, D>, tgt?: EntityID): this {
		if (DEV) accessCheck.assertRelationWrite(def);
		this._store.removeRelation(src, def, tgt);
		return this;
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf<D extends RelationDef<"exclusive">>(
		src: EntityID,
		def: D & DeclaredRelationRead<A, D>
	): EntityID | undefined {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf<D extends RelationDef>(src: EntityID, def: D & DeclaredRelationRead<A, D>): EntityID[] {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id.
	 * `(entity, def)` order, matching `targetOf` / `targetsOf`. */
	public sourcesOf<D extends RelationDef>(tgt: EntityID, def: D & DeclaredRelationRead<A, D>): EntityID[] {
		if (DEV) accessCheck.assertRelationRead(def);
		return this._store.sourcesOf(tgt, def);
	}

	/** Whether `src` holds any pair under `R`. */
	public hasRelation(src: EntityID, def: RelationDef): boolean {
		return this._store.hasRelation(src, def);
	}

	/** Flush all deferred changes: structural (add and remove) first, then
	 *  destructions. Republishes archetype row counts into the SAB
	 *  descriptor at the end so any WASM scan running in the next phase
	 *  sees fresh `row_count` fields. This is one of two publish sites,
	 *  `ECS.update()` also republishes once at tick start, which covers
	 *  host-side mutations between updates. The publish walks
	 *  descriptors only. It doesn't touch column data, and benches at
	 *  sub-microsecond per archetype, so paying it once per phase boundary
	 *  is materially cheaper than the earlier pattern of paying it per
	 *  WASM-using system per tick. The descriptor walk is now gated
	 *  on a dirty flag, so read-only phases skip the walk entirely. */
	public flush(): void {
		this._store.flushStructural();
		this._store.flushDestroys();
		this._store.publishRowCounts();
	}

	// =======================================================
	// Events
	// =======================================================

	/**
	 * Emit an event (or a payload-less signal) onto its channel. The event is
	 * visible to every system that runs *later* in the same `update()` and is
	 * cleared at the tick's tail, events live exactly one tick, there is no
	 * ack/consume. The channel must have been registered at world setup via
	 * `ecs.events.register(key, fields)` / `registerSignal(key)`.
	 *
	 * @example
	 * const Damaged = eventKey<{ target: EntityID; amount: number }>("Damaged");
	 * ecs.events.register(Damaged, ["target", "amount"]);
	 * // inside a system:
	 * ctx.emit(Damaged, { target: e, amount: 10 });
	 */
	public emit(key: SignalKey): void;
	public emit<S extends EventShape<S>>(key: EventKey<S>, values: NoInfer<S>): void;
	public emit(key: EventKey, values?: Record<string, number>): void {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventEmit(key.description ?? "");
		}
		if (DEV) this._store.trace?.eventEmitted(key.description ?? "");
		const def = this._store.getEventDefByKey(key);
		if (values === undefined) {
			this._store.emitSignal(def as EventDef<EmptyEventSchema>);
		} else {
			this._store.emitEvent(def, values);
		}
	}

	/**
	 * Read this tick's events on a channel. Returns an SoA reader over
	 * everything emitted *earlier in the same `update()`*, order systems so
	 * readers run after emitters, or they see an empty reader.
	 *
	 * @example
	 * const dmg = ctx.readEvents(Damaged); // SoA columns, one per field
	 * for (let i = 0; i < dmg.length; i++) {
	 *   applyDamage(dmg.target[i], dmg.amount[i]);
	 * }
	 */
	public readEvents<S extends EventShape<S>>(key: EventKey<S>): EventReader<S> {
		if (DEV && dispatchTrace.isActive()) {
			dispatchTrace.recordEventRead(key.description ?? "");
		}
		const def = this._store.getEventDefByKey(key);
		const reader = this._store.getEventReader(def) as EventReader<S>;
		if (DEV) this._store.trace?.eventRead(key.description ?? "", reader.length);
		return reader;
	}

	// =======================================================
	// Resources
	// =======================================================

	/** Read a resource (declared in `resourceReads`). The flat `ctx` surface verbs
	 * its accessors, `getResource`, `setResource`, `removeResource` and `hasResource`,
	 * matching `getField`, `setField` and `hasComponent`. The grouped `ecs.resources`
	 * facade drops the noun (`get`, `set`, `remove` and `has`) because its receiver
	 * already names it. */
	public getResource<K extends ResourceKey<any>>(
		key: K & DeclaredResourceRead<A, K>
	): ResourceValueOf<K> {
		if (DEV) {
			accessCheck.assertResourceRead(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRead(key.description ?? "");
			}
		}
		return unsafeCast<ResourceValueOf<K>>(this._store.getResource(key));
	}

	public setResource<K extends ResourceKey<any>>(
		key: K & DeclaredResourceWrite<A, K>,
		value: ResourceValueOf<NoInfer<K>>
	): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceWrite(key.description ?? "");
			}
		}
		this._store.setResource(key, value);
	}

	/** Drop a resource mid-tick. A lifecycle mutation, so it is access-
	 * checked as a *write*, the system must declare the key in `resourceWrites`,
	 * which serialises it against readers and writers of the same resource. Fails
	 * closed on a missing key. */
	public removeResource<K extends ResourceKey<any>>(key: K & DeclaredResourceWrite<A, K>): void {
		if (DEV) {
			accessCheck.assertResourceWrite(key);
			if (dispatchTrace.isActive()) {
				dispatchTrace.recordResourceRemove(key.description ?? "");
			}
		}
		this._store.removeResource(key);
	}

	public hasResource<T>(key: ResourceKey<T>): boolean {
		return this._store.hasResource(key);
	}
}

export class ChangedQuery<Defs extends readonly ComponentDef[]> {
	private readonly _query: Query<Defs>;
	private readonly _changedIds: number[];

	constructor(query: Query<Defs>, changedIds: number[]) {
		this._query = query;
		this._changedIds = changedIds;
		if (DEV) {
			for (let i = 0; i < changedIds.length; i++) {
				if (!query.include.has(changedIds[i])) {
					throw new ECSError(
						ECS_ERROR.COMPONENT_NOT_REGISTERED,
						`changed() component ${changedIds[i]} is not in query's include mask`
					);
				}
			}
		}
	}

	// --- Composition, a ChangedQuery is a chainable filter, not a dead end.
	// Each verb refines the underlying query and re-wraps, so the dense mask and
	// query-cache identity are reused (the base derive is cached); only the
	// thin wrapper is freshly allocated. `_changedIds` carry through unchanged and
	// stay ⊆ the include mask (which only ever grows, via `and`), so the
	// constructor's dev guard always still holds. Same set result as refining
	// before `changed()`, `q.changed(P).without(D)` ≡ `q.without(D).changed(P)`,
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

	public forEach(cb: (arch: ArchetypeView<Defs>) => void): void {
		// Mirror Query.forEach's include-disabled handling: publish the
		// all-rows flag so the SoA loop's `arch.entityCount` spans disabled rows.
		// Cold branch split out to keep the flag dance off the inlined hot body.
		if (this._query.includesDisabled) {
			this._forEachIncludeDisabled(cb);
			return;
		}
		// Default path: inline `_forEachInner`'s body rather than delegate,
		// for the same reason as `Query.forEach`. This is a megamorphic call site
		// V8 will not inline through, so the delegate hop is a real per-call cost.
		// Keep byte-identical to `_forEachInner`. Do not re-introduce the hop.
		const lastTick = this._query.lastRunTick();
		const archs = this._query.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does, otherwise
			// `getOptionalColumnRead` falls into `assertOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here.
			// Dev-only. Prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							arch.iterDepth++;
							try {
								cb(arch);
							} finally {
								arch.iterDepth--;
							}
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
				if (arch.changedTick[ids[j]] > lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}

	/** The chunk form of `forEach`: the changed archetypes, as column groups.
	 * The row grain sits inside: `cols.ticksRead(def)` is the row tick column,
	 * and a row above `cols.since` changed since the previous run of the
	 * system. `def` needs row ticks (`ecs.trackRows`). Same include-disabled
	 * handling as `Query.forEachChunk`. */
	public forEachChunk(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		if (this._query.includesDisabled) {
			const prev = _setIterAllRows(true);
			try {
				this._forEachChunkInner(cb);
			} finally {
				_setIterAllRows(prev);
			}
			return;
		}
		this._forEachChunkInner(cb);
	}

	/** @internal, the body of `forEachChunk`: `Query._forEachChunkInner` with
	 * the change-tick filter of `forEach` in front of each archetype. */
	private _forEachChunkInner(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		const q = this._query;
		const view = new ChunkColumns<Defs>();
		view.tick = q.changeTick();
		view.since = q.lastRunTick();
		view.resolver = q.resolver();
		const lastTick = view.since;
		const archs = q.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			q.assertDenseOnly("changed().forEachChunk");
			accessCheck.enterOptionalScope(q.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							view.arch = arch;
							arch.iterDepth++;
							try {
								cb(view, arch.entityCount);
							} finally {
								arch.iterDepth--;
							}
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
				if (arch.changedTick[ids[j]] > lastTick) {
					view.arch = arch;
					cb(view, arch.entityCount);
					break;
				}
			}
		}
	}

	/** @internal, cold `includeDisabled` wrapper, split out of `forEach`
	 * so the all-rows flag dance stays out of the inlined hot body. */
	private _forEachIncludeDisabled(cb: (arch: ArchetypeView<Defs>) => void): void {
		const prev = _setIterAllRows(true);
		try {
			this._forEachInner(cb);
		} finally {
			_setIterAllRows(prev);
		}
	}

	/** @internal, the `includeDisabled` delegate for `forEach`. The
	 * default path inlines this body directly into `forEach` to dodge a
	 * megamorphic delegate hop. This copy survives only for the rare all-rows
	 * path, which needs the `_setIterAllRows` `finally` wrap. */
	private _forEachInner(cb: (arch: ArchetypeView<Defs>) => void): void {
		const lastTick = this._query.lastRunTick();
		const archs = this._query.nonEmptyArchs();
		const ids = this._changedIds;
		if (DEV) {
			// A changed-query loop is still iterating the underlying query, so it must
			// publish the same optional scope `Query.forEach` does, otherwise
			// `getOptionalColumnRead` falls into `assertOptionalFetch`'s lenient
			// no-scope branch and the `.optional(T)` gate never fires here.
			// Dev-only. Prod runs the bare loop below byte-for-byte.
			accessCheck.enterOptionalScope(this._query.optionalTerms);
			try {
				for (let i = 0; i < archs.length; i++) {
					const arch = archs[i];
					for (let j = 0; j < ids.length; j++) {
						if (arch.changedTick[ids[j]] > lastTick) {
							arch.iterDepth++;
							try {
								cb(arch);
							} finally {
								arch.iterDepth--;
							}
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
				if (arch.changedTick[ids[j]] > lastTick) {
					cb(arch);
					break;
				}
			}
		}
	}
}
