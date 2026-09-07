/**
 * SAB header, the first 52 bytes of the simulation SharedArrayBuffer.
 *
 * This file locks the binary layout a WASM module and the TS host both read
 * from. Any change to field order, width, or count is a `SIM_ABI_VERSION`
 * bump and is incompatible with prior `.wasm` builds.
 *
 * Field order is identical to the extern struct a module declares, so the
 * module's header pointer and a JS `DataView` see the same bytes.
 *
 * Endianness: little-endian. WASM is little-endian. Bun and every browser
 * we target run on little-endian hosts (x86_64 and arm64). All DataView reads
 * and writes pass `littleEndian = true` explicitly so the fixture bytes are
 * the same regardless of host byte order, even if a future host disagrees.
 *
 * History:
 *   - v1: 32-byte header with magic, sim_abi_version, view_stamp,
 *     capacity, archetype_count, layout_descriptor_off, command_ring_off,
 *     action_ring_off.
 *   - v2: 48-byte header. Adds `entity_index_off`
 *     pointing at the SAB-resident entity-index region (entityId →
 *     archetype_id, row, generation). 12 trailing bytes reserved for
 *     future fields to avoid another version bump.
 *   - v2: adds `event_ring_off` at byte 36 by
 *     promoting the first of v2's three reserved u32s. No version bump,
 *     earlier readers saw the byte range as zero (`_reserved0`), so
 *     the change is backward-compatible.
 *   - v2: adds `terrain_off` at byte 40 by
 *     promoting the next reserved u32. Same backward-compat story as
 *     `event_ring_off`, earlier readers saw zero there, new readers see
 *     the offset of the terrain region or 0 when absent. No version bump.
 *   - v2: adds `spatial_grid_off` at byte 44
 *     by promoting the final reserved u32. Header is now fully packed
 *     (zero reserved bytes). The next schema change widens
 *     `STORE_HEADER_BYTES` or bumps `SIM_ABI_VERSION`.
 *   - v3: widens to 56 bytes and adds two consumer-named offsets, an army
 *     composition table (byte 48) and a spawn anchor list (byte 52). Both
 *     point at SAB-resident regions a consumer's WASM systems read, and the
 *     host writes. ABI bump because the header widened past its previous
 *     packed size. Earlier wasm builds cannot be mixed with a v3 SAB.
 *   - v4: widens to 60 bytes and adds a third consumer-named offset (byte
 *     56), a flow-field region the host writes and a WASM system reads.
 *     ABI bump because the header widened by 4 bytes past v3's packed
 *     size. Pre-v4 wasm builds cannot be mixed with v4 SABs.
 *   - v5 ("SAB-is-the-interface"): widens to 64 bytes and adds
 *     `bindings_off` (byte 60). Points at the SAB-resident sim-bindings
 *     region, a fixed block of `u16` component and field ids the host writes
 *     once per layout. A WASM per-system export reads its
 *     `(component_id, field_id)` pairs from this block instead of taking
 *     them as positional call args, so a frame can run several systems in
 *     one JS to WASM crossing. The region was always present at this
 *     version, with a fixed size and no option knob. The host owned the
 *     writes, and the module was read-only. ABI bump because the header
 *     widened by 4 bytes past v4's packed size. Pre-v5 wasm builds cannot
 *     be mixed with v5 SABs.
 *   - v6: widens the per-archetype `ArchetypeDescriptorHeader`
 *     component mask from 2 → `COMPONENT_MASK_WORDS` (4) u32 words
 *     (component limit 64 → 128). Touches the descriptor header (24 → 32
 *     bytes), not this `StoreHeader`, recorded here only to keep the version
 *     log in step with the module-side twin. Pre-v6 wasm cannot read v6 SABs
 *     (descriptor stride differs).
 *   - v7: de-games the SAB substrate. Drops the five consumer-named
 *     offset fields (terrain, spatial grid, army composition, spawn anchor
 *     and flow field) and replaces them with the
 *     generic `region_table_off` + `region_table_count` pair pointing at a
 *     `RegionTableEntry[]` directory. A consumer resolves its region via
 *     `findRegionOffset` in TS and its module-side twin. Header shrinks
 *     64 → 52 bytes, the first schema change that narrowed it. The SAB
 *     stays the always-on substrate. Only the game-named shape moves out.
 *
 * The v1…v7 labels above are the narrative log of the shape, not the value on
 * the wire. `SIM_ABI_VERSION` is that value, and it is 1. The golden fixtures
 * in `__tests__/header.test.ts` catch unintended drift.
 *
 * Every `*_off` field below is measured from the store base, not from buffer
 * byte 0. The store base is a caller-chosen byte offset, so a WASM module can
 * own the low addresses of the same memory. `capacity` is the store span in
 * bytes, measured from the same base.
 */

