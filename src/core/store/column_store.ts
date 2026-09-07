/**
 * ColumnStore, the sizing + layout primitive that turns a set of archetype
 * requirements into one span of a backing carrying:
 *   1. A locked header (see `header.ts`).
 *   2. A layout descriptor region (see `descriptor.ts`).
 *   3. Aligned column regions, each addressable via a TypedArray view.
 *
 * The span starts at `storeBase`, a caller-chosen byte offset, and every offset
 * the store writes is relative to it. The store writes only inside
 * `[storeBase, storeBase + capacity)`, which is what lets a WASM module own the
 * low addresses of the same linear memory. The base defaults to 0.
 *
 * `Store.allocate` returns TypedArray views into a single buffer at the
 * right offset. This file builds that mapping, given
 * `{ archetype_id, row_capacity, columns: [{ component_id, field_id,
 * type_tag }] }` for every archetype, it computes byte offsets, writes the
 * header + descriptor, and hands back the views in one shot.
 *
 * The offset math is locked against a binary fixture, so `Archetype` and
 * `Store` lean on a tested primitive instead of inventing their own
 * arithmetic.
 *
 * Alignment: each column starts at its `type_tag` stride boundary. This is
 * the minimum needed for TypedArray construction (`new Float32Array(buffer,
 * off, n)` throws on a misaligned `off`) and matches the alignment a module's
 * typed pointer expects.
 */

import {
	STORE_HEADER_BYTES,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	writeStoreHeader,
	type StoreHeader
} from "./header";
import {
	type ArchetypeDescriptor,
	type ColumnDescriptor,
	type TypeTagValue,
	TYPE_TAG,
	TYPE_TAG_STRIDE,
	archetypeDescriptorBytes,
	layoutDescriptorRegionBytes,
	writeLayoutDescriptorRegion
} from "./descriptor";
import { DEFAULT_SAB_ALLOCATOR, type BufferAllocator } from "./allocator";
import { COMMAND_RING_DEFAULT_CAPACITY_SLOTS } from "./command_ring";
import { ENTITY_INDEX_DEFAULT_CAPACITY } from "./entity_index";
import { EVENT_RING_DEFAULT_CAPACITY_SLOTS } from "./event_ring";
import { STORE_PREFIX_REGIONS, type StoreRegionOffsetField } from "./store_regions";
import {
	regionTableBytes,
	assertRegionSpecs,
	writeRegionTable,
	type RegionTableEntry,
	type StoreRegionSpec
} from "./region_table";

/** Caller-facing column spec, no `byte_off` yet, the store computes it. */
export interface ColumnSpec {
	readonly componentId: number;
	readonly fieldId: number;
	readonly typeTag: TypeTagValue;
}

/** Caller-facing archetype spec, no `column_count` (derived) and no
 * `byte_off`s in the columns. Both are computed during sizing. */
export interface ArchetypeSpec {
	readonly archetypeId: number;
	/** Component bitmask, `COMPONENT_MASK_WORDS` little-endian u32 words. */
	readonly componentMask: readonly number[];
	readonly rowCapacity: number;
	readonly columns: readonly ColumnSpec[];
}

/** A single column's view after allocation. `byteOff` matches what the layout
 * descriptor records, so it is measured from the store base. `view` is a
 * TypedArray of the right element type, length `row_capacity`, and its
 * `byteOffset` is `storeBase + byteOff`. */
export interface ColumnView {
	readonly componentId: number;
	readonly fieldId: number;
	readonly typeTag: TypeTagValue;
	readonly byteOff: number;
	readonly stride: number;
	readonly view: AnyTypedArray;
}

/** Views for all columns in a single archetype, indexed by a numeric
 * key encoding `(component_id, field_id)` so a (cid, fid) pair maps to
 * its column in O(1). The encoding (see `columnKey`) is dense over
 * (cid: 0..65535, fid: 0..65535), letting V8 keep this as a
 * Number-keyed `Map`, meaningfully faster than the previous string
 * keys (no per-lookup template-string allocation, no string hashing).
 * The row order matches `ArchetypeSpec.columns`. The
 * `component_mask` words mirror what's in the SAB layout descriptor so
 * `growColumnStore` (and any other carry-forward path) doesn't have to
 * re-parse the descriptor region. */
