/**
 * Action ring — main-thread producer / worker-thread consumer SPSC ring
 * for client input intents (`send_action`-shaped bytes). Plan §6.5 task
 * 3 / `docs/ideas/buffer-wasm-sim-plan-2026-05-14T1600.md`.
 *
 * Same on-the-wire shape as `command_ring.ts`, but with two practical
 * differences:
 *
 *   1. Producer/consumer roles flip — the action ring is main → worker,
 *      whereas the command ring is sim → host.
 *   2. Slot payload carries a `length` prefix because client actions are
 *      variable-width (the encoded bytes that would normally go straight
 *      to the WebSocket). `payload[0]` is the length in bytes; bytes
 *      `[1..1+length)` are the action payload itself.
 *
 * Layout (identical to command ring header):
 *
 *   [ write_head:   u32 ]   monotonic; modulo `capacity_slots` for slot
 *   [ read_head:    u32 ]   monotonic
 *   [ capacity:     u32 ]   slot count, power-of-two
 *   [ overflow:     u32 ]   0 = OK; 1 = ring exhausted (producer side)
 *   [ slot 0:       16 B ]  length: u8, payload: [15]u8
 *   [ slot 1:       16 B ]  ...
 *
 * SPSC contract:
 *   - Producer: main thread, from `GameNetworkClient.send_action`. Pushes
 *     one entry per user action; `Atomics.store`s `write_head` after each.
 *   - Consumer: sim worker, drained on each `apply_diff` / `apply_snapshot`
 *     boundary. `Atomics.store`s `read_head` after each pop.
 *   - Today's consumer is a no-op observer (logs / counts in DEV) — the
 *     wire path still goes main → WebSocket → server. PR 5N migrates the
 *     `PredictionReconciler` into the worker so the action ring becomes
 *     load-bearing for client-side prediction.
 *
 * Overflow:
 *   - If main writes a slot when `(write_head - read_head) === capacity`,
 *     it sets `overflow = 1` and the push returns `false`. The server
 *     send path is independent (`_transport.send(...)` ran first), so an
 *     overflow doesn't drop the action — it only drops worker
 *     observability for that one entry.
 *
 * Atomics: the head fields (`write_head` / `read_head`) are the
 * cross-thread synchronization edge — the producer runs on the main
 * thread, the consumer in the sim worker, and both alias the same
 * `SharedArrayBuffer`. The producer writes the slot bytes, then
 * `Atomics.store`s `write_head`; the consumer `Atomics.load`s
 * `write_head` before touching the slot, reads it, then `Atomics.store`s
 * `read_head`. These SeqCst ops establish the happens-before that a
 * plain `DataView` write does not under the JS memory model (#374):
 * without them the worker could observe a bumped `write_head` before the
 * producer's `setUint8(len)` + payload `set()` are visible and read a
 * torn/stale slot, and the producer could read a stale `read_head`
 * (false overflow, or overwrite a slot mid-read). Slot payload bytes
 * stay on plain `DataView` / `Uint8Array` ops — the head Atomics fence
 * them, so no per-byte atomic is needed. A future PR may still add an
 * `Atomics.wait/notify` pair so the worker can block between actions
 * instead of polling — additive change, no layout shift.
 */

/** Total bytes for the ring header. Identical to `command_ring`. */
export const ACTION_RING_HEADER_BYTES = 16;

/** Fixed slot size — 1-byte length + 15-byte payload. */
export const ACTION_RING_SLOT_BYTES = 16;

/** Default ring capacity in slots. Sized for ~250 ms of click-spam at 60
 * Hz on the high end of human input rates; 256 × 16 B = 4 KiB + 16 B
 * header. */
export const ACTION_RING_DEFAULT_CAPACITY_SLOTS = 256;

/** Max payload bytes per slot (slot size minus the length prefix). All
 * actions defined in `packages/protocol/src/actions.ts` encode to under
 * 8 bytes, so this is comfortably above today's max. */
export const ACTION_RING_MAX_PAYLOAD_BYTES = ACTION_RING_SLOT_BYTES - 1;

/** Byte offsets within the ring header. Matches `command_ring` so a
 * future shared helper can normalise across both rings without per-ring
 * arithmetic. */
export const ACTION_RING_HEADER_OFFSETS = {
	write_head: 0,
	read_head: 4,
	capacity_slots: 8,
	overflow_flag: 12
} as const;

/** `Int32Array` element indices for the four header u32s — the byte
 * offsets above divided by 4. The head region is accessed exclusively
 * through `Atomics.{load,store}` on this index space so the producer and
 * consumer (different agents over one `SharedArrayBuffer`) get a
 * sequentially-consistent happens-before edge; see the file header. */
const HEAD_WRITE_IDX = ACTION_RING_HEADER_OFFSETS.write_head / 4;
const HEAD_READ_IDX = ACTION_RING_HEADER_OFFSETS.read_head / 4;
const HEAD_CAPACITY_IDX = ACTION_RING_HEADER_OFFSETS.capacity_slots / 4;
const HEAD_OVERFLOW_IDX = ACTION_RING_HEADER_OFFSETS.overflow_flag / 4;

