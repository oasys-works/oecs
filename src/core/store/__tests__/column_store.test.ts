/**
 * ColumnStore behavior tests (#171 §6.1.3).
 *
 * Verifies the sizing + layout primitive end-to-end: given a set of
 * archetype specs, the resulting SAB contains a valid locked header, a
 * round-trippable layout descriptor, and TypedArray views that read and
 * write the same bytes the descriptor advertises.
 *
 * Not a binary fixture (the byte offsets depend on alignment and column
 * order — locked at the descriptor level in `descriptor.test.ts`). The
 * contract pinned here is "views land where the descriptor says they
 * land", which is the load-bearing invariant for the eventual Archetype
 * integration.
 */

import { describe, expect, it } from "vitest";
import {
	columnKey,
	createColumnStore,
	isValidSab,
	readLayoutDescriptorRegion,
	readStoreHeader,
	STORE_HEADER_BYTES,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	TYPE_TAG,
	type ArchetypeSpec
} from "../index";

// The sim-bindings region size is game-owned since #625 — the engine no longer
// exports a `SIM_BINDINGS_BYTES` ABI constant. A consumer that opts into a WASM
// backend supplies its own size via `bindingsRegionBytes`; this test owns its
// own value (mirrors @internal/sim's 64-field × 2-byte region).
const BINDINGS_BYTES = 128;
// Internal layout primitives not surfaced through the barrel — exercised
// directly so the 2³¹ overflow guard (#382) can be pinned without allocating
// a 2 GiB SharedArrayBuffer.
import { alignUp, STORE_MAX_BYTE_OFFSET, StoreLayoutOverflowError, _planLayout } from "../column_store";

// Single-archetype spec with three columns of mixed widths so alignment
// padding actually matters (u32 lands after a u8, exercises `alignUp`).
const SPEC_SINGLE: ArchetypeSpec = {
	archetypeId: 7,
	componentMask: [0b0111, 0, 0, 0],
	rowCapacity: 8,
	columns: [
		{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.u8 },
		{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.u32 },
		{ componentId: 2, fieldId: 1, typeTag: TYPE_TAG.f64 }
	]
};

// Two archetypes — exercises descriptor walk + multiple typed-array views.
const SPEC_MULTI: readonly ArchetypeSpec[] = [
	{
		archetypeId: 1,
		componentMask: [0b001, 0, 0, 0],
		rowCapacity: 4,
		columns: [{ componentId: 10, fieldId: 0, typeTag: TYPE_TAG.i32 }]
	},
	{
		archetypeId: 2,
		componentMask: [0b011, 0, 0, 0],
		rowCapacity: 16,
		columns: [
			{ componentId: 10, fieldId: 0, typeTag: TYPE_TAG.i32 },
			{ componentId: 11, fieldId: 0, typeTag: TYPE_TAG.u16 }
		]
	}
];

