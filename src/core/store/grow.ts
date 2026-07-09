/**
 * Host-side SAB realloc — the realloc-and-republish growth path the plan
 * commits to (#171 §6.1.4 / §8.1 / §8.3 / §8.4). Allocates a new
 * `SharedArrayBuffer` sized for the new per-archetype row capacities, copies
 * live row data column by column from the old SAB, writes the descriptors,
 * and bumps `view_stamp` so consumers know their cached TypedArray views
 * are stale.
 *
 * Why realloc instead of `SharedArrayBuffer.prototype.grow()`: every column
 * is densely packed against the next in the SAB layout, so a non-tail column
 * needing more rows forces every following column to relocate — the in-place
 * `grow()` API can't avoid the copy. We need the realloc path for the
 * non-tail case anyway, so we use it everywhere and keep one code path.
 * (See plan §8.4.)
 *
 * The caller is responsible for two things:
 *   1. **Telling us how many live rows each archetype has.** Descriptors
 *      carry a `row_count` field but no live code currently writes it; the
 *      authoritative row count is held by the Archetype on the TS side. The
 *      `GrowPlan` shape below makes the caller pass it explicitly so this
 *      primitive doesn't need to dig through the old descriptor's
 *      potentially-stale `row_count`.
 *   2. **Picking the new capacities.** Doubling is the §8.3 default but the
 *      caller chooses — different archetypes may pick different growth
 *      multipliers, or some may stay the same.
 *
 * Growth never happens during `tick()` (§8.2). The intended sequence is:
 *   - Tick observes a column at capacity, defers the structural change to
 *     the next inter-tick safe point.
 *   - Host calls `growColumnStore(old, plan)` between ticks.
 *   - Host calls `Archetype.refreshViews(newStore)` on every archetype
 *     that drew columns from the old store.
 *   - Worker (Phase 5) receives the new SAB via `postMessage`.
 */

import {
	archetypeDescriptorBytes,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	writeArchetypeDescriptor,
	type ArchetypeDescriptor
} from "./descriptor";
import { STORE_HEADER_OFFSETS } from "./header";
import {
	buildArchetypeViews,
	type ArchetypeSpec,
	type ArchetypeViews,
	type ColumnStore,
	isColumnStoreInternal,
	type ColumnStoreInternal
} from "./column_store";
import type { BufferAllocator } from "./allocator";
import {
	growBufferInPlace,
	layoutColumnsAtTail,
	reallocAndRepublish,
	tailCursorBytes,
	type ArchetypeGrowSpec,
	type TailArchetypeLayout
} from "./layout_ops";
import { DEV } from "../../dev_flag";

// The per-archetype plan-entry shape lives in layout_ops.ts (shared with
// `ExtendPlan.existing`); re-exported here so `GrowPlan` consumers keep their
// import path.
export type { ArchetypeGrowSpec } from "./layout_ops";

export interface GrowPlan {
	readonly archetypes: readonly ArchetypeGrowSpec[];
}

/** Returned alongside the new `ColumnStore` so callers can sanity-check the
 * grow (and so tests can assert it without re-reading the SAB). */
export interface GrowResult {
	readonly store: ColumnStore;
	readonly oldViewStamp: number;
	readonly newViewStamp: number;
	/** True when the in-place fast path ran: every archetype EXCEPT those in
	 * `grownArchetypeIds` kept its column views, so the caller only needs to
	 * `refreshViews` the grown ones. False on the realloc path, where the
	 * whole store moved and every view must be refreshed. */
	readonly viewsPreserved: boolean;
	/** Archetype ids whose columns were relocated (in-place path). Empty on
	 * the realloc path. */
	readonly grownArchetypeIds: readonly number[];
}

interface GrowTarget {
	readonly archetypeId: number;
	readonly newRowCapacity: number;
	readonly rowCount: number;
}

