/***
 * Query and QueryBuilder. The read side of the system-facing interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. Iterate with forEach(), which yields non-empty
 * archetypes. Use arch.getColumnRead() to access SoA columns, then
 * write the inner loop over arch.entityCount.
 *
 * QueryBuilder is the entry point for creating queries inside
 * registerSystem(fn, qb => qb.and(Pos, Vel)).
 *
 * The write side is `system_context.ts`. A system reaches this file for the
 * rows it iterates and that one for the values it changes.
 *
 * A query carries two kinds of term. A dense term sets a bit in the component
 * mask and picks the archetypes. Every other term rides in one `QueryTerms`
 * record, leaves the mask alone, and lets a derived query share the parent's
 * live archetype list. Read `QueryTerms` before adding a term.
 *
 * Usage (inside a system):
 *
 *   q.forEach((arch) => {
 *     const px = arch.getColumnRead(Pos, "x");
 *     const py = arch.getColumnRead(Pos, "y");
 *     const vx = arch.getColumnRead(Vel, "vx");
 *     const vy = arch.getColumnRead(Vel, "vy");
 *     for (let i = 0; i < arch.entityCount; i++) {
 *       // reads only. Mutate with ctx.ref or ctx.setField (bumps change tick)
 *       sum += px[i] + py[i] + vx[i] + vy[i];
 *     }
 *   });
 *
 * Three words name every connective, in every form. `and` requires, `not`
 * excludes, `or` requires one of a set. A term outside the archetype takes the
 * same word with the storage after it:
 *
 *   q.and(Energy)             require Energy
 *   q.not(Frozen)             exclude archetypes with Frozen
 *   q.or(Sprite, Mesh)        require one of these, or both
 *   q.andSparse(Selected)     require sparse membership
 *   q.notSparse(Selected)     exclude sparse membership
 *   q.andRelation(ChildOf)    require any (R, *) pair
 *   q.notRelation(ChildOf)    exclude a source of any (R, *) pair
 *   q.optional(Vel)           fetch Vel if present. Match either way
 *
 * `and`, `not` and `or` are functionally complete over archetype membership.
 * Every predicate over a component mask is one of their compositions, thus no
 * fourth connective exists and none is coming.
 *
 * The free `and`, `or` and `not` build a nested expression for `where`, over
 * the same three words: `q.where(or(and(Pos, Vel), Frozen))`. An expression
 * judges the dense component mask alone. Sparse membership and relation
 * membership are per entity, outside the archetype, so they stay on
 * `andSparse`, `notSparse`, `andRelation` and `notRelation`.
 *
 * An optional term (Bevy `Option<&T>`, flecs `?`) does not narrow the
 * matched set. It stays at the required terms, spanning archetypes that hold
 * `T` and archetypes that do not. Read the column per archetype span via
 * `arch.getOptionalColumnRead(T, field)`, which returns the column or
 * `undefined` (absent span). Like the sparse terms, it doesn't touch the dense
 * mask, so the derived query reuses this one's live archetype list.
 *
 ***/

import type { Archetype, ArchetypeView } from "./archetype";
import { _setIterAllRows } from "./archetype";
import type { EntityID } from "./entity";
import type { ComponentDef, ComponentID } from "./component";
import type { SparseComponentDef, SparseComponentID } from "./sparse_store";
import type { RelationDef } from "./relation";
import { BitSet } from "../../type_primitives";
import { ECSError, ECS_ERROR } from "./utils/error";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";
import {
	HIERARCHY_UNBOUNDED,
	NO_TERMS,
	appendOptional,
	appendRelation,
	appendSparse,
	deriveTerms,
	termCacheKey
} from "./query_terms";
import type { ArchetypeTerm, HierarchyTerm, QueryTerms } from "./query_terms";
import type { QueryResolver } from "./query_cache";
import { ChunkColumns } from "./chunk_columns";
import { ChangedQuery } from "./changed_query";