// The byte-layout constants below are maintained by hand in this repository.
// No generator produces them and no upstream source defines them. The golden
// tests pin them. We re-export them here so existing `./header` importers and
// the `core/store` barrel keep the same surface. The rich semantics for each
// field live on the `StoreHeader` interface and the golden bytes in
// `__tests__/header.test.ts`.
//
//   - STORE_MAGIC          ASCII 'SIM1' as little-endian u32
//   - SIM_ABI_VERSION      bumped on any header, descriptor or region-table
//                          schema change
//   - STORE_HEADER_BYTES   total header size (13 u32 fields)
//
// The sim-bindings region's byte size is no longer an engine ABI constant.
// It is consumer-owned. A consumer that opts into a WASM backend passes its
// own size through `CreateColumnStoreOptions.bindingsRegionBytes`, computed
// from its own binding manifest. Keeping it out of the ABI means a consumer's
// binding-manifest edit no longer drifts this engine golden.
import {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	LEGACY_ABSOLUTE_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS
} from "./vendored_abi/abi";

export {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	LEGACY_ABSOLUTE_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS
};

export interface StoreHeader {
	/** Magic value `STORE_MAGIC`. Used to detect a stale or foreign buffer
	 * before any other field is trusted. */
	readonly magic: number;
	/** ABI version. Mismatch means the WASM and TS disagree on layout and
	 * the SAB must not be used. */
	readonly simAbiVersion: number;
	/** Monotonic. Incremented every time the host reallocates the SAB.
	 * Cached TypedArray views become stale on bump. */
	readonly viewStamp: number;
	/** Store span in bytes, measured from the store base. The store writes
	 * only inside `[storeBase, storeBase + capacity)`. */
	readonly capacity: number;
	/** Number of archetype regions described by the layout descriptor. */
	readonly archetypeCount: number;
	/** Byte offset of the layout descriptor region, measured from the store
	 * base. */
	readonly layoutDescriptorOff: number;
	/** Byte offset of the WASM→TS command ring header. */
	readonly commandRingOff: number;
	/** Byte offset of the TS→WASM action ring header. */
	readonly actionRingOff: number;
	/** Byte offset of the entity-index region (entityId → archetype_id,
	 * row, generation lookup). 0 means absent, fixtures and bare-SAB
	 * tests that don't need the index see the v1 layout (the engine's
	 * `Store` always allocates one). */
	readonly entityIndexOff: number;
	/** Byte offset of the event ring region (ECS signal payloads shared
	 * with a compute backend). 0 means absent. */
	readonly eventRingOff: number;
	/** Byte offset of the region-table directory, a `RegionTableEntry[]`
	 * (`(region_id, byte_offset, byte_length)` triples) holding one entry
	 * per consumer-declared region. 0 means no consumer regions were
	 * declared. The engine treats `region_id` as opaque. A consumer resolves
	 * its region with `findRegionOffset(view, id)` in TS, or with the
	 * matching module-side lookup. Replaces the five consumer-named
	 * offset fields the SAB header used to hard-code. This de-games the SAB
	 * substrate. */
	readonly regionTableOff: number;
	/** Number of `RegionTableEntry` records at `region_table_off`. */
	readonly regionTableCount: number;
	/** Byte offset of the sim-bindings region, an opaque block of `u16`
	 * `(component_id, field_id)` ids. The consumer owns the layout, and the host
	 * writes the block once per layout. A WASM per-system export reads its ids
	 * from here instead of taking them as call args. Present only when the
	 * consumer opts into a WASM backend by passing `bindingsRegionBytes` to
	 * `createColumnStore`. 0 = absent, so a pure-TS world pays nothing for this
	 * region. The size is a runtime input, not an engine ABI constant. */
	readonly bindingsOff: number;
}