export interface ArchetypeViews {
	readonly archetypeId: number;
	/** Component bitmask, `COMPONENT_MASK_WORDS` little-endian u32 words. */
	readonly componentMask: readonly number[];
	readonly rowCapacity: number;
	readonly columns: ReadonlyMap<number, ColumnView>;
	readonly columnsInOrder: readonly ColumnView[];
}

export interface ColumnStore {
	/** The backing buffer. `ArrayBufferLike` because the store is backing-agnostic:
	 * a `SharedArrayBuffer` for the SAB, WASM and worker profile, or a plain fixed
	 * `ArrayBuffer` for the pure-TS heap profile (`heapArrayBufferAllocator`).
	 * A consumer that genuinely requires sharing (worker transfer, WASM memory)
	 * narrows back to `SharedArrayBuffer` at its own boundary. */
	readonly buffer: ArrayBufferLike;
	/** A `DataView` whose start is the store base, so every relative offset the
	 * header and the descriptors carry indexes it directly. */
	readonly view: DataView;
	readonly header: StoreHeader;
	/** Byte offset of the header inside `buffer`. Every other offset in the
	 * store is relative to this. The store writes only inside
	 * `[storeBase, storeBase + header.capacity)`, which is what lets a WASM
	 * module own the bytes below the base. */
	readonly storeBase: number;
	/** Indexed by `archetype_id`. */
	readonly archetypes: ReadonlyMap<number, ArchetypeViews>;
}

export type AnyTypedArray =
	| Uint8Array
	| Int8Array
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array
	| Float64Array;

/** Pack `(component_id, field_id)` into a single non-negative integer so
 * `ArchetypeViews.columns` can be a `Map<number, ColumnView>` instead of
 * `Map<string, ColumnView>`. V8's number-keyed `Map` skips the
 * string-hash + string-equality every lookup pays, and template-string
 * keys (`"${cid}:${fid}"`) allocated a fresh string on every call. On
 * the lazy-registration ramp-up the per-extend `refreshViews`
 * walks `N` × `cols` of these lookups for `N` archetypes, so the saving
 * compounds quadratically.
 *
 * Encoding: `(component_id << 16) | field_id`. `component_id` is bounded
 * by `STORE_DESCRIPTOR_COMPONENT_LIMIT` (the registration cap, 128), well
 * below 65536. `field_id` is bounded by the component's schema width,
 * single digits in practice. */
export function columnKey(componentId: number, fieldId: number): number {
	return (componentId << 16) | fieldId;
}

/** First byte offset the SAB layout math cannot represent: 2³¹.
 *
 * `alignUp` rounds with `& ~(align-1)`, and JS bitwise operators coerce
 * their operands to **signed** 32-bit integers (`ToInt32`). Once an offset
 * reaches 2³¹ the result wraps to a negative number (or, for some inputs, a
 * misaligned positive one), which then flows straight into
 * `new Uint8Array(buffer, byte_off, …)`, either a thrown `RangeError` deep in
 * the TypedArray ctor or, worse, a silently wrong view overlapping another
 * column. The 256 MiB default allocator cap (`growableSabAllocator`) keeps
 * a real world far below this, but the cap is tunable
 * and callers are invited to raise it for bigger worlds, so the layout step
 * guards the hard 2³¹ ceiling explicitly rather than relying on the policy
 * cap to stay in front of it. */
export const STORE_MAX_BYTE_OFFSET = 2 ** 31;

/** Thrown when a SAB column layout would place an offset at or beyond
 * {@link STORE_MAX_BYTE_OFFSET} (2³¹), past which the signed-32-bit bitwise
 * `alignUp` can no longer produce correct offsets. This is a hard ceiling,
 * not the (tunable, much lower) 256 MiB allocator cap. */
