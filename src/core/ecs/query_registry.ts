/***
 * QueryRegistry, the live set of registered queries and the mask resolver
 * that fills them.
 *
 * Extracted from `Store`, which keeps one-line delegations. Owns the
 * registered-query records and the two operations over them: resolving a mask
 * triple to the archetypes that match it, and fanning a newly-installed
 * archetype into every query whose masks it satisfies.
 *
 * What it does not own is the archetype topology. It reads the graph through
 * the closure host, the same way `ArchetypeGraph` reads the store's storage
 * lifecycle. The registry never creates an archetype and never writes one.
 *
 * Cold path, both ways. `matching` and `register` run on the query mint path
 * only, because `ECS.resolveQuery` answers a repeat call from its own dedup
 * cache and never reaches the store. `fanIn` runs once per archetype
 * creation, so it is amortised over every entity that later lands in that
 * archetype. Neither is on a per-entity or per-frame path.
 *
 * The result array a `register` call returns is live: this registry pushes
 * later archetypes into it, and the `Query` that holds it sees them without
 * asking. That is why the array is handed out mutable and never copied.
 ***/

import type { BitSet } from "../../type_primitives";
import { BITS_PER_WORD_MASK, BITS_PER_WORD_SHIFT } from "../../type_primitives";
import type { Archetype, ArchetypeID } from "./archetype";
import type { Query } from "./query";

/** What the registry needs from the archetype topology, closure-injected.
 *
 * Three reads, no writes. `archetypes` and `componentIndex` hand back the
 * graph's live arrays, which is safe because the graph is their sole writer
 * and an archetype is never removed. Creation and mint path only. */
export interface QueryRegistryHost {
	/** Every archetype, by id. Read when a query declares no required
	 * component and has to scan the whole set. */
	readonly archetypes: () => readonly Archetype[];
	/** Component id to the ascending archetype ids that hold it. The registry
	 * starts its superset scan from the smallest bucket. */
	readonly componentIndex: () => readonly ArchetypeID[][];
	/** One archetype by id. */
	readonly archetypeAt: (id: ArchetypeID) => Archetype;
}

/** One registered query: the masks it was minted with, the live result array
 * the `Query` holds, and a back reference for diagnostics. The masks are
 * copies, because a caller may pass a scratch mask it reuses. */
interface RegisteredQuery {
	includeMask: BitSet;
	excludeMask: BitSet | null;
	anyOfMask: BitSet | null;
	result: Archetype[];
	query: Query<any> | null;
}

export class QueryRegistry {
	private readonly _registered: RegisteredQuery[] = [];
	private readonly _host: QueryRegistryHost;

	constructor(host: QueryRegistryHost) {
		this._host = host;
	}

	/**
	 * Every archetype matching the given masks.
	 * Starts from the component with the fewest archetypes, which is the
	 * tightest starting point for the superset intersection.
	 */
	public matching(
		required: BitSet,
		excluded?: BitSet,
		anyOf?: BitSet
	): readonly Archetype[] {
		const words = required.words;
		let hasAnyBit = false;
		for (let i = 0; i < words.length; i++) {
			if (words[i] !== 0) {
				hasAnyBit = true;
				break;
			}
		}
		// Empty required mask → match all archetypes (only filter by exclude and any_of)
		if (!hasAnyBit) {
			const archs = this._host.archetypes();
			const result: Archetype[] = [];
			for (let i = 0; i < archs.length; i++) {
				const arch = archs[i];
				if (
					(!excluded || !arch.mask.overlaps(excluded)) &&
					(!anyOf || arch.mask.overlaps(anyOf))
				) {
					result.push(arch);
				}
			}
			return result;
		}

		// Find the smallest componentIndex bucket among all required components.
		// This is the tightest starting point for the superset intersection.
		const componentIndex = this._host.componentIndex();
		let smallestSet: readonly ArchetypeID[] | undefined;
		let hasEmpty = false;
		for (let wi = 0; wi < words.length; wi++) {
			let word = words[wi];
			if (word === 0) continue;
			const base = wi << BITS_PER_WORD_SHIFT;
			while (word !== 0) {
				// Extract lowest set bit
				const t = word & (-word >>> 0);
				const bit = base + (BITS_PER_WORD_MASK - Math.clz32(t));
				word ^= t;
				const bucket = componentIndex[bit];
				if (bucket === undefined || bucket.length === 0) {
					hasEmpty = true;
					break;
				}
				if (!smallestSet || bucket.length < smallestSet.length) smallestSet = bucket;
			}
			if (hasEmpty) break;
		}
		// If any required component has zero archetypes, no match is possible
		if (hasEmpty || !smallestSet) return [];

		const result: Archetype[] = [];
		for (let i = 0; i < smallestSet.length; i++) {
			const arch = this._host.archetypeAt(smallestSet[i]);
			if (
				arch.matches(required) &&
				(!excluded || !arch.mask.overlaps(excluded)) &&
				(!anyOf || arch.mask.overlaps(anyOf))
			) {
				result.push(arch);
			}
		}
		return result;
	}

	/**
	 * Register a live query. Returns a mutable `Archetype[]` that `fanIn`
	 * pushes newly-created matching archetypes into, keeping the query always
	 * up to date.
	 *
	 * **Mask ownership: borrowed.** Each mask is copied into the record here,
	 * so a caller may pass a scratch mask it intends to reuse.
	 */
	public register(include: BitSet, exclude?: BitSet, anyOf?: BitSet): Archetype[] {
		const result = this.matching(include, exclude, anyOf) as Archetype[];
		this._registered.push({
			includeMask: include.copy(),
			excludeMask: exclude ? exclude.copy() : null,
			anyOfMask: anyOf ? anyOf.copy() : null,
			result,
			query: null
		});
		return result;
	}

	/** Attach the `Query` that owns `result`, found by array identity. The
	 * back reference is for diagnostics, and the caller makes this call right
	 * after `register`. */
	public updateRef(result: Archetype[], query: Query<any>): void {
		const registered = this._registered;
		for (let i = 0; i < registered.length; i++) {
			if (registered[i].result === result) {
				registered[i].query = query;
				return;
			}
		}
	}

	/** Push a newly-installed archetype into every registered query whose
	 * masks it satisfies. No epoch bump, see the note in
	 * `ArchetypeGraph._install`. Once per archetype creation. */
	public fanIn(archetype: Archetype): void {
		const registered = this._registered;
		for (let i = 0; i < registered.length; i++) {
			const rq = registered[i];
			if (
				archetype.matches(rq.includeMask) &&
				(!rq.excludeMask || !archetype.mask.overlaps(rq.excludeMask)) &&
				(!rq.anyOfMask || archetype.mask.overlaps(rq.anyOfMask))
			) {
				rq.result.push(archetype);
			}
		}
	}
}
