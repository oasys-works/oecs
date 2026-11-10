/**
 * Host-side SAB realloc, the realloc-and-republish growth path the plan
 * commits to. Allocates a new
 * `SharedArrayBuffer` sized for the new per-archetype row capacities, copies
 * live row data column by column from the old SAB, writes the descriptors,
 * and bumps `view_stamp` so consumers know their cached TypedArray views
 * are stale.
 *
 * Why realloc instead of `SharedArrayBuffer.prototype.grow()`: every column
 * is densely packed against the next in the SAB layout, so a non-tail column
 * needing more rows forces every following column to relocate, the in-place
 * `grow()` API can't avoid the copy. We need the realloc path for the
 * non-tail case anyway, so we use it everywhere and keep one code path.
 *
 * The caller is responsible for two things:
 *   1. **Telling us how many live rows each archetype has.** Descriptors
 *      carry a `row_count` field, and `Store.publishRowCounts` writes it at
 *      tick start and at each phase flush. It is therefore a copy that goes
 *      stale between those points. The authoritative row count is held by the
 *      Archetype on the TS side. The `GrowPlan` shape below makes the caller
 *      pass it explicitly so this primitive never reads the stale copy.
 *   2. **Picking the new capacities.** Doubling is the default but the
 *      caller chooses, different archetypes may pick different growth
 *      multipliers, or some may stay the same.
 *
 * Growth never happens during `tick()`. The intended sequence is:
 *   - Tick observes a column at capacity, defers the structural change to
 *     the next inter-tick safe point.
 *   - Host calls `growColumnStore(old, plan)` between ticks.
 *   - Host calls `Archetype.refreshViews(newStore)` on every archetype
 *     that drew columns from the old store.
 *   - A worker receives the new SAB via `postMessage`.
 */

import {
	archetypeDescriptorBytes,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	writeArchetypeDescriptor,
	type ArchetypeDescriptor
} from "./descriptor";
import { STORE_HEADER_OFFSETS } from "./header";
import {
	createArchetypeViews,
	type ArchetypeSpec,
	type ArchetypeViews,
	type ColumnStore,
	isColumnStoreInternal,
	type ColumnStoreInternal
} from "./column_store";
import type { BufferAllocator } from "./allocator";
import { growBufferInPlace, reallocAndRepublish, type ArchetypeGrowSpec } from "./layout_ops";
import { moveAndClear, planPlacements, type PlacementRequest } from "./holes";
import { DEV } from "../../dev_flag";

// The per-archetype plan-entry shape lives in layout_ops.ts (shared with
// `ExtendPlan.existing`). Re-exported here so `GrowPlan` consumers keep their
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
	/** True when the in-place fast path ran: every archetype except those in
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
 * In-place grow fast path, the grow-side analogue of
 * `extendColumnStoreInPlace`. Pre-conditions (checked by the caller):
 *   - `allocator.isInPlace === true` (existing TypedArray or DataView views
 *     stay valid after the next allocator call).
 *   - `old._allocator === allocator`.
 *
 * Why this is needed: the realloc path (below) snapshots every archetype's
 * live columns, allocates a fresh whole-store SAB, and copies it all back.
 * O(total-live-data) per grow, even though only one archetype overflowed.
 * That relayout of the whole store is what made a frame much slower. A hot
 * archetype that becomes larger in steps fires one grow at each step, and each
 * grow copies every other archetype again.
 *
 * The fast path relocates only the growing archetypes' columns, to a hole
 * or the SAB tail (copying only their live rows), rewrites their descriptors in place
 * (a grow never changes column count, so each descriptor occupies the same
 * bytes), grows the SAB, and rebuilds views for the grown archetypes only.
 * Every other archetype, and the prefix regions (entity-index, command
 * ring) that sit before the descriptor region, is untouched, so its views
 * and data carry forward verbatim. Cost drops from O(all archetypes) to
 * O(grown archetype live rows).
 *
 * The grown archetype's previous column region becomes a hole. A later grow
 * or extend reuses it (`holes.ts`), and an archetype with free bytes after it
 * grows where it stands. The p26 probe measured the holes at 28 to 50% of the
 * column area before the reuse and under 2% after it. The cost: a write
 * through a column view held across a grow can now land in live data, where
 * it used to land in an abandoned region.
 */
