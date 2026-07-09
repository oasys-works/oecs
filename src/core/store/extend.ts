/**
 * Host-side SAB extend — plant a NEW archetype region at the SAB tail
 * (#171 §6.1.9 prerequisite). Where `growColumnStore` resizes existing
 * archetype rows, `extendColumnStore` adds an archetype the SAB has never
 * carried before.
 *
 * Motivation: live ECS discovers archetypes dynamically — a new component
 * combination first seen at tick T spawns a new `Archetype` at runtime.
 * For ECS to live on a single SAB (the Phase 1 endgame), the host needs
 * a way to add that archetype's column region without throwing away the
 * existing rows. `extendColumnStore` is that primitive.
 *
 * Mechanism mirrors `growColumnStore`:
 *   1. Compose a merged spec list — old archetypes at their current
 *      capacities + new archetypes from the plan.
 *   2. Allocate a fresh SAB via `createColumnStore` (descriptor region is
 *      re-sized to fit the new archetype count).
 *   3. Copy live rows for every existing archetype that the caller
 *      declared a `row_count` for. Defaults to 0 — same convention as
 *      `growColumnStore`.
 *   4. Bump `view_stamp` from the OLD SAB's live value (not the cached
 *      header snapshot, which goes stale across consecutive extends).
 *
 * The old SAB is untouched; callers may keep reading from it until they
 * swap in views from the new store and call `refreshViews` on the
 * affected Archetypes.
 */

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
	TYPE_TAG_STRIDE,
	archetypeDescriptorBytes,
	writeArchetypeDescriptor
} from "./descriptor";
import {
	growBufferInPlace,
	layoutColumnsAtTail,
	reallocAndRepublish,
	tailCursorBytes,
	type ArchetypeGrowSpec,
	type TailArchetypeLayout
} from "./layout_ops";

export interface ExtendPlan {
	/** Archetypes to append. Each `archetype_id` MUST be absent from
	 * `old.archetypes`; collisions throw `StoreExtendError`. */
	readonly newArchetypes: readonly ArchetypeSpec[];
	/** Per-existing-archetype live row counts. Same shape as
	 * `GrowPlan.archetypes` so callers can reuse plan-building helpers.
	 * Omitted or `0` ⇒ no rows to copy (the archetype is empty). */
	readonly existing?: readonly ArchetypeGrowSpec[];
}

export interface ExtendResult {
	readonly store: ColumnStore;
	readonly oldViewStamp: number;
	readonly newViewStamp: number;
	/** True when the in-place fast path (#237 Option A) was taken: the SAB
	 * instance is reused, existing column TypedArray views are unchanged,
	 * and callers may skip `refreshViews` on every pre-existing
	 * Archetype. False when the slow path ran (fresh SAB or wasm-memory
	 * grow with detached views); callers MUST refresh every Archetype's
	 * SAB-backed columns from the returned `store` before reading them. */
	readonly viewsPreserved: boolean;
}

export class StoreExtendError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreExtendError";
	}
}

/** Allocate a new SAB sized for `old` + `plan.newArchetypes`, copy
 * existing rows, bump `view_stamp`.
 *
 * `allocator` (PR 3D / #234): pluggable buffer source forwarded into
 * `createColumnStore`. When the allocator is `wasmMemoryAllocator`,
 * `memory.grow` may detach `old`'s typed-array views before the copy
 * runs — so live rows are snapshotted into heap `Uint8Array`s BEFORE the
 * allocator call and restored into the new views afterwards. The cost
 * is one extra heap allocation per live archetype-column; negligible
 * compared to the SAB walk itself. */
