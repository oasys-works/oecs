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

import type { ArchetypeGrowSpec } from "./grow";
import { STORE_HEADER_OFFSETS } from "./header";
import {
	alignUp,
	buildArchetypeViews,
	createColumnStore,
	STORE_MAX_BYTE_OFFSET,
	StoreLayoutOverflowError,
	type ArchetypeSpec,
	type ArchetypeViews,
	type CreateColumnStoreOptions,
	type ColumnStore,
	type ColumnStoreInternal
} from "./column_store";
import type { BufferAllocator } from "./allocator";
import {
	TYPE_TAG_STRIDE,
	archetypeDescriptorBytes,
	writeArchetypeDescriptor,
	type ArchetypeDescriptor,
	type ColumnDescriptor
} from "./descriptor";
import {
	STORE_PREFIX_REGIONS,
	type MutableColumnStoreOptions,
	type StoreRegionOffsetField
} from "./store_regions";
import { findRegionOffset, readHeaderRegionTable, type StoreRegionSpec } from "./region_table";

/**
 * Derive `CreateColumnStoreOptions` from an old ColumnStore so a slow-path realloc
 * preserves the same set of optional regions at the same byte offsets in the
 * new SAB. Without this, an extend / grow would silently drop a region — the
 * command ring's pending commands, every entity placement in the index, etc.
 * would be lost.
 *
 * Walks `STORE_PREFIX_REGIONS`: each present region's `readOptions` replays the
 * exact capacity the engine configured (regions may carry non-default sizes),
 * not just the default. Live state (write_head, length, …) is preserved
 * separately via `snapshotPrefixRegions`.
 *
 * Also re-applies the descriptor-region headroom policy
 * (`reservedDescriptorBytes`, #541). Unlike the prefix regions this is NOT
 * read from the SAB bytes — it's a JS-side policy carried on
 * `ColumnStoreInternal._reservedDescriptorBytes` — but it belongs here for the
 * same reason: without it the realloc'd store drops to zero descriptor
 * headroom and every later `extendColumnStore` takes the slow path forever.
 * Re-reserving the same margin (additive, see `planLayout`) keeps the #237
 * in-place fast path alive across reallocs.
 */
export function optionsFromOld(old: ColumnStore): CreateColumnStoreOptions {
	const options: MutableColumnStoreOptions = {};
	for (let i = 0; i < STORE_PREFIX_REGIONS.length; i++) {
		const region = STORE_PREFIX_REGIONS[i];
		const off = old.view.getUint32(STORE_HEADER_OFFSETS[region.headerOff], true);
		if (off !== 0) region.readOptions(old.view, off, options);
	}
	// Consumer regions (#623): the region-table directory is self-describing —
	// each entry carries the region's id and byte length — so the new SAB can be
	// re-laid-out identically WITHOUT re-deriving the consumer's sizing knobs.
	// `init` is a no-op here: the region's live bytes are restored verbatim by
	// `restorePrefixRegions`, so createColumnStore only needs the size to
	// reserve the right span at the same offset.
	const table = readHeaderRegionTable(old.view);
	if (table.length > 0) {
		options.regions = table.map(
			(e): StoreRegionSpec => ({
				id: e.regionId,
				name: `region:${e.regionId}`,
				bytes: e.byteLength,
				init: () => {}
			})
		);
	}
	// Sim-bindings region (#625): self-describing from the old header — the
	// region is the gap between `bindings_off` and the descriptor region, so its
	// size is re-derived rather than carried as a JS-side policy. `bindings_off`
	// = 0 means the consumer never opted into a bindings region (pure-TS game),
	// so the new SAB reserves none either. The region's live bytes are NOT
	// snapshotted — the host re-writes them via `write_sim_bindings` on the
	// `setLayout` that fires after every realloc (loader.ts), same as before.
	const bindingsOff = old.view.getUint32(STORE_HEADER_OFFSETS.bindings_off, true);
	if (bindingsOff !== 0) {
		const descriptorOff = old.view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
		options.bindingsRegionBytes = descriptorOff - bindingsOff;
	}
	const reserved = (old as Partial<ColumnStoreInternal>)._reservedDescriptorBytes;
	if (reserved !== undefined && reserved > 0) {
		options.reservedDescriptorBytes = reserved;
	}
	return options;
}

