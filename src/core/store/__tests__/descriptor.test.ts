/**
 * Binary-fixture lock for the SAB layout descriptor (#171 §6.1.2).
 *
 * Pins the byte sequence of `ColumnDescriptor` (16 bytes) and
 * `ArchetypeDescriptor` (32-byte header + N × 16-byte columns) so the
 * WASM sim and the TS host can never silently disagree on where a column
 * lives in the SAB. Same role as `header.test.ts` plays for the SAB header.
 *
 * Schema change ⇒ `SIM_ABI_VERSION` bump (see `header.ts`).
 */

import { describe, expect, it } from "vitest";
import {
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	type ArchetypeDescriptor,
	archetypeDescriptorBytes,
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	type ColumnDescriptor,
	layoutDescriptorRegionBytes,
	readArchetypeDescriptor,
	readColumnDescriptor,
	readLayoutDescriptorRegion,
	TYPE_TAG,
	TYPE_TAG_STRIDE,
	writeArchetypeDescriptor,
	writeColumnDescriptor,
	writeLayoutDescriptorRegion
} from "../descriptor";

function toHex(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, "0");
	}
	return s;
}

// ───────────────────────── ColumnDescriptor ─────────────────────────────

const COLUMN_FIXTURE: ColumnDescriptor = {
	componentId: 5,
	fieldId: 2,
	typeTag: TYPE_TAG.i32,
	byteOff: 128,
	stride: 4
};

// Bytes hand-derived from §7.3 + COLUMN_DESCRIPTOR_OFFSETS, little-endian.
// [0..2) cid=0x0005 → 05 00
// [2..4) fid=0x0002 → 02 00
// [4..5) tag=0x05   → 05
// [5..8) _pad       → 00 00 00
// [8..12) byte_off=0x80 → 80 00 00 00
// [12..14) stride=0x04 → 04 00
// [14..16) _pad2    → 00 00
const COLUMN_GOLDEN_HEX = "05000200050000008000000004000000";

// ───────────────────────── ArchetypeDescriptor ─────────────────────────────

const ARCHETYPE_FIXTURE: ArchetypeDescriptor = {
	archetypeId: 42,
	componentMask: [0xdead_beef, 0, 0, 0],
	rowCount: 3,
	enabledCount: 3,
	rowCapacity: 16,
	columns: [COLUMN_FIXTURE]
};

// Header bytes (36) + COLUMN_GOLDEN_HEX (16) = 52 bytes total.
// [0..4) archetype_id=42=0x2A → 2a 00 00 00
// [4..8) mask[0]=0xDEADBEEF   → ef be ad de
// [8..12) mask[1]=0           → 00 00 00 00
// [12..16) mask[2]=0          → 00 00 00 00
// [16..20) mask[3]=0          → 00 00 00 00
// [20..24) row_count=3        → 03 00 00 00
// [24..28) row_cap=16=0x10    → 10 00 00 00
// [28..32) column_count=1     → 01 00 00 00
// [32..36) enabled_count=3    → 03 00 00 00
const ARCHETYPE_HEADER_GOLDEN_HEX =
	"2a000000efbeadde0000000000000000000000000300000010000000" + "01000000" + "03000000";
const ARCHETYPE_GOLDEN_HEX = ARCHETYPE_HEADER_GOLDEN_HEX + COLUMN_GOLDEN_HEX;

// ───────────────────────── Region (2 archetypes) ────────────────────────

const COLUMN_2: ColumnDescriptor = {
	componentId: 7,
	fieldId: 0,
	typeTag: TYPE_TAG.u8,
	byteOff: 256,
	stride: 1
};
const ARCHETYPE_2: ArchetypeDescriptor = {
	archetypeId: 99,
	componentMask: [1, 0, 0, 0],
	rowCount: 0,
	enabledCount: 0,
	rowCapacity: 8,
	columns: [COLUMN_2]
};

const REGION_FIXTURE: readonly ArchetypeDescriptor[] = [ARCHETYPE_FIXTURE, ARCHETYPE_2];

// ───────────────────────── Tests ─────────────────────────────

