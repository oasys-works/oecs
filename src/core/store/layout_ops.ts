/**
 * Shared layout/realloc operations for `growColumnStore` / `extendColumnStore`
 * (H5). The two files used to duplicate ~200 lines of structurally parallel
 * logic — the tail-cursor `alignUp` placement with its 2³¹ offset guard, the
 * in-place buffer grow + view-mint step, and the whole realloc-and-republish
 * choreography (snapshot → createColumnStore → restore → view-stamp bump →
 * header patch). Each invariant now has one home here; grow/extend keep only
 * their genuinely distinct logic (which archetypes move, how descriptors are
 * written, how result views merge).
 *
 * The prefix-region and live-column snapshot helpers also live here (moved
 * from extend.ts) — they are exactly the realloc path's building blocks, and
 * housing them beside `reallocAndRepublish` removes the grow → extend value
 * import that marked these files as one module split in two.
 */

import type { BufferAllocator } from "./allocator";
import {
	alignUp,
	createColumnStore,
	STORE_MAX_BYTE_OFFSET,
	StoreLayoutOverflowError,
	isColumnStoreInternal,
	type ArchetypeSpec,
	type ColumnStore,
	type ColumnStoreInternal,
	type CreateColumnStoreOptions
} from "./column_store";
import type { ArchetypeDescriptor, ColumnDescriptor, TypeTagValue } from "./descriptor";
import { STORE_HEADER_OFFSETS } from "./header";
import { findRegionOffset, readHeaderRegionTable, type StoreRegionSpec } from "./region_table";
import {
	STORE_PREFIX_REGIONS,
	type MutableColumnStoreOptions,
	type StoreRegionOffsetField
} from "./store_regions";

/** Per-archetype resize/copy input, shared by `GrowPlan.archetypes` and
 * `ExtendPlan.existing` (so callers can reuse plan-building helpers). The
 * caller picks the new `row_capacity` and declares the current live
 * `row_count` so the copy knows how many rows matter. */
export interface ArchetypeGrowSpec {
	readonly archetypeId: number;
	readonly newRowCapacity: number;
	readonly rowCount: number;
}

/** One archetype's column-layout request for `layoutColumnsAtTail`. `stride`
 * is resolved by the caller — grow reuses the old column's stride verbatim;
 * extend derives it from `TYPE_TAG_STRIDE[typeTag]` for brand-new columns. */
export interface TailArchetypeLayout {
	readonly archetypeId: number;
	readonly componentMask: ArchetypeDescriptor["componentMask"];
	readonly rowCapacity: number;
	readonly columns: readonly {
		readonly componentId: number;
		readonly fieldId: number;
		readonly typeTag: TypeTagValue;
		readonly stride: number;
	}[];
}

/** Tail-cursor column placement — the single home for the in-place paths'
 * layout rule and the 2³¹ offset cap (#382). Starting at `startCursor`
 * (the current buffer byteLength), each archetype's columns are placed
 * `alignUp(cursor, stride)` then advanced by `stride * rowCapacity`; the
 * final tail (last column's advance, not re-aligned) becomes the grown
 * buffer's byteLength and is guarded past `STORE_MAX_BYTE_OFFSET` exactly
 * like `planLayout` guards the create-time layout. Descriptors come back
 * with `rowCount` / `enabledCount` zeroed (the store side of those counters
 * lives with the caller). */
export function layoutColumnsAtTail(
	startCursor: number,
	archetypes: readonly TailArchetypeLayout[]
): { descriptors: ArchetypeDescriptor[]; newTotal: number } {
	let cursor = startCursor;
	const descriptors: ArchetypeDescriptor[] = new Array(archetypes.length);
	for (let i = 0; i < archetypes.length; i++) {
		const arch = archetypes[i];
		const columns: ColumnDescriptor[] = new Array(arch.columns.length);
		for (let j = 0; j < arch.columns.length; j++) {
			const c = arch.columns[j];
			cursor = alignUp(cursor, c.stride);
			columns[j] = {
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: cursor,
				stride: c.stride
			};
			cursor += c.stride * arch.rowCapacity;
		}
		descriptors[i] = {
			archetypeId: arch.archetypeId,
			componentMask: arch.componentMask,
			rowCount: 0,
			enabledCount: 0,
			rowCapacity: arch.rowCapacity,
			columns
		};
	}
	if (cursor > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(cursor);
	}
	return { descriptors, newTotal: cursor };
}