export class StoreLayoutOverflowError extends Error {
	constructor(byteOff: number) {
		super(
			`SAB column layout offset ${byteOff} reaches or exceeds the 2³¹ ` +
				`(${STORE_MAX_BYTE_OFFSET}-byte) ceiling. Past 2 GiB the signed-32-bit ` +
				`bitwise alignment math wraps to a negative or misaligned offset. This ` +
				`is a structural limit independent of the allocator cap, so a single ` +
				`store cannot back more than 2 GiB of column data.`
		);
		this.name = "StoreLayoutOverflowError";
	}
}

/** Round `off` up to the next multiple of `align`. `align` must be a power
 * of two (1, 2, 4 or 8 here, all `TYPE_TAG_STRIDE` values).
 *
 * Throws {@link StoreLayoutOverflowError} when the rounded offset would reach
 * {@link STORE_MAX_BYTE_OFFSET}, because the `& ~(align-1)` step coerces to a
 * signed 32-bit int and wraps past 2³¹. The guard fires before the
 * bitwise op so any returned offset is always a correct, in-range value.
 * Shared by `extend.ts` and `grow.ts`, whose in-place paths compute tail
 * byte_offs without going through `planLayout`. */
export function alignUp(off: number, align: number): number {
	if (off + align > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(off);
	}
	return (off + (align - 1)) & ~(align - 1);
}

/**
 * Build the TypedArray view for one column.
 *
 * Every view gets an explicit `(byteOffset, length)`, and it must stay that
 * way. A TypedArray built with no length argument tracks the length of its
 * buffer. Measurement shows that a length-tracking view over a buffer that can
 * grow is the worst of all the access shapes: each element access costs far
 * more than the same access through a fixed-length view, on every engine
 * tested. A fixed-length view over the same growable buffer does not pay that.
 *
 * The store never reaches the bad shape, because this function is the only
 * place that makes a column view and it always gives the length. Keep it the
 * only place. `extend.test.ts` locks the other half: a view keeps its length
 * when the buffer below it grows.
 */
function createView(
	buffer: ArrayBufferLike,
	storeBase: number,
	typeTag: TypeTagValue,
	relOff: number,
	rowCapacity: number
): AnyTypedArray {
	// The one seam that turns a store-relative offset into a buffer offset.
	const byteOff = storeBase + relOff;
	switch (typeTag) {
		case TYPE_TAG.u8:
			return new Uint8Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.i8:
			return new Int8Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.u16:
			return new Uint16Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.i16:
			return new Int16Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.u32:
			return new Uint32Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.i32:
			return new Int32Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.f32:
			return new Float32Array(buffer, byteOff, rowCapacity);
		case TYPE_TAG.f64:
			return new Float64Array(buffer, byteOff, rowCapacity);
	}
}

/** Build the layout-descriptor-region descriptors (with `byte_off` and
 * `stride` filled in) and return both them and the byte offset immediately past
 * the last column, i.e. the total SAB size.
 *
 * `headroomBytes` reserves slack at the end of the descriptor region. On
 * top of the natural size for `specs`, so future extends can append new
 * descriptor entries without shifting existing column byte_offs. Used by
 * the growable-SAB path, column views stay valid across
 * `extendColumnStore` because their byte_offs don't move.
 *
 * Additive, not a floor: `regionSize = natural + headroom`, not
 * `max(natural, headroom)`. A floor only yields slack while `natural` is
 * below it. The moment the descriptor region outgrows the floor (the
 * headroom exhausts and a realloc re-plans the merged spec set), a floor
 * would size the region to exactly `natural`, zero slack, and every
 * subsequent extend would take the slow realloc path forever after. The
 * additive form re-creates the same `headroom` margin on every realloc.
 * For the engine's empty-seed store (`createColumnStore([], …)`, where
 * `natural === 0`) the two forms coincide, so this is behaviour-identical
 * for the only production caller. */