function growColumnStoreInPlace(
	old: ColumnStoreInternal,
	growTargets: readonly GrowTarget[],
	regionOff: number
): GrowResult {
	// 1. Place the grown archetypes' columns: in a hole that fits, where the
	//    archetype stands when the bytes after it are free, else at the tail
	//    (see `planPlacements`). Only these archetypes move. A grow keeps each
	//    column's stride (the column set is unchanged), so the layout reuses
	//    the old strides verbatim.
	const requests: PlacementRequest[] = new Array(growTargets.length);
	for (let t = 0; t < growTargets.length; t++) {
		const target = growTargets[t];
		const oldArch = old.archetypes.get(target.archetypeId)!;
		const oldOffsets: number[] = new Array(oldArch.columnsInOrder.length);
		for (let j = 0; j < oldOffsets.length; j++) oldOffsets[j] = oldArch.columnsInOrder[j].byteOff;
		requests[t] = {
			layout: {
				archetypeId: target.archetypeId,
				componentMask: oldArch.componentMask,
				rowCapacity: target.newRowCapacity,
				columns: oldArch.columnsInOrder
			},
			old: { offsets: oldOffsets, rowCapacity: oldArch.rowCapacity, rowCount: target.rowCount }
		};
	}
	const plan = planPlacements(old, requests);
	const newTotal = plan.newTotal;
	const newDescriptors = new Map<number, ArchetypeDescriptor>();
	for (let i = 0; i < plan.placements.length; i++) {
		const d = plan.placements[i].descriptor;
		newDescriptors.set(d.archetypeId, d);
	}

	// 2. Grow the backing store in place when the span grew. Old views stay
	//    valid either way, see `growBufferInPlace`.
	const { grownBuffer, newView } = growBufferInPlace(old, newTotal);

	// 3. Copy each grown archetype's live rows to its new columns, in plan
	//    order, and zero the rest of each column where the bytes may be stale.
	//    A source and its destination may overlap. `planPlacements` picked the
	//    column order that makes the copy safe.
	// Based at the store, so a descriptor's relative `byte_off` indexes it.
	const bytes = new Uint8Array(grownBuffer, old.storeBase, newTotal);
	for (let t = 0; t < growTargets.length; t++) {
		moveAndClear(
			bytes,
			plan.placements[t],
			requests[t].old!.offsets,
			growTargets[t].rowCount,
			plan.fillLimit
		);
	}

	// 4. Rewrite the grown archetypes' descriptors in place. A grow never
	//    changes column count, so each descriptor occupies the same bytes,
	//    overwriting at the same offset is safe. Walk the descriptor region in
	//    archetype-iteration order (descriptors are written in that order by
	//    `createColumnStore`. Non-grown entries are left untouched).
	let descOff = regionOff;
	for (const [archetypeId, arch] of old.archetypes) {
		if (DEV) {
			// This positional rewrite trusts that `old.archetypes` Map order equals
			// the on-store descriptor write order (`createColumnStore` writes in that
			// order). Lock the invariant: the descriptor physically at `descOff` must
			// already carry this `archetype_id`, else the cursor is overwriting the
			// wrong descriptor.
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

	// 6. Build views for the grown archetypes only. Carry the rest forward
	//    verbatim (their views still read the same valid memory).
	const grownViews = createArchetypeViews(grownBuffer, old.storeBase, [...newDescriptors.values()]);
	const merged = new Map<number, ArchetypeViews>();
	for (const [archetypeId, arch] of old.archetypes) {
		const rebuilt = grownViews.get(archetypeId);
		merged.set(archetypeId, rebuilt ?? arch);
	}

	const newStore: ColumnStoreInternal = {
		buffer: grownBuffer,
		view: newView,
		header: { ...old.header, viewStamp: newViewStamp, capacity: newTotal },
		storeBase: old.storeBase,
		archetypes: merged,
		_regionBytes: old._regionBytes,
		_allocator: old._allocator,
		// Carry the headroom policy forward so a later extend realloc
		// re-reserves the same descriptor-region margin.
		_reservedDescriptorBytes: old._reservedDescriptorBytes,
		// A grow adds no archetype, so the descriptor bytes in use do not change.
		_usedDescriptorBytes: old._usedDescriptorBytes,
		_holes: plan.holes
	};

	const grownArchetypeIds: number[] = new Array(growTargets.length);
	for (let t = 0; t < growTargets.length; t++) grownArchetypeIds[t] = growTargets[t].archetypeId;

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
 * views may be detached as soon as `createColumnStore` returns, live
 * data is snapshotted before the allocator call to make both code paths
 * behave identically from the caller's perspective. */
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
	// store has gets carried forward. Capacity comes from the plan if
	// supplied, else stays the same. Also collect the archetypes that
	// actually grow (capacity increased) for the in-place fast path.
	const newSpecs: ArchetypeSpec[] = [];
	const growTargets: GrowTarget[] = [];
	for (const [archetypeId, oldArch] of old.archetypes) {
		const growSpec = growById.get(archetypeId);
		const newCapacity = growSpec?.newRowCapacity ?? oldArch.rowCapacity;
		if (newCapacity < (growSpec?.rowCount ?? 0)) {
			throw new StoreGrowError(
				`archetype ${archetypeId}: newRowCapacity ${newCapacity} < rowCount ${growSpec?.rowCount}`
			);
		}
		if (newCapacity < oldArch.rowCapacity) {
			// Realloc must not shrink, old views might still hold valid rows
			// past the new capacity. (We don't truncate, we only ever grow.)
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

		// `columnsInOrder` is structurally a `ColumnSpec[]`, pass it
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

	// In-place fast path, the grow-side analogue of extend's fast path.
	// When the allocator keeps views valid across grow (`isInPlace`) and is
	// the same one this store was built with, relocate only the growing
	// archetypes to the SAB tail instead of reallocating + snapshotting the
	// whole store. This is the fix for the per-frame regression, see
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
	// any archetype not named in the plan. Those archetypes contribute no
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