/**
 * In-place grow fast path — the grow-side analogue of
 * `extendColumnStoreInPlace` (#361). Pre-conditions (checked by the caller):
 *   - `allocator.isInPlace === true` (existing TypedArray/DataView views
 *     stay valid after the next allocator call).
 *   - `old._allocator === allocator`.
 *
 * Why this is needed: the realloc path (below) snapshots EVERY archetype's
 * live columns, allocates a fresh whole-store SAB, and copies it all back —
 * O(total-live-data) per grow, even though only one archetype overflowed.
 * That whole-store relayout is what made `frame_loop` 0.29x vs oecs: a hot
 * archetype doubling 1k→100k fires ~7 grows, each re-copying all 80+
 * archetypes. (See docs/reports/bench/ frame_loop diagnosis.)
 *
 * The fast path relocates ONLY the growing archetypes' columns to the SAB
 * tail (copying just their live rows), rewrites their descriptors in place
 * (a grow never changes column count, so each descriptor occupies the same
 * bytes), grows the SAB, and rebuilds views for the grown archetypes only.
 * Every other archetype — and the prefix regions (entity-index, command
 * ring) that sit before the descriptor region — is untouched, so its views
 * and data carry forward verbatim. Cost drops from O(all archetypes) to
 * O(grown archetype live rows).
 *
 * Tradeoff: the grown archetype's previous column region is abandoned (a
 * hole). With geometric doubling the wasted bytes are bounded by ~1x the
 * archetype's final live size; the growable SAB only ever grows, so holes
 * are not reclaimed within an allocator's lifetime. Acceptable for
 * match-scoped worlds (archetypes reach steady-state capacity and stop
 * growing); a future compaction pass could reclaim them.
 */