export class Query<Defs extends readonly ComponentDef[]> {
	private readonly _archetypes: Archetype[];
	// Public-readonly, as `include` and `id` below are, so a run
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
	// The non-dense terms, one frozen record (see `QueryTerms`). A query that
	// declares none holds the shared `NO_TERMS`, which is the identity
	// `_carryNondense` tests. No term here touches the dense mask, so a derived
	// query reuses this one's live `_archetypes` array: the store keeps pushing
	// newly-created archetypes into it, and both queries stay live off one
	// `registerQuery`.
	public readonly terms: QueryTerms;
	// `terms.includesDisabled`, copied out at construction. The iteration bound
	// is chosen from it on every `entityCount`, `firstEntity` and `forEach`
	// call, and reading it through `terms` there costs a second load on a path
	// measured in single-digit nanoseconds. The constructor is the only writer
	// and `terms` is frozen, so the copy cannot drift.
	public readonly includesDisabled: boolean;

	constructor(
		archetypes: Archetype[],
		defs: Defs,
		resolver: QueryResolver,
		include: BitSet,
		exclude: BitSet | null,
		anyOf: BitSet | null,
		id: number,
		terms: QueryTerms = NO_TERMS
	) {
		this._archetypes = archetypes;
		this.defs = defs;
		this._resolver = resolver;
		this.include = include;
		this._exclude = exclude;
		this._anyOf = anyOf;
		this.id = id;
		this.terms = terms;
		this.includesDisabled = terms.includesDisabled;
	}

	/** Guard the dense-only methods `count`, `forEach` and `archetype_count`
	 * against a query carrying sparse terms. These walk the dense archetype
	 * list and never consult `sparseIncludes` or `sparseExcludes`, so on a
	 * sparse-derived query they would fail open, returning the unfiltered dense
	 * result instead of the sparse-filtered one. Throw in `DEV` (compiled
	 * out of prod) steering the caller to `forEachEntity`, the only path that
	 * honors sparse membership. Mirrors `ChangedQuery`'s dev-guard on its
	 * include-mask invariant. */
	private _assertDenseOnly(method: string): void {
		if (
			this.terms.sparseIncludes.length > 0 ||
			this.terms.sparseExcludes.length > 0 ||
			this.terms.relationIncludes.length > 0 ||
			this.terms.relationExcludes.length > 0 ||
			this.terms.hierarchyTerm !== null
		) {
			throw new ECSError(
				ECS_ERROR.SPARSE_QUERY_DENSE_PATH,
				`Query.${method} walks the dense archetype list alone, and this query carries a term it cannot see: andSparse, notSparse, andRelation, notRelation or hierarchy. Iterate it with forEachEntity instead.`
			);
		}
	}

	/** Refuse a reader that answers from the unfiltered dense list. Three do:
	 * `archetypeCount`, `archetypes` and `excludeWords`. Each would report the
	 * archetypes the mask picked and not the ones the term kept, which is a
	 * wider set and a wrong answer. Dev-only, and prod keeps the reader. */
	private _assertNoArchetypeTerm(method: string): void {
		const terms = this.terms.archetypeTerms;
		if (terms.length === 0) return;
		throw new ECSError(
			ECS_ERROR.QUERY_TERM_DENSE_PATH,
			`Query.${method} answers from the dense archetype list, and this query carries the archetype term ${terms[0].name}, which narrows that list. Read the matched archetypes with forEach instead.`
		);
	}

	/** Whether this query carries only dense terms, the precondition for the
	 * archetype-walk fast paths (`entityCount`, `firstEntity`, `singleEntity`). */
	private _isDenseOnly(): boolean {
		return (
			this.terms.sparseIncludes.length === 0 &&
			this.terms.sparseExcludes.length === 0 &&
			this.terms.relationIncludes.length === 0 &&
			this.terms.relationExcludes.length === 0 &&
			this.terms.hierarchyTerm === null
		);
	}

	/** First matching entity, or `undefined` when the query matches none, the
	 * singleton read (`player`, `camera`) without hand-rolling a forEach +
	 * closure capture. Dense-only queries answer from the
	 * first non-empty archetype in O(archetypes). A query with a sparse, relation
	 * or hierarchy term falls back to a full `forEachEntity` walk.
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
		if (DEV) this._assertNoArchetypeTerm("archetypeCount");
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
	/** @internal The exclude-mask as raw words, or `null` when the query has no
	 * `not` term. A worker resolves the matched archetypes from the masks
	 * alone, so the parallel plan carries these words to the pool. */
	public get excludeWords(): readonly number[] | null {
		if (DEV) this._assertNoArchetypeTerm("excludeWords");
		return this._exclude === null ? null : this._exclude.words;
	}