describe("SAB ColumnDescriptor — 16-byte fixed layout (#171 §7.3)", () => {
	it("fixture writes to the golden byte sequence", () => {
		const buf = new ArrayBuffer(COLUMN_DESCRIPTOR_BYTES);
		const view = new DataView(buf);
		writeColumnDescriptor(view, 0, COLUMN_FIXTURE);
		expect(toHex(new Uint8Array(buf))).toBe(COLUMN_GOLDEN_HEX);
	});

	it("ColumnDescriptor is exactly 16 bytes wide", () => {
		expect(COLUMN_DESCRIPTOR_BYTES).toBe(16);
		// Offsets must match Zig `extern struct` field positions in plan §7.3.
		// Reordering or adding a field shifts these — fails before the fixture
		// to point at the version-bump requirement.
		expect(COLUMN_DESCRIPTOR_OFFSETS).toEqual({
			component_id: 0,
			field_id: 2,
			type_tag: 4,
			byte_off: 8,
			stride: 12
		});
	});

	it("write → read round-trips every field", () => {
		const buf = new ArrayBuffer(COLUMN_DESCRIPTOR_BYTES);
		const view = new DataView(buf);
		writeColumnDescriptor(view, 0, COLUMN_FIXTURE);
		expect(readColumnDescriptor(view, 0)).toEqual(COLUMN_FIXTURE);
	});

	it("writes to non-zero offsets correctly (off=16)", () => {
		// Region reads call this with off = N × COLUMN_DESCRIPTOR_BYTES. A bug
		// that treated `off` as 0-based-from-the-field would only show up here.
		const buf = new ArrayBuffer(64);
		const view = new DataView(buf);
		writeColumnDescriptor(view, 16, COLUMN_FIXTURE);
		expect(readColumnDescriptor(view, 16)).toEqual(COLUMN_FIXTURE);
		// Bytes before the write are untouched (still zero).
		const u8 = new Uint8Array(buf);
		for (let i = 0; i < 16; i++) expect(u8[i]).toBe(0);
	});

	it("TYPE_TAG_STRIDE matches IEEE byte widths for every tag", () => {
		expect(TYPE_TAG_STRIDE[TYPE_TAG.u8]).toBe(1);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.i8]).toBe(1);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.u16]).toBe(2);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.i16]).toBe(2);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.u32]).toBe(4);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.i32]).toBe(4);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.f32]).toBe(4);
		expect(TYPE_TAG_STRIDE[TYPE_TAG.f64]).toBe(8);
	});
});

describe("SAB ArchetypeDescriptor — 36-byte header + N × 16 (#171 §7.2 / #599)", () => {
	it("fixture writes to the golden byte sequence (1 column)", () => {
		const buf = new ArrayBuffer(archetypeDescriptorBytes(1));
		const view = new DataView(buf);
		const end = writeArchetypeDescriptor(view, 0, ARCHETYPE_FIXTURE);
		expect(end).toBe(archetypeDescriptorBytes(1));
		expect(toHex(new Uint8Array(buf))).toBe(ARCHETYPE_GOLDEN_HEX);
	});

	it("header is exactly ARCHETYPE_DESCRIPTOR_HEADER_BYTES (36) bytes", () => {
		expect(ARCHETYPE_DESCRIPTOR_HEADER_BYTES).toBe(36);
		// archetype_id, component_mask (4 words @ 4), row_count, row_capacity,
		// column_count, enabled_count (#599). Reordering or widening shifts these —
		// fails before the fixture to point at the version-bump requirement.
		expect(Object.values(ARCHETYPE_DESCRIPTOR_OFFSETS)).toEqual([0, 4, 20, 24, 28, 32]);
	});

	it("archetype_descriptor_bytes(N) = 36 + N × 16", () => {
		expect(archetypeDescriptorBytes(0)).toBe(36);
		expect(archetypeDescriptorBytes(1)).toBe(52);
		expect(archetypeDescriptorBytes(5)).toBe(36 + 5 * 16);
	});

	it("write → read round-trips header + every column", () => {
		const buf = new ArrayBuffer(archetypeDescriptorBytes(2));
		const view = new DataView(buf);
		const multi: ArchetypeDescriptor = {
			...ARCHETYPE_FIXTURE,
			columns: [COLUMN_FIXTURE, COLUMN_2]
		};
		writeArchetypeDescriptor(view, 0, multi);
		expect(readArchetypeDescriptor(view, 0)).toEqual(multi);
	});

	it("read returns columns in write order", () => {
		const buf = new ArrayBuffer(archetypeDescriptorBytes(3));
		const view = new DataView(buf);
		const a: ColumnDescriptor = { ...COLUMN_FIXTURE, componentId: 1 };
		const b: ColumnDescriptor = { ...COLUMN_FIXTURE, componentId: 2 };
		const c: ColumnDescriptor = { ...COLUMN_FIXTURE, componentId: 3 };
		writeArchetypeDescriptor(view, 0, { ...ARCHETYPE_FIXTURE, columns: [a, b, c] });

		const roundTrip = readArchetypeDescriptor(view, 0);
		expect(roundTrip.columns.map((col) => col.componentId)).toEqual([1, 2, 3]);
	});
});

