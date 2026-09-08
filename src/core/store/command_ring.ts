/**
 * Command ring. A WASM-side producer and TS-side consumer SPSC ring buffer
 * for structural-change intents emitted during `sim.tick()`.
 *
 * Layout:
 *
 *   [ write_head:   u32 ]   slot 0..N-1, monotonic (not slot-modulo)
 *   [ read_head:    u32 ]   slot 0..N-1, monotonic
 *   [ capacity:     u32 ]   slot count, power-of-two
 *   [ overflow:     u32 ]   0 = OK, 1 = WASM exhausted the ring this tick
 *   [ slot 0:       16 B ]  opCode: u8, payload: [15]u8
 *   [ slot 1:       16 B ]  ...
 *   ...
 *
 * SPSC contract (single host thread):
 *   - Producer: the WASM tick. It pushes 0..N commands during one tick and
 *     bumps `write_head` after each.
 *   - Consumer: TS host, immediately after `wasm.tick()` returns. Drains
 *     0..N pending commands. Bumps `read_head` after each.
 *   - The two never run concurrently (one host thread orchestrates
 *     both). A later worker offload promotes the head
 *     bumps to `Atomics.store`. That's an additive change without
 *     altering the layout.
 *
 * Overflow:
 *   - If WASM would write a slot when (`write_head - read_head == capacity`),
 *     it sets `overflow = 1` and drops the command. TS treats overflow as
 *     a hard error in dev builds. Production logs and continues (a command
 *     might be lost rather than crash the host).
 *
 * Slot format:
 *   byte 0:       opCode (u8). 0 is reserved as the empty-slot marker
 *                 (`COMMAND_OP_EMPTY`), and every other code is
 *                 consumer-defined. The engine never interprets a code. It
 *                 drains `(opCode, payload)` and hands them to the attached
 *                 consumer, which owns the opcode enum and the payload codecs.
 *   bytes 1..15:  payload, op-specific. Multi-byte fields may be
 *                 unaligned within the payload. Readers must use byte-
 *                 oriented helpers, such as a `DataView` in TS.
 *
 * The ring lives before the layout-descriptor region in the SAB (right
 * after the `STORE_HEADER_BYTES` header) so its offset is stable across
 * descriptor growth and column-region growth. The host writes `header.command_ring_off` to
 * point at it during `createColumnStore`. Absent ring is signalled by
 * `command_ring_off === 0`.
 */

/** Total bytes for the ring header. */
export const COMMAND_RING_HEADER_BYTES = 16;

/** Fixed slot size, 1-byte opCode + 15-byte payload. */
export const COMMAND_RING_SLOT_BYTES = 16;

/** Default ring capacity in slots. 256 × 16 B = 4 KiB of ring data plus
 * 16 B header. Sized for the worst-case burst of spawn intents in one tick,
 * with a small safety margin. Tune it up when a burst pushes past it. */
export const COMMAND_RING_DEFAULT_CAPACITY_SLOTS = 256;

/** Byte offsets within the ring header. A reader on the module side mirrors
 * these offsets, so a change here is an ABI change. */
export const COMMAND_RING_HEADER_OFFSETS = {
	write_head: 0,
	read_head: 4,
	capacity_slots: 8,
	overflow_flag: 12
} as const;

/** Op-code `0` is reserved across the SAB layer as the empty-slot marker
 * so a zero-initialised SAB doesn't appear to hold a valid command (mirror
 * of `EVENT_OP_EMPTY`). Every non-zero code is opaque to the engine, and
 * the attached consumer owns the opcode enum and the payload codecs. */
export const COMMAND_OP_EMPTY = 0;

/** Total bytes the ring occupies for `capacity_slots` slots. */
export function commandRingBytes(capacitySlots: number): number {
	return COMMAND_RING_HEADER_BYTES + capacitySlots * COMMAND_RING_SLOT_BYTES;
}

/** True when `n` is a positive power of two. Used to validate
 * `capacity_slots`, the `head & (capacity - 1)` modulo trick relies on
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
 * `write_head`, `read_head`, and `overflow_flag`. Sets `capacity_slots`.
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
export function commandRingWriteHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, true);
}
export function commandRingReadHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.read_head, true);
}
export function commandRingCapacitySlots(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.capacity_slots, true);
}
export function commandRingOverflow(view: DataView, ringOff: number): boolean {
	return view.getUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.overflow_flag, true) !== 0;
}

/** Pending command count = `(write_head - read_head) mod 2^32`. The
 * `>>> 0` keeps the result a u32 in the wrap-around case. A ring lives for
 * the host's lifetime, so a long-lived host can reach the wrap, and the
 * arithmetic has to stay correct there. */
