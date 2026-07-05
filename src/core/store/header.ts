/**
 * SAB header — the first 52 bytes of the simulation SharedArrayBuffer.
 *
 * This file LOCKS the binary layout the WASM sim and the TS host both read
 * from. Any change to field order, width, or count is a `SIM_ABI_VERSION`
 * bump and is incompatible with prior `.wasm` builds. See
 * docs/ideas/buffer-wasm-sim-plan-2026-05-14T1600.md §7.1.
 *
 * Field order is identical to the Zig `extern struct` in plan §7.3 so a Zig
 * `*StoreHeader` and a JS `DataView` see the same bytes.
 *
 * Endianness: little-endian. WASM is little-endian; Bun and every browser
 * we target run on little-endian hosts (x86_64 / arm64). All DataView reads
 * and writes pass `littleEndian = true` explicitly so the fixture bytes are
 * the same regardless of host byte order, even if a future host disagrees.
 *
 * History:
 *   - v1 (#171 §7.1): 32-byte header with magic, sim_abi_version, view_stamp,
 *     capacity, archetype_count, layout_descriptor_off, command_ring_off,
 *     action_ring_off.
 *   - v2 (#245 / Phase 4 PR 4B): 48-byte header. Adds `entity_index_off`
 *     pointing at the SAB-resident entity-index region (entityId →
 *     archetype_id, row, generation). 12 trailing bytes reserved for
 *     future fields to avoid another version bump.
 *   - v2 (#247 / Phase 4 PR 4C): adds `event_ring_off` at byte 36 by
 *     promoting the first of v2's three reserved u32s. No version bump
 *     — pre-#247 readers saw the byte range as zero (`_reserved0`), so
 *     the change is backward-compatible.
 *   - v2 (#264 / Phase 4 gate PR-A): adds `terrain_off` at byte 40 by
 *     promoting the next reserved u32. Same backward-compat story as
 *     #247 — pre-#264 readers saw zero in that range, new readers see
 *     the offset of the terrain region or 0 when absent. No version bump.
 *   - v2 (#265 / Phase 4 gate PR-A): adds `spatial_grid_off` at byte 44
 *     by promoting the final reserved u32. Header is now fully packed
 *     (zero reserved bytes); the next schema change widens
 *     `STORE_HEADER_BYTES` or bumps `SIM_ABI_VERSION`.
 *   - v3 (#263 / Phase 4 gate PR-C+D): widens to 56 bytes and adds
 *     `army_compositions_off` (byte 48) + `spawn_anchors_off` (byte 52).
 *     Both point at SAB-resident regions the Zig `wave_spawn` system
 *     reads: army_compositions holds `NUM_PLAYERS × ARMY_SIZE` u8 slot
 *     bytes (TS writes, Zig reads); spawn_anchors holds `NUM_PLAYERS`
 *     `(i16 q, i16 r)` pairs (TS writes once at match init, Zig reads).
 *     ABI bump because the header widened past its previous packed size;
 *     pre-#263 wasm builds can't be mixed with post-#263 SABs.
 *   - v4 (#268 / Phase 4 gate PR-B): widens to 60 bytes and adds
 *     `flow_field_off` (byte 56). Points at the SAB-resident flow-field
 *     `next_step` region — per-base-owner blocks of `(from_hex_id,
 *     to_hex_id)` u32 pairs that the eventual Zig port of `movement.ts`
 *     reads via linear scan. TS owns writes (`build_flow_field` rebuilds
 *     per-match on wave-spawn / building changes); Zig is read-only.
 *     ABI bump because the header widened by 4 bytes past v3's packed
 *     size; pre-v4 wasm builds can't be mixed with v4 SABs.
 *   - v5 ("SAB-is-the-interface"): widens to 64 bytes and adds
 *     `bindings_off` (byte 60). Points at the SAB-resident sim-bindings
 *     region — a fixed `SIM_BINDINGS_BYTES` block of `u16` component/field
 *     IDs the host writes once (per layout). The Zig per-system exports
 *     (`tick_cooldown_ready`, `tick_movement_tick`, `tick_faith_production`,
 *     and the batched `tick_all`) read their `(component_id, field_id)`
 *     pairs from this block instead of taking them as positional call
 *     args, so a frame can run several systems in one JS→WASM crossing.
 *     The region is ALWAYS present (fixed size, no option knob); TS owns
 *     writes via `write_sim_bindings`, Zig is read-only. ABI bump because
 *     the header widened by 4 bytes past v4's packed size; pre-v5 wasm
 *     builds can't be mixed with v5 SABs.
 *   - v6 (#381): widens the per-archetype `ArchetypeDescriptorHeader`
 *     component mask from 2 → `COMPONENT_MASK_WORDS` (4) u32 words
 *     (component limit 64 → 128). Touches the descriptor header (24 → 32
 *     bytes), NOT this `StoreHeader` — recorded here only to keep the version
 *     log in step with the `abi.zig` twin. Pre-v6 wasm can't read v6 SABs
 *     (descriptor stride differs).
 *   - v7 (#623): de-games the SAB substrate. Drops the five game-named
 *     offset fields (`terrain_off`/`spatial_grid_off`/`army_compositions_off`/
 *     `spawn_anchors_off`/`flow_field_off`) and replaces them with the
 *     generic `region_table_off` + `region_table_count` pair pointing at a
 *     `RegionTableEntry[]` directory; a consumer resolves its region via
 *     `findRegionOffset` (TS) / `abi.find_region` (Zig). Header SHRINKS
 *     64 → 52 bytes — the first schema change that narrowed it. (ADR-0018 —
 *     SAB stays the always-on substrate; only the game-named shape moves out.)
 *
 * SIM_ABI_VERSION carries the pre-publish sentinel `0` (see `abi.zig`), so the
 * v1…v7 labels above are the narrative version log, not the value on the wire;
 * the golden fixtures in `__tests__/header.test.ts` catch unintended drift.
 */

