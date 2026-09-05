// ABI layout constants for the column store's binary header, descriptor and
// rings. The re-export points are `header.ts` and `descriptor.ts`.
//
// This repository maintains these constants by hand. No generator produces
// them, and no upstream source defines them. The golden tests under
// `src/core/store/__tests__/` pin every byte they imply, so a transposed field
// changes a fixture and fails there.
//
// To change one: edit the constant, then rebuild the golden fixtures from the
// contract and bump `SIM_ABI_VERSION` in the same commit. A reader that carries
// a different version must refuse the bytes.
//
// Two kinds of test pin these constants. The round-trip tests verify the read
// side against the write side in this repository. The `wasm_store_reader`
// integration test drives a checked-in WebAssembly module, built with no
// toolchain, against a live store and compares its walk, its digest and its
// kernel output with the TypeScript side.

export const STORE_MAGIC = 0x314d4953;
/** Schema version of the header, the descriptors and the region table.
 *
 * Version 1 makes every `*_off` in the header, every `byte_off` in a column
 * descriptor and every region-table offset relative to the store base, and
 * makes `capacity` the store span measured from that base. Version 0 measured
 * all of them from buffer byte 0. Restore and resume reject a version they do
 * not know, because the two readings of one offset disagree. */
export const SIM_ABI_VERSION = 1;
/** The version the published 0.5 line wrote. Every store of that version sat
 * at buffer byte 0, so its offsets read correctly as version 1 offsets from the
 * header. Restore and resume accept it and stamp the current version. */
export const LEGACY_ABSOLUTE_ABI_VERSION = 0;
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
