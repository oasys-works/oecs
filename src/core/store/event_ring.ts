/**
 * Event ring — SPSC ring buffer for ECS signal/event payloads shared
 * between TS and the Zig sim. (#247 / Phase 4 PR 4C)
 *
 * Same byte layout as the command ring (`command_ring.ts`); the two
 * could share a primitive but keeping them separate makes the
 * direction of flow explicit: command ring is WASM→TS (structural
 * intents to drain post-tick); event ring is bidirectional during
 * `tick()` — Zig systems push events, TS readers (or other Zig
 * systems) drain.
 *
 * Layout (identical to command ring):
 *
 *   [ write_head:    u32 ]   slot 0..N-1, monotonic (NOT slot-modulo)
 *   [ read_head:     u32 ]   slot 0..N-1, monotonic
 *   [ capacity:      u32 ]   slot count, power-of-two
 *   [ overflow_flag: u32 ]   0 = OK; 1 = sticky overflow witness
 *   [ slot 0:        16 B ]  opCode: u8, payload: [15]u8
 *   [ slot 1:        16 B ]  ...
 *
 * Op codes: event-def IDs (assigned by `ECS.registerEvent()` at
 * registration time; #247 plan §required-FFI). The 0 op-code is
 * reserved as the empty-slot marker so a zero-initialised SAB does not
 * appear to hold a valid event. Event-def registration starts numbering
 * from 1 to honour this; the engine integration in 4D+ enforces it.
 *
 * SPSC contract (Phase 4 scope, single host thread):
 *   - Producer: Zig sim `tick()` (post-4D) OR TS host (test producers /
 *     existing JS-side emitters bridged into the ring).
 *   - Consumer: TS host drain (post-4D) OR Zig system that reads
 *     queued events from a sibling system.
 *   - The two never run concurrently in Phase 4 (single host thread
 *     orchestrates both). Phase 5's worker offload promotes the head
 *     bumps to `Atomics.store`; that's an additive change without
 *     altering the layout.
 *
 * Payload size: fixed 15 bytes per slot. Today's events all fit
 * (e.g. a 12-byte 3-field event, a 4-byte 1-field event, a 0-field
 * signal). Larger payloads require a separate variable-size ring
 * design — out of scope here.
 *
 * Region placement: between the entity-index region and the descriptor
 * region so its offset is stable across descriptor / column growth.
 * `header.event_ring_off` (the field promoted out of `_reserved0` in
 * #245's reservation) carries the offset; 0 means absent.
 */

/** Total bytes for the ring header. Matches command ring exactly. */
export const EVENT_RING_HEADER_BYTES = 16;

/** Fixed slot size — 1-byte opCode + 15-byte payload. Matches
 * command ring exactly. */
export const EVENT_RING_SLOT_BYTES = 16;

/** Default ring capacity in slots. 256 × 16 B = 4 KiB of slot data
 * plus 16 B header. Mirrors `COMMAND_RING_DEFAULT_CAPACITY_SLOTS`. */
export const EVENT_RING_DEFAULT_CAPACITY_SLOTS = 256;

/** Byte offsets within the ring header. Mirrored on the Zig side in
 * `packages/sim/src/event_ring.zig` — keep in sync. */
export const EVENT_RING_HEADER_OFFSETS = {
	write_head: 0,
	read_head: 4,
	capacity_slots: 8,
	overflow_flag: 12
} as const;

/** Op-code = `0` is reserved across the SAB layer as "empty slot"
 * (see file header). Event-def IDs start at 1; `ECS.registerEvent`
 * shifts to honour this when wiring SAB-backed channels in 4D+. */
export const EVENT_OP_EMPTY = 0;

/** Total bytes the ring occupies for `capacity_slots` slots. */
export function eventRingBytes(capacitySlots: number): number {
	return EVENT_RING_HEADER_BYTES + capacitySlots * EVENT_RING_SLOT_BYTES;
}

function isPow2(n: number): boolean {
	return n > 0 && (n & (n - 1)) === 0;
}

export class EventRingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EventRingError";
	}
}

/** Initialise the ring header at `ringOff` in the SAB. Zeroes
 * `write_head`, `read_head`, and `overflow_flag`; sets `capacity_slots`.
 * Slot bytes are left as-is (callers normally allocate the ring on a
 * fresh, zero-initialised SAB). */
export function initEventRing(view: DataView, ringOff: number, capacitySlots: number): void {
	if (!isPow2(capacitySlots)) {
		throw new EventRingError(
			`event ring capacity_slots must be a positive power of two (got ${capacitySlots})`
		);
	}
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.write_head, 0, true);
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.read_head, 0, true);
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.capacity_slots, capacitySlots, true);
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.overflow_flag, 0, true);
}

