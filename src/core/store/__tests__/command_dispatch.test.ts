/**
 * `CommandDispatcher` — the generic register-a-handler-per-opcode drain surface
 * (#624, game-agnostic ECS). The engine ships no game opcodes; a consumer binds
 * a payload codec + handler to each opcode and round-trips a fabricated,
 * non-game command through the ring. This is the acceptance test for "a consumer
 * can register opcodes + payload codecs and round-trip a fabricated non-game
 * command through the ring".
 */

import { describe, expect, it, vi } from "vitest";
import {
	CommandDispatcher,
	type PayloadCodec,
	commandRingBytes,
	initCommandRing,
	pushCommand
} from "..";

/** A fabricated, deliberately NON-game command — proves the engine surface is
 * opaque to opcode semantics. Two u32s packed little-endian into the 15-byte
 * payload region. */
interface MoveCursorFields {
	readonly x: number;
	readonly y: number;
}

/** An opcode no game in this repo uses — picked high to make the point that the
 * engine neither defines nor validates it beyond "u8, not 0". */
const OP_MOVE_CURSOR = 200;

const moveCursorCodec: PayloadCodec<MoveCursorFields> = {
	encode({ x, y }) {
		const out = new Uint8Array(15);
		const view = new DataView(out.buffer);
		view.setUint32(0, x, true);
		view.setUint32(4, y, true);
		return out;
	},
	decode(payload) {
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		return { x: view.getUint32(0, true), y: view.getUint32(4, true) };
	}
};

function freshRing(capacitySlots = 8): { view: DataView; ringOff: number } {
	const view = new DataView(new ArrayBuffer(commandRingBytes(capacitySlots)));
	initCommandRing(view, 0, capacitySlots);
	return { view, ringOff: 0 };
}

describe("CommandDispatcher", () => {
	it("registers an opcode + codec and round-trips a fabricated non-game command", () => {
		const { view, ringOff } = freshRing();
		const seen: MoveCursorFields[] = [];
		const dispatcher = new CommandDispatcher().on(OP_MOVE_CURSOR, moveCursorCodec, (fields) =>
			seen.push(fields)
		);

		const fixtures: MoveCursorFields[] = [
			{ x: 1, y: 2 },
			{ x: 4_000_000_000, y: 7 } // exercises the full u32 range
		];
		for (const f of fixtures) {
			expect(pushCommand(view, ringOff, OP_MOVE_CURSOR, moveCursorCodec.encode(f))).toBe(true);
		}

		const drained = dispatcher.drain(view, ringOff);
		expect(drained).toBe(fixtures.length);
		expect(seen).toEqual(fixtures);
	});

	it("dispatches each opcode to its own handler", () => {
		const { view, ringOff } = freshRing();
		const a = vi.fn();
		const b = vi.fn();
		const rawCodec: PayloadCodec<Uint8Array> = {
			encode: (v) => v,
			decode: (p) => p
		};
		const dispatcher = new CommandDispatcher().on(10, rawCodec, a).on(20, rawCodec, b);

		pushCommand(view, ringOff, 10, new Uint8Array(15).fill(1));
		pushCommand(view, ringOff, 20, new Uint8Array(15).fill(2));
		pushCommand(view, ringOff, 10, new Uint8Array(15).fill(3));

		expect(dispatcher.drain(view, ringOff)).toBe(3);
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("skips commands with no registered opcode but still advances the ring", () => {
		const { view, ringOff } = freshRing();
		const handled = vi.fn();
		const dispatcher = new CommandDispatcher().on(
			10,
			{ encode: (v) => v, decode: (p) => p },
			handled
		);

		pushCommand(view, ringOff, 10, new Uint8Array(15).fill(1));
		pushCommand(view, ringOff, 99, new Uint8Array(15).fill(2)); // unregistered

		// Both slots are drained (count includes the skipped one); only the
		// registered opcode invokes a handler.
		expect(dispatcher.drain(view, ringOff)).toBe(2);
		expect(handled).toHaveBeenCalledTimes(1);
	});

	it("rejects registering the reserved empty-slot marker (op 0) or a non-u8 code", () => {
		const dispatcher = new CommandDispatcher();
		const codec: PayloadCodec<Uint8Array> = { encode: (v) => v, decode: (p) => p };
		expect(() => dispatcher.on(0, codec, () => {})).toThrow();
		expect(() => dispatcher.on(256, codec, () => {})).toThrow();
		expect(() => dispatcher.on(-1, codec, () => {})).toThrow();
		expect(() => dispatcher.on(1.5, codec, () => {})).toThrow();
	});

	it("re-registering an opcode replaces its binding", () => {
		const { view, ringOff } = freshRing();
		const first = vi.fn();
		const second = vi.fn();
		const codec: PayloadCodec<Uint8Array> = { encode: (v) => v, decode: (p) => p };
		const dispatcher = new CommandDispatcher().on(10, codec, first).on(10, codec, second);

		pushCommand(view, ringOff, 10, new Uint8Array(15));
		dispatcher.drain(view, ringOff);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});
