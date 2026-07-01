import { describe, expect, it } from "vitest";
import {
	ACTION_RING_DEFAULT_CAPACITY_SLOTS,
	ACTION_RING_HEADER_BYTES,
	ACTION_RING_HEADER_OFFSETS,
	ACTION_RING_MAX_PAYLOAD_BYTES,
	ACTION_RING_SLOT_BYTES,
	actionRingBytes,
	actionRingCapacitySlots,
	actionRingOverflow,
	clearActionRingOverflow,
	drainActionRing,
	initActionRing,
	pendingActionCount,
	popAction,
	pushAction,
	ActionRingError
} from "../action_ring";

const RING_OFF = 0;

function makeRing(capacity: number = 8): { view: DataView; off: number } {
	const buffer = new ArrayBuffer(actionRingBytes(capacity) + 64);
	const view = new DataView(buffer);
	initActionRing(view, RING_OFF, capacity);
	return { view, off: RING_OFF };
}

describe("action_ring header", () => {
	it("init zeroes heads and overflow, writes capacity", () => {
		const { view, off } = makeRing(16);
		expect(view.getUint32(off + ACTION_RING_HEADER_OFFSETS.write_head, true)).toBe(0);
		expect(view.getUint32(off + ACTION_RING_HEADER_OFFSETS.read_head, true)).toBe(0);
		expect(actionRingCapacitySlots(view, off)).toBe(16);
		expect(actionRingOverflow(view, off)).toBe(false);
	});

	it("rejects non-power-of-two capacity", () => {
		const buffer = new ArrayBuffer(1024);
		const view = new DataView(buffer);
		expect(() => initActionRing(view, RING_OFF, 7)).toThrow(ActionRingError);
		expect(() => initActionRing(view, RING_OFF, 0)).toThrow(ActionRingError);
	});

	it("action_ring_bytes accounts for header + slots", () => {
		expect(actionRingBytes(8)).toBe(ACTION_RING_HEADER_BYTES + 8 * ACTION_RING_SLOT_BYTES);
	});
});

describe("push_action / pop_action round-trip", () => {
	it("pops in FIFO order with correct length and bytes", () => {
		const { view, off } = makeRing(4);
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([10, 20, 30, 40, 50]);
		const c = new Uint8Array([99]);
		expect(pushAction(view, off, a)).toBe(true);
		expect(pushAction(view, off, b)).toBe(true);
		expect(pushAction(view, off, c)).toBe(true);
		expect(pendingActionCount(view, off)).toBe(3);

		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		expect(popAction(view, off, out)).toBe(3);
		expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 3]);
		expect(popAction(view, off, out)).toBe(5);
		expect(Array.from(out.subarray(0, 5))).toEqual([10, 20, 30, 40, 50]);
		expect(popAction(view, off, out)).toBe(1);
		expect(out[0]).toBe(99);
		expect(popAction(view, off, out)).toBe(0); // empty
	});

	it("returns 0 immediately on an empty ring", () => {
		const { view, off } = makeRing();
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		expect(popAction(view, off, out)).toBe(0);
	});

	it("rejects oversized push", () => {
		const { view, off } = makeRing();
		const tooBig = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES + 1);
		expect(() => pushAction(view, off, tooBig)).toThrow(ActionRingError);
	});

	it("rejects undersized pop buffer", () => {
		const { view, off } = makeRing();
		const tooSmall = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES - 1);
		expect(() => popAction(view, off, tooSmall)).toThrow(ActionRingError);
	});
});

