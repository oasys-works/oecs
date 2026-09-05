/***
 * The worker half of the pool, written once for every runtime.
 *
 * A worker owns three things: the store bytes, a control buffer and a table of
 * kernels. It never touches the header, never writes a column it was not given,
 * never spawns and never calls back into the world.
 *
 * Two loops, and the worker is in one of them. In the message loop it takes
 * kernel registrations. In the barrier loop it sleeps on the epoch word and
 * runs one kernel for each release. `Atomics.wait` parks the whole thread, so a
 * worker inside the barrier loop runs no message callback. That is why the host
 * releases the workers with a yield job before it registers a kernel.
 *
 * Growth differs by backing and the worker survives both. The shared buffer
 * grows in place, so the same object gains length. A `WebAssembly.Memory` hands
 * back a new buffer object and freezes the old one at its pre-grow length, so
 * the worker reads `memory.buffer` again on every release. Either way the bind
 * is rebuilt only when the buffer object changed or `view_stamp` moved.
 *
 * This module imports the ABI constants, the protocol and the bind walk. The
 * worker entry runs outside the bundler, so every import in its chain names the
 * file with its extension.
 ***/

import {
	CTL_DONE,
	CTL_DT,
	CTL_EPOCH,
	CTL_EXCLUDE,
	CTL_FAILED,
	CTL_HAS_EXCLUDE,
	CTL_INCLUDE,
	CTL_KERNEL,
	JOB_STOP,
	JOB_YIELD,
	type HostMessage,
	type KernelMessage,
	type WorkerReply,
	type WorkerStart
} from "./protocol.ts";
import {
	bindArchetypes,
	readEnabledCount,
	readViewStamp,
	type BoundArchetype
} from "./worker_bind.ts";
import { COMPONENT_MASK_WORDS } from "../../store/vendored_abi/abi.ts";

type KernelFn = (...args: number[]) => void;

interface Kernel {
	readonly call: KernelFn;
	readonly exportName: string;
	readonly specs: Int32Array;
	/** A js kernel takes typed arrays, a wasm kernel takes byte offsets. */
	readonly wantViews: boolean;
	/** Reused across frames: one array of the kernel's arity, refilled per
	 * archetype. A fresh array per segment would allocate inside the pass. */
	readonly args: unknown[];
	/** What the cached bind was built from. */
	buffer: ArrayBufferLike | null;
	stamp: number;
	readonly masks: Uint32Array;
	hasExclude: boolean;
	bound: BoundArchetype[];
}

/** What a runtime adapter drives. `onMessage` takes one host message, and
 * `start` is called once the worker is ready to receive them. */
export interface WorkerRuntime {
	onMessage(message: HostMessage): void;
}

/**
 * Build the worker body. `post` sends one reply to the host, and the adapter
 * owns how that happens.
 *
 * Hot path once the barrier loop starts. Everything before it is setup.
 */