function growColumnStoreInPlace(
	old: ColumnStoreInternal,
	growTargets: readonly GrowTarget[],
	regionOff: number
): GrowResult {
	// 1. Lay the grown archetypes' columns out at the current SAB tail. Only
	//    these archetypes move. A grow keeps each column's stride (the column
	//    set is unchanged), so the tail layout reuses the old strides verbatim.
	const tailLayouts: TailArchetypeLayout[] = new Array(growTargets.length);
	for (let t = 0; t < growTargets.length; t++) {
		const target = growTargets[t];
		const oldArch = old.archetypes.get(target.archetypeId)!;
		tailLayouts[t] = {
			archetypeId: target.archetypeId,
			componentMask: oldArch.componentMask,
			rowCapacity: target.newRowCapacity,
			columns: oldArch.columnsInOrder
		};
	}
	// Tail cursor = the backing's live extent (see `tailCursorBytes`): the header
	// `capacity` for the fixed heap ArrayBuffer (whose byteLength is the full
	// cap), or `buffer.byteLength` for the growable-SAB / wasm backings (unchanged).
	const { descriptors, newTotal } = layoutColumnsAtTail(tailCursorBytes(old), tailLayouts);
	const newDescriptors = new Map<number, ArchetypeDescriptor>();
	for (let i = 0; i < descriptors.length; i++) {
		newDescriptors.set(descriptors[i].archetypeId, descriptors[i]);
	}

	// 2. Grow the backing store in place. Old views stay valid either way —
	//    see `growBufferInPlace`.
	const { grownBuffer, newView } = growBufferInPlace(old, newTotal);

	// 3. Copy each grown archetype's live rows from its old column ranges to
	//    the new tail ranges. Byte-level copy handles any column type; src
	//    (< pre-grow byteLength) and dst (>= pre-grow byteLength) never
	//    overlap.
	const bytes = new Uint8Array(grownBuffer);
	for (let t = 0; t < growTargets.length; t++) {
		const target = growTargets[t];
		const oldArch = old.archetypes.get(target.archetypeId)!;
		const desc = newDescriptors.get(target.archetypeId)!;
		for (let j = 0; j < oldArch.columnsInOrder.length; j++) {
			const oldc = oldArch.columnsInOrder[j];
			const live = target.rowCount * oldc.stride;
			if (live > 0) {
				bytes.copyWithin(desc.columns[j].byteOff, oldc.byteOff, oldc.byteOff + live);
			}
		}
	}

	// 4. Rewrite the grown archetypes' descriptors in place. A grow never
	//    changes column count, so each descriptor occupies the same bytes —
	//    overwriting at the same offset is safe. Walk the descriptor region in
	//    archetype-iteration order (descriptors are written in that order by
	//    `createColumnStore`; non-grown entries are left untouched).
	let descOff = regionOff;
	for (const [archetypeId, arch] of old.archetypes) {
		if (DEV) {
			// This positional rewrite trusts that `old.archetypes` Map order equals
			// the on-store descriptor write order (`createColumnStore` writes in that
			// order). Lock the invariant: the descriptor physically at `descOff` must
			// already carry this `archetype_id`, else the cursor is overwriting the
			// wrong descriptor. (#731)
			const onStore = newView.getUint32(descOff + ARCHETYPE_DESCRIPTOR_OFFSETS.archetype_id, true);
			if (onStore !== archetypeId) {
				throw new StoreGrowError(
					`descriptor cursor desync at byte ${descOff}: store holds archetype ${onStore}, expected ${archetypeId} (Map order diverged from on-store write order)`
				);
			}
		}
		const grown = newDescriptors.get(archetypeId);
		if (grown !== undefined) {
			writeArchetypeDescriptor(newView, descOff, grown);
		}
		descOff += archetypeDescriptorBytes(arch.columnsInOrder.length);
	}

	// 5. Header: bump view_stamp, update capacity. archetype_count is
	//    unchanged (a grow adds no archetypes).
	const oldViewStamp = newView.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
	const newViewStamp = (oldViewStamp + 1) >>> 0;
	newView.setUint32(STORE_HEADER_OFFSETS.view_stamp, newViewStamp, true);
	newView.setUint32(STORE_HEADER_OFFSETS.capacity, newTotal, true);

	// 6. Build views for the grown archetypes only; carry the rest forward
	//    verbatim (their views still read the same valid memory).
	const grownViews = buildArchetypeViews(grownBuffer, [...newDescriptors.values()]);
	const merged = new Map<number, ArchetypeViews>();
	for (const [archetypeId, arch] of old.archetypes) {
		const rebuilt = grownViews.get(archetypeId);
		merged.set(archetypeId, rebuilt ?? arch);
	}

	const newStore: ColumnStoreInternal = {
		buffer: grownBuffer,
		view: newView,
		header: { ...old.header, viewStamp: newViewStamp, capacity: newTotal },
		archetypes: merged,
		_regionBytes: old._regionBytes,
		_allocator: old._allocator,
		// Carry the headroom policy forward so a LATER extend realloc
		// re-reserves the same descriptor-region margin (#541).
		_reservedDescriptorBytes: old._reservedDescriptorBytes
	};

	const grownArchetypeIds: number[] = new Array(growTargets.length);
	for (let t = 0; t < growTargets.length; t++)
		grownArchetypeIds[t] = growTargets[t].archetypeId;

	return {
		store: newStore,
		oldViewStamp,
		newViewStamp,
		viewsPreserved: true,
		grownArchetypeIds
	};
}

export class StoreGrowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreGrowError";
	}
}

/** Allocate a new SAB sized for `plan`, copy live rows from `old`, bump
 * `view_stamp`. With the default allocator the old SAB is untouched and
 * callers may continue reading from it until they finish swapping in
 * the new views. With a `wasmMemoryAllocator`, `old`'s typed-array
 * views may be detached as soon as `createColumnStore` returns — live
 * data is snapshotted before the allocator call to make both code paths
 * behave identically from the caller's perspective. (PR 3D / #234) */