describe("SAB layout descriptor region — sequential variable-length walk", () => {
	it("layout_descriptor_region_bytes sums each archetype's footprint", () => {
		// 1-column archetype = 52, 1-column archetype = 52, total = 104.
		expect(layoutDescriptorRegionBytes(REGION_FIXTURE)).toBe(104);

		const wider: readonly ArchetypeDescriptor[] = [
			{ ...ARCHETYPE_FIXTURE, columns: [COLUMN_FIXTURE, COLUMN_FIXTURE, COLUMN_FIXTURE] },
			ARCHETYPE_2
		];
		// 36 + 3×16 = 84; plus 52 = 136.
		expect(layoutDescriptorRegionBytes(wider)).toBe(136);
	});

	it("write_layout_descriptor_region returns the end offset", () => {
		const regionOff = 64;
		const buf = new ArrayBuffer(regionOff + layoutDescriptorRegionBytes(REGION_FIXTURE));
		const view = new DataView(buf);
		const end = writeLayoutDescriptorRegion(view, regionOff, REGION_FIXTURE);
		expect(end).toBe(regionOff + 104);
	});

	it("region round-trips through write → read at non-zero offset", () => {
		// Real SAB usage: region lives after the 32-byte header, so the
		// region offset is non-zero. Pin that here.
		const regionOff = 32;
		const buf = new ArrayBuffer(regionOff + layoutDescriptorRegionBytes(REGION_FIXTURE));
		const view = new DataView(buf);
		writeLayoutDescriptorRegion(view, regionOff, REGION_FIXTURE);

		const roundTrip = readLayoutDescriptorRegion(view, regionOff, REGION_FIXTURE.length);
		expect(roundTrip).toEqual(REGION_FIXTURE);
	});

	it("region walk does not read past the supplied archetype_count", () => {
		// `readLayoutDescriptorRegion` stops at `archetype_count`. Anything
		// later in the buffer must not bleed into the result.
		const regionOff = 0;
		const buf = new ArrayBuffer(layoutDescriptorRegionBytes(REGION_FIXTURE) + 64);
		const view = new DataView(buf);
		writeLayoutDescriptorRegion(view, regionOff, REGION_FIXTURE);

		// Write some garbage past the region.
		const u8 = new Uint8Array(buf);
		const garbageStart = layoutDescriptorRegionBytes(REGION_FIXTURE);
		for (let i = garbageStart; i < u8.length; i++) u8[i] = 0xff;

		const roundTrip = readLayoutDescriptorRegion(view, regionOff, REGION_FIXTURE.length);
		expect(roundTrip).toEqual(REGION_FIXTURE);
	});

	it("works through a SharedArrayBuffer view (real-world target)", () => {
		const buffer = new SharedArrayBuffer(layoutDescriptorRegionBytes(REGION_FIXTURE));
		const view = new DataView(buffer);
		writeLayoutDescriptorRegion(view, 0, REGION_FIXTURE);
		expect(readLayoutDescriptorRegion(view, 0, REGION_FIXTURE.length)).toEqual(REGION_FIXTURE);
	});
});
