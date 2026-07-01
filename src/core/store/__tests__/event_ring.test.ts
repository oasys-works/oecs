import { describe, expect, it } from "vitest";

import {
	drainEventRing,
	EVENT_OP_EMPTY,
	EVENT_RING_DEFAULT_CAPACITY_SLOTS,
	EVENT_RING_HEADER_BYTES,
	EVENT_RING_HEADER_OFFSETS,
	EVENT_RING_SLOT_BYTES,
	EventRingError,
	eventRingBytes,
	initEventRing,
	pendingEventCount,
	popEvent,
	pushEvent,
	ringCapacitySlots,
	ringOverflow,
	ringReadHead,
	ringWriteHead
} from "../event_ring";

function freshRing(capacitySlots: number = 8): {
	view: DataView;
	ringOff: number;
} {
	const bytes = eventRingBytes(capacitySlots);
	const buffer = new SharedArrayBuffer(bytes);
	const view = new DataView(buffer);
	initEventRing(view, 0, capacitySlots);
	return { view, ringOff: 0 };
}

function fill(buf: Uint8Array, value: number): Uint8Array {
	for (let i = 0; i < buf.length; i++) buf[i] = (value + i) & 0xff;
	return buf;
}

describe("event_ring — constants and sizing", () => {
	it("header is 16 bytes, slot is 16 bytes (matches command ring)", () => {
		expect(EVENT_RING_HEADER_BYTES).toBe(16);
		expect(EVENT_RING_SLOT_BYTES).toBe(16);
	});

	it("default capacity is 256 slots (4 KiB of slot data)", () => {
		expect(EVENT_RING_DEFAULT_CAPACITY_SLOTS).toBe(256);
		expect(eventRingBytes(EVENT_RING_DEFAULT_CAPACITY_SLOTS)).toBe(16 + 256 * 16);
	});

	it("empty-slot marker is 0; event-def IDs must be > 0", () => {
		expect(EVENT_OP_EMPTY).toBe(0);
	});

	it("header field byte offsets are locked", () => {
		expect(EVENT_RING_HEADER_OFFSETS.write_head).toBe(0);
		expect(EVENT_RING_HEADER_OFFSETS.read_head).toBe(4);
		expect(EVENT_RING_HEADER_OFFSETS.capacity_slots).toBe(8);
		expect(EVENT_RING_HEADER_OFFSETS.overflow_flag).toBe(12);
	});
});

describe("event_ring — init", () => {
	it("zeroes write_head, read_head, overflow; sets capacity", () => {
		const { view, ringOff } = freshRing(16);
		expect(ringWriteHead(view, ringOff)).toBe(0);
		expect(ringReadHead(view, ringOff)).toBe(0);
		expect(ringCapacitySlots(view, ringOff)).toBe(16);
		expect(ringOverflow(view, ringOff)).toBe(false);
	});

	it("rejects non-power-of-two capacity", () => {
		const buffer = new SharedArrayBuffer(1024);
		const view = new DataView(buffer);
		expect(() => initEventRing(view, 0, 3)).toThrow(EventRingError);
		expect(() => initEventRing(view, 0, 7)).toThrow(EventRingError);
		expect(() => initEventRing(view, 0, 100)).toThrow(EventRingError);
		expect(() => initEventRing(view, 0, 0)).toThrow(EventRingError);
	});

	it("accepts powers of two", () => {
		const buffer = new SharedArrayBuffer(1024 * 16);
		const view = new DataView(buffer);
		for (const n of [1, 2, 4, 8, 16, 64, 256]) {
			expect(() => initEventRing(view, 0, n)).not.toThrow();
		}
	});
});

