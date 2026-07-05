/***
 * ArchetypeGraph — archetype topology: mask → archetype resolution/creation,
 * add/remove edge caching, and the inverted component index (H1 step 6).
 *
 * Owns the graph STATE (`archetypes`, the hash-bucketed mask map, the
 * monotonic id counter, `componentIndex`) and the topology operations over
 * it. What it does NOT own is the storage lifecycle: extending the SAB for a
 * new archetype's column region, materialising the `Archetype` object over
 * the live column store, and fanning a new archetype into registered
 * queries all stay on `Store`, reached through the closure host — the same
 * storage-vs-orchestration split as `SnapshotService`'s mount seam. The
 * graph never touches `_columnStore`.
 *
 * Hot-path notes (#368 discipline): `get` / `resolveAdd` / `resolveRemove`
 * are called per structural op; both resolve paths are edge-cache hits on
 * the steady state (one array index + one property read). `archetypes` and
 * `componentIndex` are exposed as the live arrays so Store's flush loops
 * can hoist them to locals once per flush — the graph is their sole writer,
 * and archetypes are never removed, so a hoisted reference stays valid.
 */

import { BitSet, type TypedArrayTag } from "../../type_primitives";
import {
	Archetype,
	asArchetypeId,
	buildTransitionMap,
	type ArchetypeColumnLayout,
	type ArchetypeEdge,
	type ArchetypeID
} from "./archetype";
import type { ComponentID } from "./component";
import type { ComponentMeta } from "./store";
import { ECS_ERROR, ECSError } from "./utils/error";
import { bucketPush } from "./utils/arrays";
import {
	COMPONENT_MASK_WORDS,
	TYPED_ARRAY_TAG_TO_TYPE_TAG,
	type ArchetypeSpec,
	type ColumnSpec
} from "../store";
import { DEV } from "../../dev_flag";

/** What the graph needs from `Store` — closure-injected. `extendStore` and
 * `materialize` bind the storage lifecycle (SAB extend + column-store views
 * + grow handler) on the Store side; `fanIntoQueries` binds query-registry
 * state. All are creation-path only — never called on an edge-cache hit. */
export interface ArchetypeGraphHost {
	/** Component field metadata, indexed by ComponentID — for building a new
	 * archetype's column layouts. */
	readonly componentMetas: () => readonly ComponentMeta[];
	/** Row capacity for a new archetype's column region. */
	readonly initialCapacity: () => number;
	/** Extend the SAB with the new archetypes' column regions (one call for
	 * the whole batch — the bulk path's O(N²)→O(N) win, #213). */
	readonly extendStore: (specs: ArchetypeSpec[]) => void;
	/** Materialise the `Archetype` over the live column store and attach the
	 * store's grow handler. */
	readonly materialize: (
		id: ArchetypeID,
		ownedMask: BitSet,
		layouts: ArchetypeColumnLayout[]
	) => Archetype;
	/** Push a newly-installed archetype into every registered query whose
	 * masks it satisfies. */
	readonly fanIntoQueries: (archetype: Archetype) => void;
}

export class ArchetypeGraph {
	/** All archetypes, indexed by `ArchetypeID` (ids are minted monotonically
	 * and never removed). Store's flush loops hoist this array to a local. */
	public readonly archetypes: Archetype[] = [];
	/** Inverted index: ComponentID → ascending list of ArchetypeIDs that contain
	 * that component. Indexed POSITIONALLY by component id (a small, dense id
	 * space, 0..STORE_DESCRIPTOR_COMPONENT_LIMIT-1), so a lookup is an array
	 * index, not a Map hash. Used by `getMatchingArchetypes` to start the
	 * superset scan from the smallest bucket. Each bucket is a plain push-only
	 * array — NOT a Set — and deliberately does NOT dedup: a (component,
	 * archetype) pair can be inserted here at most once (see the "no duplicate
	 * pair" invariant on `install` + ADR-0015), so there is nothing for a Set
	 * to collapse. Archetypes are never removed from a Store, so buckets only
	 * grow, in ascending archetype-id order — which is canonical order,
	 * exploited by `_forEachChangedArchetype` to skip a sort. */
	public readonly componentIndex: ArchetypeID[][] = [];
	// Hash-bucketed lookup: BitSet.hash() → ArchetypeID[] for deduplication
	private readonly archetypeMap: Map<number, ArchetypeID[]> = new Map();
	private nextArchetypeId = 0;