/** A prefix-region snapshot: the live bytes of every present region from the
 * old SAB. `mechanism` is keyed by the `StoreHeader` field holding a mechanism
 * region's offset; `consumer` is keyed by `region_id` (consumer regions have no
 * named header field). Pairs `snapshotPrefixRegions` with
 * `restorePrefixRegions`. */
export interface PrefixRegionSnapshot {
	readonly mechanism: Map<StoreRegionOffsetField, Uint8Array>;
	readonly consumer: Map<number, Uint8Array>;
}

/**
 * Snapshot the live bytes of every present region — both engine MECHANISM
 * regions (STORE_PREFIX_REGIONS) and CONSUMER regions (the region-table
 * directory) — from the old SAB BEFORE any allocator call that may detach
 * views. Each entry is a heap `Uint8Array` copy (via `slice()`) so it survives
 * an allocator-induced detach; `restorePrefixRegions` places it back at the
 * matching offset in the new SAB.
 *
 * Header bytes themselves are NOT snapshotted — `createColumnStore` writes the
 * header (and the region-table directory) from scratch with the correct
 * view_stamp (bumped after this call) and offsets.
 */
export function snapshotPrefixRegions(old: ColumnStore): PrefixRegionSnapshot {
	const mechanism = new Map<StoreRegionOffsetField, Uint8Array>();
	for (let i = 0; i < STORE_PREFIX_REGIONS.length; i++) {
		const region = STORE_PREFIX_REGIONS[i];
		const off = old.view.getUint32(STORE_HEADER_OFFSETS[region.headerOff], true);
		if (off === 0) continue;
		const bytes = region.regionBytes(old.view, off);
		// boundary: TypedArray interop. Materialise a Uint8Array view over the
		// region's byte range, then copy via slice() so the heap copy survives
		// an allocator-induced detach.
		mechanism.set(region.headerOff, new Uint8Array(old.buffer, off, bytes).slice());
	}
	// Consumer regions: the directory carries each region's offset + byte length
	// directly, so the snapshot needs no per-region helper (unlike mechanism
	// regions, whose size lives in their own header).
	const consumer = new Map<number, Uint8Array>();
	const table = readHeaderRegionTable(old.view);
	for (let i = 0; i < table.length; i++) {
		const e = table[i];
		consumer.set(e.regionId, new Uint8Array(old.buffer, e.byteOffset, e.byteLength).slice());
	}
	return { mechanism, consumer };
}

/** Restore prefix-region byte snapshots into `newStore` at the matching
 * region offsets. Pairs with `snapshotPrefixRegions`. The new SAB's regions
 * were sized identically by `optionsFromOld`, so each snapshot lands at the
 * same length its source had — mechanism regions at their named header offset,
 * consumer regions at the offset the rebuilt region-table resolves their id to. */
export function restorePrefixRegions(newStore: ColumnStore, snap: PrefixRegionSnapshot): void {
	for (const [headerOff, bytes] of snap.mechanism) {
		const off = newStore.view.getUint32(STORE_HEADER_OFFSETS[headerOff], true);
		// boundary: TypedArray interop. Write back at the same offset.
		const dst = new Uint8Array(newStore.buffer, off, bytes.byteLength);
		dst.set(bytes);
	}
	for (const [regionId, bytes] of snap.consumer) {
		const off = findRegionOffset(newStore.view, regionId);
		if (off === 0) continue; // region absent in the new layout (shouldn't happen)
		// boundary: TypedArray interop. Write back at the rebuilt offset.
		const dst = new Uint8Array(newStore.buffer, off, bytes.byteLength);
		dst.set(bytes);
	}
}