function planLayout(
	specs: readonly ArchetypeSpec[],
	regionOff: number,
	headroomBytes: number = 0
): { descriptors: ArchetypeDescriptor[]; totalBytes: number; regionBytes: number } {
	// The descriptor region itself sits at `regionOff`. Columns start after
	// the descriptor region. We do not know the descriptor region size until
	// we know `column_count` per archetype, but that is only `columns.length`
	// in the spec, so we can size the region up front.
	const naturalRegionSize = layoutDescriptorRegionBytes(
		specs.map((s) => ({
			archetypeId: s.archetypeId,
			componentMask: s.componentMask,
			rowCount: 0,
			enabledCount: 0,
			rowCapacity: s.rowCapacity,
			columns: s.columns.map((c) => ({
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: 0,
				stride: TYPE_TAG_STRIDE[c.typeTag]
			}))
		}))
	);
	const regionSize = naturalRegionSize + headroomBytes;
	let cursor = regionOff + regionSize;

	const descriptors: ArchetypeDescriptor[] = new Array(specs.length);
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i];
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
		descriptors[i] = {
			archetypeId: spec.archetypeId,
			componentMask: spec.componentMask,
			rowCount: 0,
			enabledCount: 0,
			rowCapacity: spec.rowCapacity,
			columns
		};
	}
	// The last column's `cursor += stride * row_capacity` isn't followed by
	// another `alignUp`, so the final total can land at and above 2³¹ even when
	// every per-column guard passed. This total becomes the backing's
	// byteLength, so guard it too.
	if (cursor > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(cursor);
	}
	return { descriptors, totalBytes: cursor, regionBytes: regionSize };
}

/** Exported for the layout tests' overflow-guard coverage. The in-place
 * resize paths use `layoutColumnsAtTail` (layout_ops.ts), not this. */
export { planLayout };

// `SabUnavailableError` now lives in `./allocator` (the SAB-producing seam that
// actually needs `SharedArrayBuffer`), re-exported via the barrel for callers.