export function extendColumnStore(
	old: ColumnStore,
	plan: ExtendPlan,
	allocator?: BufferAllocator
): ExtendResult {
	if (plan.newArchetypes.length === 0) {
		throw new StoreExtendError("extend plan has no new archetypes; use grow_column_store for resizes");
	}

	// 1. Validate new archetype IDs: no duplicates within the plan, no
	//    collisions with the existing store.
	const newIds = new Set<number>();
	for (let i = 0; i < plan.newArchetypes.length; i++) {
		const id = plan.newArchetypes[i].archetypeId;
		if (newIds.has(id)) {
			throw new StoreExtendError(`duplicate archetype_id ${id} in extend plan`);
		}
		if (old.archetypes.has(id)) {
			throw new StoreExtendError(
				`archetype_id ${id} already exists in the SAB; use grow_column_store to resize it`
			);
		}
		newIds.add(id);
	}

	// 2. Build per-archetype row-count index from the plan's `existing` list.
	//    Reject row_counts naming an archetype that isn't in the old store —
	//    that's a caller bug, not a silent no-op.
	const rowCountsById = new Map<number, number>();
	if (plan.existing) {
		for (let i = 0; i < plan.existing.length; i++) {
			const spec = plan.existing[i];
			if (!old.archetypes.has(spec.archetypeId)) {
				throw new StoreExtendError(
					`existing row_count names unknown archetype_id ${spec.archetypeId}`
				);
			}
			if (spec.rowCount < 0) {
				throw new StoreExtendError(
					`archetype ${spec.archetypeId}: row_count must be non-negative (got ${spec.rowCount})`
				);
			}
			if (spec.rowCount > 0) {
				const oldArch = old.archetypes.get(spec.archetypeId)!;
				if (spec.rowCount > oldArch.rowCapacity) {
					throw new StoreExtendError(
						`archetype ${spec.archetypeId}: row_count ${spec.rowCount} > old row_capacity ${oldArch.rowCapacity}`
					);
				}
			}
			rowCountsById.set(spec.archetypeId, spec.rowCount);
		}
	}

	// 2.5. IN-PLACE FAST PATH (#237 Option A).
	//
	// When the old store was built with `growableSabAllocator` AND it
	// has enough descriptor-region headroom for the new archetypes'
	// entries, we can:
	//   - Reuse the old SAB (its `.grow()` extends in place — existing
	//     typed-array views built with explicit `(byteOffset, length)`
	//     stay valid).
	//   - Append the new descriptors into the descriptor-region slack
	//     (existing descriptor bytes stay put).
	//   - Place the new archetypes' column regions at the SAB tail.
	//   - Skip snapshot+restore entirely — existing column data does not
	//     move.
	//   - Build views only for the new archetypes.
	//
	// Cost per extend drops from O(total-columns-across-all-archetypes)
	// to O(new-columns-this-extend). That's the gap an earlier extend-cost
	// audit identified as the remaining 10× lazy-registration tax.
	if (allocator?.isInPlace === true && isColumnStoreInternal(old) && old._allocator === allocator) {
		const regionOff = old.view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
		// Used descriptor bytes = sum over existing archetypes.
		let usedRegion = 0;
		for (const [, arch] of old.archetypes) {
			usedRegion += archetypeDescriptorBytes(arch.columnsInOrder.length);
		}
		// New descriptor bytes needed.
		let newRegion = 0;
		for (let i = 0; i < plan.newArchetypes.length; i++) {
			newRegion += archetypeDescriptorBytes(plan.newArchetypes[i].columns.length);
		}
		if (usedRegion + newRegion <= old._regionBytes) {
			return extendColumnStoreInPlace(old, plan.newArchetypes, regionOff, usedRegion);
		}
		// Headroom exhausted — fall through to the realloc-and-republish
		// path. The store carries forward the SAME growable allocator so
		// the new SAB also grows in place (just allocated fresh here), and
		// `optionsFromOld` re-reserves the descriptor-region headroom so
		// the realloc'd store keeps taking this fast path next time (#541).
	}

	// 3. Compose the merged spec list. Existing archetypes preserve their
	//    column ordering and current row_capacity (extend never resizes —
	//    that's grow's job).
	//
	// Pass the existing archetype's `columnsInOrder` directly as the new
	// spec's `columns` — `ColumnView` is structurally a `ColumnSpec` (the
	// three required readonly fields `component_id`, `field_id`, `type_tag`
	// match; extra fields like `byte_off`, `stride`, `view` are harmless).
	// Previously we mapped to a fresh `{ component_id, field_id, type_tag }`
	// object per column on every extend — that's an O(total columns)
	// allocation each call, dominant during the lazy-registration ramp-up
	// where 500 archetypes × ~3 columns × 500 extends = 750k allocations.
	const mergedSpecs: ArchetypeSpec[] = [];
	for (const [archetypeId, oldArch] of old.archetypes) {
		mergedSpecs.push({
			archetypeId,
			componentMask: oldArch.componentMask,
			rowCapacity: oldArch.rowCapacity,
			columns: oldArch.columnsInOrder
		});
	}
	for (let i = 0; i < plan.newArchetypes.length; i++) {
		mergedSpecs.push(plan.newArchetypes[i]);
	}

	// 4–6. Realloc-and-republish (see `reallocAndRepublish` for the snapshot →
	// create → restore → stamp choreography). New archetypes start zeroed —
	// fresh SABs and grown wasm-memory both zero-initialise.
	//
	// Slow path: the returned store has fresh ArchetypeViews built via
	// `buildArchetypeViews`. Old views in caller-side wrappers (e.g.,
	// BufferBackedColumn instances) are stale even if the underlying SAB
	// happens to be the same instance (wasmMemoryAllocator preserves
	// `memory.buffer` across grow but the column byte_offs were
	// recomputed in the new layout). Callers MUST refresh.
	const { store, oldViewStamp, newViewStamp } = reallocAndRepublish(
		old,
		mergedSpecs,
		rowCountsById,
		allocator
	);
	return { store, oldViewStamp, newViewStamp, viewsPreserved: false };
}