describe("create_column_store — SAB allocation + layout", () => {
	it("writes a valid header at byte 0", () => {
		const store = createColumnStore([SPEC_SINGLE]);
		expect(isValidSab(store.view)).toBe(true);

		const h = readStoreHeader(store.view);
		expect(h.magic).toBe(STORE_MAGIC);
		expect(h.simAbiVersion).toBe(SIM_ABI_VERSION);
		expect(h.viewStamp).toBe(0);
		expect(h.archetypeCount).toBe(1);
		// No bindings region by default (opt-in since #625) — a pure-TS store
		// pays nothing for the WASM seam, so the descriptor sits right after the
		// header and `bindings_off` is the absent sentinel 0.
		expect(h.bindingsOff).toBe(0);
		expect(h.layoutDescriptorOff).toBe(STORE_HEADER_BYTES);
		expect(h.commandRingOff).toBe(0);
		expect(h.actionRingOff).toBe(0);
		// capacity field == buffer.byteLength
		expect(h.capacity).toBe(store.buffer.byteLength);
	});

	it("layout descriptor round-trips for a multi-archetype store", () => {
		const store = createColumnStore(SPEC_MULTI);
		const h = readStoreHeader(store.view);

		const descs = readLayoutDescriptorRegion(
			store.view,
			h.layoutDescriptorOff,
			h.archetypeCount
		);
		expect(descs.length).toBe(SPEC_MULTI.length);
		for (let i = 0; i < SPEC_MULTI.length; i++) {
			expect(descs[i].archetypeId).toBe(SPEC_MULTI[i].archetypeId);
			expect(descs[i].rowCapacity).toBe(SPEC_MULTI[i].rowCapacity);
			expect(descs[i].columns.length).toBe(SPEC_MULTI[i].columns.length);
		}
	});

	it("column views land at the byte offsets the descriptor records", () => {
		const store = createColumnStore([SPEC_SINGLE]);
		const arch = store.archetypes.get(SPEC_SINGLE.archetypeId);
		expect(arch).toBeDefined();
		if (!arch) return; // type narrow

		// Each ColumnView's byte_off matches the descriptor; writing through
		// the view at index i lands at byte_off + i*stride. Inspect via the
		// DataView to catch any view/descriptor offset mismatch.
		const u32View = arch.columns.get(columnKey(2, 0));
		expect(u32View).toBeDefined();
		if (!u32View) return;
		expect(u32View.typeTag).toBe(TYPE_TAG.u32);
		expect(u32View.stride).toBe(4);
		// Stride alignment: byte_off must be a multiple of 4 for a u32 view
		// (TypedArray constructor throws on misalignment; this catches it
		// even if the SAB allocation pads accidentally).
		expect(u32View.byteOff % 4).toBe(0);

		// Mutating through the view shows up in raw bytes.
		const arr = u32View.view as Uint32Array;
		arr[0] = 0xdead_beef;
		arr[5] = 0x1234_5678;
		expect(store.view.getUint32(u32View.byteOff, true)).toBe(0xdead_beef);
		expect(store.view.getUint32(u32View.byteOff + 5 * 4, true)).toBe(0x1234_5678);
	});

	it("columns of different types do not overlap", () => {
		const store = createColumnStore([SPEC_SINGLE]);
		const arch = store.archetypes.get(SPEC_SINGLE.archetypeId);
		if (!arch) {
			expect(arch).toBeDefined();
			return;
		}

		// Fill every column with a distinctive constant pattern, then verify
		// each view reads back its own pattern — proving the byte ranges
		// don't alias. A bug that put u32 and f64 at overlapping offsets
		// would scramble one or the other.
		const u8 = arch.columns.get(columnKey(1, 0))!.view as Uint8Array;
		const u32 = arch.columns.get(columnKey(2, 0))!.view as Uint32Array;
		const f64 = arch.columns.get(columnKey(2, 1))!.view as Float64Array;
		u8.fill(0xab);
		u32.fill(0xcafebabe);
		f64.fill(Math.PI);

		// Verify no cross-corruption.
		for (let i = 0; i < u8.length; i++) expect(u8[i]).toBe(0xab);
		for (let i = 0; i < u32.length; i++) expect(u32[i]).toBe(0xcafebabe);
		for (let i = 0; i < f64.length; i++) expect(f64[i]).toBe(Math.PI);
	});

	it("f64 columns get 8-byte alignment", () => {
		// f64's TypedArray ctor throws on a non-8-aligned byte offset. This
		// pins that the alignment math in `planLayout` does what it claims.
		const spec: ArchetypeSpec = {
			archetypeId: 1,
			componentMask: [0b11, 0, 0, 0],
			rowCapacity: 2,
			columns: [
				// Trigger a non-8-aligned cursor by putting a single u8
				// column first; if `alignUp` is wrong, the f64 ctor throws
				// before we even reach an assertion.
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.u8 },
				{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }
			]
		};
		const store = createColumnStore([spec]);
		const arch = store.archetypes.get(1)!;
		const f64Col = arch.columns.get(columnKey(2, 0))!;
		expect(f64Col.byteOff % 8).toBe(0);
	});

	it("column_count in views matches the original spec ordering", () => {
		const store = createColumnStore(SPEC_MULTI);
		for (const spec of SPEC_MULTI) {
			const arch = store.archetypes.get(spec.archetypeId)!;
			expect(arch.columnsInOrder.length).toBe(spec.columns.length);
			for (let j = 0; j < spec.columns.length; j++) {
				expect(arch.columnsInOrder[j].componentId).toBe(spec.columns[j].componentId);
				expect(arch.columnsInOrder[j].fieldId).toBe(spec.columns[j].fieldId);
				expect(arch.columnsInOrder[j].typeTag).toBe(spec.columns[j].typeTag);
			}
		}
	});

	it("SAB is exactly the size the header reports", () => {
		// Useful invariant for snapshot/restore (#171 §6.1.6) — header.capacity
		// is the authoritative size and `Store.snapshot()` will return a
		// Uint8Array view of that many bytes. If the SAB and the header
		// disagree, snapshot/restore truncates or overruns.
		const store = createColumnStore(SPEC_MULTI);
		expect(store.header.capacity).toBe(store.buffer.byteLength);
		expect(readStoreHeader(store.view).capacity).toBe(store.buffer.byteLength);
	});

	it("empty spec list still produces a valid (header-only) SAB", () => {
		// Edge case: a Store with zero archetypes (e.g. before any component
		// is registered). Must produce a SAB that's at least the descriptor
		// region offset, with archetype_count = 0.
		const store = createColumnStore([]);
		expect(isValidSab(store.view)).toBe(true);
		const h = readStoreHeader(store.view);
		expect(h.archetypeCount).toBe(0);
		// Header only — no bindings region by default (#625), descriptor region
		// zero-sized with no archetypes.
		expect(h.capacity).toBe(STORE_HEADER_BYTES);
		expect(store.archetypes.size).toBe(0);
	});

	it("multiple archetypes do not overlap each other", () => {
		const store = createColumnStore(SPEC_MULTI);
		const arch1 = store.archetypes.get(1)!;
		const arch2 = store.archetypes.get(2)!;

		// Write distinct patterns into each archetype's columns.
		const a1I32 = arch1.columns.get(columnKey(10, 0))!.view as Int32Array;
		const a2I32 = arch2.columns.get(columnKey(10, 0))!.view as Int32Array;
		a1I32.fill(0x11_11_11_11);
		a2I32.fill(0x22_22_22_22);

		for (let i = 0; i < a1I32.length; i++) expect(a1I32[i]).toBe(0x11_11_11_11);
		for (let i = 0; i < a2I32.length; i++) expect(a2I32[i]).toBe(0x22_22_22_22);
	});
});