/** Optional configuration for `createColumnStore`. */
export interface CreateColumnStoreOptions {
	/** Extra slack to reserve at the end of the layout descriptor region,
	 * on top of the natural size for `specs` (additive, not a floor).
	 * The descriptor region is padded with this many unused bytes so future
	 * `extendColumnStore` calls can append new archetype descriptors into the
	 * slack without shifting existing column byte_offs. Pairs with
	 * `growableSabAllocator` to give the in-place fast path: existing
	 * TypedArray column views stay valid across extends because their offsets
	 * and the underlying buffer both stay put.
	 *
	 * Carried forward as a policy across the realloc-and-republish path: the
	 * value lives on `ColumnStoreInternal._reservedDescriptorBytes` and
	 * `optionsFromOld` re-applies it, so a store that exhausts its headroom
	 * and reallocs gets a fresh margin rather than dropping to zero slack and
	 * going permanently slow. */
	readonly reservedDescriptorBytes?: number;
	/** When provided, allocates a command ring inside
	 * the SAB at a stable offset right after the `STORE_HEADER_BYTES` header.
	 * Slot count must be a power of two. `COMMAND_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring. `command_ring_off`
	 * stays at 0 ("absent"). An existing test fixture with a hand-rolled SAB
	 * sees the legacy layout, with the descriptor region right after the header.
	 *
	 * Sizing the ring this way, between header and descriptor region,
	 * keeps `command_ring_off` stable across an `extendColumnStore` or
	 * `growColumnStore` call, since those grow the descriptor region and
	 * the column tail but never the bytes between header and descriptor. */
	readonly commandRingCapacitySlots?: number;
	/** When provided, allocates the entity-index region inside the SAB at a
	 * stable offset between the command ring
	 * (or header) and the descriptor region. Holds `(generations,
	 * archetypes, rows)` triples indexed by entity slot. The engine's
	 * `Store` populates them as entities are created, moved and destroyed,
	 * and a compute backend reads them to resolve cross-entity targets without
	 * a callback. Capacity is in *slots* (entities), not bytes. Each
	 * slot is 12 bytes. Omitted ⇒ no region. `entity_index_off` stays
	 * at 0 ("absent"). The engine's Store always sets it to
	 * `ENTITY_INDEX_DEFAULT_CAPACITY`. Bare-SAB tests can leave it
	 * absent. */
	readonly entityIndexCapacity?: number;
	/** When provided, allocates the event ring
	 * inside the SAB at a stable offset between the entity-index region
	 * and the descriptor region. It has the same SPSC shape as the command
	 * ring. It carries ECS signal payloads, so a module's systems emit and
	 * consume them during a tick without callbacks into TS.
	 *
	 * Slot count must be a power of two. `EVENT_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring. `event_ring_off`
	 * stays at 0 ("absent"). An existing test fixture with a hand-rolled
	 * SAB sees the layout without it. */
	readonly eventRingCapacitySlots?: number;
	/** When provided, allocates the action ring
	 * inside the SAB at a stable offset between the entity-index and event-ring
	 * and the region-table directory. The main thread writes encoded actions to
	 * it, and the worker drains them on each apply.
	 *
	 * Slot count must be a power of two. `ACTION_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring. `action_ring_off`
	 * stays at 0 ("absent"). A bare-SAB test skips it. (Engine mechanism, the
	 * `Store` allocates one always-on. It is no longer a public ECS option.) */
	readonly actionRingCapacitySlots?: number;
	/** Consumer-declared SAB regions. Each `StoreRegionSpec` carries an
	 * opaque `region_id`, a precomputed byte size, and an `init` closure. The
	 * engine lays them out after the mechanism regions, writes a generic
	 * region-table directory (`region_table.ts`) keyed by `region_id`, and
	 * snapshots and restores them across a grow or extend. The engine never
	 * interprets `region_id`. The consumer that declared the region owns it.
	 * Omitted ⇒ no consumer regions. `region_table_off` stays 0. */
	readonly regions?: readonly StoreRegionSpec[];
	/** Byte size of the always-before-descriptor sim-bindings region. A consumer
	 * that opts into a WASM backend supplies its own size here, computed from
	 * its own binding manifest. The engine treats the region as opaque bytes:
	 * it reserves the block at `bindings_off` (right before the descriptor
	 * region, so the offset is stable across grow and extend) and the host
	 * writes the `(component_id, field_id)` ids into it.
	 *
	 * Omitted or 0 ⇒ no bindings region (`bindings_off` stays 0, "absent"), the
	 * default for a pure-TS world that pays nothing for the WASM seam. This size
	 * used to be an engine-baked ABI constant reflected from the consumer's
	 * binding struct. It is now a runtime input, so a manifest edit no longer
	 * dirties the engine ABI golden. Re-derived across realloc by `optionsFromOld`
	 * (= `layout_descriptor_off - bindings_off`), so it survives grow and extend
	 * without a carried policy field. */
	readonly bindingsRegionBytes?: number;
	/** Byte offset inside the backing where the header goes. Default 0.
	 *
	 * Every offset the store writes is relative to this base, and the store
	 * writes only inside `[storeBase, storeBase + capacity)`. A WASM module owns
	 * the low addresses of its own linear memory, so a store mounted on that
	 * memory must stand above the module's data segment, its shadow stack and
	 * its heap base. A safe Zig or Rust build also traps on a read of address 0,
	 * so a module-hosted store cannot put the header there at all.
	 *
	 * Must be a non-negative integer and a multiple of
	 * `STORE_BASE_ALIGNMENT`, so every column keeps the alignment its type tag
	 * needs. */
	readonly storeBase?: number;
}

/** Every store base must be a multiple of this. The widest column element is 8
 * bytes, and the entity index wants 16, so 16 keeps both aligned whatever the
 * base is. */
export const STORE_BASE_ALIGNMENT = 16;

/** Reject a base the layout math cannot honour. Cold path, one call per store
 * creation. `resolveECSMemory` rejects the same values earlier with an
 * `ECS_ERROR` code, so a world never reaches this. A direct store caller does. */