describe("overflow", () => {
	it("sets overflow and returns false when full", () => {
		const { view, off } = makeRing(4);
		const payload = new Uint8Array([1]);
		for (let i = 0; i < 4; i++) expect(pushAction(view, off, payload)).toBe(true);
		expect(actionRingOverflow(view, off)).toBe(false);
		expect(pushAction(view, off, payload)).toBe(false);
		expect(actionRingOverflow(view, off)).toBe(true);
	});

	it("clear_action_ring_overflow resets the flag without touching heads", () => {
		const { view, off } = makeRing(2);
		pushAction(view, off, new Uint8Array([1]));
		pushAction(view, off, new Uint8Array([2]));
		pushAction(view, off, new Uint8Array([3])); // overflow
		expect(actionRingOverflow(view, off)).toBe(true);
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		expect(popAction(view, off, out)).toBe(1); // FIFO: first was [1]
		clearActionRingOverflow(view, off);
		expect(actionRingOverflow(view, off)).toBe(false);
	});

	it("after draining, ring accepts new pushes again", () => {
		const { view, off } = makeRing(2);
		pushAction(view, off, new Uint8Array([1]));
		pushAction(view, off, new Uint8Array([2]));
		expect(pushAction(view, off, new Uint8Array([3]))).toBe(false);
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		popAction(view, off, out);
		popAction(view, off, out);
		expect(pushAction(view, off, new Uint8Array([4]))).toBe(true);
	});
});

describe("drain_action_ring", () => {
	it("invokes handler per entry in FIFO order", () => {
		const { view, off } = makeRing();
		pushAction(view, off, new Uint8Array([1, 2]));
		pushAction(view, off, new Uint8Array([3, 4, 5]));
		pushAction(view, off, new Uint8Array([6]));
		const seen: number[][] = [];
		const count = drainActionRing(view, off, (p) => seen.push(Array.from(p)));
		expect(count).toBe(3);
		expect(seen).toEqual([[1, 2], [3, 4, 5], [6]]);
		expect(pendingActionCount(view, off)).toBe(0);
	});

	it("handler gets a fresh buffer per call (no aliasing across pops)", () => {
		const { view, off } = makeRing();
		pushAction(view, off, new Uint8Array([1, 2, 3]));
		pushAction(view, off, new Uint8Array([10, 20]));
		const held: Uint8Array[] = [];
		drainActionRing(view, off, (p) => held.push(p));
		// Drain a second time after held captured references; held should
		// not have been overwritten.
		expect(Array.from(held[0])).toEqual([1, 2, 3]);
		expect(Array.from(held[1])).toEqual([10, 20]);
	});

	it("returns 0 on an empty ring without invoking handler", () => {
		const { view, off } = makeRing();
		let calls = 0;
		const count = drainActionRing(view, off, () => calls++);
		expect(count).toBe(0);
		expect(calls).toBe(0);
	});
});

describe("zero-length entry (#430)", () => {
	// Manually enqueue a slot whose length prefix is 0, bypassing
	// `pushAction` (which now rejects empty payloads). This simulates the
	// ABI-skew case the issue guards against: a slot present in the ring whose
	// length collides with `popAction`'s empty-ring sentinel.
	function enqueueRawSlot(view: DataView, off: number, len: number, bytes: number[]): void {
		const capacity = actionRingCapacitySlots(view, off);
		const heads = new Int32Array(view.buffer, view.byteOffset + off, 4);
		const writeHead = Atomics.load(heads, ACTION_RING_HEADER_OFFSETS.write_head / 4) >>> 0;
		const slotIdx = writeHead & (capacity - 1);
		const slotOff = off + ACTION_RING_HEADER_BYTES + slotIdx * ACTION_RING_SLOT_BYTES;
		view.setUint8(slotOff, len);
		for (let i = 0; i < bytes.length; i++) view.setUint8(slotOff + 1 + i, bytes[i]);
		Atomics.store(heads, ACTION_RING_HEADER_OFFSETS.write_head / 4, (writeHead + 1) >>> 0);
	}

	it("push_action rejects an empty payload", () => {
		const { view, off } = makeRing();
		expect(() => pushAction(view, off, new Uint8Array(0))).toThrow(ActionRingError);
		expect(pendingActionCount(view, off)).toBe(0);
	});

	it("drain delivers a zero-length entry and does not stall entries behind it", () => {
		const { view, off } = makeRing();
		// [0-byte entry, then a normal entry] — pre-fix the drain terminated on
		// the zero-length entry's len===0 return, dropping its handler and
		// stranding [7, 8] for a tick.
		enqueueRawSlot(view, off, 0, []);
		pushAction(view, off, new Uint8Array([7, 8]));
		expect(pendingActionCount(view, off)).toBe(2);

		const seen: number[][] = [];
		const count = drainActionRing(view, off, (p) => seen.push(Array.from(p)));
		expect(count).toBe(2);
		expect(seen).toEqual([[], [7, 8]]);
		expect(pendingActionCount(view, off)).toBe(0);
	});

	it("drain consumes a zero-length entry sitting alone in the ring", () => {
		const { view, off } = makeRing();
		enqueueRawSlot(view, off, 0, []);
		const seen: number[][] = [];
		const count = drainActionRing(view, off, (p) => seen.push(Array.from(p)));
		expect(count).toBe(1);
		expect(seen).toEqual([[]]);
		expect(pendingActionCount(view, off)).toBe(0);
	});
});

