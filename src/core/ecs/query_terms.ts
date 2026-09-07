/***
 * The query term vocabulary, and the record that carries every term outside
 * the dense component mask.
 *
 * A dense term sets a bit in the component mask and picks the archetypes.
 * Every other term rides in one `QueryTerms` record, leaves the mask alone,
 * and lets a derived query share the parent's live archetype list.
 *
 * `and`, `or` and `not` build a nested `ArchetypeTerm` for `Query.where`.
 * They are functionally complete over archetype membership, thus no fourth
 * connective exists and none is coming.
 *
 * This file holds no iteration. Every function here runs once per derive, on
 * a query cache miss, and never per row. `query.ts` owns the rows.
 ***/

import type { ComponentDef, ComponentID } from "./component";
import type { SparseComponentID } from "./sparse_store";
import type { RelationDef } from "./relation";
import type { BitSet } from "../../type_primitives";
import { componentDebugName } from "./debug_names";
import { ECSError, ECS_ERROR } from "./utils/error";
import { DEV } from "../../dev_flag";

// Frozen empty sparse-term list, shared by every dense-only Query so the
// common path allocates no per-query arrays.
const NO_SPARSE_TERMS: readonly SparseComponentID[] = Object.freeze([]);

// Frozen empty optional-term list, shared by every Query without an optional
// fetch term, same zero-alloc rationale as NO_SPARSE_TERMS.
const NO_OPTIONAL_TERMS: readonly ComponentID[] = Object.freeze([]);

// Frozen empty relation-wildcard-term list, shared by every Query without a
// `(R, *)` term, same zero-alloc rationale. These lists exist only for the
// `DEV` `relationReads` access check (`_assertRelationAccess`). The driver
// reads the relation's backing sparse id off `sparseIncludes`, never this.
const NO_RELATION_TERMS: readonly RelationDef[] = Object.freeze([]);

/** The non-dense query terms, carried as one frozen record.
 *
 * Every term here leaves the dense component mask alone, so a query that
 * carries one still shares its parent's live archetype list. They travel
 * together through each derive (`and`, `not`, `or`) and through each
 * driver seam below, so one parameter replaces the run of positional lists
 * those signatures used to repeat.
 *
 * A query that carries none of them holds `NO_TERMS`. That is why
 * `_carryNondense` decides with one reference comparison, where it used to
 * test each term in turn. The old shape spread one term across a constructor
 * parameter, a carry test and a `new Query` argument, and a term added to two
 * of the three went unnoticed. Add a term by adding a field here and a line to
 * `deriveTerms`.
 *
 * Cold path. Read once per `forEach` call, never per row. */
/** An archetype-level term a plugin contributes.
 *
 * The engine already answers three archetype questions with a bit mask: hold
 * these, hold none of these, hold one of these. A term answers a fourth in
 * whatever way the plugin wants, over the same input. `or(and(A, B), C)` is
 * one, and so is any predicate over the component mask.
 *
 * Where it runs. Once per archetype, per query, at the rebuild the store's
 * dirty epoch triggers. Never per row, and never per drive. A query that
 * carries no term reaches a rebuild body byte-identical to today's.
 *
 * What the caller guarantees. `matches` is pure and stable: one archetype
 * gives one answer for the life of the world. The archetype list is rebuilt
 * from scratch on each epoch, so an unstable term does not corrupt the list,
 * but it does make the matched set depend on when the epoch last advanced,
 * which nothing else in the query engine does.
 *
 * Cold path. Build the term once and hold it. */
export interface ArchetypeTerm {
	/** Names the term in a dev refusal. Diagnostics only, never a cache key. */
	readonly name: string;
	/** True when an archetype whose component mask is `mask` belongs. */
	matches(mask: BitSet): boolean;
}

/** The terms of a query that declares no archetype term. Shared, so the
 * common path allocates nothing. */
const NO_ARCHETYPE_TERMS: readonly ArchetypeTerm[] = Object.freeze([]);

// ── Archetype expressions ──────────────────────────────────────

/** One operand of `and`, `or` or `not`. A component definition is a leaf, and
 * holding it is the whole question. Any `ArchetypeTerm` is a node, which is
 * how one combinator nests inside another. */