describe("create_column_store — sim-bindings region (opt-in, #625)", () => {
	it("reserves the region before the descriptor when bindings_region_bytes is set", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			bindingsRegionBytes: BINDINGS_BYTES
		});
		const h = readStoreHeader(store.view);
		// Region sits right after the header (no rings here), before the
		// descriptor — a stable offset across grow/extend.
		expect(h.bindingsOff).toBe(STORE_HEADER_BYTES);
		expect(h.layoutDescriptorOff).toBe(STORE_HEADER_BYTES + BINDINGS_BYTES);
	});

	it("places the region after the command ring when both are present", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			commandRingCapacitySlots: 16,
			bindingsRegionBytes: BINDINGS_BYTES
		});
		const h = readStoreHeader(store.view);
		const ringBytes = 16 /* header */ + 16 * 16; /* slots */
		expect(h.commandRingOff).toBe(STORE_HEADER_BYTES);
		expect(h.bindingsOff).toBe(STORE_HEADER_BYTES + ringBytes);
		expect(h.layoutDescriptorOff).toBe(STORE_HEADER_BYTES + ringBytes + BINDINGS_BYTES);
	});

	it("zero-fills the reserved region so a reused buffer can't bleed stale IDs", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			bindingsRegionBytes: BINDINGS_BYTES
		});
		const h = readStoreHeader(store.view);
		const region = new Uint8Array(store.buffer, h.bindingsOff, BINDINGS_BYTES);
		expect(region.every((b) => b === 0)).toBe(true);
	});
});

describe("create_column_store — command ring (plan §7.5, #243 PR 4A)", () => {
	it("command_ring_off is 0 when option is omitted (legacy layout)", () => {
		const store = createColumnStore([SPEC_SINGLE]);
		const h = readStoreHeader(store.view);
		expect(h.commandRingOff).toBe(0);
		// Descriptor region sits right after the header; no command ring, no
		// bindings region (opt-in, #625).
		expect(h.layoutDescriptorOff).toBe(STORE_HEADER_BYTES);
	});

	it("command_ring_off is set when capacity_slots is provided", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			commandRingCapacitySlots: 16
		});
		const h = readStoreHeader(store.view);
		expect(h.commandRingOff).toBe(STORE_HEADER_BYTES);
		// Descriptor region pushed past the ring. Ring sits between header and
		// the (absent-by-default) bindings region, so its offset is unchanged.
		const ringBytes = 16 /* header */ + 16 * 16; /* slots */
		expect(h.layoutDescriptorOff).toBe(STORE_HEADER_BYTES + ringBytes);
	});

	it("ring header is initialised (write_head=0, read_head=0, capacity set)", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			commandRingCapacitySlots: 32
		});
		const h = readStoreHeader(store.view);
		const ringOff = h.commandRingOff;
		expect(store.view.getUint32(ringOff, true)).toBe(0); // write_head
		expect(store.view.getUint32(ringOff + 4, true)).toBe(0); // read_head
		expect(store.view.getUint32(ringOff + 8, true)).toBe(32); // capacity_slots
		expect(store.view.getUint32(ringOff + 12, true)).toBe(0); // overflow_flag
	});

	it("column byte_offs land past the ring + descriptor region", () => {
		const store = createColumnStore([SPEC_SINGLE], undefined, {
			commandRingCapacitySlots: 16
		});
		const arch = store.archetypes.get(7)!;
		for (const col of arch.columnsInOrder) {
			expect(col.byteOff).toBeGreaterThanOrEqual(
				readStoreHeader(store.view).layoutDescriptorOff
			);
		}
	});

	it("non-power-of-two ring capacity propagates the validation error", () => {
		expect(() =>
			createColumnStore([SPEC_SINGLE], undefined, { commandRingCapacitySlots: 100 })
		).toThrow();
	});
});