	private readonly host: ArchetypeGraphHost;

	constructor(host: ArchetypeGraphHost) {
		this.host = host;
	}

	public get(id: ArchetypeID): Archetype {
		if (DEV) {
			if (id < 0 || id >= this.archetypes.length) {
				throw new ECSError(ECS_ERROR.ARCHETYPE_NOT_FOUND, `Archetype with ID ${id} not found`);
			}
		}
		return this.archetypes[id];
	}

	/**
	 * Find or create an archetype for the given component mask.
	 * Also updates the componentIndex and pushes into matching registered queries.
	 *
	 * Hot single-mask path. The bulk batched variant — used by Phase C
	 * pre-warming at `world.startup()` — is `createManyFromMasks`;
	 * see #213 / `ECS.startup()` for how it gets called and why.
	 */
	public getOrCreateFromMask(mask: BitSet): ArchetypeID {
		const hash = mask.hash();
		const existingId = this.lookup(mask, hash);
		if (existingId !== null) return existingId;

		const id = asArchetypeId(this.nextArchetypeId++);
		const layouts = this.buildLayouts(mask);

		// Extend the SAB to carry the new archetype's column region (Store-side
		// seam: existing archetypes' rows are carried forward and their stale
		// TypedArray views refreshed before any caller can touch them).
		this.host.extendStore([
			storeSpecFromLayouts(id, mask, layouts, this.host.initialCapacity())
		]);
		this.install(id, mask, layouts, hash);
		return id;
	}

	/**
	 * Bulk variant of `getOrCreateFromMask` — Phase C of issue #213.
	 *
	 * Given a set of masks, creates Archetypes for the ones not already
	 * planted, in a SINGLE `extendColumnStore` call (instead of one per
	 * archetype). Single-mask creation is O(N) in archetypes-so-far because
	 * the extend has to copy every existing archetype's live rows forward;
	 * N such calls compound to O(N²). Batching collapses the per-archetype
	 * setup-and-copy down to one pass — the per-startup cost the design doc
	 * §5.2 calls out as "O(N²) → O(N)" for in-tree systems whose archetype
	 * set is known at registration time via `spawns` + `transitions`.
	 *
	 * Masks already in the map are skipped. Returns the resolved
	 * `ArchetypeID` per input mask in input order — callers that don't need
	 * the ids can ignore the return value.
	 */
	public createManyFromMasks(masks: readonly BitSet[]): ArchetypeID[] {
		const out: ArchetypeID[] = new Array(masks.length);
		const newMasks: BitSet[] = [];
		const newHashes: number[] = [];
		const newLayouts: ArchetypeColumnLayout[][] = [];
		const newIds: ArchetypeID[] = [];
		const outIndices: number[] = [];

		// Pass 1: classify — existing vs. new. Existing get their id straight
		// from the lookup; new ones get a fresh id and queued specs.
		for (let i = 0; i < masks.length; i++) {
			const mask = masks[i];
			const hash = mask.hash();
			const found = this.lookup(mask, hash);
			if (found !== null) {
				out[i] = found;
				continue;
			}
			// Also skip duplicates within the input — the second occurrence
			// of an in-flight mask resolves to the first occurrence's id.
			let dup = false;
			for (let j = 0; j < newMasks.length; j++) {
				if (newHashes[j] === hash && newMasks[j].equals(mask)) {
					out[i] = newIds[j];
					dup = true;
					break;
				}
			}
			if (dup) continue;

			const id = asArchetypeId(this.nextArchetypeId++);
			newMasks.push(mask);
			newHashes.push(hash);
			newLayouts.push(this.buildLayouts(mask));
			newIds.push(id);
			out[i] = id;
			outIndices.push(i);
		}

		if (newMasks.length === 0) return out;

		const newSpecs: ArchetypeSpec[] = new Array(newMasks.length);
		for (let i = 0; i < newMasks.length; i++) {
			newSpecs[i] = storeSpecFromLayouts(
				newIds[i],
				newMasks[i],
				newLayouts[i],
				this.host.initialCapacity()
			);
		}

		// One extend covers every new archetype's column region — existing
		// rows get copied forward once, not once per new archetype.
		this.host.extendStore(newSpecs);
		for (let i = 0; i < newMasks.length; i++) {
			this.install(newIds[i], newMasks[i], newLayouts[i], newHashes[i]);
		}
		return out;
	}

