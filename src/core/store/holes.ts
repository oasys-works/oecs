/**
 * Hole reuse for the in-place grow and extend paths. Cold path: one call per
 * grow or extend, never per row.
 *
 * A hole is a byte range of the column data area that no live column extent
 * covers. The data area runs from the end of the descriptor region
 * (`layout_descriptor_off + _regionBytes`) to the header `capacity`. A grow
 * that moves an archetype leaves its old region behind as a hole, and
 * alignment padding between two columns is a hole too.
 *
 * Holes are derived, not stored. The bytes hold no free list, so a snapshot,
 * a restore and a worker need no new state, and the same history gives the
 * same layout. The list is cached on the store record (`_holes`) only so that
 * an extend does not sort every extent each time. The cache is kept equal to
 * the derivation: every placement here releases and takes exact extents, and a
 * store without the cache (a fresh store, a realloc) derives it once.
 *
 * Placement order for one archetype, first fit wins:
 *   1. The best-fitting hole the whole archetype fits in (the smallest hole,
 *      then the lowest address). For a grow, the archetype's own old region is
 *      released first, so the hole that holds it counts, and the archetype can
 *      stay where it is and grow into the bytes after it.
 *   2. The hole that ends at the used span, extended past it. Only when the
 *      span is the tail (`capacity === tailCursorBytes`), so the wasm backing,
 *      whose tail is page-rounded past the span, never takes it.
 *   3. The tail, as before this change.
 *
 * A placement that overlaps the archetype's own old region is taken only when
 * every column moves the same way: all new offsets at or above the old ones
 * (copy the columns last to first) or all at or below (copy first to last).
 * Then no copy overwrites a column that is not yet copied, and `copyWithin`
 * handles a column that overlaps itself.
 *
 * Stale bytes: a reused hole holds old data, while the bytes past the tail are
 * as fresh as the append path always had them. So the part of a placed column
 * that the live rows do not cover is zero-filled up to the old tail. Past the
 * tail nothing is filled, so a placement there costs what an append cost.
 */

import { alignUp, STORE_MAX_BYTE_OFFSET, StoreLayoutOverflowError } from "./column_store";
import type { ColumnStoreInternal } from "./column_store";
import type { ArchetypeDescriptor, ColumnDescriptor } from "./descriptor";
import { STORE_HEADER_OFFSETS } from "./header";
import { tailCursorBytes, type TailArchetypeLayout } from "./layout_ops";

/** One archetype to place. `old` is set for a grow and names where its
 * columns live now and how many rows to carry. */
export interface PlacementRequest {
	readonly layout: TailArchetypeLayout;
	readonly old?: {
		readonly offsets: readonly number[];
		readonly rowCapacity: number;
		readonly rowCount: number;
	};
}

/** How the live rows of a placed archetype move. `0`: any order (the new
 * region does not overlap the old one, or there is nothing to copy). `1`:
 * columns first to last. `-1`: columns last to first. */
export type MoveOrder = 0 | 1 | -1;

export interface Placement {
	readonly descriptor: ArchetypeDescriptor;
	readonly order: MoveOrder;
}

export interface PlacementPlan {
	readonly placements: Placement[];
	/** The new used span (header `capacity`). */
	readonly newTotal: number;
	/** The hole list after the placements, to cache on the new store record. */
	readonly holes: number[];
	/** Bytes below this offset may hold stale data. A placed column's bytes
	 * past its live rows are zero-filled up to here. */
	readonly fillLimit: number;
	/** True when some placement starts below `fillLimit`, so it may hold stale
	 * bytes. False when every archetype went past the old tail, and then an
	 * extend has nothing to zero and skips the pass. */
	readonly reused: boolean;
}

/** Derive the hole list from the descriptors: the data area minus the union
 * of the live column extents. Flat `[start0, end0, start1, end1, ...]`,
 * sorted, never two touching. O(columns log columns). */