/**
 * In-place extend (#237 Option A fast path, generalised in #361 to cover
 * `wasmMemoryAllocator`). Pre-conditions verified by the caller in
 * `extendColumnStore`:
 *   - `old._allocator.isInPlace === true` (i.e. the allocator promises
 *     existing TypedArray/DataView views remain valid after the next
 *     allocator call — see `BufferAllocator.isInPlace`).
 *   - `old._regionBytes >= usedRegion + new_descriptor_bytes`
 *     (descriptor headroom suffices for the new archetypes).
 *
 * Existing column TypedArray views are carried forward verbatim — the
 * `isInPlace` contract guarantees they still read/write the same
 * bytes after the allocator extends the underlying storage. The cost is
 * only what's intrinsic to the new archetypes: write their descriptors,
 * allocate new byte ranges at the SAB tail, build their column views.
 *
 * Two `isInPlace` variants are handled identically here:
 *   - `growableSabAllocator` returns the SAME SAB instance grown in
 *     place; `grownBuffer === old.buffer`.
 *   - `wasmMemoryAllocator` returns a NEW SAB ref pointing to the
 *     same underlying shared linear memory; `grownBuffer !== old.buffer` but
 *     old views still operate on the same bytes (verified empirically
 *     against Bun + V8, #361 thread A / PR #363 probe 3).
 *
 * When the SAB ref changed we mint a fresh `DataView` over `grownBuffer`
 * so header / descriptor writes past the pre-grow `byteLength` are
 * legal. New archetype views are built over `grownBuffer` (their byte
 * ranges live past the pre-grow tail, so the old ref's frozen
 * `byteLength` would refuse them).
 */
