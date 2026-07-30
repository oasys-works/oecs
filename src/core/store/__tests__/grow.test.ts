import { describe, expect, it } from "vitest";

import {
	archetypeDescriptorBytes,
	columnKey,
	createColumnStore,
	readStoreHeader,
	TYPE_TAG,
	type ArchetypeSpec
} from "..";
import { growableSabAllocator, wasmMemoryAllocator } from "../allocator";
import { extendColumnStore } from "../extend";
import { growColumnStore, StoreGrowError } from "../grow";
import type { ColumnStoreInternal } from "../column_store";

function spec(
	archetypeId: number,
	rowCapacity: number,
	cols: { componentId: number; fieldId: number; typeTag: number }[],
	maskLo = 0,
	maskHi = 0
): ArchetypeSpec {
	return {
		archetypeId,
		componentMask: [maskLo, maskHi, 0, 0],
		rowCapacity,
		columns: cols.map((c) => ({
			componentId: c.componentId,
			fieldId: c.fieldId,
			typeTag: c.typeTag as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
		}))
	};
}

describe("grow_column_store", () => {
	it("bumps view_stamp by 1 in the new SAB header", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const {
			store: next,
			oldViewStamp,
			newViewStamp
		} = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});

		expect(oldViewStamp).toBe(0);
		expect(newViewStamp).toBe(1);
		expect(readStoreHeader(next.view).viewStamp).toBe(1);
		// The realloc path patches the returned header so its cached
		// `view_stamp` matches the SAB bytes — consistent with the in-place
		// path, no stale 0.
		expect(next.header.viewStamp).toBe(1);
		// `capacity` on the cached header must likewise match the SAB.
		expect(next.header.capacity).toBe(readStoreHeader(next.view).capacity);
	});

	it("preserves view_stamp on subsequent grows (1 → 2)", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const { store: gen1 } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		const { store: gen2, newViewStamp } = growColumnStore(gen1, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 0 }]
		});

		expect(newViewStamp).toBe(2);
		expect(readStoreHeader(gen2.view).viewStamp).toBe(2);
	});

	it("preserves view_stamp wrap-around at u32 max", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		// Manually push the stamp to UINT32_MAX so the next grow wraps to 0.
		const STORE_HEADER_VIEW_STAMP_OFF = 8;
		old.view.setUint32(STORE_HEADER_VIEW_STAMP_OFF, 0xff_ff_ff_ff, true);

		const { store: next, newViewStamp } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		expect(newViewStamp).toBe(0);
		expect(readStoreHeader(next.view).viewStamp).toBe(0);
	});

	it("grows row_capacity in the new store's archetype views", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.f32 }])
		]);
		expect(old.archetypes.get(0)!.rowCapacity).toBe(4);

		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 0 }]
		});
		expect(next.archetypes.get(0)!.rowCapacity).toBe(16);
		const newView = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view;
		expect(newView.length).toBe(16);
	});

	it("copies live rows from old to new column views", () => {
		const old = createColumnStore([
			spec(0, 4, [
				{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 },
				{ componentId: 1, fieldId: 1, typeTag: TYPE_TAG.f64 }
			])
		]);

		const oldX = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const oldY = old.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;
		oldX[0] = 11;
		oldX[1] = 22;
		oldX[2] = 33;
		oldY[0] = 1.5;
		oldY[1] = 2.5;
		oldY[2] = 3.5;

		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 3 }]
		});
		const newX = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		const newY = next.archetypes.get(0)!.columns.get(columnKey(1, 1))!.view as Float64Array;

		expect(Array.from(newX.subarray(0, 3))).toEqual([11, 22, 33]);
		expect(Array.from(newY.subarray(0, 3))).toEqual([1.5, 2.5, 3.5]);
		// Untouched tail is zero-initialised by SAB construction.
		expect(newX[3]).toBe(0);
		expect(newX[7]).toBe(0);
	});

	it("carries forward archetypes not named in the plan at their old capacity", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }]),
			spec(1, 8, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);

		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 0 }]
		});

		// Archetype 0 grew; archetype 1 carried forward unchanged.
		expect(next.archetypes.get(0)!.rowCapacity).toBe(16);
		expect(next.archetypes.get(1)!.rowCapacity).toBe(8);
	});

	it("preserves component_mask bits across grow", () => {
		const old = createColumnStore([
			spec(
				0,
				4,
				[{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }],
				0xdead_beef,
				0xcafe_f00d
			)
		]);
		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		const arch = next.archetypes.get(0)!;
		expect(arch.componentMask[0]).toBe(0xdead_beef);
		expect(arch.componentMask[1]).toBe(0xcafe_f00d);
	});

	it("preserves column order across grow", () => {
		const old = createColumnStore([
			spec(0, 4, [
				{ componentId: 7, fieldId: 0, typeTag: TYPE_TAG.u8 },
				{ componentId: 3, fieldId: 0, typeTag: TYPE_TAG.f32 },
				{ componentId: 7, fieldId: 1, typeTag: TYPE_TAG.i32 }
			])
		]);
		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }]
		});
		const cols = next.archetypes.get(0)!.columnsInOrder;
		expect(cols.map((c) => `${c.componentId}:${c.fieldId}`)).toEqual(["7:0", "3:0", "7:1"]);
	});

	it("allocates a new SAB (old SAB is untouched)", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		const oldX = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		oldX[0] = 42;

		const { store: next } = growColumnStore(old, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 1 }]
		});

		// Different SAB instance
		expect(next.buffer).not.toBe(old.buffer);
		// Mutating the new SAB does NOT affect the old one
		const newX = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		newX[0] = 99;
		expect(oldX[0]).toBe(42);
	});

	it("rejects shrink", () => {
		const old = createColumnStore([
			spec(0, 8, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			growColumnStore(old, {
				archetypes: [{ archetypeId: 0, newRowCapacity: 4, rowCount: 0 }]
			})
		).toThrow(StoreGrowError);
	});

	it("rejects new_row_capacity smaller than row_count", () => {
		const old = createColumnStore([
			spec(0, 8, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			growColumnStore(old, {
				archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 10 }]
			})
		).toThrow(StoreGrowError);
	});

	it("rejects row_count greater than old row_capacity", () => {
		const old = createColumnStore([
			spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])
		]);
		expect(() =>
			growColumnStore(old, {
				archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 8 }]
			})
		).toThrow(StoreGrowError);
	});
});