/**
 * Snapshot per-archetype live column bytes from `old` BEFORE any
 * subsequent allocator call may detach the underlying typed-array views.
 * Returned shape: `{ archetype_id → Uint8Array[] }`, one entry per
 * column in `columnsInOrder`. Each `Uint8Array` is a fresh copy
 * (not a view) so it survives a `WebAssembly.Memory.grow`. Archetypes
 * with `row_count === 0` are omitted — nothing to copy.
 *
 * Shared with `growColumnStore`; both functions need the same
 * snapshot-before-allocate pattern under the wasm-memory allocator.
 */
export function snapshotLiveColumns(
	old: ColumnStore,
	rowCountsById: Map<number, number>
): Map<number, Uint8Array[]> {
	const out = new Map<number, Uint8Array[]>();
	for (const [archetypeId, oldArch] of old.archetypes) {
		const rowCount = rowCountsById.get(archetypeId) ?? 0;
		if (rowCount === 0) continue;
		const cols: Uint8Array[] = [];
		for (let i = 0; i < oldArch.columnsInOrder.length; i++) {
			const c = oldArch.columnsInOrder[i];
			const liveBytes = rowCount * c.stride;
			const snap = new Uint8Array(liveBytes);
			// boundary: TypedArray interop. `c.view` is `AnyTypedArray`; we
			// reinterpret its byte range as `Uint8Array` for the copy. The
			// source SAB is not mutated; the snapshot owns its own storage.
			snap.set(new Uint8Array(c.view.buffer, c.view.byteOffset, liveBytes));
			cols.push(snap);
		}
		out.set(archetypeId, cols);
	}
	return out;
}

/**
 * Write per-archetype column snapshots produced by `snapshotLiveColumns`
 * into `newStore`'s column views. The snapshot's column ORDER must match
 * the new archetype's `columnsInOrder` (extend / grow guarantee this
 * because they carry the column spec forward unchanged).
 */