export function growColumnStore(
	old: ColumnStore,
	plan: GrowPlan,
	allocator?: BufferAllocator
): GrowResult {
	const growById = new Map<number, ArchetypeGrowSpec>();
	for (let i = 0; i < plan.archetypes.length; i++) {
		const spec = plan.archetypes[i];
		growById.set(spec.archetypeId, spec);
	}

	// Build the new specs by walking the old store. Every archetype the old
	// store has gets carried forward; capacity comes from the plan if
	// supplied, else stays the same. Also collect the archetypes that
	// actually grow (capacity increased) for the in-place fast path.
	const newSpecs: ArchetypeSpec[] = [];
	const growTargets: GrowTarget[] = [];
	for (const [archetypeId, oldArch] of old.archetypes) {
		const growSpec = growById.get(archetypeId);
		const newCapacity = growSpec?.newRowCapacity ?? oldArch.rowCapacity;
		if (newCapacity < (growSpec?.rowCount ?? 0)) {
			throw new StoreGrowError(
				`archetype ${archetypeId}: new_row_capacity ${newCapacity} < row_count ${growSpec?.rowCount}`
			);
		}
		if (newCapacity < oldArch.rowCapacity) {
			// Realloc must not shrink — old views might still hold valid rows
			// past the new capacity. (We don't truncate; we only ever grow.)
			throw new StoreGrowError(
				`archetype ${archetypeId}: shrinking from ${oldArch.rowCapacity} to ${newCapacity} is not supported`
			);
		}
		if (newCapacity > oldArch.rowCapacity) {
			growTargets.push({
				archetypeId,
				newRowCapacity: newCapacity,
				rowCount: growSpec?.rowCount ?? 0
			});
		}

		// `columnsInOrder` is structurally a `ColumnSpec[]` — pass it
		// through directly instead of re-allocating a fresh array of
		// stripped-down clones. See `extendColumnStore` for the matching
		// comment on why this is safe.
		newSpecs.push({
			archetypeId,
			componentMask: oldArch.componentMask,
			rowCapacity: newCapacity,
			columns: oldArch.columnsInOrder
		});
	}

	// Build a per-archetype row-count index for the snapshot helper, also
	// validating row_count <= oldCapacity here (kept close to the spec
	// processing so the error message can name the archetype clearly).
	const rowCountsById = new Map<number, number>();
	for (const [archetypeId, oldArch] of old.archetypes) {
		const growSpec = growById.get(archetypeId);
		const rowCount = growSpec?.rowCount ?? 0;
		if (rowCount > oldArch.rowCapacity) {
			throw new StoreGrowError(
				`archetype ${archetypeId}: row_count ${rowCount} > old row_capacity ${oldArch.rowCapacity}`
			);
		}
		if (rowCount > 0) {
			rowCountsById.set(archetypeId, rowCount);
		}
	}

	// IN-PLACE FAST PATH (grow-side analogue of extend's #361 fast path).
	// When the allocator keeps views valid across grow (`isInPlace`) and is
	// the same one this store was built with, relocate only the growing
	// archetypes to the SAB tail instead of reallocating + snapshotting the
	// whole store. This is the fix for the frame_loop 0.29x regression — see
	// `growColumnStoreInPlace`.
	if (
		allocator?.isInPlace === true &&
		isColumnStoreInternal(old) &&
		old._allocator === allocator &&
		growTargets.length > 0
	) {
		const regionOff = old.view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
		return growColumnStoreInPlace(old, growTargets, regionOff);
	}

	// Realloc-and-republish (see `reallocAndRepublish` for the snapshot →
	// create → restore → stamp choreography). `row_count` defaults to 0 for
	// any archetype not named in the plan; those archetypes contribute no
	// snapshot and their new views remain zero-initialised.
	const { store, oldViewStamp, newViewStamp } = reallocAndRepublish(
		old,
		newSpecs,
		rowCountsById,
		allocator
	);

	return {
		store,
		oldViewStamp,
		newViewStamp,
		viewsPreserved: false,
		grownArchetypeIds: []
	};
}
