/**
 * Command ring — WASM-side producer / TS-side consumer SPSC ring buffer
 * for structural-change intents emitted during `sim.tick()`. Plan §7.5
 * (`docs/ideas/buffer-wasm-sim-plan-2026-05-14T1600.md`).
 *
 * Layout:
 *
 *   [ write_head:   u32 ]   slot 0..N-1, monotonic (NOT slot-modulo)
 *   [ read_head:    u32 ]   slot 0..N-1, monotonic
 *   [ capacity:     u32 ]   slot count, power-of-two
 *   [ overflow:     u32 ]   0 = OK; 1 = WASM exhausted the ring this tick
 *   [ slot 0:       16 B ]  opCode: u8, payload: [15]u8
 *   [ slot 1:       16 B ]  ...
 *   ...
 *
 * SPSC contract (Phase 4 scope):
 *   - Producer: WASM `sim.tick()`. Pushes 0..N commands during one tick;
 *     bumps `write_head` after each.
 *   - Consumer: TS host, immediately after `wasm.tick()` returns. Drains
 *     0..N pending commands; bumps `read_head` after each.
 *   - The two never run concurrently in Phase 4 (single host thread
 *     orchestrates both). Phase 5's worker offload promotes the head
 *     bumps to `Atomics.store`; that's an additive change without
 *     altering the layout.
 *
 * Overflow:
 *   - If WASM would write a slot when (`write_head - read_head == capacity`),
 *     it sets `overflow = 1` and drops the command. TS treats overflow as
 *     a hard error in dev builds; production logs and continues (a command
 *     might be lost rather than crash the host).
 *
 * Slot format (plan §7.5):
 *   byte 0:       opCode (u8). 0 is reserved as the empty-slot marker
 *                 (`COMMAND_OP_EMPTY`); all other codes are consumer-defined.
 *                 The engine never interprets a code — it drains
 *                 `(opCode, payload)` and hands them to the attached
 *                 consumer, which owns the opcode enum + payload codecs (the
 *                 game's live in `@internal/sim`'s `command_payloads.ts`).
 *   bytes 1..15:  payload, op-specific. Multi-byte fields may be
 *                 unaligned within the payload; readers must use byte-
 *                 oriented helpers (DataView in TS, `mem.readInt` in Zig).
 *
 * The ring lives BEFORE the layout-descriptor region in the SAB (right
 * after the 32-byte header) so its offset is stable across descriptor /
 * column-region growth. The host writes `header.command_ring_off` to
 * point at it during `createColumnStore`; absent ring is signalled by
 * `command_ring_off === 0`.
 */

/** Total bytes for the ring header. */
export const COMMAND_RING_HEADER_BYTES = 16;

/** Fixed slot size — 1-byte opCode + 15-byte payload. */
export const COMMAND_RING_SLOT_BYTES = 16;

/** Default ring capacity in slots. 256 × 16 B = 4 KiB of ring data plus
 * 16 B header. Sized for the worst-case burst (peak spawn intents per
 * tick) × small safety margin. Tune up if a Phase 4 burst pushes past it
 * in the bench harness. */
export const COMMAND_RING_DEFAULT_CAPACITY_SLOTS = 256;

/** Byte offsets within the ring header. Mirrored on the Zig side in
 * `packages/sim/src/command_ring.zig` — keep in sync. */
export const COMMAND_RING_HEADER_OFFSETS = {
	write_head: 0,
	read_head: 4,
	capacity_slots: 8,
	overflow_flag: 12
} as const;

/** Op-code `0` is reserved across the SAB layer as the empty-slot marker
 * so a zero-initialised SAB doesn't appear to hold a valid command (mirror
 * of `EVENT_OP_EMPTY`). All non-zero codes are opaque to the engine —
 * the attached consumer owns the opcode enum + payload codecs (the game's
 * `COMMAND_OP` + `SpawnUnitFields` live in `@internal/sim`). */
export const COMMAND_OP_EMPTY = 0;

/** Total bytes the ring occupies for `capacity_slots` slots. */
export function commandRingBytes(capacitySlots: number): number {
	return COMMAND_RING_HEADER_BYTES + capacitySlots * COMMAND_RING_SLOT_BYTES;
}

/** True when `n` is a positive power of two. Used to validate
 * `capacity_slots` — the `head & (capacity - 1)` modulo trick relies on
 * this. */
function isPow2(n: number): boolean {
	return n > 0 && (n & (n - 1)) === 0;
}

export class CommandRingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRingError";
	}
}

/** Initialise the ring header at `ringOff` in the SAB. Zeroes
 * `write_head`, `read_head`, and `overflow_flag`; sets `capacity_slots`.
 * Slot bytes are left as-is (callers normally allocate the ring on a
 * fresh, zero-initialised SAB). */
export function initCommandRing(view: DataView, ringOff: number, capacitySlots: number): void {
	if (!isPow2(capacitySlots)) {
		throw new CommandRingError(
			`command ring capacity_slots must be a positive power of two (got ${capacitySlots})`
		);
	}
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, 0, true);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.read_head, 0, true);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.capacity_slots, capacitySlots, true);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.overflow_flag, 0, true);
}

