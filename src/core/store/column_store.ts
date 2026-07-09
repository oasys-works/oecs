/**
 * ColumnStore — the sizing + layout primitive that turns a set of archetype
 * requirements into a `SharedArrayBuffer` carrying:
 *   1. A locked 32-byte header (see `header.ts`).
 *   2. A layout descriptor region (see `descriptor.ts`).
 *   3. Aligned column regions, each addressable via a TypedArray view.
 *
 * Plan §6.1.3 calls for `Store.allocate` to return TypedArray views into
 * a single SAB at the right offset. This file builds that mapping — given
 * `{ archetype_id, row_capacity, columns: [{ component_id, field_id,
 * type_tag }] }` for every archetype, it computes byte offsets, writes the
 * header + descriptor, and hands back the views in one shot.
 *
 * NOT YET wired into `Archetype` / `Store` — that lands in a follow-up
 * once `view_stamp` invalidation (#171 §6.1.4) is in place. The intent
 * here is to lock the offset math against a binary fixture so the
 * Archetype migration can lean on a tested primitive instead of inventing
 * its own arithmetic.
 *
 * Alignment: each column starts at its `type_tag` stride boundary. This is
 * the minimum needed for TypedArray construction (`new Float32Array(buffer,
 * off, n)` throws on a misaligned `off`) and matches what a Zig `*f32`
 * etc. expects.
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
	validateRegionSpecs,
	writeRegionTable,
	type RegionTableEntry,
	type StoreRegionSpec
} from "./region_table";

/** Caller-facing column spec — no `byte_off` yet, the store computes it. */
export interface ColumnSpec {
	readonly componentId: number;
	readonly fieldId: number;
	readonly typeTag: TypeTagValue;
}

/** Caller-facing archetype spec — no `column_count` (derived) and no
 * `byte_off`s in the columns; both are computed during sizing. */
export interface ArchetypeSpec {
	readonly archetypeId: number;
	/** Component bitmask, `COMPONENT_MASK_WORDS` little-endian u32 words. */
	readonly componentMask: readonly number[];
	readonly rowCapacity: number;
	readonly columns: readonly ColumnSpec[];
}