/** Write the header at offset 0 of `view`. The caller passes a `DataView`
 * whose start is the store base, so every offset the header carries stays
 * relative to that base. */
export function writeStoreHeader(view: DataView, h: StoreHeader): void {
	view.setUint32(STORE_HEADER_OFFSETS.magic, h.magic, true);
	view.setUint32(STORE_HEADER_OFFSETS.sim_abi_version, h.simAbiVersion, true);
	view.setUint32(STORE_HEADER_OFFSETS.view_stamp, h.viewStamp, true);
	view.setUint32(STORE_HEADER_OFFSETS.capacity, h.capacity, true);
	view.setUint32(STORE_HEADER_OFFSETS.archetype_count, h.archetypeCount, true);
	view.setUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, h.layoutDescriptorOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.command_ring_off, h.commandRingOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.action_ring_off, h.actionRingOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.entity_index_off, h.entityIndexOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.event_ring_off, h.eventRingOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.region_table_off, h.regionTableOff, true);
	view.setUint32(STORE_HEADER_OFFSETS.region_table_count, h.regionTableCount, true);
	view.setUint32(STORE_HEADER_OFFSETS.bindings_off, h.bindingsOff, true);
}

/** Read the header at offset 0 of `view`. Pass a `DataView` whose start is the
 * store base. */
export function readStoreHeader(view: DataView): StoreHeader {
	return {
		magic: view.getUint32(STORE_HEADER_OFFSETS.magic, true),
		simAbiVersion: view.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true),
		viewStamp: view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true),
		capacity: view.getUint32(STORE_HEADER_OFFSETS.capacity, true),
		archetypeCount: view.getUint32(STORE_HEADER_OFFSETS.archetype_count, true),
		layoutDescriptorOff: view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true),
		commandRingOff: view.getUint32(STORE_HEADER_OFFSETS.command_ring_off, true),
		actionRingOff: view.getUint32(STORE_HEADER_OFFSETS.action_ring_off, true),
		entityIndexOff: view.getUint32(STORE_HEADER_OFFSETS.entity_index_off, true),
		eventRingOff: view.getUint32(STORE_HEADER_OFFSETS.event_ring_off, true),
		regionTableOff: view.getUint32(STORE_HEADER_OFFSETS.region_table_off, true),
		regionTableCount: view.getUint32(STORE_HEADER_OFFSETS.region_table_count, true),
		bindingsOff: view.getUint32(STORE_HEADER_OFFSETS.bindings_off, true)
	};
}

/** Increment `view_stamp` in place after a host-side SAB reallocation. The
 * monotonic counter is the trigger for cached-view invalidation on the TS
 * side and for re-pointing in WASM. */
export function bumpViewStamp(view: DataView): number {
	const next = (view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true) + 1) >>> 0;
	view.setUint32(STORE_HEADER_OFFSETS.view_stamp, next, true);
	return next;
}

/** True iff the buffer's first four bytes are `STORE_MAGIC` and the ABI
 * version matches the current build. Used by both TS and WASM as a
 * pre-flight before treating any other field as meaningful. */
export function isValidStoreHeader(view: DataView): boolean {
	if (view.byteLength < STORE_HEADER_BYTES) return false;
	if (view.getUint32(STORE_HEADER_OFFSETS.magic, true) !== STORE_MAGIC) return false;
	if (view.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true) !== SIM_ABI_VERSION) return false;
	return true;
}
