import { describe, expect, it } from "vitest";

import {
	COMMAND_OP_EMPTY,
	COMMAND_RING_DEFAULT_CAPACITY_SLOTS,
	COMMAND_RING_HEADER_BYTES,
	COMMAND_RING_HEADER_OFFSETS,
	COMMAND_RING_SLOT_BYTES,
	CommandRingError,
	commandRingBytes,
	drainCommandRing,
	initCommandRing,
	pendingCommandCount,
	popCommand,
	pushCommand,
	ringCapacitySlots,
	ringOverflow,
	ringReadHead,
	ringWriteHead
} from "../command_ring";

// Fabricated, non-game op codes. The engine command ring treats the opCode as
// an opaque u8 slot prefix — it ships no game opcode enum. These three
// stand in for whatever a consumer registers; only `0` is reserved
// (`COMMAND_OP_EMPTY`, the empty-slot marker).
const OP_A = 1;
const OP_B = 2;
const OP_C = 3;

/** Build a standalone DataView backed by a SAB sized to host one ring of
 * `capacity_slots` slots starting at offset 0. The ring is initialised
 * via `initCommandRing` so tests start from a known-empty state. */
function freshRing(capacitySlots: number = 8): {
	view: DataView;
	ringOff: number;
} {
	const bytes = commandRingBytes(capacitySlots);
	const buffer = new SharedArrayBuffer(bytes);
	const view = new DataView(buffer);
	initCommandRing(view, 0, capacitySlots);
	return { view, ringOff: 0 };
}

function fill(buf: Uint8Array, value: number): Uint8Array {
	for (let i = 0; i < buf.length; i++) buf[i] = (value + i) & 0xff;
	return buf;
}

describe("command_ring — constants and sizing", () => {
	it("header is 16 bytes, slot is 16 bytes", () => {
		expect(COMMAND_RING_HEADER_BYTES).toBe(16);
		expect(COMMAND_RING_SLOT_BYTES).toBe(16);
	});

	it("default capacity is 256 slots (4 KiB of slot data)", () => {
		expect(COMMAND_RING_DEFAULT_CAPACITY_SLOTS).toBe(256);
		expect(commandRingBytes(COMMAND_RING_DEFAULT_CAPACITY_SLOTS)).toBe(16 + 256 * 16);
	});

	it("reserves op_code 0 as the empty-slot marker (no game opcode enum)", () => {
		// The engine ships only `COMMAND_OP_EMPTY` — the game opcode enum
		// (`OP_A`, …) moved to `@internal/sim`. Every
		// non-zero u8 is an opaque, consumer-defined code.
		expect(COMMAND_OP_EMPTY).toBe(0);
	});

	it("header field byte offsets are locked", () => {
		expect(COMMAND_RING_HEADER_OFFSETS.write_head).toBe(0);
		expect(COMMAND_RING_HEADER_OFFSETS.read_head).toBe(4);
		expect(COMMAND_RING_HEADER_OFFSETS.capacity_slots).toBe(8);
		expect(COMMAND_RING_HEADER_OFFSETS.overflow_flag).toBe(12);
	});
});

describe("command_ring — init", () => {
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
		expect(() => initCommandRing(view, 0, 3)).toThrow(CommandRingError);
		expect(() => initCommandRing(view, 0, 7)).toThrow(CommandRingError);
		expect(() => initCommandRing(view, 0, 100)).toThrow(CommandRingError);
		expect(() => initCommandRing(view, 0, 0)).toThrow(CommandRingError);
	});

	it("accepts powers of two", () => {
		const buffer = new SharedArrayBuffer(1024 * 16);
		const view = new DataView(buffer);
		for (const n of [1, 2, 4, 8, 16, 64, 256]) {
			expect(() => initCommandRing(view, 0, n)).not.toThrow();
		}
	});
});