export function ringWriteHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + EVENT_RING_HEADER_OFFSETS.write_head, true);
}
export function ringReadHead(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + EVENT_RING_HEADER_OFFSETS.read_head, true);
}
export function ringCapacitySlots(view: DataView, ringOff: number): number {
	return view.getUint32(ringOff + EVENT_RING_HEADER_OFFSETS.capacity_slots, true);
}
export function ringOverflow(view: DataView, ringOff: number): boolean {
	return view.getUint32(ringOff + EVENT_RING_HEADER_OFFSETS.overflow_flag, true) !== 0;
}

/** Pending event count = `(write_head - read_head) mod 2^32`. */
export function pendingEventCount(view: DataView, ringOff: number): number {
	return (ringWriteHead(view, ringOff) - ringReadHead(view, ringOff)) >>> 0;
}

/** Push an event into the ring. Returns `false` on overflow and sets
 * the (sticky) overflow flag. `opCode` must be > 0 — 0 is reserved as
 * the empty-slot marker. Payload must be exactly 15 bytes. */
export function pushEvent(
	view: DataView,
	ringOff: number,
	opCode: number,
	payload: Uint8Array
): boolean {
	if (opCode === EVENT_OP_EMPTY) {
		throw new EventRingError(`event op_code must be > 0 (0 is reserved as the empty-slot marker)`);
	}
	if (opCode < 0 || opCode > 0xff || !Number.isInteger(opCode)) {
		throw new EventRingError(`event op_code must be a u8 in [1, 255] (got ${opCode})`);
	}
	if (payload.byteLength !== EVENT_RING_SLOT_BYTES - 1) {
		throw new EventRingError(
			`event payload must be ${EVENT_RING_SLOT_BYTES - 1} bytes (got ${payload.byteLength})`
		);
	}
	const writeHead = ringWriteHead(view, ringOff);
	const readHead = ringReadHead(view, ringOff);
	const capacity = ringCapacitySlots(view, ringOff);
	if ((writeHead - readHead) >>> 0 >= capacity) {
		view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.overflow_flag, 1, true);
		return false;
	}
	const slotIdx = writeHead & (capacity - 1);
	const slotOff = ringOff + EVENT_RING_HEADER_BYTES + slotIdx * EVENT_RING_SLOT_BYTES;
	view.setUint8(slotOff, opCode);
	// boundary: TypedArray interop. Materialise a payload-sized view at
	// the slot's payload region and copy in. Mirrors `pushCommand`.
	const dest = new Uint8Array(view.buffer, slotOff + 1, EVENT_RING_SLOT_BYTES - 1);
	dest.set(payload);
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.write_head, (writeHead + 1) >>> 0, true);
	return true;
}

/** Read one event from the ring. Returns opCode (0 = empty/no event)
 * and fills `outPayload` with 15 bytes. When 0 is returned,
 * `outPayload` is untouched. */
export function popEvent(view: DataView, ringOff: number, outPayload: Uint8Array): number {
	if (outPayload.byteLength !== EVENT_RING_SLOT_BYTES - 1) {
		throw new EventRingError(
			`out_payload must be ${EVENT_RING_SLOT_BYTES - 1} bytes (got ${outPayload.byteLength})`
		);
	}
	const writeHead = ringWriteHead(view, ringOff);
	const readHead = ringReadHead(view, ringOff);
	if (writeHead === readHead) return EVENT_OP_EMPTY;
	const capacity = ringCapacitySlots(view, ringOff);
	const slotIdx = readHead & (capacity - 1);
	const slotOff = ringOff + EVENT_RING_HEADER_BYTES + slotIdx * EVENT_RING_SLOT_BYTES;
	const opCode = view.getUint8(slotOff);
	const src = new Uint8Array(view.buffer, slotOff + 1, EVENT_RING_SLOT_BYTES - 1);
	outPayload.set(src);
	view.setUint32(ringOff + EVENT_RING_HEADER_OFFSETS.read_head, (readHead + 1) >>> 0, true);
	return opCode;
}

/** Drain every pending event, calling `handler` for each. Yields a
 * freshly-copied 15-byte Uint8Array per event so handlers can hold the
 * payload past the next iteration. Returns the count drained. */
export function drainEventRing(
	view: DataView,
	ringOff: number,
	handler: (opCode: number, payload: Uint8Array) => void
): number {
	let drained = 0;
	const scratch = new Uint8Array(EVENT_RING_SLOT_BYTES - 1);
	for (;;) {
		const op = popEvent(view, ringOff, scratch);
		if (op === EVENT_OP_EMPTY) return drained;
		handler(op, scratch.slice());
		drained++;
	}
}
