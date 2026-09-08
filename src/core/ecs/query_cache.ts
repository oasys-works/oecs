/***
 * The query host seam, the query resolver seam, and the one owner of every
 * query-resolution cache.
 *
 * `Store` implements `QueryHost`. `ECS` implements `QueryResolver` and holds
 * one `QueryCache`. `query.ts` reaches both through the resolver it is
 * constructed with, and never names this file at run time except for the
 * `QueryCache` constructor `ECS` calls once per world.
 *
 * Every map here is append-only. A query is minted once per unique term set
 * and lives for the world's lifetime, so no entry is ever invalidated. The
 * one warm read is the composition-map hit a derive takes, which stays a
 * `Map.get` at the call site in `query.ts`.
 ***/

import type { FrameTraceSink } from "./frame_trace";
import type { Archetype } from "./archetype";
import type { EntityID } from "./entity";
import type { ComponentDef, ComponentHandle } from "./component";
import type { SparseComponentID } from "./sparse_store";
import type { RelationDef } from "./relation";
import type { BitSet } from "../../type_primitives";
import type { ArchetypeTerm, QueryTerms } from "./query_terms";
import type { Query } from "./query";
import type { ChangedQuery } from "./changed_query";
import { bucketPush } from "./utils/arrays";

/** The query-driver seam on `Store`, the typed contract behind the
 * underscore members `ecs.ts` and the query internals reach. `Store`
 * implements this. The interface names the collaborator, so a host swap
 * touches no consumer.
 * `tick` and `trace` are deliberately mutable. `ECS.update()` sets the frame
 * tick, and `ECS.setTrace` installs the sink through this seam. */
export interface QueryHost {
	/** Frame tick, set by `ECS.update()` each frame. `ctx.ecsTick` reads it. */
	tick: number;
	/** Change tick, the stamp every write makes. Advanced before each system
	 * run, so a consumer can order a write against its own last run. */
	readonly changeTick: number;
	/** Advance the change tick and return the new value. The schedule calls
	 * it before each system run and before each phase flush. */
	advanceChangeTick(): number;
	/** Dev-only frame-trace sink (`ECS.setTrace`). Always null in prod. */
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
	/** The event registry and the relation service are reached by name off the
	 * store (`store.events`, `store.relations`), not through this seam. This
	 * interface stays the query driver's view of its host, and nothing else. */
	/** Second query-match path: sparse-term intersection. */
	forEachSparseMatch(
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void
	): void;
	/** Fourth query-match path: hierarchy depth ordering. */
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

export interface QueryCacheEntry {
	includeMask: BitSet;
	excludeMask: BitSet | null;
	anyOfMask: BitSet | null;
	query: Query<any>; // any: heterogeneous cache, different queries have different Defs tuples
}

/** One owner for every query-resolution cache. Previously the dedup
 * bucket map lived on `ECS` while `Query` populated the composition maps
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
	public readonly notSingle: Map<number, Query<any>> = new Map();
	public readonly orSingle: Map<number, Query<any>> = new Map();
	public readonly changedSingle: Map<number, ChangedQuery<any>> = new Map();
	// Optional fetch-if-present composition cache, dense cid keying,
	// same shape as the dense single caches above.
	public readonly optionalSingle: Map<number, Query<any>> = new Map();
	// Sparse-membership composition caches, same (parent_id << 16) | id
	// keying, the id is a SparseComponentID (a separate id space), so these
	// never collide with the dense maps.
	public readonly andSparseSingle: Map<number, Query<any>> = new Map();
	public readonly notSparseSingle: Map<number, Query<any>> = new Map();
	// Relation-wildcard `(R, *)` composition caches, keyed
	// (parent_id << 16) | relation_id, a separate Map from the sparse caches
	// because a `andRelation(R)` query also carries the relation id for its
	// `relationReads` access check.
	public readonly andRelationSingle: Map<number, Query<any>> = new Map();
	public readonly notRelationSingle: Map<number, Query<any>> = new Map();
	// Include-disabled composition cache, keyed by parent query id so
	// `q.includeDisabled()` returns a stable instance on repeated calls.
	public readonly includeDisabledSingle: Map<number, Query<any>> = new Map();
	// Hierarchy depth-ordering composition cache, keyed
	// (parent_id << 16) | relation_id. Only the unbounded form is cached, a
	// `maxDepth`-limited term adds a third key dimension and is the rarer
	// shape, so it mints fresh (hierarchy queries are built at registration,
	// not per tick).
	public readonly hierarchySingle: Map<number, Query<any>> = new Map();
	// Plugin archetype-term composition cache. A term is an object and carries
	// no id, so this keys on the term itself and then on the parent query id.
	// A `WeakMap` because the term belongs to the plugin and outlives nothing
	// here: a term the plugin drops takes its queries with it.
	public readonly whereSingle: WeakMap<ArchetypeTerm, Map<number, Query<any>>> = new WeakMap();

	/** Dedup lookup: bucket scan with full mask equality. A bucket holds few
	 * entries, so the scan is cheap. */
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
				anyOf === null ? e.anyOfMask === null : e.anyOfMask !== null && e.anyOfMask.equals(anyOf);
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
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		cb: (entityId: EntityID) => void
	): void;
	/** Backing sparse id of a relation, resolves a `(R, *)` wildcard term
	 * (`andRelation`) to the membership store the sparse-match path
	 * already drives. `api` names the query verb the caller used, so a world
	 * without the relations plugin faults with the verb it reached. */
	relationBackingSparseId(def: RelationDef, api: string): SparseComponentID;
	/** Third query-match path: `(*, T)`, drive iteration from the union of
	 * every relation's `sourcesOf(target)` (dedup + canonical sort), intersected
	 * with the dense mask + sparse terms + the enabled-row filter. Only entered via
	 * `Query.forEachRelatedTo`. */
	forEachTargetMatch(
		target: EntityID,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		terms: QueryTerms,
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
		terms: QueryTerms,
		denseArchetypes: readonly Archetype[],
		relation: RelationDef,
		maxDepth: number,
		cb: (entityId: EntityID) => void
	): void;
}