describe("command_ring — SPSC happy path", () => {
	it("push then pop round-trips op_code and payload", () => {
		const { view, ringOff } = freshRing(8);
		const payload = fill(new Uint8Array(15), 42);
		expect(pushCommand(view, ringOff, OP_A, payload)).toBe(true);
		expect(pendingCommandCount(view, ringOff)).toBe(1);

		const out = new Uint8Array(15);
		const op = popCommand(view, ringOff, out);
		expect(op).toBe(OP_A);
		expect(out).toEqual(payload);
		expect(pendingCommandCount(view, ringOff)).toBe(0);
	});

	it("pop on empty ring returns the empty-slot marker (0) and does not touch out_payload", () => {
		const { view, ringOff } = freshRing(8);
		const out = fill(new Uint8Array(15), 0xab);
		const before = new Uint8Array(out); // snapshot
		const op = popCommand(view, ringOff, out);
		expect(op).toBe(COMMAND_OP_EMPTY);
		expect(out).toEqual(before);
	});

	it("FIFO order across N pushes / N pops", () => {
		const { view, ringOff } = freshRing(8);
		const N = 5;
		for (let i = 0; i < N; i++) {
			const p = fill(new Uint8Array(15), i * 17);
			expect(pushCommand(view, ringOff, OP_B, p)).toBe(true);
		}
		expect(pendingCommandCount(view, ringOff)).toBe(N);
		for (let i = 0; i < N; i++) {
			const out = new Uint8Array(15);
			const op = popCommand(view, ringOff, out);
			expect(op).toBe(OP_B);
			expect(out).toEqual(fill(new Uint8Array(15), i * 17));
		}
		expect(pendingCommandCount(view, ringOff)).toBe(0);
	});

	it("interleaved push/pop drains correctly", () => {
		const { view, ringOff } = freshRing(4);
		const out = new Uint8Array(15);
		// Push 2, pop 1, push 2, pop 3 — verifies head indices stay sane
		expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 1))).toBe(true);
		expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 2))).toBe(true);
		expect(popCommand(view, ringOff, out)).toBe(OP_A);
		expect(out).toEqual(fill(new Uint8Array(15), 1));
		expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 3))).toBe(true);
		expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 4))).toBe(true);
		expect(popCommand(view, ringOff, out)).toBe(OP_A);
		expect(out).toEqual(fill(new Uint8Array(15), 2));
		expect(popCommand(view, ringOff, out)).toBe(OP_A);
		expect(out).toEqual(fill(new Uint8Array(15), 3));
		expect(popCommand(view, ringOff, out)).toBe(OP_A);
		expect(out).toEqual(fill(new Uint8Array(15), 4));
		expect(popCommand(view, ringOff, out)).toBe(COMMAND_OP_EMPTY);
	});
});

describe("command_ring — overflow", () => {
	it("push beyond capacity returns false and sets overflow flag", () => {
		const { view, ringOff } = freshRing(4);
		for (let i = 0; i < 4; i++) {
			expect(pushCommand(view, ringOff, OP_A, new Uint8Array(15))).toBe(true);
		}
		expect(ringOverflow(view, ringOff)).toBe(false);
		expect(pushCommand(view, ringOff, OP_A, new Uint8Array(15))).toBe(false);
		expect(ringOverflow(view, ringOff)).toBe(true);
	});

	it("after pop, ring accepts a new push (overflow flag stays set as a sticky witness)", () => {
		const { view, ringOff } = freshRing(2);
		expect(pushCommand(view, ringOff, OP_C, new Uint8Array(15))).toBe(true);
		expect(pushCommand(view, ringOff, OP_C, new Uint8Array(15))).toBe(true);
		expect(pushCommand(view, ringOff, OP_C, new Uint8Array(15))).toBe(false);
		expect(ringOverflow(view, ringOff)).toBe(true);
		const out = new Uint8Array(15);
		expect(popCommand(view, ringOff, out)).toBe(OP_C);
		expect(pushCommand(view, ringOff, OP_C, new Uint8Array(15))).toBe(true);
		// Flag stays set so the host can detect the prior overflow even after
		// draining; resetting is the host's responsibility (re-init the ring
		// or zero the flag explicitly).
		expect(ringOverflow(view, ringOff)).toBe(true);
	});
});

describe("command_ring — wrap-around", () => {
	it("FIFO order survives write_head/read_head wrap across many ticks", () => {
		const { view, ringOff } = freshRing(4);
		// 32 pushes interleaved with pops; head indices wrap modulo
		// capacity (4). The head counters themselves wrap modulo 2^32 —
		// not exercised here, but the slot-index math (`head & 3`) is.
		const out = new Uint8Array(15);
		let pushed = 0;
		let popped = 0;
		for (let cycle = 0; cycle < 8; cycle++) {
			expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			while (popped < pushed) {
				const op = popCommand(view, ringOff, out);
				expect(op).toBe(OP_A);
				expect(out).toEqual(fill(new Uint8Array(15), popped));
				popped++;
			}
		}
		expect(ringWriteHead(view, ringOff)).toBe(pushed);
		expect(ringReadHead(view, ringOff)).toBe(popped);
		expect(pendingCommandCount(view, ringOff)).toBe(0);
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
		view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, NEAR_MAX, true);
		view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.read_head, NEAR_MAX, true);
		expect(pendingCommandCount(view, ringOff)).toBe(0);

		const out = new Uint8Array(15);
		let pushed = 0;
		let popped = 0;
		// 10 cycles of (push 2, drain all) walk the heads from 0xfffffffe
		// through the wrap and on past it, so the boundary is crossed and
		// then read-from on the far side rather than only touched once.
		for (let cycle = 0; cycle < 10; cycle++) {
			expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			expect(pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), pushed))).toBe(true);
			pushed++;
			// Two pending straddling the wrap — count must stay exact (this is
			// the assertion the missing `>>> 0` would break).
			expect(pendingCommandCount(view, ringOff)).toBe(pushed - popped);
			while (popped < pushed) {
				expect(popCommand(view, ringOff, out)).toBe(OP_A);
				expect(out).toEqual(fill(new Uint8Array(15), popped));
				popped++;
			}
			expect(pendingCommandCount(view, ringOff)).toBe(0);
		}
		// The counters genuinely wrapped: seed + 20 ops ≡ 18 (mod 2^32),
		// which is below the seed — proving we crossed 2^32, not just bumped.
		expect(ringWriteHead(view, ringOff)).toBe((NEAR_MAX + pushed) >>> 0);
		expect(ringWriteHead(view, ringOff)).toBeLessThan(NEAR_MAX);
		expect(ringReadHead(view, ringOff)).toBe((NEAR_MAX + popped) >>> 0);
	});
});