export function createWorkerRuntime(
	start: WorkerStart,
	post: (reply: WorkerReply) => void
): WorkerRuntime {
	const memory: WebAssembly.Memory | null =
		start.store instanceof SharedArrayBuffer ? null : (start.store as WebAssembly.Memory);
	const sab: SharedArrayBuffer | null = memory === null ? (start.store as SharedArrayBuffer) : null;
	const storeBase = start.storeBase;
	const index = start.index;
	const count = start.count;
	const ctl = new Int32Array(start.control);
	const ctlF64 = new Float64Array(start.control);
	const kernels: (Kernel | undefined)[] = [];
	const include = new Uint32Array(COMPONENT_MASK_WORDS);
	const exclude = new Uint32Array(COMPONENT_MASK_WORDS);

	function currentBuffer(): ArrayBufferLike {
		return memory !== null ? memory.buffer : (sab as SharedArrayBuffer);
	}

	function loadKernel(message: KernelMessage): void {
		const specs = message.specs;
		const settle = (call: KernelFn, wantViews: boolean): void => {
			kernels[message.slot] = {
				call,
				exportName: message.exportName,
				specs,
				wantViews,
				args: new Array<unknown>((specs.length >> 1) + 3),
				buffer: null,
				stamp: -1,
				masks: new Uint32Array(COMPONENT_MASK_WORDS * 2),
				hasExclude: false,
				bound: []
			};
			post({ type: "kernel", slot: message.slot });
		};
		const fail = (error: unknown): void => {
			post({
				type: "kernel",
				slot: message.slot,
				error: error instanceof Error ? error.message : String(error)
			});
		};

		try {
			if (message.wasm !== undefined) {
				if (memory === null) {
					throw new Error(
						"a wasm kernel imports the world's memory, and this world is not backed by a " +
							"WebAssembly.Memory. Build the world with the wasm backing, or give the system a js kernel"
					);
				}
				const instance = new WebAssembly.Instance(message.wasm, { env: { memory } });
				const call = instance.exports[message.exportName];
				if (typeof call !== "function") {
					throw new Error(`the wasm kernel exports no function named ${message.exportName}`);
				}
				settle(call as KernelFn, false);
				return;
			}
			void import(/* @vite-ignore */ message.js as string).then(
				(module: Record<string, unknown>) => {
					const call = module[message.exportName];
					if (typeof call !== "function") {
						fail(new Error(`the js kernel exports no function named ${message.exportName}`));
						return;
					}
					settle(call as KernelFn, true);
				},
				fail
			);
		} catch (error) {
			fail(error);
		}
	}

	/** Re-read the masks the host wrote, and say whether they moved. */
	function readMasks(kernel: Kernel): boolean {
		const hasExclude = ctl[CTL_HAS_EXCLUDE] === 1;
		let moved = hasExclude !== kernel.hasExclude;
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			include[w] = ctl[CTL_INCLUDE + w] >>> 0;
			exclude[w] = ctl[CTL_EXCLUDE + w] >>> 0;
			if (kernel.masks[w] !== include[w] || kernel.masks[COMPONENT_MASK_WORDS + w] !== exclude[w]) {
				moved = true;
			}
		}
		if (moved) {
			kernel.masks.set(include, 0);
			kernel.masks.set(exclude, COMPONENT_MASK_WORDS);
			kernel.hasExclude = hasExclude;
		}
		return moved;
	}

	function runJob(slot: number): void {
		const kernel = kernels[slot];
		if (kernel === undefined) throw new Error(`no kernel is registered in slot ${slot}`);
		const buffer = currentBuffer();
		const stamp = readViewStamp(buffer, storeBase);
		const masksMoved = readMasks(kernel);
		if (masksMoved || kernel.buffer !== buffer || kernel.stamp !== stamp) {
			kernel.bound = bindArchetypes(
				buffer,
				storeBase,
				kernel.specs,
				include,
				kernel.hasExclude ? exclude : null,
				kernel.wantViews
			);
			kernel.buffer = buffer;
			kernel.stamp = stamp;
		}

		const dt = ctlF64[CTL_DT];
		const bound = kernel.bound;
		const args = kernel.args;
		const columns = kernel.specs.length >> 1;
		for (let b = 0; b < bound.length; b++) {
			const rows = readEnabledCount(buffer, bound[b].descriptorOff);
			const begin = Math.floor((rows * index) / count);
			const end = Math.floor((rows * (index + 1)) / count);
			if (end <= begin) continue;
			const source = kernel.wantViews ? bound[b].views : bound[b].offsets;
			for (let c = 0; c < columns; c++) args[c] = source[c];
			args[columns] = begin;
			args[columns + 1] = end;
			args[columns + 2] = dt;
			(kernel.call as (...a: unknown[]) => void).apply(undefined, args);
		}
	}

	// The last epoch this worker served, kept across a yield. Reading the live
	// epoch on re-entry instead would drop a release the host wrote between the
	// run message and the first `Atomics.wait`, and the host would then park for
	// the rest of the process.
	let seen = 0;

	/** Sleep on the epoch word, run one job per release, report done. Returns
	 * when the host asks the worker to yield or to stop. */
	function barrierLoop(): boolean {
		for (;;) {
			while (Atomics.load(ctl, CTL_EPOCH) === seen) {
				Atomics.wait(ctl, CTL_EPOCH, seen);
			}
			seen = Atomics.load(ctl, CTL_EPOCH);
			const slot = Atomics.load(ctl, CTL_KERNEL);
			if (slot === JOB_STOP) return false;
			if (slot === JOB_YIELD) return true;
			try {
				runJob(slot);
			} catch {
				// The host reads one failing index and names the kernel itself, so
				// no text crosses. The worker still reports done, otherwise the
				// host parks for the rest of the process.
				Atomics.compareExchange(ctl, CTL_FAILED, 0, index + 1);
			}
			Atomics.add(ctl, CTL_DONE, 1);
			Atomics.notify(ctl, CTL_DONE);
		}
	}

	return {
		onMessage(message: HostMessage): void {
			if (message.type === "kernel") {
				loadKernel(message);
				return;
			}
			// Back into the barrier. Control returns here only when the host
			// releases the workers with a yield or a stop job.
			if (barrierLoop()) post({ type: "yielded" });
		}
	};
}
