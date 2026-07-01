/**
 * Entity-index SAB region tests (#245 / Phase 4 PR 4B).
 *
 * Covers the standalone region primitive in `entity_index.ts` —
 * sizing, header field offsets, init, and the typed-array view
 * factory. Integration with `createColumnStore` is exercised by
 * `column_store.test.ts`; integration with the engine's `Store` (entity
 * placements round-tripping through the region) is covered by the ECS
 * test suite.
 */

import { describe, expect, it } from "vitest";
import {
	buildEntityIndexViews,
	entityIndexCapacity,
	entityIndexLength,
	entityIndexRegionBytes,
	ENTITY_INDEX_BYTES_PER_SLOT,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	ENTITY_INDEX_HEADER_BYTES,
	ENTITY_INDEX_HEADER_OFFSETS,
	EntityIndexError,
	initEntityIndexRegion,
	setEntityIndexLength
} from "../entity_index";

describe("entity_index — constants", () => {
	it("header is 16 bytes (length + capacity + 8 B pad)", () => {
		expect(ENTITY_INDEX_HEADER_BYTES).toBe(16);
	});

	it("each slot is 12 bytes (3 × i32: generation, archetype, row)", () => {
		expect(ENTITY_INDEX_BYTES_PER_SLOT).toBe(12);
	});

	it("default capacity is MAX_INDEX (1<<20 = 1,048,576)", () => {
		expect(ENTITY_INDEX_DEFAULT_CAPACITY).toBe(1 << 20);
	});

	it("header field offsets are locked", () => {
		expect(ENTITY_INDEX_HEADER_OFFSETS.length).toBe(0);
		expect(ENTITY_INDEX_HEADER_OFFSETS.capacity).toBe(4);
	});
});

describe("entity_index — sizing", () => {
	it("region_bytes = header + capacity * 12", () => {
		expect(entityIndexRegionBytes(0)).toBe(16);
		expect(entityIndexRegionBytes(1)).toBe(16 + 12);
		expect(entityIndexRegionBytes(100)).toBe(16 + 1200);
		expect(entityIndexRegionBytes(1024)).toBe(16 + 12_288);
	});

	it("rejects negative or non-integer capacity", () => {
		expect(() => entityIndexRegionBytes(-1)).toThrow(EntityIndexError);
		expect(() => entityIndexRegionBytes(1.5)).toThrow(EntityIndexError);
	});
});

describe("entity_index — init + readers", () => {
	function freshRegion(capacity: number) {
		const buffer = new SharedArrayBuffer(entityIndexRegionBytes(capacity));
		const view = new DataView(buffer);
		initEntityIndexRegion(view, 0, capacity);
		return { buffer, view };
	}

	it("init zeroes length and writes capacity", () => {
		const { view } = freshRegion(8);
		expect(entityIndexLength(view, 0)).toBe(0);
		expect(entityIndexCapacity(view, 0)).toBe(8);
	});

	it("set_entity_index_length writes through", () => {
		const { view } = freshRegion(8);
		setEntityIndexLength(view, 0, 5);
		expect(entityIndexLength(view, 0)).toBe(5);
		setEntityIndexLength(view, 0, 0);
		expect(entityIndexLength(view, 0)).toBe(0);
	});

	it("init rejects non-integer capacity", () => {
		const buffer = new SharedArrayBuffer(64);
		const view = new DataView(buffer);
		expect(() => initEntityIndexRegion(view, 0, 1.5)).toThrow(EntityIndexError);
		expect(() => initEntityIndexRegion(view, 0, -1)).toThrow(EntityIndexError);
	});

	it("init accepts capacity = 0 (empty region, header only)", () => {
		const buffer = new SharedArrayBuffer(16);
		const view = new DataView(buffer);
		expect(() => initEntityIndexRegion(view, 0, 0)).not.toThrow();
		expect(entityIndexCapacity(view, 0)).toBe(0);
	});
});

describe("entity_index — typed-array views", () => {
	it("views have correct length and shared byte ordering", () => {
		const cap = 4;
		const buffer = new SharedArrayBuffer(entityIndexRegionBytes(cap));
		const view = new DataView(buffer);
		initEntityIndexRegion(view, 0, cap);

		const v = buildEntityIndexViews(buffer, 0, cap);
		expect(v.generations.length).toBe(cap);
		expect(v.archetypes.length).toBe(cap);
		expect(v.rows.length).toBe(cap);

		// All three should be Int32Array — UNASSIGNED (-1) round-trips.
		expect(v.generations).toBeInstanceOf(Int32Array);
		expect(v.archetypes).toBeInstanceOf(Int32Array);
		expect(v.rows).toBeInstanceOf(Int32Array);
	});

	it("byte offsets land past the header in column order (gen, arch, row)", () => {
		const cap = 3;
		const buffer = new SharedArrayBuffer(entityIndexRegionBytes(cap));
		const view = new DataView(buffer);
		initEntityIndexRegion(view, 0, cap);

		const v = buildEntityIndexViews(buffer, 0, cap);
		expect(v.generations.byteOffset).toBe(ENTITY_INDEX_HEADER_BYTES);
		expect(v.archetypes.byteOffset).toBe(ENTITY_INDEX_HEADER_BYTES + cap * 4);
		expect(v.rows.byteOffset).toBe(ENTITY_INDEX_HEADER_BYTES + 2 * cap * 4);
	});

	it("-1 sentinel round-trips through Int32Array (UNASSIGNED ↔ 0xFFFFFFFF)", () => {
		const cap = 2;
		const buffer = new SharedArrayBuffer(entityIndexRegionBytes(cap));
		const view = new DataView(buffer);
		initEntityIndexRegion(view, 0, cap);
		const v = buildEntityIndexViews(buffer, 0, cap);

		v.archetypes[0] = -1;
		v.rows[0] = -1;
		expect(v.archetypes[0]).toBe(-1);
		expect(v.rows[0]).toBe(-1);

		// Raw bytes are 0xFF * 4 — what the Zig side reads as i32 == -1
		// (signed) and what a Uint32Array view would read as 4294967295.
		const u8 = new Uint8Array(buffer);
		// arch col for cap=2 starts at header (16) + cap*4 (8) = 24; slot 0
		// is bytes 24..27.
		const archSlot0 = ENTITY_INDEX_HEADER_BYTES + cap * 4;
		for (let i = archSlot0; i < archSlot0 + 4; i++) {
			expect(u8[i]).toBe(0xff);
		}
	});

	it("writing through one view does not bleed into another", () => {
		const cap = 4;
		const buffer = new SharedArrayBuffer(entityIndexRegionBytes(cap));
		const view = new DataView(buffer);
		initEntityIndexRegion(view, 0, cap);
		const v = buildEntityIndexViews(buffer, 0, cap);

		v.generations[2] = 0x11_22_33_44;
		v.archetypes[2] = 0x55_66_77_78; // positive — sign bit clear
		v.rows[2] = 0x12_34_56_78;

		expect(v.generations[2]).toBe(0x11_22_33_44);
		expect(v.archetypes[2]).toBe(0x55_66_77_78);
		expect(v.rows[2]).toBe(0x12_34_56_78);

		// Other slots untouched.
		expect(v.generations[0]).toBe(0);
		expect(v.archetypes[0]).toBe(0);
		expect(v.rows[0]).toBe(0);
	});
});