describe("command_ring — drain", () => {
	it("drain visits every pending command in FIFO order and returns the count", () => {
		const { view, ringOff } = freshRing(8);
		const expected: { op: number; payload: Uint8Array }[] = [];
		for (let i = 0; i < 5; i++) {
			const p = fill(new Uint8Array(15), i * 7);
			pushCommand(view, ringOff, OP_A, p);
			expected.push({ op: OP_A, payload: p });
		}
		const seen: { op: number; payload: Uint8Array }[] = [];
		const n = drainCommandRing(view, ringOff, (op, payload) => {
			seen.push({ op, payload });
		});
		expect(n).toBe(5);
		expect(seen.length).toBe(5);
		for (let i = 0; i < 5; i++) {
			expect(seen[i].op).toBe(expected[i].op);
			expect(seen[i].payload).toEqual(expected[i].payload);
		}
		expect(pendingCommandCount(view, ringOff)).toBe(0);
	});

	it("drain on empty ring returns 0 and never invokes the handler", () => {
		const { view, ringOff } = freshRing(4);
		let calls = 0;
		const n = drainCommandRing(view, ringOff, () => {
			calls++;
		});
		expect(n).toBe(0);
		expect(calls).toBe(0);
	});

	it("drain hands the handler an independent payload copy each iteration", () => {
		const { view, ringOff } = freshRing(4);
		pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 1));
		pushCommand(view, ringOff, OP_A, fill(new Uint8Array(15), 2));
		const captured: Uint8Array[] = [];
		drainCommandRing(view, ringOff, (_op, payload) => {
			captured.push(payload);
		});
		expect(captured.length).toBe(2);
		// Different objects — handler can hold them past the next iteration
		// without aliasing the drain scratch buffer.
		expect(captured[0]).not.toBe(captured[1]);
		expect(captured[0]).toEqual(fill(new Uint8Array(15), 1));
		expect(captured[1]).toEqual(fill(new Uint8Array(15), 2));
	});
});

describe("command_ring — validation", () => {
	// Mirror of event_ring's opCode guard: the command ring's slot
	// prefix is a u8 and opCode 0 is the reserved empty-slot marker, so the TS
	// host producer must reject 0, out-of-u8-range, and non-integer codes — a
	// corrupt op byte would otherwise be indistinguishable from an empty slot or
	// would silently truncate via `setUint8`.
	it("push rejects op_code === 0 (reserved as empty-slot marker)", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushCommand(view, ringOff, COMMAND_OP_EMPTY, new Uint8Array(15))).toThrow(
			CommandRingError
		);
	});

	it("push rejects op_code outside the u8 range [1, 255]", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushCommand(view, ringOff, 256, new Uint8Array(15))).toThrow(CommandRingError);
		expect(() => pushCommand(view, ringOff, -1, new Uint8Array(15))).toThrow(CommandRingError);
		expect(() => pushCommand(view, ringOff, 1.5, new Uint8Array(15))).toThrow(CommandRingError);
	});

	it("push accepts a valid op_code (1) and pushes the slot", () => {
		const { view, ringOff } = freshRing(4);
		expect(pushCommand(view, ringOff, OP_A, new Uint8Array(15))).toBe(true);
		expect(pendingCommandCount(view, ringOff)).toBe(1);
	});

	it("push rejects wrong-sized payload", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => pushCommand(view, ringOff, OP_A, new Uint8Array(14))).toThrow(CommandRingError);
		expect(() => pushCommand(view, ringOff, OP_A, new Uint8Array(16))).toThrow(CommandRingError);
	});

	it("pop rejects wrong-sized out_payload", () => {
		const { view, ringOff } = freshRing(4);
		expect(() => popCommand(view, ringOff, new Uint8Array(14))).toThrow(CommandRingError);
		expect(() => popCommand(view, ringOff, new Uint8Array(16))).toThrow(CommandRingError);
	});
});