describe("Atomics head ordering (#374)", () => {
	// The head region is the cross-thread synchronization edge between the
	// main-thread producer and the sim-worker consumer. These assert the
	// observable contract: heads live at the documented Int32Array indices
	// and are advanced via Atomics, so a consumer reading them with
	// `Atomics.load` sees the same monotonic counters the ring tracks.
	function heads(view: DataView, off: number): Int32Array {
		return new Int32Array(view.buffer, view.byteOffset + off, 4);
	}

	it("push advances write_head via an Atomics-readable counter", () => {
		const { view, off } = makeRing(4);
		const h = heads(view, off);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.write_head / 4)).toBe(0);
		pushAction(view, off, new Uint8Array([1, 2]));
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.write_head / 4)).toBe(1);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.read_head / 4)).toBe(0);
	});

	it("pop advances read_head via an Atomics-readable counter", () => {
		const { view, off } = makeRing(4);
		const h = heads(view, off);
		pushAction(view, off, new Uint8Array([7]));
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		popAction(view, off, out);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.read_head / 4)).toBe(1);
	});

	it("capacity is published at the capacity index", () => {
		const { view, off } = makeRing(8);
		const h = heads(view, off);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.capacity_slots / 4)).toBe(8);
	});

	it("overflow flag round-trips through the overflow index", () => {
		const { view, off } = makeRing(2);
		const h = heads(view, off);
		pushAction(view, off, new Uint8Array([1]));
		pushAction(view, off, new Uint8Array([2]));
		expect(pushAction(view, off, new Uint8Array([3]))).toBe(false);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.overflow_flag / 4)).toBe(1);
		clearActionRingOverflow(view, off);
		expect(Atomics.load(h, ACTION_RING_HEADER_OFFSETS.overflow_flag / 4)).toBe(0);
	});

	it("works at a non-zero, 4-aligned ring offset", () => {
		const off = 32;
		const buffer = new ArrayBuffer(off + actionRingBytes(4));
		const view = new DataView(buffer);
		initActionRing(view, off, 4);
		expect(pushAction(view, off, new Uint8Array([5, 6, 7]))).toBe(true);
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		expect(popAction(view, off, out)).toBe(3);
		expect(Array.from(out.subarray(0, 3))).toEqual([5, 6, 7]);
	});

	it("rejects a misaligned ring offset (Atomics needs 4-byte alignment)", () => {
		const buffer = new ArrayBuffer(actionRingBytes(4) + 8);
		const view = new DataView(buffer);
		expect(() => initActionRing(view, 2, 4)).toThrow(ActionRingError);
	});

	it("round-trips correctly over a SharedArrayBuffer backing", () => {
		// The production backing is a SharedArrayBuffer; confirm Atomics on
		// the head region behave identically to the ArrayBuffer path.
		const buffer = new SharedArrayBuffer(actionRingBytes(4));
		const view = new DataView(buffer);
		initActionRing(view, 0, 4);
		expect(pushAction(view, 0, new Uint8Array([9, 8]))).toBe(true);
		const out = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
		expect(popAction(view, 0, out)).toBe(2);
		expect(Array.from(out.subarray(0, 2))).toEqual([9, 8]);
	});
});

describe("default capacity", () => {
	it("is a positive power of two", () => {
		expect(ACTION_RING_DEFAULT_CAPACITY_SLOTS).toBeGreaterThan(0);
		expect(
			(ACTION_RING_DEFAULT_CAPACITY_SLOTS & (ACTION_RING_DEFAULT_CAPACITY_SLOTS - 1)) === 0
		).toBe(true);
	});
});