export type ArchetypeExpr = ComponentDef<any> | ArchetypeTerm;

// A definition is callable and a term is a plain object, so one `typeof`
// separates a leaf from a node. Resolving the matcher once at build time keeps
// the per-archetype call a direct closure call, not a branch per operand.
function exprMatcher(e: ArchetypeExpr): (mask: BitSet) => boolean {
	if (typeof e === "function") {
		const cid = e.id as number;
		return (mask: BitSet): boolean => mask.has(cid);
	}
	return (mask: BitSet): boolean => e.matches(mask);
}

// The short label, not `componentLabel`. An expression name nests, so the id
// suffix would repeat at every leaf and bury the shape the reader wants.
function exprName(e: ArchetypeExpr): string {
	if (typeof e === "function") return componentDebugName(e) ?? `component ${e.id as number}`;
	return e.name;
}

/** Every operand holds. `and()` over nothing matches every archetype, the
 * identity of the conjunction, so a fold over an empty list narrows nothing.
 *
 * Pair it with `where`: `q.where(and(Pos, Vel))`. Prefer `q.and(Pos, Vel)`
 * when the operands are a flat list of definitions, because a dense term sets
 * a mask bit and picks the archetypes, where an expression tests each one.
 *
 * Cold path. Build the expression once and hold it, because `where` caches on
 * the term's identity. */
export function and(...terms: ArchetypeExpr[]): ArchetypeTerm {
	const parts = terms.map(exprMatcher);
	const name = `and(${terms.map(exprName).join(", ")})`;
	return {
		name,
		matches(mask: BitSet): boolean {
			for (let i = 0; i < parts.length; i++) {
				if (!parts[i](mask)) return false;
			}
			return true;
		}
	};
}

/** One operand holds, or more. `or()` over nothing matches no archetype, the
 * identity of the disjunction. Cold path, same caching rule as `and`. */
export function or(...terms: ArchetypeExpr[]): ArchetypeTerm {
	const parts = terms.map(exprMatcher);
	const name = `or(${terms.map(exprName).join(", ")})`;
	return {
		name,
		matches(mask: BitSet): boolean {
			for (let i = 0; i < parts.length; i++) {
				if (parts[i](mask)) return true;
			}
			return false;
		}
	};
}

/** No operand holds. Several operands read as one negated disjunction, which
 * is the same set as the conjunction of each negation, so `not(A, B)` matches
 * exactly what `Query.not(A, B)` matches. `not()` over nothing matches every
 * archetype. Cold path, same caching rule as `and`. */
export function not(...terms: ArchetypeExpr[]): ArchetypeTerm {
	const parts = terms.map(exprMatcher);
	const name = `not(${terms.map(exprName).join(", ")})`;
	return {
		name,
		matches(mask: BitSet): boolean {
			for (let i = 0; i < parts.length; i++) {
				if (parts[i](mask)) return false;
			}
			return true;
		}
	};
}

export interface QueryTerms {
	/** Sparse membership a matched entity must hold. Also carries the backing
	 * sparse id of each `(R, *)` relation term, which is how the wildcard
	 * reuses the sparse-match driver unchanged. */
	readonly sparseIncludes: readonly SparseComponentID[];
	/** Sparse membership a matched entity must not hold. */
	readonly sparseExcludes: readonly SparseComponentID[];
	/** Fetch-if-present terms. Does not narrow the matched set. Authorizes
	 * `getOptionalColumnRead` under `DEV`. */
	readonly optionalTerms: readonly ComponentID[];
	/** Include disabled rows. Widens the iteration bound from the enabled
	 * count to the total count. */
	readonly includesDisabled: boolean;
	/** `(R, *)` terms, recorded for the `DEV` `relationReads` access check
	 * alone. The driver reads the backing sparse id off `sparseIncludes`. */
	readonly relationIncludes: readonly RelationDef[];
	readonly relationExcludes: readonly RelationDef[];
	/** Depth-ordering term. Reorders the matched entities, parents first. */
	readonly hierarchyTerm: HierarchyTerm | null;
	/** Archetype-level terms a plugin contributed. Narrows the matched set
	 * without touching the dense mask, so the derived query still shares the
	 * parent's live archetype list and the narrowing happens at the rebuild.
	 * Empty for every query the core builds. */
	readonly archetypeTerms: readonly ArchetypeTerm[];
}