export function assertStoreBase(storeBase: number): void {
	if (!Number.isInteger(storeBase) || storeBase < 0) {
		throw new RangeError(
			`createColumnStore: storeBase must be an integer >= 0, got ${storeBase}`
		);
	}
	if (storeBase % STORE_BASE_ALIGNMENT !== 0) {
		throw new RangeError(
			`createColumnStore: storeBase must be a multiple of ${STORE_BASE_ALIGNMENT}, got ${storeBase}`
		);
	}
}

/** Internal `ColumnStore` extension carrying the descriptor-region byte
 * size. Used by the in-place extend path to know where the next
 * descriptor entry should be written (= `regionOff + region_bytes_used`,
 * tracked separately) and how much headroom remains. */
export interface ColumnStoreInternal extends ColumnStore {
	readonly _regionBytes: number;
	readonly _allocator: BufferAllocator;
	/** The `reservedDescriptorBytes` policy this store was created with
	 * (the additive descriptor-region headroom margin, 0 when none). Carried
	 * with the store. Not re-derivable from the SAB bytes, since `_regionBytes`
	 * holds the absolute region size (natural + this), and once `natural`
	 * outgrows the margin the two are indistinguishable. The realloc slow path
	 * reads it via `optionsFromOld` and re-reserves the same margin, so a
	 * store that exhausts its headroom and reallocs keeps taking the
	 * in-place fast path instead of going permanently slow. The
	 * `*_in_place` paths carry it forward verbatim. */
	readonly _reservedDescriptorBytes: number;
	/** The descriptor-region bytes in use: the sum of `archetypeDescriptorBytes`
	 * over every archetype. The in-place extend reads it to find where the next
	 * descriptor goes and how much headroom remains. Cached here so an extend
	 * does not sum over every archetype each time, which made the cost of the
	 * N-th archetype grow with N. Absent on a record that predates the cache
	 * (a store from `growColumnStore`), and then summed one time on demand. */
	readonly _usedDescriptorBytes?: number;
}

/** The descriptor-region bytes that `archetypes` use. */
export function usedDescriptorBytes(archetypes: ReadonlyMap<number, ArchetypeViews>): number {
	let used = 0;
	for (const [, arch] of archetypes) used += archetypeDescriptorBytes(arch.columnsInOrder.length);
	return used;
}

/** Typed recovery of `ColumnStoreInternal` from a public `ColumnStore`.
 * Not every store is internal: `restoreColumnStore` deliberately returns a
 * plain `{ buffer, view, header, archetypes }` (a snapshot carries no JS-side
 * allocator or headroom policy), and grow and extend must send such a store down
 * the realloc slow path. This guard is the one place that discrimination
 * happens, grow and extend previously re-derived the internal type via
 * structural `as`-casts at six sites. */
export function isColumnStoreInternal(store: ColumnStore): store is ColumnStoreInternal {
	const s = store as Partial<ColumnStoreInternal>;
	return (
		typeof s._regionBytes === "number" &&
		typeof s._allocator === "function" &&
		typeof s._reservedDescriptorBytes === "number"
	);
}

/** Allocate a backing sized for `specs` plus `options.storeBase`, write the
 * header and the layout descriptor at the base, and construct one TypedArray
 * view per column.
 *
 * The returned `ColumnStore` is the source of truth for "where every column
 * lives". Offsets in the bytes are relative to the base. `view_stamp` is
 * initialised to 0, and a grow bumps it. */