// The byte-layout constants below are GENERATED from the Zig `extern struct`s
// in `packages/sim/src/{abi,bindings}.zig` via `bun run gen:abi` (in-house Zig
// bindgen, #392). The Zig struct is the single source of truth — `@offsetOf`
// reads the real layout, so a transposed field is impossible. We re-export
// them here so existing `./header` importers and the `core/buffer` barrel keep
// the same surface; the rich semantics for each field live on the `StoreHeader`
// interface and the golden bytes in `__tests__/header.test.ts`.
//
//   - STORE_MAGIC         — ASCII 'SIM1' as little-endian u32 (#171 §7.1)
//   - SIM_ABI_VERSION   — bumped on any header/descriptor schema change;
//                         independent from `PROTOCOL_VERSION`
//   - STORE_HEADER_BYTES  — total header size (13 u32 fields)
//
// The sim-bindings region's byte size is NO LONGER an engine ABI constant
// (#625). It's game-owned — a consumer that opts into a WASM backend passes its
// own size via `CreateColumnStoreOptions.bindingsRegionBytes` (the game-computed
// `SIM_BINDINGS_BYTES` in `@internal/sim`). De-welding it from the ABI means a
// game's binding-manifest edit no longer drifts this engine golden.
import {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS
} from "./vendored_abi/abi";

export {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS
};

export interface StoreHeader {
	/** Magic value `STORE_MAGIC`; used to detect a stale or foreign buffer
	 * before any other field is trusted. */
	readonly magic: number;
	/** ABI version; mismatch means the WASM and TS disagree on layout and
	 * the SAB must not be used. */
	readonly simAbiVersion: number;
	/** Monotonic; incremented every time the host reallocates the SAB.
	 * Cached TypedArray views become stale on bump. (#171 §8.1) */
	readonly viewStamp: number;
	/** Total SAB size in bytes. */
	readonly capacity: number;
	/** Number of archetype regions described by the layout descriptor. */
	readonly archetypeCount: number;
	/** Byte offset into the SAB where the layout descriptor region starts. */
	readonly layoutDescriptorOff: number;
	/** Byte offset of the WASM→TS command ring header. (#171 §7.5) */
	readonly commandRingOff: number;
	/** Byte offset of the TS→WASM action ring header. (#171 §7.5, Phase 5) */
	readonly actionRingOff: number;
	/** Byte offset of the entity-index region (entityId → archetype_id,
	 * row, generation lookup). 0 means absent — fixtures and bare-SAB
	 * tests that don't need the index see the v1 layout (the engine's
	 * `Store` always allocates one). (#245 / Phase 4 PR 4B) */
	readonly entityIndexOff: number;
	/** Byte offset of the event ring region (ECS signal payloads shared
	 * with the Zig sim). 0 means absent. (#247 / Phase 4 PR 4C) */
	readonly eventRingOff: number;
	/** Byte offset of the region-table directory — a `RegionTableEntry[]`
	 * (`(region_id, byte_offset, byte_length)` triples) holding one entry
	 * per consumer-declared region. 0 means no consumer regions were
	 * declared. The engine treats `region_id` as opaque; a consumer resolves
	 * its region with `findRegionOffset(view, header, id)` (TS) /
	 * `abi.find_region(header_addr, id)` (Zig). Replaces the five game-named
	 * offset fields (`terrain_off`/`spatial_grid_off`/… ) the SAB header
	 * used to hard-code. (#623 — de-game the SAB substrate; ADR-0018.) */
	readonly regionTableOff: number;
	/** Number of `RegionTableEntry` records at `region_table_off`. (#623) */
	readonly regionTableCount: number;
	/** Byte offset of the sim-bindings region — an opaque block of `u16`
	 * `(component_id, field_id)` IDs (layout owned by the game, in
	 * `@internal/sim`'s `sim_bindings.ts` / `bindings.zig`). The host writes it
	 * once per layout via `write_sim_bindings`; the Zig per-system exports
	 * (`tick_cooldown_ready` / `tick_movement_tick` / `tick_faith_production`
	 * and the batched `tick_all`) read their IDs from here instead of taking
	 * them as call args. Present only when the consumer opts into a WASM backend
	 * by passing `bindingsRegionBytes` to `createColumnStore`; 0 = absent (a
	 * pure-TS game pays nothing for this region). The size is a runtime input,
	 * not an engine ABI constant, since #625. (v5 / "SAB-is-the-interface".) */
	readonly bindingsOff: number;
}

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
 * side and for re-pointing in WASM. (#171 §8.1) */
export function bumpViewStamp(view: DataView): number {
	const next = (view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true) + 1) >>> 0;
	view.setUint32(STORE_HEADER_OFFSETS.view_stamp, next, true);
	return next;
}

/** True iff the buffer's first four bytes are `STORE_MAGIC` AND the ABI
 * version matches the current build. Used by both TS and WASM as a
 * pre-flight before treating any other field as meaningful. */
export function isValidSab(view: DataView): boolean {
	if (view.byteLength < STORE_HEADER_BYTES) return false;
	if (view.getUint32(STORE_HEADER_OFFSETS.magic, true) !== STORE_MAGIC) return false;
	if (view.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true) !== SIM_ABI_VERSION) return false;
	return true;
}