/** Alias an `Int32Array` over the 4-u32 header region at `ringOff`.
 * `Atomics` ops need an integer TypedArray (works on both `ArrayBuffer`
 * and `SharedArrayBuffer` backings). The element-offset arithmetic
 * requires the absolute byte offset to be 4-aligned; `initActionRing`
 * enforces that. Heads are stored as signed int32 but interpreted
 * unsigned by callers via `>>> 0`, matching the prior `getUint32`. */
function headView(view: DataView, ringOff: number): Int32Array {
	// boundary: TypedArray interop. The header u32s are int-aliased so the
	// head bumps can use Atomics for cross-thread ordering (#374).
	return new Int32Array(view.buffer, view.byteOffset + ringOff, 4);
}

/** Total bytes the ring occupies for `capacity_slots` slots. */
export function actionRingBytes(capacitySlots: number): number {
	return ACTION_RING_HEADER_BYTES + capacitySlots * ACTION_RING_SLOT_BYTES;
}

function isPow2(n: number): boolean {
	return n > 0 && (n & (n - 1)) === 0;
}

export class ActionRingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionRingError";
	}
}

/** Initialise the ring header at `ringOff` in the SAB. Zeroes heads
 * and the overflow flag; sets `capacity_slots`. Slot bytes are left
 * as-is (callers normally allocate the ring on a zero-initialised SAB). */
export function initActionRing(view: DataView, ringOff: number, capacitySlots: number): void {
	if (!isPow2(capacitySlots)) {
		throw new ActionRingError(
			`action ring capacity_slots must be a positive power of two (got ${capacitySlots})`
		);
	}
	if ((view.byteOffset + ringOff) % 4 !== 0) {
		throw new ActionRingError(
			`action ring header must be 4-byte aligned for Atomics ` +
				`(view.byteOffset ${view.byteOffset} + ring_off ${ringOff} is not a multiple of 4)`
		);
	}
	const heads = headView(view, ringOff);
	Atomics.store(heads, HEAD_WRITE_IDX, 0);
	Atomics.store(heads, HEAD_READ_IDX, 0);
	Atomics.store(heads, HEAD_CAPACITY_IDX, capacitySlots);
	Atomics.store(heads, HEAD_OVERFLOW_IDX, 0);
}

/** Read live ring-header fields. Heads are stored signed but returned
 * unsigned (`>>> 0`) so the monotonic-counter arithmetic below is
 * identical to the prior `getUint32` behaviour. */
export function actionRingWriteHead(view: DataView, ringOff: number): number {
	return Atomics.load(headView(view, ringOff), HEAD_WRITE_IDX) >>> 0;
}
export function actionRingReadHead(view: DataView, ringOff: number): number {
	return Atomics.load(headView(view, ringOff), HEAD_READ_IDX) >>> 0;
}
export function actionRingCapacitySlots(view: DataView, ringOff: number): number {
	return Atomics.load(headView(view, ringOff), HEAD_CAPACITY_IDX) >>> 0;
}
export function actionRingOverflow(view: DataView, ringOff: number): boolean {
	return Atomics.load(headView(view, ringOff), HEAD_OVERFLOW_IDX) !== 0;
}

/** Pending entry count = `(write_head - read_head) mod 2^32`. */
export function pendingActionCount(view: DataView, ringOff: number): number {
	return (actionRingWriteHead(view, ringOff) - actionRingReadHead(view, ringOff)) >>> 0;
}

/** Push an action into the ring. `payload` must be in
 * `[1, ACTION_RING_MAX_PAYLOAD_BYTES]`; longer payloads — and **empty**
 * ones — are an `ActionRingError` (the producer is the only caller and it
 * can size its inputs ahead of time). The zero-length rejection closes the
 * lower-bound footgun: a 0-byte slot is indistinguishable from
 * `popAction`'s empty-ring sentinel (`0`), so admitting one would let it
 * masquerade as "ring empty". No encoder produces a 0-byte payload, so this
 * only ever rejects the ABI-skew bug case (#430). Returns `false` on
 * overflow and sets the overflow flag. */