/** Grow an in-place-backed store's buffer to `newTotal` and mint the DataView
 * the caller must write headers/descriptors through. `growableSabAllocator` /
 * `heapArraybufferAllocator` return the SAME buffer instance grown in place;
 * `wasmMemoryAllocator` returns a NEW ref over the same linear memory — old
 * typed-array views stay valid either way (the `isInPlace` contract), but
 * when the ref changed the old DataView's byteLength is frozen at the
 * pre-grow size, so a fresh DataView over the new ref is required for any
 * write past that boundary. */
export function growBufferInPlace(
	old: ColumnStoreInternal,
	newTotal: number
): { grownBuffer: ArrayBufferLike; newView: DataView } {
	const grownBuffer = old._allocator(newTotal);
	const newView = grownBuffer !== old.buffer ? new DataView(grownBuffer) : old.view;
	return { grownBuffer, newView };
}

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
	if (isColumnStoreInternal(old) && old._reservedDescriptorBytes > 0) {
		options.reservedDescriptorBytes = old._reservedDescriptorBytes;
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

/**
 * The realloc-and-republish slow path shared by `growColumnStore` and
 * `extendColumnStore` — everything between "the specs are decided" and "the
 * caller shapes its result":
 *
 *   1. Capture `view_stamp` and snapshot live rows AND prefix regions
 *      (command ring, entity-index) BEFORE the allocator call — the
 *      wasmMemoryAllocator may detach `old`'s views on grow, so everything
 *      needed is captured first. The prefix-region preservation is the
 *      contract `Store` relies on to keep its entity table across resizes
 *      (#245); `optionsFromOld` re-reserves regions and descriptor headroom
 *      (#541) so the republished store keeps its layout and fast paths.
 *   2. `createColumnStore` with the derived options (fresh buffer; the same
 *      growable allocator carries forward so the new buffer also grows in
 *      place).
 *   3. Restore live rows + prefix regions. Archetypes without a row count
 *      contributed no snapshot and stay zero-initialised; prefix regions
 *      overwrite the empty state `createColumnStore` initialised.
 *   4. Bump `view_stamp` from the pre-capture value and patch the returned
 *      header so its cached `viewStamp` matches the buffer bytes just
 *      written — `createColumnStore` stamped it 0 (#386). `capacity` /
 *      `archetype_count` are already correct (createColumnStore sized them),
 *      so the spread carries them — and the internal `_allocator` /
 *      `_regionBytes` fields — through unchanged.
 *
 * Every view in the returned store is fresh; callers MUST refresh
 * (`viewsPreserved: false` is the callers' contract with THEIR callers).
 */
export function reallocAndRepublish(
	old: ColumnStore,
	specs: readonly ArchetypeSpec[],
	rowCountsById: Map<number, number>,
	allocator: BufferAllocator | undefined
): { store: ColumnStore; oldViewStamp: number; newViewStamp: number } {
	const oldViewStamp = old.view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
	const snapshots = snapshotLiveColumns(old, rowCountsById);
	const prefixSnap = snapshotPrefixRegions(old);
	const derivedOptions = optionsFromOld(old);

	const newStore = createColumnStore(specs, allocator, derivedOptions);

	restoreColumnSnapshots(newStore, snapshots);
	restorePrefixRegions(newStore, prefixSnap);

	const newViewStamp = (oldViewStamp + 1) >>> 0;
	newStore.view.setUint32(STORE_HEADER_OFFSETS.view_stamp, newViewStamp, true);

	const patchedStore: ColumnStore = {
		...newStore,
		header: { ...newStore.header, viewStamp: newViewStamp }
	};
	return { store: patchedStore, oldViewStamp, newViewStamp };
}