describe("event_ring — SPSC happy path", () => {
	it("push then pop round-trips op_code and payload", () => {
		const { view, ringOff } = freshRing(8);
		const payload = fill(new Uint8Array(15), 42);
		expect(pushEvent(view, ringOff, 1, payload)).toBe(true);
		expect(pendingEventCount(view, ringOff)).toBe(1);

		const out = new Uint8Array(15);
		const op = popEvent(view, ringOff, out);
		expect(op).toBe(1);
		expect(out).toEqual(payload);
		expect(pendingEventCount(view, ringOff)).toBe(0);
	});

	it("pop on empty ring returns EVENT_OP_EMPTY and does not touch out_payload", () => {
		const { view, ringOff } = freshRing(8);
		const out = fill(new Uint8Array(15), 0xab);
		const before = new Uint8Array(out);
		const op = popEvent(view, ringOff, out);
		expect(op).toBe(EVENT_OP_EMPTY);
		expect(out).toEqual(before);
	});

	it("FIFO order across N pushes / N pops", () => {
		const { view, ringOff } = freshRing(8);
		const N = 5;
		for (let i = 0; i < N; i++) {
			const p = fill(new Uint8Array(15), i * 17);
			expect(pushEvent(view, ringOff, 7, p)).toBe(true);
		}
		expect(pendingEventCount(view, ringOff)).toBe(N);
		for (let i = 0; i < N; i++) {
			const out = new Uint8Array(15);
			const op = popEvent(view, ringOff, out);
			expect(op).toBe(7);
			expect(out).toEqual(fill(new Uint8Array(15), i * 17));
		}
		expect(pendingEventCount(view, ringOff)).toBe(0);
	});

	it("interleaved push/pop drains correctly", () => {
		const { view, ringOff } = freshRing(4);
		const out = new Uint8Array(15);
		expect(pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 1))).toBe(true);
		expect(pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 2))).toBe(true);
		expect(popEvent(view, ringOff, out)).toBe(1);
		expect(out).toEqual(fill(new Uint8Array(15), 1));
		expect(pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 3))).toBe(true);
		expect(pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 4))).toBe(true);
		expect(popEvent(view, ringOff, out)).toBe(1);
		expect(out).toEqual(fill(new Uint8Array(15), 2));
		expect(popEvent(view, ringOff, out)).toBe(1);
		expect(out).toEqual(fill(new Uint8Array(15), 3));
		expect(popEvent(view, ringOff, out)).toBe(1);
		expect(out).toEqual(fill(new Uint8Array(15), 4));
		expect(popEvent(view, ringOff, out)).toBe(EVENT_OP_EMPTY);
	});

	it("different op_codes survive a multi-event drain", () => {
		const { view, ringOff } = freshRing(4);
		// Three event-def IDs, distinct payloads.
		expect(pushEvent(view, ringOff, 7, fill(new Uint8Array(15), 1))).toBe(true);
		expect(pushEvent(view, ringOff, 13, fill(new Uint8Array(15), 2))).toBe(true);
		expect(pushEvent(view, ringOff, 99, fill(new Uint8Array(15), 3))).toBe(true);

		const seen: number[] = [];
		drainEventRing(view, ringOff, (op) => seen.push(op));
		expect(seen).toEqual([7, 13, 99]);
	});
});

describe("event_ring — overflow", () => {
	it("push beyond capacity returns false and sets overflow flag", () => {
		const { view, ringOff } = freshRing(4);
		for (let i = 0; i < 4; i++) {
			expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(true);
		}
		expect(ringOverflow(view, ringOff)).toBe(false);
		expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(false);
		expect(ringOverflow(view, ringOff)).toBe(true);
	});

	it("after pop, ring accepts a new push (overflow flag stays sticky)", () => {
		const { view, ringOff } = freshRing(2);
		expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(true);
		expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(true);
		expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(false);
		expect(ringOverflow(view, ringOff)).toBe(true);
		const out = new Uint8Array(15);
		expect(popEvent(view, ringOff, out)).toBe(1);
		expect(pushEvent(view, ringOff, 1, new Uint8Array(15))).toBe(true);
		expect(ringOverflow(view, ringOff)).toBe(true);
	});
});