export function createColumnStore(
	specs: readonly ArchetypeSpec[],
	allocator: BufferAllocator = DEFAULT_SAB_ALLOCATOR,
	options: CreateColumnStoreOptions = {}
): ColumnStore {
	// SAB-availability is enforced by the allocator (the only thing that builds a
	// SharedArrayBuffer): `DEFAULT_SAB_ALLOCATOR` and `growableSabAllocator` throw
	// `SabUnavailableError` in a SAB-less runtime, while `heapArrayBufferAllocator`
	// returns a plain ArrayBuffer. So this function is backing-agnostic. It builds
	// views over whatever `allocator(totalBytes)` hands back.
	//
	// Region order inside the store span, all offsets relative to the base:
	// header, the engine mechanism prefix regions
	// (STORE_PREFIX_REGIONS, command, entity-index, event and action), the generic
	// region-table directory + consumer regions, then the always-present
	// sim-bindings block, then the layout descriptor + column data. Everything
	// before the descriptor region keeps a stable offset across descriptor growth
	// and column growth. STORE_PREFIX_REGIONS (mechanism) + the consumer region table
	// are both walked again by the realloc snapshot and restore in extend.ts.
	const storeBase = options.storeBase ?? 0;
	assertStoreBase(storeBase);
	const regionOffsets = {} as Record<StoreRegionOffsetField, number>;
	let cursor = STORE_HEADER_BYTES;
	for (let i = 0; i < STORE_PREFIX_REGIONS.length; i++) {
		const region = STORE_PREFIX_REGIONS[i];
		const bytes = region.sizeFromOptions(options);
		// Absent regions report offset 0 ("not present") but consume no bytes,
		// so the cursor still matches the historical `STORE_HEADER_BYTES + Σ(prior
		// region bytes)` arithmetic exactly.
		regionOffsets[region.headerOff] = bytes === 0 ? 0 : cursor;
		cursor += bytes;
	}

	// Consumer-declared regions: laid out after the mechanism regions
	// and addressed via a generic region-table directory rather than named
	// header fields. The directory precedes the regions (so its own offset is
	// stable too). Each entry records the region's `byte_length`, letting the
	// realloc snapshot and restore path copy a region across a grow without
	// re-deriving consumer knobs.
	const consumerRegions = options.regions ?? [];
	assertRegionSpecs(consumerRegions);
	const regionTableCount = consumerRegions.length;
	const regionTableOff = regionTableCount > 0 ? cursor : 0;
	cursor += regionTableBytes(regionTableCount);
	const regionEntries: RegionTableEntry[] = new Array(regionTableCount);
	for (let i = 0; i < consumerRegions.length; i++) {
		const spec = consumerRegions[i];
		regionEntries[i] = { regionId: spec.id, byteOffset: cursor, byteLength: spec.bytes };
		cursor += spec.bytes;
	}

	// Sim-bindings region, the "SAB is the interface" arm. Opt-in: a consumer
	// that attaches a WASM backend supplies its size through `bindingsRegionBytes`,
	// computed from its own binding manifest. A pure-TS world omits it
	// and gets no region (`bindings_off` = 0, "absent"). Sits right before the
	// descriptor region so its offset is stable across `extendColumnStore` and
	// `growColumnStore` (those grow the descriptor region and the column tail,
	// never the bytes before it). The host writes the `(component_id, field_id)`
	// ids into it once per layout, and the module's per-system exports read from
	// here. Engine-opaque, and the size is a runtime input, not an ABI constant
	// reflected from the consumer's binding struct.
	const bindingsBytes = options.bindingsRegionBytes ?? 0;
	const bindingsOff = bindingsBytes === 0 ? 0 : cursor;
	cursor += bindingsBytes;

	const layoutDescriptorOff = cursor;
	const { descriptors, totalBytes, regionBytes } = planLayout(
		specs,
		layoutDescriptorOff,
		options.reservedDescriptorBytes ?? 0
	);

	// The allocator reserves the base as well as the span. Everything below the
	// base belongs to whoever else shares the backing.
	const buffer = allocator(storeBase + totalBytes);
	const view = new DataView(buffer, storeBase);

	const header: StoreHeader = {
		magic: STORE_MAGIC,
		simAbiVersion: SIM_ABI_VERSION,
		viewStamp: 0,
		capacity: totalBytes,
		archetypeCount: specs.length,
		layoutDescriptorOff,
		bindingsOff,
		regionTableOff,
		regionTableCount,
		// `regionOffsets` stays keyed by the snake ABI field names (it also indexes
		// `STORE_HEADER_OFFSETS`). Map its 4 entries onto the camelCase header fields.
		commandRingOff: regionOffsets.command_ring_off,
		entityIndexOff: regionOffsets.entity_index_off,
		eventRingOff: regionOffsets.event_ring_off,
		actionRingOff: regionOffsets.action_ring_off
	};
	writeStoreHeader(view, header);
	// Zero-fill the sim-bindings region defensively (when present). A fresh
	// allocator buffer is already zeroed, but `growableSabAllocator` may hand
	// back a reused arena slice, so zero it and a stale layout's ids cannot
	// bleed through before the host's first write.
	if (bindingsBytes > 0) new Uint8Array(buffer, storeBase + bindingsOff, bindingsBytes).fill(0);
	// Initialise each present region's header. `off !== 0` ⇒ that region's
	// `sizeFromOptions` returned > 0, so `options` carries the knobs its
	// `init` reads.
	for (let i = 0; i < STORE_PREFIX_REGIONS.length; i++) {
		const region = STORE_PREFIX_REGIONS[i];
		const off = regionOffsets[region.headerOff];
		if (off !== 0) region.init(view, off, options);
	}
	// Write the consumer region-table directory, then init each consumer region
	// at its recorded offset. The directory is written first so the SAB is
	// internally consistent (and a region's `init` could read its own entry)
	// before any consumer bytes are touched.
	if (regionTableOff !== 0) writeRegionTable(view, regionTableOff, regionEntries);
	for (let i = 0; i < consumerRegions.length; i++) {
		consumerRegions[i].init(view, regionEntries[i].byteOffset);
	}
	writeLayoutDescriptorRegion(view, layoutDescriptorOff, descriptors);

	const archetypes = createArchetypeViews(buffer, storeBase, descriptors);

	const store: ColumnStoreInternal = {
		buffer,
		view,
		header,
		storeBase,
		archetypes,
		_regionBytes: regionBytes,
		_allocator: allocator,
		// Carry the headroom policy with the store so the realloc slow path
		// (`optionsFromOld`) can re-reserve the same margin.
		_reservedDescriptorBytes: options.reservedDescriptorBytes ?? 0,
		_usedDescriptorBytes: usedDescriptorBytes(archetypes)
	};
	return store;
}