/** A single column's view after allocation. The `byte_off` matches what
 * was recorded in the layout descriptor; `view` is a TypedArray of the
 * right element type, length `row_capacity`, backed by the SAB. */
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
 * Number-keyed `Map` — meaningfully faster than the previous string
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
	 * a `SharedArrayBuffer` for the SAB/WASM/worker profile, or a plain fixed
	 * `ArrayBuffer` for the pure-TS heap profile (`heapArraybufferAllocator`).
	 * Consumers that genuinely require sharing (worker transfer, WASM memory)
	 * narrow back to `SharedArrayBuffer` at their boundary. */
	readonly buffer: ArrayBufferLike;
	readonly view: DataView;
	readonly header: StoreHeader;
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
 * `new Uint8Array(buffer, byte_off, …)` — either a thrown `RangeError` deep in
 * the TypedArray ctor or, worse, a silently wrong view overlapping another
 * column. The 256 MiB default allocator cap (`growableSabAllocator`) keeps
 * real matches three orders of magnitude below this, but the cap is tunable
 * and callers are invited to raise it for bigger worlds — so the layout step
 * guards the hard 2³¹ ceiling explicitly rather than relying on the policy
 * cap to stay in front of it (#382). */
export const STORE_MAX_BYTE_OFFSET = 2 ** 31;

/** Thrown when a SAB column layout would place an offset at or beyond
 * {@link STORE_MAX_BYTE_OFFSET} (2³¹), past which the signed-32-bit bitwise
 * `alignUp` can no longer produce correct offsets. This is a hard ceiling,
 * not the (tunable, much lower) 256 MiB allocator cap — see #382. */
export class StoreLayoutOverflowError extends Error {
	constructor(byteOff: number) {
		super(
			`SAB column layout offset ${byteOff} reaches or exceeds the 2³¹ ` +
				`(${STORE_MAX_BYTE_OFFSET}-byte) ceiling. Past 2 GiB the signed-32-bit ` +
				`bitwise alignment math wraps to negative/misaligned offsets. This is a ` +
				`structural limit independent of the (default 256 MiB) allocator cap — a ` +
				`single SAB cannot back more than ~2 GiB of column data (#382).`
		);
		this.name = "StoreLayoutOverflowError";
	}
}

/** Round `off` up to the next multiple of `align`. `align` must be a power
 * of two (1/2/4/8 here, all `TYPE_TAG_STRIDE` values).
 *
 * Throws {@link StoreLayoutOverflowError} when the rounded offset would reach
 * {@link STORE_MAX_BYTE_OFFSET}, because the `& ~(align-1)` step coerces to a
 * signed 32-bit int and wraps past 2³¹ (#382). The guard fires before the
 * bitwise op so any returned offset is always a correct, in-range value.
 * Shared by `extend.ts` and `grow.ts`, whose in-place paths compute tail
 * byte_offs without going through `planLayout`. */
export function alignUp(off: number, align: number): number {
	if (off + align > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(off);
	}
	return (off + (align - 1)) & ~(align - 1);
}

function makeView(
	buffer: ArrayBufferLike,
	typeTag: TypeTagValue,
	byteOff: number,
	rowCapacity: number
): AnyTypedArray {
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
 * `stride` filled in) and return both them and the byte offset just past
 * the last column — i.e. the total SAB size.
 *
 * `headroomBytes` reserves slack at the end of the descriptor region — ON
 * TOP OF the natural size for `specs` — so future extends can append new
 * descriptor entries without shifting existing column byte_offs. Used by
 * the growable-SAB path (#237 Option A) — column views stay valid across
 * `extendColumnStore` because their byte_offs don't move.
 *
 * Additive, not a floor (#541): `regionSize = natural + headroom`, NOT
 * `max(natural, headroom)`. A floor only yields slack while `natural` is
 * below it; the moment the descriptor region outgrows the floor (the #237
 * headroom exhausts and a realloc re-plans the merged spec set), a floor
 * would size the region to exactly `natural` — zero slack — and every
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
	// we know `column_count` per archetype — but that's just `columns.length`
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
	// another `alignUp`, so the final total can land at/above 2³¹ even when
	// every per-column guard passed. This total becomes the SAB byteLength;
	// guard it too (#382).
	if (cursor > STORE_MAX_BYTE_OFFSET) {
		throw new StoreLayoutOverflowError(cursor);
	}
	return { descriptors, totalBytes: cursor, regionBytes: regionSize };
}

/** Exported for the layout tests' overflow-guard coverage; the in-place
 * resize paths use `layoutColumnsAtTail` (layout_ops.ts), not this. */
export { planLayout };

// `SabUnavailableError` now lives in `./allocator` (the SAB-producing seam that
// actually needs `SharedArrayBuffer`), re-exported via the barrel for callers.

/** Optional configuration for `createColumnStore`. */
export interface CreateColumnStoreOptions {
	/** Extra slack to reserve at the end of the layout descriptor region,
	 * ON TOP OF the natural size for `specs` (#541 — additive, not a floor).
	 * The descriptor region is padded with this many unused bytes so future
	 * `extendColumnStore` calls can append new archetype descriptors into the
	 * slack without shifting existing column byte_offs. Pairs with
	 * `growableSabAllocator` to give the #237 Option A fast path: existing
	 * TypedArray column views stay valid across extends because their offsets
	 * and the underlying buffer both stay put.
	 *
	 * Carried forward as a policy across the realloc-and-republish path: the
	 * value lives on `ColumnStoreInternal._reservedDescriptorBytes` and
	 * `optionsFromOld` re-applies it, so a store that exhausts its headroom
	 * and reallocs gets a fresh margin rather than dropping to zero slack and
	 * going permanently slow (#541). */
	readonly reservedDescriptorBytes?: number;
	/** When provided, allocates a command ring (#171 §7.5, Phase 4) inside
	 * the SAB at a stable offset right after the 48-byte header. Slot
	 * count MUST be a power of two; `COMMAND_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring; `command_ring_off`
	 * stays at 0 ("absent"); existing test fixtures with hand-rolled SABs
	 * see the legacy layout (descriptor region immediately after header).
	 *
	 * Sizing the ring this way — between header and descriptor region —
	 * keeps `command_ring_off` stable across `extendColumnStore` /
	 * `growColumnStore` calls, since those grow the descriptor region and
	 * the column tail but never the bytes between header and descriptor. */
	readonly commandRingCapacitySlots?: number;
	/** When provided, allocates the entity-index region (#245 / Phase 4
	 * PR 4B) inside the SAB at a stable offset between the command ring
	 * (or header) and the descriptor region. Holds `(generations,
	 * archetypes, rows)` triples indexed by entity slot; the engine's
	 * `Store` populates them as entities are created/moved/destroyed,
	 * and Zig systems read them to resolve cross-entity targets without
	 * a callback. Capacity is in *slots* (entities), not bytes; each
	 * slot is 12 bytes. Omitted ⇒ no region; `entity_index_off` stays
	 * at 0 ("absent"). The engine's Store always sets it to
	 * `ENTITY_INDEX_DEFAULT_CAPACITY`; bare-SAB tests can leave it
	 * absent. */
	readonly entityIndexCapacity?: number;
	/** When provided, allocates the event ring (#247 / Phase 4 PR 4C)
	 * inside the SAB at a stable offset between the entity-index region
	 * and the descriptor region. Same SPSC shape as the command ring;
	 * carries ECS signal payloads so Zig systems can emit and consume
	 * them during `tick()` without callbacks into TS.
	 *
	 * Slot count MUST be a power of two; `EVENT_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring; `event_ring_off`
	 * stays at 0 ("absent"); existing test fixtures with hand-rolled
	 * SABs see the pre-#247 layout. */
	readonly eventRingCapacitySlots?: number;
	/** When provided, allocates the action ring (#291 / Phase 5 PR 5L)
	 * inside the SAB at a stable offset between the entity-index/event-ring
	 * and the region-table directory. Main writes encoded actions to it;
	 * the sim worker drains them on each apply.
	 *
	 * Slot count MUST be a power of two; `ACTION_RING_DEFAULT_CAPACITY_SLOTS`
	 * (256) is the canonical value. Omitted ⇒ no ring; `action_ring_off`
	 * stays at 0 ("absent"); bare-SAB tests skip it. (Engine mechanism — the
	 * `Store` allocates one always-on; it is no longer a public ECS option.) */
	readonly actionRingCapacitySlots?: number;
	/** Consumer-declared SAB regions (#623). Each `StoreRegionSpec` carries an
	 * opaque `region_id`, a precomputed byte size, and an `init` closure; the
	 * engine lays them out after the mechanism regions, writes a generic
	 * region-table directory (`region_table.ts`) keyed by `region_id`, and
	 * snapshots/restores them across a grow/extend. The engine never
	 * interprets `region_id` — a game (e.g. `@internal/sim`'s region specs)
	 * owns it. Omitted ⇒ no consumer regions; `region_table_off` stays 0. */
	readonly regions?: readonly StoreRegionSpec[];
	/** Byte size of the always-before-descriptor sim-bindings region (v5 /
	 * "SAB-is-the-interface"). A consumer that opts into a WASM backend supplies
	 * its own size here — `@internal/sim`'s `SIM_BINDINGS_BYTES`, computed from
	 * the game's binding manifest. The engine treats the region as opaque bytes:
	 * it reserves the block at `bindings_off` (right before the descriptor
	 * region, so the offset is stable across grow/extend) and the host writes the
	 * `(component_id, field_id)` IDs into it via `write_sim_bindings`.
	 *
	 * Omitted / 0 ⇒ NO bindings region (`bindings_off` stays 0, "absent") — the
	 * default for a pure-TS game that pays nothing for the WASM seam. This used
	 * to be the engine-baked `SIM_BINDINGS_BYTES` ABI constant reflected from the
	 * game's Zig struct; #625 de-welded it so a manifest edit no longer dirties
	 * the engine ABI golden. Re-derived across realloc by `optionsFromOld`
	 * (= `layout_descriptor_off - bindings_off`), so it survives grow/extend
	 * without a carried policy field. */
	readonly bindingsRegionBytes?: number;
}

/** Internal `ColumnStore` extension carrying the descriptor-region byte
 * size. Used by the in-place extend path to know where the next
 * descriptor entry should be written (= `regionOff + region_bytes_used`,
 * tracked separately) and how much headroom remains. */
export interface ColumnStoreInternal extends ColumnStore {
	readonly _regionBytes: number;
	readonly _allocator: BufferAllocator;
	/** The `reservedDescriptorBytes` policy this store was created with
	 * (the additive descriptor-region headroom margin; 0 when none). Carried
	 * with the store — NOT re-derivable from the SAB bytes, since `_regionBytes`
	 * holds the absolute region size (natural + this), and once `natural`
	 * outgrows the margin the two are indistinguishable. The realloc slow path
	 * reads it via `optionsFromOld` and re-reserves the same margin, so a
	 * store that exhausts its headroom and reallocs keeps taking the #237
	 * in-place fast path instead of going permanently slow (#541). The
	 * `*_in_place` paths carry it forward verbatim. */
	readonly _reservedDescriptorBytes: number;
}

/** Typed recovery of `ColumnStoreInternal` from a public `ColumnStore` (M8).
 * Not every store is internal: `restoreColumnStore` deliberately returns a
 * plain `{ buffer, view, header, archetypes }` (a snapshot carries no JS-side
 * allocator or headroom policy), and grow/extend must send such a store down
 * the realloc slow path. This guard is the ONE place that discrimination
 * happens — grow/extend previously re-derived the internal type via
 * structural `as`-casts at six sites. */
export function isColumnStoreInternal(store: ColumnStore): store is ColumnStoreInternal {
	const s = store as Partial<ColumnStoreInternal>;
	return (
		typeof s._regionBytes === "number" &&
		typeof s._allocator === "function" &&
		typeof s._reservedDescriptorBytes === "number"
	);
}

/** Allocate a SAB sized for `specs`, write the header + layout descriptor,
 * and construct one TypedArray view per column.
 *
 * The returned `ColumnStore` is the source of truth for "where every column
 * lives in this SAB". `view_stamp` is initialised to 0 — a Phase 4 SAB
 * grow flow will bump it. (#171 §6.1.4 / §8.1) */
export function createColumnStore(
	specs: readonly ArchetypeSpec[],
	allocator: BufferAllocator = DEFAULT_SAB_ALLOCATOR,
	options: CreateColumnStoreOptions = {}
): ColumnStore {
	// SAB-availability is enforced by the allocator (the only thing that builds a
	// SharedArrayBuffer): `DEFAULT_SAB_ALLOCATOR` / `growableSabAllocator` throw
	// `SabUnavailableError` in a SAB-less runtime, while `heapArraybufferAllocator`
	// returns a plain ArrayBuffer. So this function is backing-agnostic — it builds
	// views over whatever `allocator(totalBytes)` hands back.
	//
	// Region order in the buffer: header, the engine MECHANISM prefix regions
	// (STORE_PREFIX_REGIONS — command/entity-index/event/action), the generic
	// region-table directory + CONSUMER regions (#623), then the always-present
	// sim-bindings block, then the layout descriptor + column data. Everything
	// before the descriptor region keeps a stable offset across descriptor /
	// column growth. STORE_PREFIX_REGIONS (mechanism) + the consumer region table
	// are both walked again by the realloc snapshot/restore in extend.ts.
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

	// Consumer-declared regions (#623): laid out after the mechanism regions
	// and addressed via a generic region-table directory rather than named
	// header fields. The directory precedes the regions (so its own offset is
	// stable too); each entry records the region's `byte_length`, letting the
	// realloc snapshot/restore path copy a region across a grow without
	// re-deriving consumer knobs.
	const consumerRegions = options.regions ?? [];
	validateRegionSpecs(consumerRegions);
	const regionTableCount = consumerRegions.length;
	const regionTableOff = regionTableCount > 0 ? cursor : 0;
	cursor += regionTableBytes(regionTableCount);
	const regionEntries: RegionTableEntry[] = new Array(regionTableCount);
	for (let i = 0; i < consumerRegions.length; i++) {
		const spec = consumerRegions[i];
		regionEntries[i] = { regionId: spec.id, byteOffset: cursor, byteLength: spec.bytes };
		cursor += spec.bytes;
	}

	// Sim-bindings region (v5 / "SAB-is-the-interface"). Opt-in: a consumer that
	// attaches a WASM backend supplies its size via `bindingsRegionBytes`
	// (`@internal/sim`'s game-owned `SIM_BINDINGS_BYTES`); a pure-TS game omits it
	// and gets no region (`bindings_off` = 0, "absent"). Sits right before the
	// descriptor region so its offset is stable across `extendColumnStore` /
	// `growColumnStore` (those grow the descriptor region + column tail, never the
	// bytes before it). The host writes the `(component_id, field_id)` IDs into it
	// once per layout via `write_sim_bindings`; the Zig per-system exports read
	// from here. Engine-opaque since #625 — the size is a runtime input, not an
	// ABI constant reflected from the game's binding struct.
	const bindingsBytes = options.bindingsRegionBytes ?? 0;
	const bindingsOff = bindingsBytes === 0 ? 0 : cursor;
	cursor += bindingsBytes;

	const layoutDescriptorOff = cursor;
	const { descriptors, totalBytes, regionBytes } = planLayout(
		specs,
		layoutDescriptorOff,
		options.reservedDescriptorBytes ?? 0
	);

	const buffer = allocator(totalBytes);
	const view = new DataView(buffer);

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
		// `STORE_HEADER_OFFSETS`); map its 4 entries onto the camelCase header fields.
		commandRingOff: regionOffsets.command_ring_off,
		entityIndexOff: regionOffsets.entity_index_off,
		eventRingOff: regionOffsets.event_ring_off,
		actionRingOff: regionOffsets.action_ring_off
	};
	writeStoreHeader(view, header);
	// Zero-fill the sim-bindings region defensively (when present). A fresh
	// allocator buffer is already zeroed, but `growableSabAllocator` may hand
	// back a reused arena slice — zero it so a stale layout's IDs can't bleed
	// through before the host's first `write_sim_bindings`.
	if (bindingsBytes > 0) new Uint8Array(buffer, bindingsOff, bindingsBytes).fill(0);
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

	const archetypes = buildArchetypeViews(buffer, descriptors);

	const store: ColumnStoreInternal = {
		buffer,
		view,
		header,
		archetypes,
		_regionBytes: regionBytes,
		_allocator: allocator,
		// Carry the headroom policy with the store so the realloc slow path
		// (`optionsFromOld`) can re-reserve the same margin (#541).
		_reservedDescriptorBytes: options.reservedDescriptorBytes ?? 0
	};
	return store;
}

/** Default command-ring slot count used by `ECS.Store` when constructing
 * its SAB. Re-exported here so the Store doesn't reach across modules. */
export { COMMAND_RING_DEFAULT_CAPACITY_SLOTS };

/** Default entity-index capacity used by `ECS.Store` when constructing
 * its SAB. Re-exported alongside `COMMAND_RING_DEFAULT_CAPACITY_SLOTS`. */
export { ENTITY_INDEX_DEFAULT_CAPACITY };

/** Default event-ring slot count used by `ECS.Store` when constructing
 * its SAB. Re-exported alongside the other defaults. */
export { EVENT_RING_DEFAULT_CAPACITY_SLOTS };

/** Build the `ArchetypeViews` map from a SAB and its parsed descriptors.
 * Shared by `createColumnStore` (fresh allocation, byte_offs just computed)
 * and `restoreColumnStore` (existing allocation, byte_offs read out of the
 * snapshot). Either way the views land at the byte_offs the descriptors
 * already carry — this helper does not plan layout. */
export function buildArchetypeViews(
	buffer: ArrayBufferLike,
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
				view: makeView(buffer, c.typeTag, c.byteOff, d.rowCapacity)
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