describe("event_ring — wrap-around", () => {
	it("FIFO order survives write_head/read_head wrap across many cycles", () => {
		const { view, ringOff } = freshRing(4);
		const out = new Uint8Array(15);
		let pushed = 0;
		let popped = 0;
		for (let cycle = 0; cycle < 8; cycle++) {
			for (let i = 0; i < 3; i++) {
				expect(pushEvent(view, ringOff, 5, fill(new Uint8Array(15), pushed))).toBe(true);
				pushed++;
			}
			while (popped < pushed) {
				const op = popEvent(view, ringOff, out);
				expect(op).toBe(5);
				expect(out).toEqual(fill(new Uint8Array(15), popped));
				popped++;
			}
		}
		expect(ringWriteHead(view, ringOff)).toBe(pushed);
		expect(ringReadHead(view, ringOff)).toBe(popped);
		expect(pendingEventCount(view, ringOff)).toBe(0);
	});

	it("u32 write_head/read_head wrap at 2^32 keeps FIFO order + pending count exact", () => {
		// The `(write_head - read_head) >>> 0` slot/count math and the slot
		// index `head & (capacity - 1)` are only correct across the 2^32
		// counter boundary because of the `>>> 0` — a regression dropping it
		// surfaces ONLY near the counter wrap. Seed both heads just below
		// UINT32_MAX (the grow.test.ts:80 DataView-seed pattern) so the
		// pushes below carry the counters through 0xffffffff → 0.
		const { view, ringOff } = freshRing(4);
		const NEAR_MAX = 0xff_ff_ff_fe;
		view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.write_head, NEAR_MAX, true);
		view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.read_head, NEAR_MAX, true);
		expect(pendingEventCount(view, ringOff)).toBe(0);

		const out = new Uint8Array(15);
		let pushed = 0;
		let popped = 0;
		// 10 cycles of (push 2, drain all) walk the heads from 0xfffffffe
		// through the wrap and on past it, so the boundary is crossed and
		// then read-from on the far side rather than only touched once.
		for (let cycle = 0; cycle < 10; cycle++) {
			expect(pushEvent(view, ringOff, 5, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			expect(pushEvent(view, ringOff, 5, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			// Two pending straddling the wrap — count must stay exact (this is
			// the assertion the missing `>>> 0` would break).
			expect(pendingEventCount(view, ringOff)).toBe(pushed - popped);
			while (popped < pushed) {
				expect(popEvent(view, ringOff, out)).toBe(5);
				expect(out).toEqual(fill(new Uint8Array(15), popped));
				popped++;
			}
			expect(pendingEventCount(view, ringOff)).toBe(0);
		}
		// The counters genuinely wrapped: seed + 20 ops ≡ 18 (mod 2^32),
		// which is below the seed — proving we crossed 2^32, not just bumped.
		expect(ringWriteHead(view, ringOff)).toBe((NEAR_MAX + pushed) >>> 0);
		expect(ringWriteHead(view, ringOff)).toBeLessThan(NEAR_MAX);
		expect(ringReadHead(view, ringOff)).toBe((NEAR_MAX + popped) >>> 0);
	});
});

describe("event_ring — drain", () => {
	it("drain visits every pending event in FIFO order and returns the count", () => {
		const { view, ringOff } = freshRing(8);
		for (let i = 0; i < 5; i++) {
			pushEvent(view, ringOff, 1, fill(new Uint8Array(15), i * 7));
		}
		const seen: Uint8Array[] = [];
		const n = drainEventRing(view, ringOff, (_op, payload) => {
			seen.push(payload);
		});
		expect(n).toBe(5);
		for (let i = 0; i < 5; i++) {
			expect(seen[i]).toEqual(fill(new Uint8Array(15), i * 7));
		}
		expect(pendingEventCount(view, ringOff)).toBe(0);
	});

	it("drain on empty ring returns 0 and never invokes the handler", () => {
		const { view, ringOff } = freshRing(4);
		let calls = 0;
		const n = drainEventRing(view, ringOff, () => {
			calls++;
		});
		expect(n).toBe(0);
		expect(calls).toBe(0);
	});

	it("drain hands the handler an independent payload copy each iteration", () => {
		const { view, ringOff } = freshRing(4);
		pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 1));
		pushEvent(view, ringOff, 1, fill(new Uint8Array(15), 2));
		const captured: Uint8Array[] = [];
		drainEventRing(view, ringOff, (_op, payload) => {
			captured.push(payload);
		});
		expect(captured.length).toBe(2);
		expect(captured[0]).not.toBe(captured[1]);
		expect(captured[0]).toEqual(fill(new Uint8Array(15), 1));
		expect(captured[1]).toEqual(fill(new Uint8Array(15), 2));
	});
});

describe("event_ring — validation", () => {
	it("push rejects op_code === 0 (reserved as empty-slot marker)", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushEvent(view, ringOff, 0, new Uint8Array(15))).toThrow(EventRingError);
	});

	it("push rejects op_code > 255 (must fit in u8)", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushEvent(view, ringOff, 256, new Uint8Array(15))).toThrow(EventRingError);
		expect(() => pushEvent(view, ringOff, -1, new Uint8Array(15))).toThrow(EventRingError);
		expect(() => pushEvent(view, ringOff, 1.5, new Uint8Array(15))).toThrow(EventRingError);
	});

	it("push rejects wrong-sized payload", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushEvent(view, ringOff, 1, new Uint8Array(14))).toThrow(EventRingError);
		expect(() => pushEvent(view, ringOff, 1, new Uint8Array(16))).toThrow(EventRingError);
	});

	it("pop rejects wrong-sized out_payload", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => popEvent(view, ringOff, new Uint8Array(14))).toThrow(EventRingError);
		expect(() => popEvent(view, ringOff, new Uint8Array(16))).toThrow(EventRingError);
	});
});
