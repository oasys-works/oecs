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
 * Every worker instantiates the same module over one memory, so the shadow
 * stack is a shared resource and the worker has to split it. `loadKernel`
 * carries that split, and the comment above `assignStackRegion` says why.
 *
 * This module imports the ABI constants, the protocol and the bind walk. It
 * cannot import `ECSError`, because the enum beside it does not survive the
 * type stripping a plain runtime does on this file. So a fault here is a plain
 * `Error`, and the pool reports it under `PARALLEL_KERNEL_FAILED`. The worker
 * entry runs outside the bundler, so every import in its chain names the file
 * with its extension.
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
	KERNEL_STACK_ALIGN,
	KERNEL_STACK_MIN_BYTES,
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
import { COMPONENT_MASK_WORDS } from "../../core/store/vendored_abi/abi.ts";

type KernelFn = (...args: number[]) => void;

/**
 * A module's `__heap_base` or `__stack_pointer`, whichever form it exports.
 *
 * A toolchain exports an address as a `WebAssembly.Global`, and a hand-emitted
 * module can export a plain number for an immutable one. Both name the same
 * address, and only the `Global` form can be moved.
 */
function globalObject(exported: unknown): WebAssembly.Global | null {
	return typeof exported === "object" && exported !== null && "value" in exported
		? (exported as WebAssembly.Global)
		: null;
}

function globalNumber(exported: unknown): number | null {
	const global = globalObject(exported);
	const raw = global === null ? exported : (global.value as unknown);
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Give this worker's instance a stack region of its own.
 *
 * Every worker instantiates one module over one memory. A wasm global is
 * per-instance, so each worker holds its own `__stack_pointer`, and every one
 * of them starts at the address the linker chose. So every worker writes its
 * frames to the same bytes, and a kernel that spills a local reads back what
 * another worker wrote. The corruption is silent and it needs no shared column.
 *
 * The regions come from `[__heap_base, storeBase)`, which is the span the
 * caller reserves above everything the module owns. They are carved downward
 * from the store base, so worker `i` owns
 * `[storeBase - (i + 1) * region, storeBase - i * region)` and its stack grows
 * down from the top of that. A stack pointer at `storeBase` writes no store
 * byte, because a frame lands below the pointer and never on it.
 *
 * `stackBytes` decides the region size and so decides what is left over.
 *
 *   - Given: the region is exactly that, the regions sit at the top of the
 *     span, and everything below the lowest one stays the module's heap.
 *   - Zero: the pool divides the whole span, so the module has no heap. That is
 *     the default.
 *
 * Downward from the top either way, so one rule covers both and a caller who
 * names `stackBytes` knows where the heap ends without knowing the count.
 *
 * A module that exports no `__stack_pointer` is left alone. The engine cannot
 * find its stack, so the contract says such a kernel may not use one.
 *
 * One worker needs no split, because one instance owns the linked stack alone.
 *
 * Cold path, once for each kernel load. A pass pays nothing.
 */
function assignStackRegion(
	instance: WebAssembly.Instance,
	exportName: string,
	storeBase: number,
	index: number,
	count: number,
	stackBytes: number
): void {
	const pointer = globalObject(instance.exports.__stack_pointer);
	if (pointer === null || count === 1) return;

	const heapBase = globalNumber(instance.exports.__heap_base);
	if (heapBase === null) {
		throw new Error(
			`the kernel export '${exportName}' comes from a module with a '__stack_pointer' and no numeric '__heap_base', so the worker cannot find the span its stack may use. Link with --export=__heap_base.`
		);
	}
	// Every region top has to land on the frame alignment, so the span's own
	// bottom does too. A linker aligns `__heap_base` already, and this costs
	// nothing when it did.
	const floor = Math.ceil(heapBase / KERNEL_STACK_ALIGN) * KERNEL_STACK_ALIGN;
	const reserve = storeBase - floor;
	const region =
		stackBytes > 0
			? stackBytes
			: Math.floor(reserve / count / KERNEL_STACK_ALIGN) * KERNEL_STACK_ALIGN;
	if (region < KERNEL_STACK_MIN_BYTES) {
		throw new Error(
			`the kernel export '${exportName}' needs one stack region for each of ${count} workers, and the ${reserve} bytes between __heap_base ${heapBase} and the store base ${storeBase} leave ${region} for each. Raise memory.storeBase to reserve at least ${count * KERNEL_STACK_MIN_BYTES} bytes above the module's heap.`
		);
	}
	// Only a caller-given `stackBytes` reaches this. A divided span fits by
	// construction, and a span too small to divide failed above.
	if (count * region > reserve) {
		throw new Error(
			`the kernel export '${exportName}' needs one stack region of ${region} bytes for each of ${count} workers, and the ${reserve} bytes between __heap_base ${heapBase} and the store base ${storeBase} hold fewer. Raise memory.storeBase, or lower stackBytes on workers.attach.`
		);
	}
	try {
		pointer.value = storeBase - index * region;
	} catch {
		throw new Error(
			`the kernel export '${exportName}' comes from a module whose '__stack_pointer' is immutable, so every worker would share one stack. Build with mutable globals, or give the kernel a body that uses no stack.`
		);
	}
}

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
	// A start payload written by an older host carries no field, so the zero here
	// means the same thing a caller who named nothing means.
	const stackBytes = start.stackBytes ?? 0;
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
				// One byte offset for each column, then begin, end and dt. A wrong
				// parameter count is the one signature fault a worker can see, because
				// the JS API reports no parameter types.
				const arity = (specs.length >> 1) + 3;
				if (call.length !== arity) {
					throw new Error(
						`the wasm kernel export '${message.exportName}' takes ${call.length} parameters and the system declares ${specs.length >> 1} columns, which needs ${arity}. Give the kernel one parameter for each column, then begin, end and dt.`
					);
				}
				assignStackRegion(instance, message.exportName, storeBase, index, count, stackBytes);
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
	 * when the host asks the worker to yield or to stop.
	 *
	 * A yield and a stop return before the report, so neither touches the done
	 * word. The host waits for a message on those two paths and not for a join. */
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
				// no text crosses. The worker still falls through to the report
				// below, otherwise the host parks for the rest of the process.
				Atomics.compareExchange(ctl, CTL_FAILED, 0, index + 1);
			}
			// Only one add leaves a finished join for the host to see. It is the add
			// that carries the count to the worker count, so it is the only one that
			// notifies. Every earlier notify woke a host that read a short count and
			// parked again, once for each worker.
			//
			// No wake is lost. `Atomics.wait` compares and parks in one step. A host
			// that read a short count and then lost the race finds the word already
			// moved, and returns without parking.
			if (Atomics.add(ctl, CTL_DONE, 1) === count - 1) Atomics.notify(ctl, CTL_DONE);
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