/** Read live ring-header field. */
export function ringWriteHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, true);
}
export function ringReadHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.read_head, true);
}
export function ringCapacitySlots(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.capacity_slots, true);
}
export function ringOverflow(view: DataView, ringOff: number): boolean {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.overflow_flag, true) !== 0;
}

/** Pending command count = `(write_head - read_head) mod 2^32`. The
 * `>>> 0` keeps the result a u32 in the wrap-around case (rings live for
 * the host's lifetime; 2^32 commands at 50 Hz ≈ 2 years, but the
 * arithmetic should be correct regardless). */
export function pendingCommandCount(view: DataView, ringOff: number): number {
	return (ringWriteHead(view, ringOff) - ringReadHead(view, ringOff)) >>> 0;
}

/** Push a command into the ring from the TS side. Production producer is
 * WASM (via `command_ring.zig`); this is for host-side tests and for
 * symmetric tests across the two sides. Returns `false` on overflow and
 * sets the overflow flag. Payload must be exactly 15 bytes. */
export function pushCommand(
	view: DataView,
	ringOff: number,
	opCode: number,
	payload: Uint8Array
): boolean {
	// Symmetric with `pushEvent` / `CommandDispatcher.on` / `checkRingOpCode`:
	// opCode 0 is the empty-slot marker and a non-u8 corrupts the slot byte. The
	// production producer is WASM (op-codes ≥ 1), so this guards the TS test/host
	// producer for parity. (#731)
	if (opCode === COMMAND_OP_EMPTY) {
		throw new CommandRingError(`command op_code must be > 0 (0 is reserved as the empty-slot marker)`);
	}
	if (opCode < 0 || opCode > 0xff || !Number.isInteger(opCode)) {
		throw new CommandRingError(`command op_code must be a u8 in [1, 255] (got ${opCode})`);
	}
	if (payload.byteLength !== COMMAND_RING_SLOT_BYTES - 1) {
		throw new CommandRingError(
			`command payload must be ${COMMAND_RING_SLOT_BYTES - 1} bytes (got ${payload.byteLength})`
		);
	}
	const writeHead = ringWriteHead(view, ringOff);
	const readHead = ringReadHead(view, ringOff);
	const capacity = ringCapacitySlots(view, ringOff);
	if ((writeHead - readHead) >>> 0 >= capacity) {
		view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.overflow_flag, 1, true);
		return false;
	}
	const slotIdx = writeHead & (capacity - 1);
	const slotOff = ringOff + COMMAND_RING_HEADER_BYTES + slotIdx * COMMAND_RING_SLOT_BYTES;
	view.setUint8(slotOff, opCode);
	// boundary: TypedArray interop. Materialise a payload-sized view at the
	// slot's payload region and copy in. The DataView is owned by the
	// caller; reads/writes through the slot's own DataView would work but
	// would require a fresh DataView per slot, so we use Uint8Array.set
	// which V8 specialises well.
	const dest = new Uint8Array(view.buffer, slotOff + 1, COMMAND_RING_SLOT_BYTES - 1);
	dest.set(payload);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, (writeHead + 1) >>> 0, true);
	return true;
}

/** Read one command from the ring. Returns opCode (0 = empty/no
 * command) and fills `outPayload` (15 bytes) with the slot's payload.
 * When 0 is returned, `outPayload` is untouched. */
export function popCommand(view: DataView, ringOff: number, outPayload: Uint8Array): number {
	if (outPayload.byteLength !== COMMAND_RING_SLOT_BYTES - 1) {
		throw new CommandRingError(
			`out_payload must be ${COMMAND_RING_SLOT_BYTES - 1} bytes (got ${outPayload.byteLength})`
		);
	}
	const writeHead = ringWriteHead(view, ringOff);
	const readHead = ringReadHead(view, ringOff);
	if (writeHead === readHead) return COMMAND_OP_EMPTY;
	const capacity = ringCapacitySlots(view, ringOff);
	const slotIdx = readHead & (capacity - 1);
	const slotOff = ringOff + COMMAND_RING_HEADER_BYTES + slotIdx * COMMAND_RING_SLOT_BYTES;
	const opCode = view.getUint8(slotOff);
	const src = new Uint8Array(view.buffer, slotOff + 1, COMMAND_RING_SLOT_BYTES - 1);
	outPayload.set(src);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.read_head, (readHead + 1) >>> 0, true);
	return opCode;
}

/** Visit every pending command and bump `read_head` past them. Yields
 * `{ opCode, payload }` per slot where `payload` is a freshly-copied
 * 15-byte Uint8Array (so the handler can hold it past the next pop
 * without aliasing the ring). Stops when the ring is empty. Used by the
 * TS host drain that runs right after `wasm.tick()` returns. */
export function drainCommandRing(
	view: DataView,
	ringOff: number,
	handler: (opCode: number, payload: Uint8Array) => void
): number {
	let drained = 0;
	const scratch = new Uint8Array(COMMAND_RING_SLOT_BYTES - 1);
	for (;;) {
		const op = popCommand(view, ringOff, scratch);
		if (op === COMMAND_OP_EMPTY) return drained;
		// Copy the payload so the handler can hold it without aliasing
		// the scratch buffer the next iteration will overwrite.
		handler(op, scratch.slice());
		drained++;
	}
}