export function deriveHoles(store: ColumnStoreInternal): number[] {
	const regionOff = store.view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
	const capacity = store.view.getUint32(STORE_HEADER_OFFSETS.capacity, true);
	const extents: number[] = [];
	for (const [, arch] of store.archetypes) {
		const cols = arch.columnsInOrder;
		for (let j = 0; j < cols.length; j++) {
			const len = cols[j].stride * arch.rowCapacity;
			if (len > 0) extents.push(cols[j].byteOff, cols[j].byteOff + len);
		}
	}
	const order: number[] = new Array(extents.length >> 1);
	for (let i = 0; i < order.length; i++) order[i] = i << 1;
	order.sort((a, b) => extents[a] - extents[b]);
	const holes: number[] = [];
	let cursor = regionOff + store._regionBytes;
	for (let k = 0; k < order.length; k++) {
		const s = extents[order[k]];
		const e = extents[order[k] + 1];
		if (s > cursor) holes.push(cursor, s);
		if (e > cursor) cursor = e;
	}
	if (capacity > cursor) holes.push(cursor, capacity);
	return holes;
}

/** Index of the first hole whose start is at or past `x`. */
function lowerBound(holes: readonly number[], x: number): number {
	let lo = 0;
	let hi = holes.length >> 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (holes[mid << 1] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo << 1;
}

/** Add `[s, e)` to the hole list, merging with a touching neighbour. The
 * range must not overlap a hole. */
function release(holes: number[], s: number, e: number): void {
	if (s >= e) return;
	const i = lowerBound(holes, s);
	const prev = i > 0 && holes[i - 1] === s;
	const next = i < holes.length && holes[i] === e;
	if (prev && next) {
		holes[i - 1] = holes[i + 1];
		holes.splice(i, 2);
	} else if (prev) {
		holes[i - 1] = e;
	} else if (next) {
		holes[i] = s;
	} else {
		holes.splice(i, 0, s, e);
	}
}

/** Remove `[s, e)` from the hole list. The range must lie inside one hole. */
function take(holes: number[], s: number, e: number): void {
	if (s >= e) return;
	const i = lowerBound(holes, s + 1) - 2;
	const hs = holes[i];
	const he = holes[i + 1];
	if (i < 0 || hs > s || he < e) {
		throw new Error(`hole list desync: [${s}, ${e}) is not inside a hole`);
	}
	const pieces: number[] = [];
	if (hs < s) pieces.push(hs, s);
	if (e < he) pieces.push(e, he);
	holes.splice(i, 2, ...pieces);
}

/** Column offsets for `layout` laid out from cursor `start`, the same rule as
 * `layoutColumnsAtTail`: each column at its stride boundary, in order. */
function layoutAt(layout: TailArchetypeLayout, start: number): { offsets: number[]; end: number } {
	const offsets: number[] = new Array(layout.columns.length);
	let cursor = start;
	for (let j = 0; j < layout.columns.length; j++) {
		const stride = layout.columns[j].stride;
		cursor = alignUp(cursor, stride);
		offsets[j] = cursor;
		cursor += stride * layout.rowCapacity;
	}
	return { offsets, end: cursor };
}

/** The order a move from `old` to `offsets` is safe in, or `null` when no
 * order is. See the file header. */
function moveOrder(
	offsets: readonly number[],
	end: number,
	old: PlacementRequest["old"],
	oldStart: number,
	oldEnd: number
): MoveOrder | null {
	if (old === undefined || old.rowCount === 0 || offsets.length === 0) return 0;
	if (end <= oldStart || offsets[0] >= oldEnd) return 0;
	let up = true;
	let down = true;
	for (let j = 0; j < offsets.length; j++) {
		if (offsets[j] < old.offsets[j]) up = false;
		if (offsets[j] > old.offsets[j]) down = false;
	}
	if (up) return -1;
	if (down) return 1;
	return null;
}

/**
 * Place every request in turn, reusing holes. Pure: reads `store`, returns
 * the plan, writes nothing. Each request sees the holes the earlier ones left,
 * and the caller must copy in the same order, so a later archetype can land
 * in the region an earlier one just left.
 */
export function planPlacements(
	store: ColumnStoreInternal,
	requests: readonly PlacementRequest[]
): PlacementPlan {
	const holes = (store._holes ?? deriveHoles(store)).slice();
	let cap = store.view.getUint32(STORE_HEADER_OFFSETS.capacity, true);
	const tail = tailCursorBytes(store);
	const fillLimit = Math.max(tail, cap);
	let reused = false;
	const placements: Placement[] = new Array(requests.length);
	for (let r = 0; r < requests.length; r++) {
		const { layout, old } = requests[r];
		// Release the old region, so the archetype can grow where it is or into
		// a hole beside it.
		let oldStart = Infinity;
		let oldEnd = -Infinity;
		if (old !== undefined) {
			for (let j = 0; j < old.offsets.length; j++) {
				const s = old.offsets[j];
				const e = s + layout.columns[j].stride * old.rowCapacity;
				if (e > s) {
					release(holes, s, e);
					if (s < oldStart) oldStart = s;
					if (e > oldEnd) oldEnd = e;
				}
			}
		}

		let bestOffsets: number[] | null = null;
		let bestEnd = 0;
		let bestOrder: MoveOrder = 0;
		let bestSize = Infinity;
		let extOffsets: number[] | null = null;
		let extEnd = 0;
		let extOrder: MoveOrder = 0;
		const canExtend = cap === tail;
		for (let i = 0; i < holes.length; i += 2) {
			const hs = holes[i];
			const he = holes[i + 1];
			const size = he - hs;
			const touchesTail = canExtend && he === cap;
			if (size >= bestSize && !touchesTail) continue;
			// Two starts per hole: its first byte, and, for the hole that now
			// holds the archetype's own old region, where the archetype stands.
			for (let k = 0; k < 2; k++) {
				const start = k === 0 ? hs : oldStart;
				if (k === 1 && !(oldStart > hs && oldStart < he)) break;
				const { offsets, end } = layoutAt(layout, start);
				const order = moveOrder(offsets, end, old, oldStart, oldEnd);
				if (order === null) continue;
				if (end <= he) {
					if (size < bestSize) {
						bestOffsets = offsets;
						bestEnd = end;
						bestOrder = order;
						bestSize = size;
					}
					break;
				}
				if (touchesTail && extOffsets === null) {
					extOffsets = offsets;
					extEnd = end;
					extOrder = order;
				}
			}
		}
		let offsets: number[];
		let end: number;
		let order: MoveOrder;
		if (bestOffsets !== null) {
			offsets = bestOffsets;
			end = bestEnd;
			order = bestOrder;
		} else if (extOffsets !== null) {
			offsets = extOffsets;
			end = extEnd;
			order = extOrder;
		} else {
			// The tail. A grow off its old region copies in any order.
			({ offsets, end } = layoutAt(layout, Math.max(tail, cap)));
			order = 0;
		}
		if (end > STORE_MAX_BYTE_OFFSET) throw new StoreLayoutOverflowError(end);
		// Past the span the bytes are new: they join the holes, then the
		// columns take their extents, so the alignment padding stays a hole and
		// the list stays equal to the derivation.
		if (end > cap) {
			release(holes, cap, end);
			cap = end;
		}
		const columns: ColumnDescriptor[] = new Array(offsets.length);
		for (let j = 0; j < offsets.length; j++) {
			const c = layout.columns[j];
			take(holes, offsets[j], offsets[j] + c.stride * layout.rowCapacity);
			columns[j] = {
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: offsets[j],
				stride: c.stride
			};
		}
		if (offsets.length > 0 && offsets[0] < fillLimit) reused = true;
		placements[r] = {
			descriptor: {
				archetypeId: layout.archetypeId,
				componentMask: layout.componentMask,
				rowCount: 0,
				enabledCount: 0,
				rowCapacity: layout.rowCapacity,
				columns
			},
			order
		};
	}
	return {
		placements,
		newTotal: cap,
		holes,
		fillLimit,
		reused
	};
}

/** Copy one placed archetype's live rows from `oldOffsets` and zero the rest
 * of each column up to `fillLimit`. `bytes` is based at the store. */
export function moveAndClear(
	bytes: Uint8Array,
	placement: Placement,
	oldOffsets: readonly number[] | null,
	rowCount: number,
	fillLimit: number
): void {
	const cols = placement.descriptor.columns;
	const n = cols.length;
	if (oldOffsets !== null && rowCount > 0) {
		for (let k = 0; k < n; k++) {
			const j = placement.order === -1 ? n - 1 - k : k;
			const live = rowCount * cols[j].stride;
			if (cols[j].byteOff !== oldOffsets[j]) {
				bytes.copyWithin(cols[j].byteOff, oldOffsets[j], oldOffsets[j] + live);
			}
		}
	}
	// After every copy, so a fill never meets a column that is not yet copied.
	const capacity = placement.descriptor.rowCapacity;
	for (let j = 0; j < n; j++) {
		const from = cols[j].byteOff + rowCount * cols[j].stride;
		const to = Math.min(cols[j].byteOff + capacity * cols[j].stride, fillLimit);
		if (to > from) bytes.fill(0, from, to);
	}
}