export function restoreColumnSnapshots(
	newStore: ColumnStore,
	snapshots: Map<number, Uint8Array[]>
): void {
	for (const [archetypeId, cols] of snapshots) {
		const newArch = newStore.archetypes.get(archetypeId);
		if (newArch === undefined) {
			throw new Error(
				`restore_column_snapshots: new store missing archetype ${archetypeId} (internal)`
			);
		}
		const newCols = newArch.columnsInOrder;
		for (let i = 0; i < cols.length; i++) {
			const v = newCols[i].view;
			const dst = new Uint8Array(v.buffer, v.byteOffset, cols[i].byteLength);
			dst.set(cols[i]);
		}
	}
}

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
	const oldInternal = old as Partial<ColumnStoreInternal>;
	const allocatorInPlace = (allocator as { isInPlace?: boolean } | undefined)?.isInPlace;
	if (
		allocatorInPlace === true &&
		oldInternal._allocator === allocator &&
		typeof oldInternal._regionBytes === "number"
	) {
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
		if (usedRegion + newRegion <= oldInternal._regionBytes) {
			return extendColumnStoreInPlace(
				old as ColumnStoreInternal,
				plan.newArchetypes,
				regionOff,
				usedRegion
			);
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

	// 4. Snapshot live rows AND prefix regions (command ring,
	//    entity-index) BEFORE the allocator call. Under the
	//    `wasmMemoryAllocator`, `createColumnStore` may grow the
	//    underlying memory and detach `old`'s typed-array views; under
	//    the default allocator the snapshots are normal heap copies
	//    (and `old` stays valid alongside them). Same code path for
	//    both — keeps the extend semantics allocator-agnostic.
	//    `view_stamp` is captured here for the same detachment reason.
	//
	//    The prefix-region snapshot preserves the LIVE state of the
	//    command ring (pending commands) and entity-index (every entity
	//    placement) across the realloc. Without it, every archetype
	//    discovery during a session would lose the entire entity table
	//    (#245).
	const oldViewStamp = old.view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
	const snapshots = snapshotLiveColumns(old, rowCountsById);
	const prefixSnap = snapshotPrefixRegions(old);
	const derivedOptions = optionsFromOld(old);

	const newStore = createColumnStore(mergedSpecs, allocator, derivedOptions);

	// 5. Restore live rows + prefix regions. New archetypes start
	//    zeroed — fresh SABs and grown wasm-memory both zero-initialise.
	//    Prefix regions are restored AFTER `createColumnStore` initialised
	//    them to empty headers, overwriting the empty state with the
	//    live state we captured.
	restoreColumnSnapshots(newStore, snapshots);
	restorePrefixRegions(newStore, prefixSnap);

	// 6. Bump view_stamp from the value captured before the allocator
	//    detached old.view.
	const newViewStamp = (oldViewStamp + 1) >>> 0;
	newStore.view.setUint32(STORE_HEADER_OFFSETS.view_stamp, newViewStamp, true);

	// Patch the returned header so its cached `view_stamp` matches the SAB
	// bytes just written — `createColumnStore` stamped it 0 (#386). The
	// in-place path (`extendColumnStoreInPlace`) already does this; without
	// it a consumer trusting `store.header.view_stamp` instead of re-reading
	// via `readStoreHeader` would see a stale 0. `capacity` and
	// `archetype_count` are already correct here (createColumnStore sizes them
	// to the new store), so the spread carries them — and the internal
	// `_allocator` / `_regionBytes` fields — through unchanged.
	const patchedStore: ColumnStore = {
		...newStore,
		header: { ...newStore.header, viewStamp: newViewStamp }
	};

	// Slow path: newStore has fresh ArchetypeViews built via
	// `buildArchetypeViews`. Old views in caller-side wrappers (e.g.,
	// BufferBackedColumn instances) are stale even if the underlying SAB
	// happens to be the same instance (wasmMemoryAllocator preserves
	// `memory.buffer` across grow but the column byte_offs were
	// recomputed in the new layout). Callers MUST refresh.
	return { store: patchedStore, oldViewStamp, newViewStamp, viewsPreserved: false };
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
	// 1. Compute new column byte_offs at the SAB tail. `old.buffer.byteLength`
	//    equals the previous `totalBytes` (last `cursor` from
	//    `planLayout` / previous in-place extend).
	let cursor = old.buffer.byteLength;
	const newDescriptors: ArchetypeDescriptor[] = new Array(newArchetypes.length);
	for (let i = 0; i < newArchetypes.length; i++) {
		const spec = newArchetypes[i];
		const columns: ColumnDescriptor[] = new Array(spec.columns.length);
		for (let j = 0; j < spec.columns.length; j++) {
			const c = spec.columns[j];
			const stride = TYPE_TAG_STRIDE[c.typeTag];
			cursor = alignUp(cursor, stride);
			columns[j] = {
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: cursor,
				stride
			};
			cursor += stride * spec.rowCapacity;
		}
		newDescriptors[i] = {
			archetypeId: spec.archetypeId,
			componentMask: spec.componentMask,
			rowCount: 0,
			enabledCount: 0,
			rowCapacity: spec.rowCapacity,
			columns
		};
	}
	const newTotal = cursor;
	// The final tail (last column's `cursor += …`, not re-aligned) becomes the
	// grown SAB byteLength; guard it past 2³¹ like `planLayout` does (#382).
	if (newTotal > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(newTotal);
	}

	// 2. Grow the storage to fit the new tail. `growableSabAllocator`
	//    returns the SAME SAB instance grown in place; `wasmMemoryAllocator`
	//    returns a NEW SAB ref pointing to the same underlying linear
	//    memory (post-`memory.grow()`). Both honour the `isInPlace`
	//    contract — existing typed-array views remain valid either way.
	const grownBuffer = old._allocator(newTotal);
	const bufferRefChanged = grownBuffer !== old.buffer;

	// When the SAB ref changes (wasm path), the old DataView's byteLength
	// is frozen at the pre-grow size — writes past that boundary would
	// throw. Header + descriptor writes below all stay within the
	// pre-grow byte range (the fast path requires descriptor-region
	// headroom suffices for the new descriptors), but tracking the live
	// SAB on `newStore.view` keeps future grows / extends well-formed.
	const newView = bufferRefChanged ? new DataView(grownBuffer) : old.view;

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
