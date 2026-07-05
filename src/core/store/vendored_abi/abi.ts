// Vendored ABI layout constants for the column store's binary header,
// descriptor, and rings — re-export points are `header.ts` and `descriptor.ts`.
//
// **This is a hand-maintained vendored snapshot, not generated output.**
// Upstream (the oasys engine, `packages/sim/src/abi.zig`) these constants are
// machine-generated from a Zig `extern struct` source via `@offsetOf` — real
// layout, padding included. oecs carries no Zig source and no codegen step;
// the exact byte offsets below were copied by hand. Sync provenance:
// unverified — re-check against upstream before the next ABI-dependent change.
//
// To update: copy the constants from the upstream engine's generated
// `abi.ts` (or re-derive from `abi.zig`'s `@offsetOf` output), keep the
// `SIM_ABI_VERSION` in lockstep, then run the column-store header,
// descriptor, and state-hash round-trip suites under
// `src/core/store/__tests__/`.
//
// KNOWN TEST GAP: those round-trip tests verify TS-internal
// self-consistency only — the same constants on the read and write side —
// NOT agreement with the real upstream ABI. Cross-checking against the
// engine remains a manual step.

export const STORE_MAGIC = 0x314d4953;
export const SIM_ABI_VERSION = 0;
export const COMPONENT_MASK_WORDS = 4;

export const STORE_HEADER_BYTES = 52;
export const STORE_HEADER_OFFSETS = {
	magic: 0,
	sim_abi_version: 4,
	view_stamp: 8,
	capacity: 12,
	archetype_count: 16,
	layout_descriptor_off: 20,
	command_ring_off: 24,
	action_ring_off: 28,
	entity_index_off: 32,
	event_ring_off: 36,
	region_table_off: 40,
	region_table_count: 44,
	bindings_off: 48
} as const;

export const REGION_TABLE_ENTRY_BYTES = 12;
export const REGION_TABLE_ENTRY_OFFSETS = {
	region_id: 0,
	byte_offset: 4,
	byte_length: 8
} as const;

export const COLUMN_DESCRIPTOR_BYTES = 16;
export const COLUMN_DESCRIPTOR_OFFSETS = {
	component_id: 0,
	field_id: 2,
	type_tag: 4,
	byte_off: 8,
	stride: 12
} as const;

export const ARCHETYPE_DESCRIPTOR_HEADER_BYTES = 36;
export const ARCHETYPE_DESCRIPTOR_OFFSETS = {
	archetype_id: 0,
	component_mask: 4,
	row_count: 20,
	row_capacity: 24,
	column_count: 28,
	enabled_count: 32
} as const;
