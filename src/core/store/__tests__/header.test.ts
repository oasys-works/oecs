/**
 * Binary-fixture lock for the 52-byte SAB header. It widened from 32 B to
 * 48 B, then 56 B, then 60 B, then 64 B, and then shrank to 52 B when the
 * five game-named region offsets became a generic region table.
 *
 * The bytes in `GOLDEN_HEX` are the contract: any unintentional change to
 * field order, width, or endianness will flip them and fail this test. Treat
 * it the same as `wire_fingerprint.test.ts` treats the wire codec.
 *
 * PRE-PUBLISH SENTINEL: `sim_abi_version` is currently 0 ("not yet
 * published" — see `abi.zig`). While it is 0 we do NOT bump on layout
 * changes; this golden just guards against *unintended* drift.
 *
 * If you intentionally change the schema:
 *   1. Update `GOLDEN_HEX` to the new bytes.
 *   2. POST-PUBLISH ONLY (version >= 1): also bump `SIM_ABI_VERSION` in the
 *      same PR — the version bump is part of the "old WASM can't read new
 *      SAB" contract. Pre-publish (version 0) the bump is intentionally
 *      skipped.
 */

import { describe, expect, it } from "vitest";
import {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	bumpViewStamp,
	isValidSab,
	readStoreHeader,
	writeStoreHeader,
	type StoreHeader
} from "../header";

// Hand-derived from the layout, written little-endian per the
// "WASM is LE; every host we target is LE" invariant in `header.ts`. Held
// here as a string so a diff failure prints the exact byte that flipped.
const FIXTURE: StoreHeader = {
	magic: STORE_MAGIC,
	simAbiVersion: SIM_ABI_VERSION,
	viewStamp: 0,
	capacity: 4096,
	archetypeCount: 3,
	layoutDescriptorOff: 52,
	commandRingOff: 4_000,
	actionRingOff: 4_064,
	entityIndexOff: 1_024,
	eventRingOff: 2_048,
	regionTableOff: 3_072,
	regionTableCount: 5,
	bindingsOff: 4_032
};

const GOLDEN_HEX = [
	"53494d31", // magic ('SIM1' as bytes on disk; LE u32 = 0x314D4953)
	"00000000", // sim_abi_version = 0  (pre-publish sentinel; bumps start at 1 on release)
	"00000000", // view_stamp = 0
	"00100000", // capacity = 4096
	"03000000", // archetype_count = 3
	"34000000", // layout_descriptor_off = 52 (header is now 52 B wide)
	"a00f0000", // command_ring_off = 4000
	"e00f0000", // action_ring_off = 4064
	"00040000", // entity_index_off = 1024
	"00080000", // event_ring_off = 2048
	"000c0000", // region_table_off = 3072  (generic consumer region table)
	"05000000", // region_table_count = 5
	"c00f0000" //  bindings_off = 4032       (v5 / SAB-is-the-interface)
].join("");

function toHex(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, "0");
	}
	return s;
}

describe("SAB header — locked binary layout", () => {
	it("fixture writes to the golden byte sequence", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, FIXTURE);

		// Comparing the hex string (instead of byte-for-byte expect calls)
		// makes a single-byte regression print the surrounding context.
		expect(toHex(new Uint8Array(buf))).toBe(GOLDEN_HEX);
	});

	it("header is exactly STORE_HEADER_BYTES (52) bytes wide", () => {
		// 52 bytes: the five game-named region offsets were replaced
		// by the generic `region_table_off` + `region_table_count` pair (a net
		// −5 +2 = −3 u32 fields). Game regions now live in the region-table
		// directory, not as named header fields. A further mechanism field
		// requires widening the constant or (post-publish) bumping the ABI.
		expect(STORE_HEADER_BYTES).toBe(52);

		// Field offsets are dense u32s, no padding between them. Reordering
		// fields fails this test before the fixture does.
		const offsets = Object.values(STORE_HEADER_OFFSETS);
		expect(offsets).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]);
	});

	it("write → read round-trips every field", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, FIXTURE);

		expect(readStoreHeader(view)).toEqual(FIXTURE);
	});

	it("bump_view_stamp increments in place and returns the new value", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, { ...FIXTURE, viewStamp: 7 });

		expect(bumpViewStamp(view)).toBe(8);
		expect(readStoreHeader(view).viewStamp).toBe(8);

		expect(bumpViewStamp(view)).toBe(9);
		expect(readStoreHeader(view).viewStamp).toBe(9);
	});

	it("bump_view_stamp wraps at u32 (mod 2^32)", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, { ...FIXTURE, viewStamp: 0xff_ff_ff_ff });

		// `>>> 0` in the implementation forces unsigned wrap; a `>>>`-free
		// implementation would emit -1 here and silently mis-compare against
		// every cached stamp downstream.
		expect(bumpViewStamp(view)).toBe(0);
	});

	it("is_valid_sab accepts a freshly written header", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, FIXTURE);

		expect(isValidSab(view)).toBe(true);
	});

	it("is_valid_sab rejects wrong magic", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, { ...FIXTURE, magic: 0xdead_beef });

		expect(isValidSab(view)).toBe(false);
	});

	it("is_valid_sab rejects wrong ABI version", () => {
		const buf = new ArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buf);
		writeStoreHeader(view, { ...FIXTURE, simAbiVersion: SIM_ABI_VERSION + 1 });

		expect(isValidSab(view)).toBe(false);
	});

	it("is_valid_sab rejects a buffer too small to hold the header", () => {
		const view = new DataView(new ArrayBuffer(STORE_HEADER_BYTES - 1));

		expect(isValidSab(view)).toBe(false);
	});

	it("header layout matches when written through a SharedArrayBuffer view", () => {
		// SAB and ArrayBuffer share the same DataView API and the same
		// little-endian guarantee, but the eventual real-world target is
		// a SAB shared with WASM. Hold both code paths under test so a
		// future SAB-only divergence doesn't slip past the ArrayBuffer
		// fixture above.
		const buffer = new SharedArrayBuffer(STORE_HEADER_BYTES);
		const view = new DataView(buffer);
		writeStoreHeader(view, FIXTURE);

		expect(toHex(new Uint8Array(buffer.slice(0)))).toBe(GOLDEN_HEX);
		expect(readStoreHeader(view)).toEqual(FIXTURE);
	});
});