	public get archetypes(): readonly ArchetypeView<Defs>[] {
		if (DEV) this._assertNoArchetypeTerm("archetypes");
		return this._archetypes;
	}

	/** Carry this query's non-dense terms, optional fetch-if-present and
	 * sparse membership, onto a freshly composed dense query. `and`,
	 * `not` and `or` build the new dense mask via `resolveQuery`, which is
	 * keyed on the mask alone and so hands back a query carrying none of these
	 * terms. An earlier version silently dropped them, which made composition
	 * order-dependent (`q.optional(V).and(H)` lost `V`, `q.and(H).optional(V)`
	 * kept it). When this query carries no non-dense terms (the common case)
	 * `base` is already correct and returned as-is, preserving the mask-cached
	 * singleton with zero allocation. Otherwise re-derive on top of `base`'s dense
	 * state, threading the terms forward so composition is symmetric regardless of
	 * order. Reading `base`'s private fields is allowed, same-class instance. */
	private _carryNondense(base: Query<any>): Query<any> {
		// One reference comparison. `deriveTerms` collapses an empty result back
		// to the shared `NO_TERMS`, so this identity holds for a query that
		// derived its way back to declaring no term, not only for a fresh one.
		if (this.terms === NO_TERMS) return base;
		return new Query(
			base._archetypes,
			base.defs,
			this._resolver,
			base.include,
			base._exclude,
			base._anyOf,
			this._resolver.nextQueryId(),
			this.terms
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
		// `_carryNondense`, the GC churn and query-id climb toward
		// `CACHE_KEY_HALF_LIMIT` already fixed for `andSparse`.
		let q: Query<any> = this;
		for (let i = 0; i < comps.length; i++) q = q.and(comps[i]);
		return q as Query<[...Defs, ...D]>;
	}

	/** @internal, cold cache-miss path for single-arg `and`, split out so
	 * the hot `and` body is only key-compute + cache hit. The miss path runs once
	 * per unique composition, then every repeat is a cache hit. Keeping it out of
	 * line shrinks `and`'s inlined footprint when several composes share one hot
	 * function (the `query_compose` shape). Same rationale for `_notMiss`,
	 * `_orMiss` and `_changedMiss`. */
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
	public not(...comps: ComponentDef[]): Query<Defs> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.notSingle.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._notMiss(cid, key);
		}
		// Fold through the single-arg cached path, mirroring `and`, keeps the
		// result stable and avoids minting query-ids on a non-dense receiver.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.not(comps[i]);
		return q;
	}

	/** @internal, cold cache-miss path for single-arg `not`. See `_andMiss`. */
	private _notMiss(cid: number, key: number): Query<Defs> {
		const newExclude = this._exclude ? this._exclude.copy() : new BitSet();
		newExclude.set(cid);
		const result = this._carryNondense(
			this._resolver.resolveQuery(this.include, newExclude, this._anyOf, this.defs)
		) as Query<Defs>;
		this._resolver.caches.notSingle.set(key, result);
		return result;
	}

	/** Require a sparse component: match only entities that hold it,
	 * across every archetype. A sparse term doesn't touch the dense mask, so
	 * the returned (cached) query reuses this one's live archetype list. It is
	 * iterated via `forEachEntity`, never `forEach` (sparse members are
	 * scattered within archetypes, so there is no SoA column span to yield). */
	public andSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._andSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache one id at a time, so every
		// prefix is cached. A repeated `andSparse(A, B)` then returns the
		// identical Query, the multi-arg form used to bypass the cache and
		// mint a fresh Query + id + term arrays on every call (GC churn on the hot
		// path, and an unbounded climb toward the SPARSE_CACHE_KEY_OVERFLOW bound).
		// The fold also makes `andSparse(A, B)` the same instance as the chained
		// `andSparse(A).andSparse(B)`.
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._andSparseOne(defs[i] as unknown as number);
		return q;
	}

	/** One-id `andSparse` composition, cached on `(parent_id, sparseId)` in
	 * the resolver's shared single-term map. Both the single- and multi-arg public
	 * forms fold over this, so all sparse-require composition is deduplicated. */
	private _andSparseOne(sid: number): Query<Defs> {
		const key = termCacheKey(this.id, sid);
		const cache = this._resolver.caches.andSparseSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			appendSparse(this.terms.sparseIncludes, sid),
			this.terms.sparseExcludes
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude a sparse component: drop entities that hold it. Same
	 * dense-list reuse and `forEachEntity` iteration as `andSparse`. */
	public notSparse(...defs: SparseComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._notSparseOne(defs[0] as unknown as number);
		// Multi-arg: fold through the single-term cache, same as `andSparse`.
		// Each prefix is cached, so a repeated `notSparse(A, B)`
		// returns the identical Query instead of allocating one per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._notSparseOne(defs[i] as unknown as number);
		return q;
	}

	/** One-id `notSparse` composition, cached on `(parent_id, sparseId)`. The
	 * multi-arg form folds over this, mirrors `_andSparseOne`. */
	private _notSparseOne(sid: number): Query<Defs> {
		const key = termCacheKey(this.id, sid);
		const cache = this._resolver.caches.notSparseSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveSparse(
			this.terms.sparseIncludes,
			appendSparse(this.terms.sparseExcludes, sid)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new sparse terms. Reuses this query's
	 * dense state by reference, the masks are never mutated in place (`and`,
	 * `not` and `or` copy before mutating), and `_archetypes` is the same
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
			deriveTerms(this.terms, { sparseIncludes, sparseExcludes })
		);
	}

	/** Narrow the matched archetypes by an expression, or by a term a plugin
	 * built.
	 *
	 * A chained term asks one flat question of the mask. An expression nests,
	 * so `q.where(or(and(Pos, Vel), Frozen))` says what no chain says. Build it
	 * from the free `and`, `or` and `not`, which take a component definition as
	 * a leaf and each other as a node.
	 *
	 * A plugin supplies its own `ArchetypeTerm` instead, and `where` accepts it
	 * on the same footing.
	 *
	 * It composes both ways. `q.where(t).not(D)` and `q.not(D).where(t)`
	 * are the same set, because the derive threads the terms record forward the
	 * way every other non-dense term is threaded.
	 *
	 * What it costs. One predicate call per archetype, per query, at the
	 * rebuild the store's dirty epoch triggers. `forEach`, `forEachChunk` and
	 * `forEachEntity` are untouched: they walk the list the rebuild produced.
	 *
	 * What it refuses. `archetypeCount`, `archetypes` and `excludeWords` all
	 * answer from the unfiltered dense list, so a term-carrying query refuses
	 * them in a dev build rather than answering too wide.
	 *
	 * Cached per (term, parent query), so a repeated call gives one instance. */
	public where(term: ArchetypeTerm): Query<Defs> {
		const cache = this._resolver.caches.whereSingle;
		let byQuery = cache.get(term);
		if (byQuery === undefined) {
			byQuery = new Map();
			cache.set(term, byQuery);
		}
		const cached = byQuery.get(this.id);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = new Query<Defs>(
			this._archetypes,
			this.defs,
			this._resolver,
			this.include,
			this._exclude,
			this._anyOf,
			this._resolver.nextQueryId(),
			deriveTerms(this.terms, { archetypeTerms: [...this.terms.archetypeTerms, term] })
		);
		byQuery.set(this.id, result);
		return result;
	}

	/** Require the `(R, *)` wildcard: match only sources that hold **any**
	 * target under relation `R`. "Has any `(R, *)` pair" is exactly membership in
	 * R's backing sparse store (exclusive `{target}` row and multi tag), so this is a
	 * relation-typed front door over `andSparse`. It pushes R's backing sparse
	 * id onto `sparseIncludes` and reuses the `forEachEntity` sparse-match path
	 * (insertion order, canonical sorting is reserved for `stateHash`/snapshot, and
	 * costs much more here for no determinism benefit).
	 * Membership semantics: each source once. Fetch its targets with
	 * `ctx.targetsOf(e, R)`. Requires `relationReads: [R]` (checked at iteration).
	 * Cached per `(parent_id, relation_id)` like the sparse terms. */
	public andRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._andRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._andRelationOne(defs[i]);
		return q;
	}

	private _andRelationOne(def: RelationDef): Query<Defs> {
		const key = termCacheKey(this.id, def as unknown as number);
		const cache = this._resolver.caches.andRelationSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver.relationBackingSparseId(def, "query.andRelation");
		const result = this._deriveRelation(
			appendSparse(this.terms.sparseIncludes, sid as unknown as number),
			this.terms.sparseExcludes,
			appendRelation(this.terms.relationIncludes, def),
			this.terms.relationExcludes
		);
		cache.set(key, result);
		return result;
	}

	/** Exclude the `(R, *)` wildcard: drop sources that hold any target
	 * under `R`. Mirror of `andRelation` on the exclude side (pushes R's
	 * backing sparse id onto `sparseExcludes`). */
	public notRelation(...defs: RelationDef[]): Query<Defs> {
		if (defs.length === 1) return this._notRelationOne(defs[0]);
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._notRelationOne(defs[i]);
		return q;
	}

	private _notRelationOne(def: RelationDef): Query<Defs> {
		const key = termCacheKey(this.id, def as unknown as number);
		const cache = this._resolver.caches.notRelationSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const sid = this._resolver.relationBackingSparseId(def, "query.notRelation");
		const result = this._deriveRelation(
			this.terms.sparseIncludes,
			appendSparse(this.terms.sparseExcludes, sid as unknown as number),
			this.terms.relationIncludes,
			appendRelation(this.terms.relationExcludes, def)
		);
		cache.set(key, result);
		return result;
	}

	/** Build a derived query carrying new relation-wildcard terms. Threads the
	 * backing-sparse ids (which the driver actually consumes) plus the relation
	 * ids (which only the `DEV` access check consumes), reusing the dense,
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
			deriveTerms(this.terms, {
				sparseIncludes,
				sparseExcludes,
				relationIncludes,
				relationExcludes
			})
		);
	}

	/** Order this query's matched entities in **hierarchy depth order** over the
	 * exclusive relation `R`, parents before children, and (optionally) drop any
	 * deeper than `maxDepth` (flecs `cascade`, bitECS `Hierarchy()`). The
	 * matched set is unchanged, still the dense mask plus the sparse, `(R, *)`
	 * and disabled terms. `.hierarchy(R)` only reorders and depth-limits it, so an entity with
	 * no `R`-parent is a root at depth 0 and still yielded (first). The canonical
	 * order is depth ascending, then **entity index ascending within each depth
	 * band**, a total, insertion-order-independent order (identical across lockstep
	 * peers), produced by an O(K) radix on the entity index, never a comparator sort.
	 *
	 * Iterate with `forEachEntity`: members scatter across archetypes, so there is
	 * no SoA column span, and `forEach` and `count` reject a hierarchy query (like
	 * a sparse term). Exclusive relations only, which matches the traversal
	 * constraint. A multi relation throws `RELATION_MODE_MISMATCH` at iteration, and a
	 * cycle is a loud `RELATION_CYCLE` in `DEV` (a safe break in production).
	 * Requires `relationReads: [R]` (checked at iteration). Carried through
	 * `and`, `not` and `or` like the sparse terms (`_carryNondense`).
	 *
	 * `Defs` is unchanged, `R` is an ordering, not a required component (like
	 * `not` and `or`). Returns a new query. The unbounded form is cached. */
	public hierarchy(
		relation: RelationDef<"exclusive">,
		maxDepth: number = HIERARCHY_UNBOUNDED
	): Query<Defs> {
		if (DEV) {
			if (this.terms.hierarchyTerm !== null) {
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
	 * query's dense, sparse, optional, disabled and relation-wildcard state by
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
			deriveTerms(this.terms, { hierarchyTerm })
		);
	}

	/** Assert every `(R, *)` wildcard term on this query was declared in the
	 * system's `relationReads`. Iteration-time (`forEachEntity` and
	 * `forEachRelatedTo`), not construction-time, so it is robust to queries
	 * built outside a system, same rationale as the data-op checks. `DEV` only
	 * outside a system `assertRelationRead` is a no-op. */
	private _assertRelationAccess(): void {
		for (let i = 0; i < this.terms.relationIncludes.length; i++) {
			accessCheck.assertRelationRead(this.terms.relationIncludes[i]);
		}
		for (let i = 0; i < this.terms.relationExcludes.length; i++) {
			accessCheck.assertRelationRead(this.terms.relationExcludes[i]);
		}
	}

	/** Iterate every source related to `target` under **any** relation, the
	 * `(*, T)` wildcard, intersected with this query's dense + sparse +
	 * `(R, *)` + disabled predicate, each source yielded once in ascending-EntityID
	 * order (the `sourcesOf` and `sourcesOfAny` convention). `target` is supplied
	 * here rather than as a chained term because it is a runtime `EntityID`: baking
	 * it into a cached `Query` would key the cache on a recycled value and churn
	 * query-ids, and `(*, T)` is the rare or cold shape. Composes with
	 * `andRelation`, `andSparse` and dense terms on the receiver. Reads
	 * every relation's reverse index, so the system must declare
	 * `relationReads: [ANY_RELATION]` (plus `[R]` for any composed `andRelation`).
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
			this.terms,
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
	 * span). The term is carried through `and`, `not` and `or` (see
	 * `_carryNondense`), so it survives composition in any order. Returns a new
	 * (cached) Query.
	 *
	 * `Defs` is unchanged (the optional `T` is not a required component, like
	 * `not` and `or`). Column types come from the accessor's own generics. */
	public optional(...defs: ComponentDef[]): Query<Defs> {
		if (defs.length === 1) return this._optionalOne(defs[0].id);
		// Multi-arg folds through the single-term cache one id at a time, so every
		// prefix is cached and `optional(A, B)` is the same instance as the chained
		// `optional(A).optional(B)` (mirrors `and` and `andSparse`).
		let q: Query<Defs> = this;
		for (let i = 0; i < defs.length; i++) q = q._optionalOne(defs[i].id);
		return q;
	}

	/** One-id `optional` composition, cached on `(parent_id << 16) | cid` in the
	 * resolver's shared single-term map (dense cid <= 128, same packing as the
	 * `and`, `not` and `or` caches). */
	private _optionalOne(cid: number): Query<Defs> {
		const key = ((this.id << 16) | cid) >>> 0;
		const cache = this._resolver.caches.optionalSingle;
		const cached = cache.get(key);
		if (cached !== undefined) return cached as Query<Defs>;
		const result = this._deriveOptional(appendOptional(this.terms.optionalTerms, cid));
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
			deriveTerms(this.terms, { optionalTerms })
		);
	}

	/** Opt this query back in to disabled entities. By default a query
	 * excludes disabled entities (the iteration bound `arch.entityCount` is the
	 * enabled-row count). The returned (cached) query spans disabled rows too:
	 * `forEach` publishes the all-rows flag so the SoA loop's `arch.entityCount`
	 * reports `length`, and `count` and `forEachEntity` widen accordingly. Does not
	 * touch the dense mask, so it reuses this query's live archetype list and is
	 * carried through `and`, `not` or `or` like the sparse or optional terms. */
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
			deriveTerms(this.terms, { includesDisabled: true })
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
			accessCheck.enterOptionalScope(this.terms.optionalTerms);
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
	 * `run()` model and the koota `useStores` model, and the recommended hot-path default for
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
	 * disabled tail). Dense-only like `forEach`, so a sparse, relation or
	 * hierarchy term throws in `DEV`. Iterate those with `forEachEntity`.
	 */
	public forEachChunk(cb: (cols: ChunkColumns<Defs>, count: number) => void): void {
		// Include-disabled iteration: publish the all-rows flag so each
		// archetype's `entityCount` spans its disabled tail, then restore it
		// (re-entrancy-safe). Mirrors `forEach` and `some`, every dense
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
			accessCheck.enterOptionalScope(this.terms.optionalTerms);
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
			accessCheck.enterOptionalScope(this.terms.optionalTerms);
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
			accessCheck.enterOptionalScope(this.terms.optionalTerms);
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
	 * carries a `andSparse` or a `notSparse` term. Members are scattered
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
	 * traversal. This is sharper than for dense `forEach`. `ctx.addSparse` and
	 * `ctx.addRelation` apply immediately (no archetype transition to defer),
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
		if (this.terms.hierarchyTerm !== null) {
			if (DEV) accessCheck.assertRelationRead(this.terms.hierarchyTerm.relation);
			this._resolver.forEachHierarchyMatch(
				this.include,
				this._exclude,
				this._anyOf,
				this.terms,
				this.nonEmptyArchs(),
				this.terms.hierarchyTerm.relation,
				this.terms.hierarchyTerm.maxDepth,
				cb
			);
			return;
		}
		this._resolver.forEachSparseMatch(
			this.include,
			this._exclude,
			this._anyOf,
			this.terms,
			this.nonEmptyArchs(),
			cb
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
	 * allocation per epoch advance, and only on a boundary crossing. The
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
		// A plugin term narrows the set, and it takes its own body. One
		// predicted test keeps the loops below exactly as they were for every
		// query the core builds.
		if (this.terms.archetypeTerms.length !== 0) {
			this._rebuildFiltered(epoch);
			return;
		}
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

	/** @internal, the rebuild of a query that carries plugin archetype terms.
	 * Same non-empty filter as `_rebuildNonEmpty`, with every term consulted
	 * for each surviving archetype. Separate body so a query with no term
	 * never loads a term list. */
	private _rebuildFiltered(epoch: number): void {
		const src = this._archetypes;
		const terms = this.terms.archetypeTerms;
		const all = this.includesDisabled;
		const dst: Archetype[] = [];
		outer: for (let i = 0; i < src.length; i++) {
			const arch = src[i];
			if ((all ? arch.totalCount : arch.enabledCount) === 0) continue;
			for (let t = 0; t < terms.length; t++) {
				if (!terms[t].matches(arch.mask)) continue outer;
			}
			dst.push(arch);
		}
		this._nonEmptyArchetypes = dst;
		this._lastSeenEpoch = epoch;
	}

	/** Require at least one of these components. */
	public or(...comps: ComponentDef[]): Query<Defs> {
		if (comps.length === 1) {
			const cid = comps[0].id;
			const key = ((this.id << 16) | cid) >>> 0;
			const cached = this._resolver.caches.orSingle.get(key);
			if (cached !== undefined) return cached as Query<Defs>;
			return this._orMiss(cid, key);
		}
		// Fold through the single-arg cached path. Successive `or` calls
		// union into one anyOf mask (single-arg copies the mask and adds the bit),
		// so `or(A, B)` ≡ `or(A).or(B)`, "match at least one of {A,B}",
		// and is now cached and stable instead of minting a query-id per call.
		let q: Query<Defs> = this;
		for (let i = 0; i < comps.length; i++) q = q.or(comps[i]);
		return q;
	}

	/** @internal, cold cache-miss path for single-arg `or`. See `_andMiss`. */
	private _orMiss(cid: number, key: number): Query<Defs> {
		const newAnyOf = this._anyOf ? this._anyOf.copy() : new BitSet();
		newAnyOf.set(cid);
		const result = this._carryNondense(
			this._resolver.resolveQuery(this.include, this._exclude, newAnyOf, this.defs)
		) as Query<Defs>;
		this._resolver.caches.orSingle.set(key, result);
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
	 *  The returned ChangedQuery is composable. `and`, `not`, `or` and
	 *  `optional` refine it further, so `q.changed(Pos).not(Dead)` works, and
	 *  is the same set as `q.not(Dead).changed(Pos)`. */
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

	/** Require these components. The first link of the chain takes the same
	 * word as every later link, so `qb.and(Pos).and(Vel)` and `qb.and(Pos, Vel)`
	 * read alike and mean one thing. */
	public and<T extends ComponentDef[]>(...defs: T): Query<T> {
		const mask = new BitSet();
		for (let i = 0; i < defs.length; i++) mask.set(defs[i].id);
		return this._resolver.resolveQuery(mask, null, null, defs);
	}
}
