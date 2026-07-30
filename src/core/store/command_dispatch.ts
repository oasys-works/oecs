/**
 * Command dispatch — the generic drain surface a consumer registers against
 * (a game-agnostic ECS).
 *
 * The command ring (`command_ring.ts`) carries opaque `(opCode, payload)`
 * slots; the engine never interprets a code. This module is the thin,
 * game-free glue that lets a consumer bind a payload codec + typed handler to
 * each opcode and drain the ring in one call. The opcode enum and the codecs
 * themselves stay consumer-owned — for our game they live in
 * `@internal/sim`'s `command_payloads.ts` (`COMMAND_OP`, `SpawnUnitFields`,
 * `encode/decode_spawn_unit_payload`); the engine knows none of those names.
 *
 * Usage:
 *
 *   const dispatcher = new CommandDispatcher()
 *     .on(COMMAND_OP.spawn_unit, spawn_unit_codec, (fields) => spawn(fields));
 *   dispatcher.drain(view, ringOff); // runs after wasm.tick() returns
 *
 * Unregistered opcodes are skipped (the same forward-compatible stance as the
 * raw `drainCommandRing` handler that ignores codes it doesn't know).
 */

import { CommandRingError, COMMAND_OP_EMPTY, drainCommandRing } from "./command_ring";

/** Decode (and, symmetrically, encode) the 15-byte payload region of a
 * command slot into a typed value. A consumer supplies one per opcode it
 * cares about; the engine only ever calls `decode` during a drain, but the
 * `encode` half keeps the codec a single round-trippable unit (and is what
 * test/host producers use to push). */
export interface PayloadCodec<T> {
	/** Encode `value` into a fresh `COMMAND_RING_SLOT_BYTES - 1` (15) byte
	 * payload, ready for `pushCommand(view, off, op, payload)`. */
	encode(value: T): Uint8Array;
	/** Decode a 15-byte payload back into the typed value. */
	decode(payload: Uint8Array): T;
}

/** Internal per-opcode registration: the codec decodes the raw payload, then
 * the handler runs on the decoded value. Stored type-erased (`unknown`) — the
 * `on<T>` generic ties codec and handler together at registration so the erased
 * pair is always self-consistent. */
interface OpcodeBinding {
	readonly decode: (payload: Uint8Array) => unknown;
	readonly handle: (value: unknown) => void;
}

/**
 * Registry mapping command opcodes to a payload codec + handler. Generic over
 * the consumer's opcodes — the engine ships the mechanism; the game supplies
 * the codes and codecs.
 */
export class CommandDispatcher {
	private readonly bindings = new Map<number, OpcodeBinding>();

	/** Register `handler` for `opCode`, decoding each slot with `codec`.
	 * Re-registering an opcode replaces its binding. `opCode` must be a u8 in
	 * `[1, 255]` — `0` is the reserved empty-slot marker and can never carry a
	 * command. Returns `this` for chaining. */
	on<T>(opCode: number, codec: PayloadCodec<T>, handler: (value: T) => void): this {
		if (opCode === COMMAND_OP_EMPTY) {
			throw new CommandRingError(
				`cannot register a handler for opCode 0 (reserved as the empty-slot marker)`
			);
		}
		if (opCode < 0 || opCode > 0xff || !Number.isInteger(opCode)) {
			throw new CommandRingError(`command opCode must be a u8 in [1, 255] (got ${opCode})`);
		}
		this.bindings.set(opCode, {
			decode: (payload) => codec.decode(payload),
			handle: (value) => handler(value as T)
		});
		return this;
	}

	/** Drain every pending command, decoding + dispatching each to its
	 * registered handler. Commands with no registered opcode are skipped.
	 * Returns the number of slots drained (including skipped ones — the ring is
	 * advanced regardless, matching `drainCommandRing`). */
	drain(view: DataView, ringOff: number): number {
		return drainCommandRing(view, ringOff, (opCode, payload) => {
			const binding = this.bindings.get(opCode);
			if (binding === undefined) return;
			binding.handle(binding.decode(payload));
		});
	}
}