	/** Hash-bucketed mask → ArchetypeID lookup; null when the mask isn't planted. */
	private lookup(mask: BitSet, hash: number): ArchetypeID | null {
		const bucket = this.archetypeMap.get(hash);
		if (bucket === undefined) return null;
		for (let i = 0; i < bucket.length; i++) {
			if (this.archetypes[bucket[i]].mask.equals(mask)) return bucket[i];
		}
		return null;
	}

	/** Walk the mask's set bits and resolve each non-tag component to its
	 * layout. Used by both single and bulk archetype-create paths. */
	private buildLayouts(mask: BitSet): ArchetypeColumnLayout[] {
		const layouts: ArchetypeColumnLayout[] = [];
		const metas = this.host.componentMetas();
		mask.forEach((bit) => {
			const compId = bit as ComponentID;
			const meta = metas[compId as number];
			if (meta && meta.fieldNames.length > 0) {
				layouts.push({
					componentId: compId,
					fieldNames: meta.fieldNames,
					fieldIndex: meta.fieldIndex,
					fieldTypes: meta.fieldTypes
				});
			}
		});
		return layouts;
	}

	/** Materialise the `Archetype` for `id` (via the host, which binds the
	 * live column store + grow handler), register in the archetype map +
	 * component index, and fan into any matching registered queries.
	 *
	 * Clones `mask` before storing — callers may pass scratch BitSets that
	 * they intend to reuse (e.g. `addComponents` / `removeComponents`'s
	 * `_scratchTargetMask`). The Archetype and the archetypeMap bucket
	 * both keep references long-term, so the clone is required for
	 * correctness — and is the previously-implicit guarantee made by the
	 * mask-allocating callers (`copyWithSet`, `copyWithClear`, etc.). */
	private install(
		id: ArchetypeID,
		mask: BitSet,
		layouts: ArchetypeColumnLayout[],
		hash: number
	): void {
		const ownedMask = mask.copy();
		const archetype = this.host.materialize(id, ownedMask, layouts);
		this.archetypes.push(archetype);
		bucketPush(this.archetypeMap, hash, id);

		// Update the inverted component index. Each bucket is a push-only array,
		// NOT a Set, because a (component, archetype) pair can be inserted here AT
		// MOST ONCE — there is nothing to dedup. WHY it can never duplicate:
		//   1. A mask is a `BitSet`; `forEach` visits each component bit exactly
		//      once, so `id` is pushed once per component within this single call.
		//   2. `install` is the SOLE writer of `componentIndex`, and runs
		//      exactly once per archetype id: its only callers
		//      (`getOrCreateFromMask` / `createManyFromMasks`)
		//      mint a fresh monotonic `nextArchetypeId` and pre-check
		//      `lookup`, so an id is never re-installed.
		//   3. The multiplicity that DOES exist in the data model — a source with
		//      many relation targets — is held OUT of the mask, on the
		//      sparse/relation id spaces (ADR-0011), precisely because a 128-bit
		//      mask cannot express a duplicate. So it never reaches this index.
		// Ids are minted monotonically and installed in order, so each bucket stays
		// sorted ascending BY CONSTRUCTION — i.e. canonical archetype order, which
		// lets `_forEachChangedArchetype` iterate without re-sorting. The
		// `DEV` guard collapses all three points into one loud check: a push
		// that isn't strictly ascending means the invariant broke (a second writer,
		// or a re-installed id). See ADR-0015.
		mask.forEach((bit) => {
			const componentId = bit as number;
			let bucket = this.componentIndex[componentId];
			if (bucket === undefined) {
				bucket = [];
				this.componentIndex[componentId] = bucket;
			}
			if (DEV && bucket.length > 0 && (id as number) <= (bucket[bucket.length - 1] as number)) {
				throw new ECSError(
					ECS_ERROR.COMPONENT_INDEX_INVARIANT,
					`component_index bucket for component ${componentId} received archetype ${id as number} out of ascending order (last = ${bucket[bucket.length - 1] as number}). Buckets are duplicate-free and ascending by construction (see install / ADR-0015) — this means install ran twice for an id, or a second writer of component_index was introduced.`
				);
			}
			bucket.push(id);
		});

		// Push new archetype into any registered query whose masks it satisfies
		// (Store-side seam — the query registry stays on Store). No epoch bump
		// (#328) — the new archetype is empty, so any cached
		// `_nonEmptyArchetypes` list is still correct (it skips empty entries
		// when it rebuilds). The first mutation that puts an entity into this
		// archetype will detect the 0→non-zero crossing and bump then. SAB
		// descriptor row_count is also already correct: it was initialised to
		// 0 by `extendColumnStore` at the same moment the arch joined.
		this.host.fanIntoQueries(archetype);
	}