function extendColumnStoreInPlace(
	old: ColumnStoreInternal,
	newArchetypes: readonly ArchetypeSpec[],
	regionOff: number,
	usedRegion: number
): ExtendResult {
	// 1. Compute new column byte_offs at the SAB tail — `tailCursorBytes(old)`
	//    is the live extent (header `capacity` for the fixed heap buffer,
	//    `buffer.byteLength` for the growable-SAB / wasm backings). New columns
	//    have no prior stride, so it's derived from the type tag here.
	const tailLayouts: TailArchetypeLayout[] = new Array(newArchetypes.length);
	for (let i = 0; i < newArchetypes.length; i++) {
		const spec = newArchetypes[i];
		tailLayouts[i] = {
			archetypeId: spec.archetypeId,
			componentMask: spec.componentMask,
			rowCapacity: spec.rowCapacity,
			columns: spec.columns.map((c) => ({
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				stride: TYPE_TAG_STRIDE[c.typeTag]
			}))
		};
	}
	// Tail cursor = the backing's live extent (see `tailCursorBytes`): the header
	// `capacity` for the fixed heap ArrayBuffer, or `buffer.byteLength` for the
	// growable-SAB / wasm backings (the wasm fast path deliberately lands new
	// regions past its page-rounded tail — unchanged here).
	const { descriptors: newDescriptors, newTotal } = layoutColumnsAtTail(
		tailCursorBytes(old),
		tailLayouts
	);

	// 2. Grow the storage to fit the new tail — see `growBufferInPlace`.
	//    Header + descriptor writes below all stay within the pre-grow byte
	//    range (the fast path requires descriptor-region headroom suffices
	//    for the new descriptors), but tracking the live SAB on
	//    `newStore.view` keeps future grows / extends well-formed.
	const { grownBuffer, newView } = growBufferInPlace(old, newTotal);

	// 3. Append the new descriptor entries into the reserved descriptor
	//    region slack (after the existing entries, before the unused
	//    tail). Existing descriptor bytes are not touched — their column
	//    byte_offs in particular stay valid for existing column views.
	let descOff = regionOff + usedRegion;
	for (let i = 0; i < newDescriptors.length; i++) {
		descOff = writeArchetypeDescriptor(newView, descOff, newDescriptors[i]);
	}

	// 4. Update header fields. The header sits at the very start of the
	//    SAB; writes via `newView` (over the live SAB ref) are always
	//    in-bounds regardless of which `isInPlace` variant we took.
	const oldViewStamp = newView.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
	const newArchetypeCount = old.archetypes.size + newArchetypes.length;
	newView.setUint32(STORE_HEADER_OFFSETS.archetype_count, newArchetypeCount, true);
	newView.setUint32(STORE_HEADER_OFFSETS.capacity, newTotal, true);
	const newViewStamp = (oldViewStamp + 1) >>> 0;
	newView.setUint32(STORE_HEADER_OFFSETS.view_stamp, newViewStamp, true);

	// 5. Build views for the new archetypes only. Existing archetype
	//    views are reused as-is — `isInPlace` guarantees they still
	//    operate on the same memory. New views must bind to `grownBuffer`
	//    (the post-grow ref) because their byte ranges live past the
	//    pre-grow tail; under wasm memory the old ref's frozen
	//    `byteLength` would refuse them.
	const newViewsMap = buildArchetypeViews(grownBuffer, newDescriptors);

	// 6. Merge old + new into a fresh archetypes Map. `ArchetypeViews`
	//    references are stable — same `ColumnView` objects, same
	//    TypedArray instances.
	const mergedArchetypes = new Map<number, ArchetypeViews>();
	for (const [archetypeId, arch] of old.archetypes) {
		mergedArchetypes.set(archetypeId, arch);
	}
	for (const [archetypeId, arch] of newViewsMap) {
		mergedArchetypes.set(archetypeId, arch);
	}

	const newStore: ColumnStoreInternal = {
		buffer: grownBuffer,
		view: newView,
		header: {
			...old.header,
			viewStamp: newViewStamp,
			capacity: newTotal,
			archetypeCount: newArchetypeCount
		},
		archetypes: mergedArchetypes,
		_regionBytes: old._regionBytes,
		_allocator: old._allocator,
		// Carry the headroom policy forward so a LATER realloc (once this
		// in-place slack is exhausted) re-reserves the same margin (#541).
		_reservedDescriptorBytes: old._reservedDescriptorBytes
	};

	// Fast path: existing ArchetypeViews carried forward unchanged, so
	// caller-side column wrappers (BufferBackedColumn) still reference the
	// same valid TypedArrays. `viewsPreserved: true` is the signal that
	// `refreshViews` can be skipped for pre-existing archetypes.
	return { store: newStore, oldViewStamp, newViewStamp, viewsPreserved: true };
}