/** Default command-ring slot count used by `Store` when constructing
 * its SAB. Re-exported here so the Store doesn't reach across modules. */
export { COMMAND_RING_DEFAULT_CAPACITY_SLOTS };

/** Default entity-index capacity used by `Store` when constructing
 * its SAB. Re-exported alongside `COMMAND_RING_DEFAULT_CAPACITY_SLOTS`. */
export { ENTITY_INDEX_DEFAULT_CAPACITY };

/** Default event-ring slot count used by `Store` when constructing
 * its SAB. Re-exported alongside the other defaults. */
export { EVENT_RING_DEFAULT_CAPACITY_SLOTS };

/** Build the `ArchetypeViews` map from a backing and its parsed descriptors.
 * Shared by `createColumnStore` (fresh allocation, byte_offs only computed)
 * and `restoreColumnStore` (existing allocation, byte_offs read out of the
 * snapshot). Either way each view lands at `storeBase` plus the descriptor's
 * `byte_off`. This helper does not plan layout. */
export function createArchetypeViews(
	buffer: ArrayBufferLike,
	storeBase: number,
	descriptors: readonly ArchetypeDescriptor[]
): Map<number, ArchetypeViews> {
	const archetypes = new Map<number, ArchetypeViews>();
	for (let i = 0; i < descriptors.length; i++) {
		const d = descriptors[i];
		const columnsInOrder: ColumnView[] = new Array(d.columns.length);
		const columns = new Map<number, ColumnView>();
		for (let j = 0; j < d.columns.length; j++) {
			const c = d.columns[j];
			const colView: ColumnView = {
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: c.byteOff,
				stride: c.stride,
				view: createView(buffer, storeBase, c.typeTag, c.byteOff, d.rowCapacity)
			};
			columnsInOrder[j] = colView;
			columns.set(columnKey(c.componentId, c.fieldId), colView);
		}
		archetypes.set(d.archetypeId, {
			archetypeId: d.archetypeId,
			componentMask: d.componentMask,
			rowCapacity: d.rowCapacity,
			columns,
			columnsInOrder
		});
	}
	return archetypes;
}