/** The terms of a query that declares none. Shared by every dense-only query,
 * so the common path allocates nothing and `_carryNondense` compares one
 * reference. Frozen: a mutation here would reach every such query. */
export const NO_TERMS: QueryTerms = Object.freeze({
	sparseIncludes: NO_SPARSE_TERMS,
	sparseExcludes: NO_SPARSE_TERMS,
	optionalTerms: NO_OPTIONAL_TERMS,
	includesDisabled: false,
	relationIncludes: NO_RELATION_TERMS,
	relationExcludes: NO_RELATION_TERMS,
	hierarchyTerm: null,
	archetypeTerms: NO_ARCHETYPE_TERMS
});

/** Build the terms for a derived query.
 *
 * The result never equals `NO_TERMS`, and `_carryNondense` depends on that.
 * Every caller adds a term and none removes one, so a derive always widens the
 * record. The zero-argument forms (`optional()`, `andSparse()`) return the
 * receiver before they reach here, which is what keeps the rule true. A future
 * term that can be removed breaks it, and must collapse an emptied record back
 * to `NO_TERMS` here.
 *
 * Cold path: one call per cache miss on a derive, never per row. */
export function deriveTerms(base: QueryTerms, patch: Partial<QueryTerms>): QueryTerms {
	return Object.freeze({
		sparseIncludes: patch.sparseIncludes ?? base.sparseIncludes,
		sparseExcludes: patch.sparseExcludes ?? base.sparseExcludes,
		optionalTerms: patch.optionalTerms ?? base.optionalTerms,
		includesDisabled: patch.includesDisabled ?? base.includesDisabled,
		relationIncludes: patch.relationIncludes ?? base.relationIncludes,
		relationExcludes: patch.relationExcludes ?? base.relationExcludes,
		hierarchyTerm: patch.hierarchyTerm !== undefined ? patch.hierarchyTerm : base.hierarchyTerm,
		archetypeTerms: patch.archetypeTerms ?? base.archetypeTerms
	});
}

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
	/** Inclusive max depth to yield, where a root is 0. The walk skips an entity
	 * deeper than this. `HIERARCHY_UNBOUNDED` for no limit (bitECS `Hierarchy()`
	 * depth arg). */
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
// since cid < 128) latent risk on the query-id half.
const CACHE_KEY_HALF_LIMIT = 0x10000;
export function termCacheKey(queryId: number, sparseId: number): number {
	if (DEV && (queryId >= CACHE_KEY_HALF_LIMIT || sparseId >= CACHE_KEY_HALF_LIMIT)) {
		throw new ECSError(
			ECS_ERROR.SPARSE_CACHE_KEY_OVERFLOW,
			`sparse query cache key would overflow, queryId=${queryId} and sparseId=${sparseId} must each be < ${CACHE_KEY_HALF_LIMIT}`
		);
	}
	return ((queryId << 16) | sparseId) >>> 0;
}

// Append a sparse id to a term list, de-duplicating. Returns the same list
// (no allocation) when the id is already present, so `q.andSparse(R)`
// twice resolves to the identical term set. Term lists are tiny (a query has
// a handful of sparse terms at most), so the linear scan is free.
export function appendSparse(
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
export function appendOptional(terms: readonly ComponentID[], id: number): readonly ComponentID[] {
	for (let i = 0; i < terms.length; i++) {
		if ((terms[i] as number) === id) return terms;
	}
	return [...terms, id as ComponentID];
}

// Append a relation id to a `(R, *)` access-term list, de-duplicating.
// Same shape as `appendSparse`. Tiny lists, free linear scan.
export function appendRelation(terms: readonly RelationDef[], def: RelationDef): readonly RelationDef[] {
	for (let i = 0; i < terms.length; i++) {
		if ((terms[i] as number) === (def as number)) return terms;
	}
	return [...terms, def];
}