export function pendingCommandCount(view: DataView, ringOff: number): number {
	return (commandRingWriteHead(view, ringOff) - commandRingReadHead(view, ringOff)) >>> 0;
}

/** Push a command into the ring from the TS side. The production producer is
 * the WASM module, through its own ring writer. This is for host-side tests
 * and for symmetric tests across the two sides. Returns `false` on overflow and
 * sets the overflow flag. Payload must be exactly 15 bytes. */
export function pushCommand(
	view: DataView,
	ringOff: number,
	opCode: number,
	payload: Uint8Array
): boolean {
	// Symmetric with `pushEvent`, `CommandDispatcher.on` and `assertRingOpCode`:
	// opCode 0 is the empty-slot marker and a non-u8 corrupts the slot byte. The
	// production producer is WASM (op-codes ≥ 1), so this guards the TS test and host
	// producer for parity.
	if (opCode === COMMAND_OP_EMPTY) {
		throw new CommandRingError(
			`command opCode must be > 0 (0 is reserved as the empty-slot marker)`
		);
	}
	if (opCode < 0 || opCode > 0xff || !Number.isInteger(opCode)) {
		throw new CommandRingError(`command opCode must be a u8 in [1, 255] (got ${opCode})`);
	}
	if (payload.byteLength !== COMMAND_RING_SLOT_BYTES - 1) {
		throw new CommandRingError(
			`command payload must be ${COMMAND_RING_SLOT_BYTES - 1} bytes (got ${payload.byteLength})`
		);
	}
	const writeHead = commandRingWriteHead(view, ringOff);
	const readHead = commandRingReadHead(view, ringOff);
	const capacity = commandRingCapacitySlots(view, ringOff);
	if ((writeHead - readHead) >>> 0 >= capacity) {
		view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.overflow_flag, 1, true);
		return false;
	}
	const slotIdx = writeHead & (capacity - 1);
	const slotOff = ringOff + COMMAND_RING_HEADER_BYTES + slotIdx * COMMAND_RING_SLOT_BYTES;
	view.setUint8(slotOff, opCode);
	// boundary: TypedArray interop. Materialise a payload-sized view at the
	// slot's payload region and copy in. The DataView is owned by the
	// caller. Reads and writes through the slot's own DataView would work but
	// would require a fresh DataView per slot, so we use Uint8Array.set
	// which V8 specialises well.
	// `slotOff` indexes `view`, which starts at the store base, so the copy
	// view has to add that base back.
	const dest = new Uint8Array(
		view.buffer,
		view.byteOffset + slotOff + 1,
		COMMAND_RING_SLOT_BYTES - 1
	);
	dest.set(payload);
	view.setUint32(ringOff + COMMAND_RING_HEADER_OFFSETS.write_head, (writeHead + 1) >>> 0, true);
	return true;
}

/** Read one command from the ring. Returns opCode (0 = empty, no
 * command) and fills `outPayload` (15 bytes) with the slot's payload.
 * When 0 is returned, `outPayload` is untouched. */
export function popCommand(view: DataView, ringOff: number, outPayload: Uint8Array): number {
	if (outPayload.byteLength !== COMMAND_RING_SLOT_BYTES - 1) {
		throw new CommandRingError(
			`outPayload must be ${COMMAND_RING_SLOT_BYTES - 1} bytes (got ${outPayload.byteLength})`
		);
	}
	const writeHead = commandRingWriteHead(view, ringOff);
	const readHead = commandRingReadHead(view, ringOff);
	if (writeHead === readHead) return COMMAND_OP_EMPTY;
	const capacity = commandRingCapacitySlots(view, ringOff);
	const slotIdx = readHead & (capacity - 1);
	const slotOff = ringOff + COMMAND_RING_HEADER_BYTES + slotIdx * COMMAND_RING_SLOT_BYTES;
	const opCode = view.getUint8(slotOff);
	const src = new Uint8Array(
		view.buffer,
		view.byteOffset + slotOff + 1,
		COMMAND_RING_SLOT_BYTES - 1
	);
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