describe("grow_column_store in-place fast path (growable allocator)", () => {
	// Two-archetype world built on a growable (isInPlace) allocator. Growing
	// archetype 0 must NOT relayout archetype 1 — that whole-store relayout is
	// exactly the O(all-archetypes) cost that tanked frame_loop (0.29x vs oecs).
	function twoArchWorld(alloc: ReturnType<typeof growableSabAllocator>) {
		return createColumnStore(
			[
				spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }]),
				spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }])
			],
			alloc
		);
	}

	it("signals views_preserved and names only the grown archetype", () => {
		const alloc = growableSabAllocator();
		const old = twoArchWorld(alloc);
		const res = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 16, rowCount: 0 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
				]
			},
			alloc
		);
		expect(res.viewsPreserved).toBe(true);
		expect([...res.grownArchetypeIds]).toEqual([0]);
		expect(res.store.archetypes.get(0)!.rowCapacity).toBe(16);
		expect(res.store.archetypes.get(1)!.rowCapacity).toBe(4);
	});

	it("does NOT move non-grown archetypes' column byte_offs (regression guard)", () => {
		const alloc = growableSabAllocator();
		const old = twoArchWorld(alloc);
		const before = old.archetypes.get(1)!.columns.get(columnKey(2, 0))!.byteOff;
		const { store: next } = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 64, rowCount: 0 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
				]
			},
			alloc
		);
		// Whole-store realloc would have repacked archetype 1 to a new offset;
		// the in-place path leaves it exactly where it was.
		expect(next.archetypes.get(1)!.columns.get(columnKey(2, 0))!.byteOff).toBe(before);
	});

	it("preserves grown archetype live rows at the new capacity", () => {
		const alloc = growableSabAllocator();
		const old = twoArchWorld(alloc);
		const x = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		x[0] = 11;
		x[1] = 22;
		x[2] = 33;
		const { store: next } = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 16, rowCount: 3 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
				]
			},
			alloc
		);
		const nx = next.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		expect(nx.length).toBe(16);
		expect(Array.from(nx.subarray(0, 3))).toEqual([11, 22, 33]);
		expect(nx[3]).toBe(0);
	});

	it("preserves non-grown archetype data through the grow", () => {
		const alloc = growableSabAllocator();
		const old = twoArchWorld(alloc);
		const y = old.archetypes.get(1)!.columns.get(columnKey(2, 0))!.view as Float64Array;
		y[0] = 7.5;
		y[1] = 8.5;
		const { store: next } = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 64, rowCount: 0 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 2 }
				]
			},
			alloc
		);
		const ny = next.archetypes.get(1)!.columns.get(columnKey(2, 0))!.view as Float64Array;
		expect(Array.from(ny.subarray(0, 2))).toEqual([7.5, 8.5]);
	});

	it("bumps view_stamp and updates capacity on the in-place path", () => {
		const alloc = growableSabAllocator();
		const old = twoArchWorld(alloc);
		const { store: next, newViewStamp } = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 16, rowCount: 0 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
				]
			},
			alloc
		);
		expect(newViewStamp).toBe(1);
		expect(readStoreHeader(next.view).viewStamp).toBe(1);
	});

	it("takes the in-place branch under wasm_memory_allocator and preserves data across the new SAB ref", () => {
		// wasmMemoryAllocator returns a NEW SAB ref after memory.grow() — the
		// only path that exercises the `bufferRefChanged` branch (growable
		// returns the same ref). Verify live data survives across the ref swap.
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 64, shared: true });
		const alloc = wasmMemoryAllocator(memory);
		const old = createColumnStore(
			[
				spec(0, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }]),
				spec(1, 4, [{ componentId: 2, fieldId: 0, typeTag: TYPE_TAG.f64 }])
			],
			alloc
		);
		const x = old.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		x[0] = 123;
		x[1] = 456;
		const arch1Off = old.archetypes.get(1)!.columns.get(columnKey(2, 0))!.byteOff;

		// Grow archetype 0 far enough to force memory.grow() (a new SAB ref).
		const res = growColumnStore(
			old,
			{
				archetypes: [
					{ archetypeId: 0, newRowCapacity: 4096, rowCount: 2 },
					{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
				]
			},
			alloc
		);
		expect(res.viewsPreserved).toBe(true);
		expect([...res.grownArchetypeIds]).toEqual([0]);
		const nx = res.store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
		expect(nx.length).toBe(4096);
		expect(Array.from(nx.subarray(0, 2))).toEqual([123, 456]);
		// Non-grown archetype's byte_off unchanged (no whole-store relayout).
		expect(res.store.archetypes.get(1)!.columns.get(columnKey(2, 0))!.byteOff).toBe(arch1Off);
	});

	it("survives repeated in-place grows (doubling ramp)", () => {
		const alloc = growableSabAllocator();
		let store = twoArchWorld(alloc);
		// Seed archetype 0 with data we keep re-verifying as it grows.
		(store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array)[0] = 99;
		let cap = 4;
		let rows = 1;
		for (let i = 0; i < 6; i++) {
			cap *= 2;
			const res = growColumnStore(
				store,
				{
					archetypes: [
						{ archetypeId: 0, newRowCapacity: cap, rowCount: rows },
						{ archetypeId: 1, newRowCapacity: 4, rowCount: 0 }
					]
				},
				alloc
			);
			expect(res.viewsPreserved).toBe(true);
			store = res.store;
			const v = store.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view as Int32Array;
			expect(v.length).toBe(cap);
			expect(v[0]).toBe(99);
		}
	});
});

describe("grow_column_store — descriptor headroom policy survives", () => {
	it("an in-place grow carries the reserved-descriptor-bytes policy forward", () => {
		const alloc = growableSabAllocator(1024 * 1024);
		const reserved = archetypeDescriptorBytes(1) * 2;
		const seeded = createColumnStore(
			[spec(0, 4, [{ componentId: 0, fieldId: 0, typeTag: TYPE_TAG.i32 }])],
			alloc,
			{ reservedDescriptorBytes: reserved }
		);
		// Add an archetype in-place, then grow archetype 0's capacity in-place.
		const extended = extendColumnStore(
			seeded,
			{ newArchetypes: [spec(1, 4, [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.i32 }])] },
			alloc
		);
		const grown = growColumnStore(
			extended.store,
			{ archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 0 }] },
			alloc
		);
		expect(grown.viewsPreserved).toBe(true); // in-place grow

		// The headroom policy must survive the in-place grow so a LATER extend
		// realloc still re-reserves it. Without the carry, an extend→grow→extend
		// sequence would drop to zero slack on the final realloc.
		expect((grown.store as ColumnStoreInternal)._reservedDescriptorBytes).toBe(reserved);
	});
});
