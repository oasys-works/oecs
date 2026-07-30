import { describe, expect, it } from "vitest";

import { BufferBackedColumn, StoreColumnOverflowError } from "../buffer_backed_column";

function makeColumn<T extends Int32Array | Float32Array | Uint8Array>(
	ctor: new (buffer: SharedArrayBuffer, off: number, len: number) => T,
	capacity: number,
	stride: number
): { buffer: SharedArrayBuffer; col: BufferBackedColumn<T> } {
	const buffer = new SharedArrayBuffer(capacity * stride);
	const view = new ctor(buffer, 0, capacity);
	return { buffer, col: new BufferBackedColumn(view) };
}

describe("BufferBackedColumn", () => {
	it("starts empty with the view's length as capacity", () => {
		const { col } = makeColumn(Int32Array, 8, 4);
		expect(col.length).toBe(0);
		expect(col.capacity).toBe(8);
	});

	it("push appends and increments length", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		col.push(10);
		col.push(20);
		col.push(30);
		expect(col.length).toBe(3);
		expect(col.get(0)).toBe(10);
		expect(col.get(1)).toBe(20);
		expect(col.get(2)).toBe(30);
	});

	it("pop decrements length and returns the last value", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		col.push(7);
		col.push(11);
		expect(col.pop()).toBe(11);
		expect(col.length).toBe(1);
		expect(col.pop()).toBe(7);
		expect(col.length).toBe(0);
	});

	it("swap_remove writes the last element into the slot and returns the removed value", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		col.push(1);
		col.push(2);
		col.push(3);
		col.push(4);
		expect(col.swapRemove(1)).toBe(2);
		expect(col.length).toBe(3);
		expect(col.get(0)).toBe(1);
		expect(col.get(1)).toBe(4);
		expect(col.get(2)).toBe(3);
	});

	it("clear resets length without touching the underlying buffer", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		col.push(42);
		col.push(99);
		col.clear();
		expect(col.length).toBe(0);
		expect(col.buf[0]).toBe(42); // buffer untouched
		expect(col.buf[1]).toBe(99);
	});

	it("set_at writes by index without changing length", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		col.push(0);
		col.push(0);
		col.setAt(1, 77);
		expect(col.length).toBe(2);
		expect(col.get(1)).toBe(77);
	});

	it("view() returns a subarray over valid data only", () => {
		const { col } = makeColumn(Int32Array, 8, 4);
		col.push(5);
		col.push(6);
		col.push(7);
		const v = col.view();
		expect(v.length).toBe(3);
		expect(Array.from(v)).toEqual([5, 6, 7]);
	});

	it("buf returns the original full-capacity view (stable reference)", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		const bufBefore = col.buf;
		col.push(1);
		col.push(2);
		expect(col.buf).toBe(bufBefore);
		expect(col.buf.length).toBe(4);
	});

	it("Symbol.iterator iterates only over valid data", () => {
		const { col } = makeColumn(Int32Array, 8, 4);
		col.push(10);
		col.push(20);
		col.push(30);
		expect([...col]).toEqual([10, 20, 30]);
	});

	it("push at capacity throws StoreColumnOverflowError", () => {
		const { col } = makeColumn(Int32Array, 2, 4);
		col.push(1);
		col.push(2);
		expect(() => col.push(3)).toThrow(StoreColumnOverflowError);
		expect(col.length).toBe(2);
	});

	it("ensure_capacity is a no-op within capacity, throws past it", () => {
		const { col } = makeColumn(Int32Array, 4, 4);
		expect(() => col.ensureCapacity(4)).not.toThrow();
		expect(() => col.ensureCapacity(5)).toThrow(StoreColumnOverflowError);
	});

	it("bulk_append copies a slice and advances length", () => {
		const { col } = makeColumn(Int32Array, 8, 4);
		const src = new Int32Array([100, 200, 300, 400]);
		col.bulkAppend(src, 1, 2);
		expect(col.length).toBe(2);
		expect(col.get(0)).toBe(200);
		expect(col.get(1)).toBe(300);
	});

	it("bulk_append past capacity throws and leaves state unchanged", () => {
		const { col } = makeColumn(Int32Array, 3, 4);
		col.push(1);
		const src = new Int32Array([10, 20, 30]);
		expect(() => col.bulkAppend(src, 0, 3)).toThrow(StoreColumnOverflowError);
		expect(col.length).toBe(1);
		expect(col.get(0)).toBe(1);
	});

	it("bulk_append_zeroes zero-fills and advances length", () => {
		const { col } = makeColumn(Int32Array, 6, 4);
		col.push(7);
		col.bulkAppendZeroes(3);
		expect(col.length).toBe(4);
		expect(col.get(0)).toBe(7);
		expect(col.get(1)).toBe(0);
		expect(col.get(2)).toBe(0);
		expect(col.get(3)).toBe(0);
	});

	it("bulk_append_zeroes past capacity throws", () => {
		const { col } = makeColumn(Int32Array, 2, 4);
		expect(() => col.bulkAppendZeroes(3)).toThrow(StoreColumnOverflowError);
	});

	it("bulk_append_value fills with the value and advances length", () => {
		const { col } = makeColumn(Int32Array, 6, 4);
		col.push(7);
		col.bulkAppendValue(9, 3);
		expect(col.length).toBe(4);
		expect(col.get(0)).toBe(7);
		expect(col.get(1)).toBe(9);
		expect(col.get(2)).toBe(9);
		expect(col.get(3)).toBe(9);
	});

	it("bulk_append_value past capacity throws", () => {
		const { col } = makeColumn(Int32Array, 2, 4);
		expect(() => col.bulkAppendValue(9, 3)).toThrow(StoreColumnOverflowError);
	});

	it("writes are visible through the underlying SAB (shared semantics)", () => {
		const buffer = new SharedArrayBuffer(4 * 4);
		const viewA = new Int32Array(buffer, 0, 4);
		const viewB = new Int32Array(buffer, 0, 4);
		const col = new BufferBackedColumn(viewA);
		col.push(11);
		col.push(22);
		expect(viewB[0]).toBe(11);
		expect(viewB[1]).toBe(22);
	});

	it("works with Float32 views", () => {
		const { col } = makeColumn(Float32Array, 4, 4);
		col.push(1.5);
		col.push(-2.25);
		expect(col.get(0)).toBeCloseTo(1.5);
		expect(col.get(1)).toBeCloseTo(-2.25);
	});

	it("works with Uint8 views", () => {
		const { col } = makeColumn(Uint8Array, 8, 1);
		col.push(255);
		col.push(0);
		col.push(128);
		expect(col.get(0)).toBe(255);
		expect(col.get(1)).toBe(0);
		expect(col.get(2)).toBe(128);
	});
});

describe("BufferBackedColumn parity with GrowableTypedArray", () => {
	it("matches push/swap_remove/pop sequencing", () => {
		const { col } = makeColumn(Int32Array, 8, 4);

		col.push(10);
		col.push(20);
		col.push(30);
		col.push(40);
		col.push(50);

		// swapRemove(1) → [10, 50, 30, 40]
		expect(col.swapRemove(1)).toBe(20);
		expect(Array.from(col.view())).toEqual([10, 50, 30, 40]);

		// pop → [10, 50, 30]
		expect(col.pop()).toBe(40);
		expect(Array.from(col.view())).toEqual([10, 50, 30]);

		// bulkAppend zeroes → [10, 50, 30, 0, 0]
		col.bulkAppendZeroes(2);
		expect(Array.from(col.view())).toEqual([10, 50, 30, 0, 0]);

		// clear leaves underlying buffer intact
		col.clear();
		expect(col.length).toBe(0);
		expect(col.buf[0]).toBe(10);
	});
});