	/** Resolve "add component_id to archetype_id" → target ArchetypeID. Caches the edge. */
	public resolveAdd(archetypeId: ArchetypeID, componentId: ComponentID): ArchetypeID {
		const current = this.get(archetypeId);
		if (current.mask.has(componentId as number)) return archetypeId;
		const edge = current.getEdge(componentId);
		if (edge?.add != null) return edge.add;
		const targetId = this.getOrCreateFromMask(
			current.mask.copyWithSet(componentId as number)
		);
		this.cacheEdge(current, this.get(targetId), componentId);
		return targetId;
	}

	/** Resolve "remove component_id from archetype_id" → target ArchetypeID. Caches the edge. */
	public resolveRemove(archetypeId: ArchetypeID, componentId: ComponentID): ArchetypeID {
		const current = this.get(archetypeId);
		if (!current.mask.has(componentId as number)) return archetypeId;
		const edge = current.getEdge(componentId);
		if (edge?.remove != null) return edge.remove;
		const targetId = this.getOrCreateFromMask(
			current.mask.copyWithClear(componentId as number)
		);
		this.cacheEdge(this.get(targetId), current, componentId);
		return targetId;
	}

	/** Cache a bidirectional add/remove edge between two archetypes. */
	private cacheEdge(from: Archetype, to: Archetype, componentId: ComponentID): void {
		// from + component_id → to (add edge)
		const fromEdge: ArchetypeEdge = from.getEdge(componentId) ?? {
			add: null,
			remove: null,
			addMap: null,
			removeMap: null
		};
		fromEdge.add = to.id;
		fromEdge.addMap = buildTransitionMap(from, to);
		from.setEdge(componentId, fromEdge);

		// to - component_id → from (remove edge)
		const toEdge: ArchetypeEdge = to.getEdge(componentId) ?? {
			add: null,
			remove: null,
			addMap: null,
			removeMap: null
		};
		toEdge.remove = from.id;
		toEdge.removeMap = buildTransitionMap(to, from);
		to.setEdge(componentId, toEdge);
	}
}

/** Build a single `ArchetypeSpec` for the SAB shadow from an archetype's
 * heap-side layouts. Tag-only archetypes (no `layouts`) produce a spec
 * with `columns: []`, which `createColumnStore` / `extendColumnStore`
 * handle as a header-only descriptor (no column data region). The SAB
 * component mask is `COMPONENT_MASK_WORDS` 32-bit words copied from the
 * BitSet's first words. Components past bit `STORE_DESCRIPTOR_COMPONENT_LIMIT`
 * cannot be represented here, so `registerComponent` enforces that ceiling —
 * by the time any archetype is built, no component ID can exceed it, so the
 * copy below is lossless (#381). The mask width matches the BitSet's
 * `INITIAL_WORD_COUNT`, so these words never come from a grown BitSet. */
function storeSpecFromLayouts(
	archetypeId: ArchetypeID,
	mask: BitSet,
	layouts: ArchetypeColumnLayout[],
	rowCapacity: number
): ArchetypeSpec {
	const columns: ColumnSpec[] = [];
	for (let i = 0; i < layouts.length; i++) {
		const layout = layouts[i];
		const types: TypedArrayTag[] = layout.fieldTypes;
		for (let j = 0; j < types.length; j++) {
			columns.push({
				componentId: layout.componentId as number,
				fieldId: j,
				typeTag: TYPED_ARRAY_TAG_TO_TYPE_TAG[types[j]]
			});
		}
	}
	const words = mask._words;
	const componentMask: number[] = new Array(COMPONENT_MASK_WORDS);
	for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
		componentMask[w] = (words[w] ?? 0) >>> 0;
	}
	return {
		archetypeId: archetypeId as number,
		componentMask,
		rowCapacity,
		columns
	};
}
