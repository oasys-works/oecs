/***
 * The words a host and a worker share, and the messages that cross once.
 *
 * The control buffer is one small `SharedArrayBuffer` beside the store. The
 * host writes the job, bumps the epoch and wakes every worker. Each worker adds
 * one to the done word when it finishes, and the worker that completes the
 * count notifies it. Nothing else crosses during a frame, because `postMessage`
 * is far slower than an `Atomics` release and a parked worker never runs a
 * message callback anyway.
 *
 * The store buffer never travels here. A worker holds it from its start
 * message and reads it directly.
 *
 * This module imports the ABI constants and nothing else. The worker entry runs
 * outside the bundler, so every import in its chain names the file with its
 * extension.
 ***/

import { COMPONENT_MASK_WORDS } from "../../store/vendored_abi/abi.ts";

/** The frame number, and the word every worker sleeps on. */
export const CTL_EPOCH = 0;
/**
 * How many workers finished this epoch. The host clears it before it bumps the
 * epoch, and every worker adds one when its pass ends, whether the kernel ran
 * or threw.
 *
 * One worker notifies this word, and it is the one whose add carried the count
 * to the worker count. An earlier notify only wakes a host that reads a short
 * count and parks again. So the host wakes once for each pass and not once for
 * each worker.
 */
export const CTL_DONE = 1;
/** Which kernel slot to run, or one of the control jobs below. */
export const CTL_KERNEL = 2;
/** The first failing worker's index plus one. Zero means every worker ran. */
export const CTL_FAILED = 3;
/** The query's include mask, `COMPONENT_MASK_WORDS` little-endian words. */
export const CTL_INCLUDE = 4;
/** The query's exclude mask, read only when `CTL_HAS_EXCLUDE` is one. */
export const CTL_EXCLUDE = CTL_INCLUDE + COMPONENT_MASK_WORDS;
export const CTL_HAS_EXCLUDE = CTL_EXCLUDE + COMPONENT_MASK_WORDS;

const CTL_WORDS = CTL_HAS_EXCLUDE + 1;

/** `dt`, as an index into a `Float64Array` over the same bytes. It sits above
 * every word above, on the next 8-byte boundary. */
export const CTL_DT = (CTL_WORDS + 1) >> 1;

export const CONTROL_BYTES = (CTL_DT + 1) * 8;

/** Leave the barrier loop and return to the event loop, so the worker can take
 * a kernel registration. A parked worker runs no message callback, so the host
 * has to release it first. */
export const JOB_YIELD = -1;
/** Leave the barrier loop and stop. */
export const JOB_STOP = -2;

// ── The shadow stack of a wasm kernel ───────────────────────────────────────

/**
 * The frame alignment an LLVM wasm target keeps for its shadow stack. A region
 * that is a multiple of this needs no rounding at its top.
 *
 * The host validates `stackBytes` against it and the worker carves against it,
 * so both live here rather than in either half.
 */
export const KERNEL_STACK_ALIGN = 16;

/**
 * The smallest stack region a worker accepts, one WASM page.
 *
 * A wasm stack has no guard page, so a kernel that runs past the bottom of its
 * region writes into the region below it and nothing reports the overrun. The
 * floor catches a caller who reserved nothing. It does not size the stack of a
 * deep kernel, and no engine can. The caller reserves the span and says how
 * much of it one worker gets.
 */
export const KERNEL_STACK_MIN_BYTES = 65_536;

/** What a worker receives before it does anything. `store` is the
 * `WebAssembly.Memory` on the wasm backing and the `SharedArrayBuffer` on the
 * shared backing, because the two grow differently: the memory hands back a new
 * buffer object and freezes the old one at its pre-grow length, while the
 * shared buffer grows in place. */
export interface WorkerStart {
	readonly store: SharedArrayBuffer | WebAssembly.Memory;
	readonly storeBase: number;
	readonly control: SharedArrayBuffer;
	readonly index: number;
	readonly count: number;
	/** Bytes of shadow stack one instance of a `wasm` kernel module gets, or 0
	 * when the caller named none. At 0 the worker divides the whole span between
	 * the module's `__heap_base` and the store base, which leaves the module no
	 * heap. */
	readonly stackBytes: number;
}

/** One kernel a worker loads, addressed by its slot for the rest of the run.
 * A worker cannot receive a closure, which is why a kernel is a module and an
 * export name. */
export interface KernelMessage {
	readonly type: "kernel";
	readonly slot: number;
	/** A compiled module, structured-clone safe, shared with every worker. */
	readonly wasm?: WebAssembly.Module;
	/** An absolute module URL the worker imports. */
	readonly js?: string;
	readonly exportName: string;
	/** `(component_id, field_id)` pairs, flat, in the kernel's argument order. */
	readonly specs: Int32Array;
}

/** Re-enter the barrier loop. */
export interface RunMessage {
	readonly type: "run";
}

export type HostMessage = KernelMessage | RunMessage;

export interface WorkerReply {
	/** `ready` once at start, `kernel` for one registration, `yielded` when the
	 * worker leaves the barrier loop. */
	readonly type: "ready" | "kernel" | "yielded";
	readonly slot?: number;
	/** The failure text, when a kernel would not load. */
	readonly error?: string;
}