describe("align_up — 2³¹ overflow guard (#382)", () => {
	it("rounds up correctly for in-range offsets", () => {
		expect(alignUp(0, 8)).toBe(0);
		expect(alignUp(1, 8)).toBe(8);
		expect(alignUp(8, 8)).toBe(8);
		expect(alignUp(9, 8)).toBe(16);
		expect(alignUp(13, 4)).toBe(16);
		expect(alignUp(100, 1)).toBe(100);
	});

	it("accepts offsets right up to the ceiling without wrapping negative", () => {
		// The largest input that still rounds to a value < 2³¹. The unguarded
		// bitwise math would already be fine here; this pins that the guard
		// does NOT fire one step too early.
		const off = STORE_MAX_BYTE_OFFSET - 8;
		const aligned = alignUp(off, 8);
		expect(aligned).toBe(off);
		expect(aligned).toBeGreaterThan(0); // not wrapped negative
	});

	it("throws StoreLayoutOverflowError instead of wrapping past 2³¹", () => {
		// Before the fix, `alignUp(2³¹, 8)` returned -2147483648 (signed-32
		// wrap) and that negative offset reached `new Uint8Array(buffer, off, …)`.
		expect(() => alignUp(STORE_MAX_BYTE_OFFSET, 8)).toThrow(StoreLayoutOverflowError);
		// And the boundary just below, where rounding up would cross 2³¹.
		expect(() => alignUp(STORE_MAX_BYTE_OFFSET - 7, 8)).toThrow(StoreLayoutOverflowError);
	});

	it("never returns a negative or misaligned offset (property sweep)", () => {
		for (const align of [1, 2, 4, 8]) {
			for (const off of [0, 1, 7, 255, 1 << 20, STORE_MAX_BYTE_OFFSET - align]) {
				const aligned = alignUp(off, align);
				expect(aligned).toBeGreaterThanOrEqual(off);
				expect(aligned % align).toBe(0);
				expect(aligned).toBeLessThan(STORE_MAX_BYTE_OFFSET);
			}
		}
	});
});

describe("plan_layout — 2³¹ overflow guard (#382)", () => {
	// `_planLayout` only computes byte offsets; it never allocates, so a spec
	// whose columns span >2 GiB can be exercised cheaply (no 2 GiB SAB).
	const over2gibSpec: ArchetypeSpec = {
		archetypeId: 1,
		componentMask: [0b1, 0, 0, 0],
		// 2²⁸ rows × 8 B (f64) = exactly 2³¹ B of column data → final cursor
		// lands past the ceiling.
		rowCapacity: 2 ** 28,
		columns: [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.f64 }]
	};

	it("throws StoreLayoutOverflowError when a column region crosses 2³¹", () => {
		expect(() => _planLayout([over2gibSpec], 0)).toThrow(StoreLayoutOverflowError);
	});

	it("does not emit a negative byte_off (the pre-fix symptom)", () => {
		// Pinned as the inverse of the bug: rather than returning descriptors
		// with a negative `byte_off`, the layout step now fails loud.
		let descriptors: ReturnType<typeof _planLayout>["descriptors"] | undefined;
		try {
			descriptors = _planLayout([over2gibSpec], 0).descriptors;
		} catch (e) {
			expect(e).toBeInstanceOf(StoreLayoutOverflowError);
		}
		expect(descriptors).toBeUndefined();
	});

	it("still lays out a sub-ceiling spec correctly", () => {
		const { totalBytes, descriptors } = _planLayout(
			[
				{
					archetypeId: 1,
					componentMask: [0b1, 0, 0, 0],
					rowCapacity: 1024,
					columns: [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.f64 }]
				}
			],
			0
		);
		expect(totalBytes).toBeLessThan(STORE_MAX_BYTE_OFFSET);
		expect(descriptors[0].columns[0].byteOff % 8).toBe(0);
	});
});