export function pushAction(view: DataView, ringOff: number, payload: Uint8Array): boolean {
	const len = payload.byteLength;
	if (len === 0) {
		throw new ActionRingError("action payload must be at least 1 byte (got 0)");
	}
	if (len > ACTION_RING_MAX_PAYLOAD_BYTES) {
		throw new ActionRingError(
			`action payload of ${len} bytes exceeds slot limit ${ACTION_RING_MAX_PAYLOAD_BYTES}`
		);
	}
	const heads = headView(view, ringOff);
	const writeHead = Atomics.load(heads, HEAD_WRITE_IDX) >>> 0;
	// Acquire load of read_head: see the consumer's freed slots so the
	// overflow check isn't a false positive on a stale value.
	const readHead = Atomics.load(heads, HEAD_READ_IDX) >>> 0;
	const capacity = Atomics.load(heads, HEAD_CAPACITY_IDX) >>> 0;
	if ((writeHead - readHead) >>> 0 >= capacity) {
		Atomics.store(heads, HEAD_OVERFLOW_IDX, 1);
		return false;
	}
	const slotIdx = writeHead & (capacity - 1);
	const slotOff = ringOff + ACTION_RING_HEADER_BYTES + slotIdx * ACTION_RING_SLOT_BYTES;
	view.setUint8(slotOff, len);
	// boundary: TypedArray interop. The DataView is owned by the caller;
	// `Uint8Array.set` is the V8-fastpath bulk copy at this seam.
	const dest = new Uint8Array(view.buffer, slotOff + 1, ACTION_RING_MAX_PAYLOAD_BYTES);
	dest.set(payload);
	// Bytes past `len` in the slot are left as-is. The consumer reads
	// only `[0..length)` so any trailing stale bytes are inert.
	//
	// Release store of write_head: the SeqCst store publishes the slot
	// writes above. The consumer's acquire load of write_head (in
	// `popAction`) sees them before it touches the slot — this is the
	// happens-before edge (#374).
	Atomics.store(heads, HEAD_WRITE_IDX, (writeHead + 1) >>> 0);
	return true;
}

/** Pop one action from the ring. Returns the byte length written into
 * `outPayload`, or `0` if the ring was empty. `outPayload` must be at
 * least `ACTION_RING_MAX_PAYLOAD_BYTES`; only the first `length` bytes
 * are meaningful after a non-zero return.
 *
 * NOTE: a `0` return is ambiguous — it means "ring empty" OR "a 0-byte
 * slot" (the latter only reachable via ABI-skew, since `pushAction`
 * rejects empty payloads). Callers that loop must decide emptiness from
 * the heads (`pendingActionCount` / `write_head === read_head`), not
 * from this return value; see `drainActionRing` and #430. */
export function popAction(view: DataView, ringOff: number, outPayload: Uint8Array): number {
	if (outPayload.byteLength < ACTION_RING_MAX_PAYLOAD_BYTES) {
		throw new ActionRingError(
			`out_payload must be at least ${ACTION_RING_MAX_PAYLOAD_BYTES} bytes (got ${outPayload.byteLength})`
		);
	}
	const heads = headView(view, ringOff);
	// Acquire load of write_head before touching the slot: pairs with the
	// producer's release store so the slot bytes written before that store
	// are visible here (#374).
	const writeHead = Atomics.load(heads, HEAD_WRITE_IDX) >>> 0;
	const readHead = Atomics.load(heads, HEAD_READ_IDX) >>> 0;
	if (writeHead === readHead) return 0;
	const capacity = Atomics.load(heads, HEAD_CAPACITY_IDX) >>> 0;
	const slotIdx = readHead & (capacity - 1);
	const slotOff = ringOff + ACTION_RING_HEADER_BYTES + slotIdx * ACTION_RING_SLOT_BYTES;
	const len = view.getUint8(slotOff);
	// boundary: TypedArray interop, same shape as `pushAction`.
	const src = new Uint8Array(view.buffer, slotOff + 1, ACTION_RING_MAX_PAYLOAD_BYTES);
	outPayload.set(src);
	// Release store of read_head: publishes the freed slot to the
	// producer's acquire load in `pushAction`.
	Atomics.store(heads, HEAD_READ_IDX, (readHead + 1) >>> 0);
	return len;
}

/** Drain every pending action, invoking `handler(payload)` per entry.
 * The `payload` passed to the handler is a freshly-copied
 * `Uint8Array(length)` so handlers can hold it past the next pop without
 * aliasing the scratch buffer. Returns the number of actions drained.
 *
 * Termination is decided from the heads (`pendingActionCount`), NOT from
 * `popAction`'s return value. A genuine 0-byte slot returns `0` — the same
 * value `popAction` yields on an empty ring — so terminating on `len === 0`
 * would silently consume the zero-length entry and strand everything queued
 * behind it for a tick (#430). The heads check is SPSC-safe: this consumer
 * is the sole reader, so a non-zero pending count cannot race to empty before
 * the `popAction` below. */
export function drainActionRing(
	view: DataView,
	ringOff: number,
	handler: (payload: Uint8Array) => void
): number {
	let drained = 0;
	const scratch = new Uint8Array(ACTION_RING_MAX_PAYLOAD_BYTES);
	while (pendingActionCount(view, ringOff) > 0) {
		const len = popAction(view, ringOff, scratch);
		// Slice copies; the handler owns the buffer.
		handler(scratch.slice(0, len));
		drained++;
	}
	return drained;
}

/** Clear the overflow flag. The producer sets it on a failed push; the
 * consumer can reset it once it has observed and logged the condition,
 * so a single overflow doesn't keep firing dev assertions. */
export function clearActionRingOverflow(view: DataView, ringOff: number): void {
	Atomics.store(headView(view, ringOff), HEAD_OVERFLOW_IDX, 0);
}
