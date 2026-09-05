/***
 * The worker pool: one persistent set of workers, one `Atomics` barrier, and
 * the join that stamps what the kernels wrote.
 *
 * The workers start once. A frame writes the job into the control buffer, bumps
 * the epoch, wakes every worker and parks on the done word. `postMessage` is
 * far slower than that, and a parked worker never runs a message callback
 * anyway, so nothing but the job crosses during a frame.
 *
 * The host wakes once for each pass. The worker that carries the done count to
 * the worker count is the only one that notifies. The release side still wakes
 * every worker, and that side grows with the worker count.
 *
 * The host parks, and that is the structural guarantee. Nothing else runs on
 * the main thread while `Atomics.wait` blocks it, so no spawn, no despawn and
 * no grow can overlap a pass. A grow relocates columns with no change to the
 * buffer reference and a swap-remove moves rows with no signal at all, so a
 * worker that ran beside either would write into abandoned bytes or visit a row
 * twice. The engine gives the guarantee by construction and not by a lock.
 *
 * The park has one hole and `joinTimeoutMs` closes it. A kernel that throws is
 * caught in the worker and reported through the failed word. A worker that dies
 * outright, or spins, reports nothing and never adds to the done word, and the
 * host has no way to observe its exit from inside the park. So the host waits
 * with a deadline, fails the pass, and answers every later dispatch with false
 * until `detach`.
 *
 * The main thread computes no plan. Each worker derives its own row range from
 * the published row counts, its index and the worker count, with the same
 * integer arithmetic. There is one source of truth and it is deterministic.
 ***/

import { COMPONENT_MASK_WORDS } from "../../core/store/vendored_abi/abi";
import type { Archetype } from "../../core/ecs/archetype";
import type { SystemContext } from "../../core/ecs/system_context";
import { ECS_ERROR, ECSError } from "../../core/ecs/utils/error";
import { loadNodeThreads } from "./node_threads";
import type { ParallelPlan } from "./plan";
import {
	CONTROL_BYTES,
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
	type WorkerReply,
	type WorkerStart
} from "./protocol";

/** What the pool needs from the world, and nothing more. */
export interface PoolWorld {
	/** The `WebAssembly.Memory` on the wasm backing, the `SharedArrayBuffer` on
	 * the shared backing. The two grow differently and the worker survives both,
	 * which is why the memory itself travels and not its current buffer. */
	readonly store: SharedArrayBuffer | WebAssembly.Memory;
	readonly storeBase: number;
	/** Tell the store that a component's row ticks changed outside the dirty
	 * list, so the next entity-level drain scans the plane. */
	noteScan(componentId: number): void;
	/** Every parallel plan the world has registered so far. */
	plans(): readonly ParallelPlan[];
	/** The pool has stopped, so the world drops it and the schedule goes back to
	 * the sequential path. */
	released(): void;
}

/**
 * How long the host waits at the join before it gives up on a worker.
 *
 * A safety net, and not a budget. A pass that takes this long has already
 * missed every frame the host meant to draw, so the value only has to sit above
 * any pass a working kernel runs, on slow hardware and under load. It is far
 * above that, and still short enough that a person watching a hung process gets
 * an error instead of a dead prompt. Tune it down only to make a hang surface
 * sooner, never to bound a frame.
 */
export const DEFAULT_JOIN_TIMEOUT_MS = 30_000;

export interface AttachWorkersOptions {
	/** Workers to start. Defaults to one below the reported parallelism, floor
	 * one. One worker is always a loss against the sequential body, so a caller
	 * that wants a split gives more than one. */
	readonly count?: number;
	/** Where the engine's worker entry lives. Defaults to `@oasys/oecs/worker`,
	 * which the package ships one directory above the module this pool lands in.
	 *
	 * A bundler moves the pool into a chunk of its own and leaves the worker
	 * entry out of the graph, so the default resolves to a file the server does
	 * not hold. Pass the URL the bundler emits for `@oasys/oecs/worker`. */
	readonly workerUrl?: string | URL;
	/** Milliseconds the host waits at the join before it gives up on the pass.
	 * A positive integer. Defaults to `DEFAULT_JOIN_TIMEOUT_MS`.
	 *
	 * A kernel that throws is caught in the worker and reported. A worker that
	 * dies outright reports nothing, so without this the host parks for the life
	 * of the process. */
	readonly joinTimeoutMs?: number;
	/**
	 * Bytes of shadow stack one instance of a `wasm` kernel module gets. An
	 * integer, a multiple of `KERNEL_STACK_ALIGN`, at least
	 * `KERNEL_STACK_MIN_BYTES`.
	 *
	 * The regions are carved downward from the store base, so with this given
	 * everything below the lowest region stays the module's heap. Without it the
	 * pool divides the whole span between the module's `__heap_base` and the
	 * store base, and the module then has no heap.
	 *
	 * A wasm stack has no guard page. A kernel that runs deeper than its region
	 * writes into the region below it and nothing reports the overrun, so this is
	 * a number only the caller can pick.
	 */
	readonly stackBytes?: number;
}

/**
 * Check `stackBytes` and hand the worker the value, or 0 when the caller named
 * none.
 *
 * The worker cannot report a named fault, because it cannot import the error
 * codes, so a value the caller controls is checked here where the message can
 * carry one. A span too small for the value it names is a fact of the module,
 * and only the worker knows it, so that one still fails at kernel load.
 *
 * Cold path.
 */
function resolveStackBytes(given: number | undefined): number {
	if (given === undefined) return 0;
	if (!Number.isInteger(given) || given < 1) {
		throw new ECSError(
			ECS_ERROR.WORKERS_COUNT_INVALID,
			`workers.attach: stackBytes must be an integer >= 1, got ${String(given)}`
		);
	}
	if (given % KERNEL_STACK_ALIGN !== 0) {
		throw new ECSError(
			ECS_ERROR.WORKERS_COUNT_INVALID,
			`workers.attach: stackBytes must be a multiple of ${KERNEL_STACK_ALIGN}, the frame alignment of a wasm shadow stack, got ${given}`
		);
	}
	if (given < KERNEL_STACK_MIN_BYTES) {
		throw new ECSError(
			ECS_ERROR.WORKERS_COUNT_INVALID,
			`workers.attach: stackBytes must be at least ${KERNEL_STACK_MIN_BYTES}, one WASM page, got ${given}`
		);
	}
	return given;
}

/** One runtime's worker, behind the two calls the pool makes. */
interface PoolWorker {
	post(message: HostMessage): void;
	/** Resolve on the next reply of `type`, and on the matching `slot` when one
	 * is given. */
	expect(type: WorkerReply["type"], slot?: number): Promise<WorkerReply>;
	terminate(): Promise<unknown>;
}

/** `failed` is the state a join timeout leaves. A worker that missed its join is
 * still running somewhere, so nothing may release it again. The pool answers
 * every later dispatch with false, the schedule runs the sequential body, and
 * `detach` is the only way out. */
type PoolState = "idle" | "running" | "failed" | "detached";

/** Whether this host can block on `Atomics.wait`. A browser main thread refuses
 * it, every other supported host allows it. The probe compares against a value
 * the word does not hold, so it returns at once when it is allowed at all. */
function hostCanPark(): boolean {
	try {
		const probe = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(probe, 0, 1, 0);
		return true;
	} catch {
		return false;
	}
}

function usesNodeWorkers(): boolean {
	const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
	return typeof proc === "object" && proc !== null && typeof proc.versions?.node === "string";
}

function defaultWorkerCount(): number {
	const reported = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
		?.hardwareConcurrency;
	if (typeof reported !== "number" || !Number.isFinite(reported)) return 1;
	return Math.max(1, Math.floor(reported) - 1);
}

/**
 * Where the worker entry lives, given where this module landed.
 *
 * The build emits this plugin one directory below the package entry, and the
 * worker beside that entry, with the same variant and format suffixes:
 * `plugins/workers.js` and `worker.js`, `plugins/workers.development.cjs` and
 * `worker.development.cjs`. So the entry is the parent directory's `worker`
 * file, carrying this module's own suffixes.
 *
 * This holds for the package as it ships, and it does not survive a bundler. A
 * bundler renames the chunk this module lands in and drops the worker entry,
 * because nothing static names it. An app that bundles the package passes
 * `workerUrl`.
 */
function defaultWorkerUrl(): URL {
	const self = new URL(import.meta.url);
	const path = self.pathname;
	const slash = path.lastIndexOf("/");
	const file = path.slice(slash + 1);
	const dot = file.indexOf(".");
	const dir = path.slice(0, slash);
	const parent = dir.slice(0, dir.lastIndexOf("/") + 1);
	self.pathname = `${parent}worker${dot < 0 ? "" : file.slice(dot)}`;
	return self;
}

/** Route replies to whoever is waiting for them. One queue per reply kind keeps
 * a kernel ack from resolving a yield wait. */
class ReplyRouter {
	private readonly _waiting: Map<string, ((reply: WorkerReply) => void)[]> = new Map();
	private readonly _arrived: Map<string, WorkerReply[]> = new Map();
	private _failure: string | null = null;

	public deliver(reply: WorkerReply): void {
		const key = reply.slot === undefined ? reply.type : `${reply.type}:${reply.slot}`;
		const waiters = this._waiting.get(key);
		if (waiters !== undefined && waiters.length > 0) {
			waiters.shift()!(reply);
			return;
		}
		// A reply can beat its wait, because the host posts and then awaits.
		const queue = this._arrived.get(key);
		if (queue === undefined) this._arrived.set(key, [reply]);
		else queue.push(reply);
	}

	/** A worker that died answers nothing. Without this every wait outstanding
	 * on it would sit there for the life of the process. */
	public fail(error: string): void {
		this._failure = error;
		for (const waiters of this._waiting.values()) {
			while (waiters.length > 0) waiters.shift()!({ type: "kernel", error });
		}
		this._waiting.clear();
	}

	public expect(type: WorkerReply["type"], slot?: number): Promise<WorkerReply> {
		if (this._failure !== null) return Promise.resolve({ type, slot, error: this._failure });
		const key = slot === undefined ? type : `${type}:${slot}`;
		const queue = this._arrived.get(key);
		if (queue !== undefined && queue.length > 0) return Promise.resolve(queue.shift()!);
		return new Promise<WorkerReply>((resolve) => {
			const waiters = this._waiting.get(key);
			if (waiters === undefined) this._waiting.set(key, [resolve]);
			else waiters.push(resolve);
		});
	}
}

async function startNodeWorkers(
	url: URL | string,
	starts: readonly WorkerStart[]
): Promise<PoolWorker[]> {
	const threads = await loadNodeThreads();
	return starts.map((start) => {
		const worker = new threads.Worker(url as URL, { workerData: start });
		const router = new ReplyRouter();
		worker.on("message", (reply: WorkerReply) => router.deliver(reply));
		worker.on("error", (error: Error) => router.fail(error.message));
		return {
			post: (message) => worker.postMessage(message),
			expect: (type, slot) => router.expect(type, slot),
			terminate: () => worker.terminate()
		};
	});
}

function startBrowserWorkers(url: URL | string, starts: readonly WorkerStart[]): PoolWorker[] {
	return starts.map((start) => {
		const worker = new Worker(url as URL, { type: "module" });
		const router = new ReplyRouter();
		worker.addEventListener("message", (event: MessageEvent) =>
			router.deliver(event.data as WorkerReply)
		);
		// A worker whose script does not load answers nothing at all, and the
		// browser reports it here. Without this the attach waits for a `ready`
		// that never comes, which is a hang and not a fault.
		//
		// A script that fails to fetch raises a plain `Event`, not an
		// `ErrorEvent`, so there is no message to read. Only a script that threw
		// while it ran carries one. The URL is the fact worth reporting either way.
		worker.addEventListener("error", (event: Event) => {
			const thrown = (event as ErrorEvent).message;
			router.fail(
				typeof thrown === "string" && thrown !== ""
					? thrown
					: `the script at '${String(url)}' did not load`
			);
		});
		worker.postMessage(start);
		return {
			post: (message) => worker.postMessage(message),
			expect: (type, slot) => router.expect(type, slot),
			terminate: () => {
				worker.terminate();
				return Promise.resolve();
			}
		};
	});
}

/**
 * The pool a world attaches. One per world, started once, and the only thing
 * that speaks to a worker.
 */
export class WorkerPool {
	private readonly _world: PoolWorld;
	private readonly _workers: PoolWorker[];
	private readonly _ctl: Int32Array;
	private readonly _ctlF64: Float64Array;
	private readonly _joinTimeoutMs: number;
	private _state: PoolState = "idle";
	private _epoch = 0;
	private _nextSlot = 0;
	private _pending: ParallelPlan[] = [];
	private _syncing: Promise<void> = Promise.resolve();

	private constructor(
		world: PoolWorld,
		workers: PoolWorker[],
		control: SharedArrayBuffer,
		joinTimeoutMs: number
	) {
		this._world = world;
		this._workers = workers;
		this._ctl = new Int32Array(control);
		this._ctlF64 = new Float64Array(control);
		this._joinTimeoutMs = joinTimeoutMs;
	}

	/** How many workers the pool runs. */
	public get count(): number {
		return this._workers.length;
	}

	/**
	 * Start the workers, hand each the store and the control buffer, and load
	 * every kernel the world has declared. Resolves when each worker is parked on
	 * the barrier with its kernels in hand. Cold path, and a caller runs it once.
	 *
	 * Throws `WORKERS_ENTRY_UNREACHABLE` when a worker's script does not load,
	 * which is what a wrong `workerUrl` looks like from here.
	 */
	public static async attach(
		world: PoolWorld,
		options?: AttachWorkersOptions
	): Promise<WorkerPool> {
		if (!hostCanPark()) {
			throw new ECSError(
				ECS_ERROR.WORKERS_HOST_CANNOT_PARK,
				"workers.attach: this host refuses Atomics.wait, so it cannot park while the workers run. Host the world inside a worker and attach the pool from there."
			);
		}
		const count = options?.count ?? defaultWorkerCount();
		if (!Number.isInteger(count) || count < 1) {
			throw new ECSError(
				ECS_ERROR.WORKERS_COUNT_INVALID,
				`workers.attach: count must be an integer >= 1, got ${String(count)}`
			);
		}
		const joinTimeoutMs = options?.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
		if (!Number.isInteger(joinTimeoutMs) || joinTimeoutMs < 1) {
			throw new ECSError(
				ECS_ERROR.WORKERS_COUNT_INVALID,
				`workers.attach: joinTimeoutMs must be an integer >= 1, got ${String(joinTimeoutMs)}`
			);
		}
		const stackBytes = resolveStackBytes(options?.stackBytes);
		const control = new SharedArrayBuffer(CONTROL_BYTES);
		const starts: WorkerStart[] = [];
		for (let i = 0; i < count; i++) {
			starts.push({
				store: world.store,
				storeBase: world.storeBase,
				control,
				index: i,
				count,
				stackBytes
			});
		}
		const url = options?.workerUrl ?? defaultWorkerUrl();
		const workers = usesNodeWorkers()
			? await startNodeWorkers(url, starts)
			: startBrowserWorkers(url, starts);
		const ready = await Promise.all(workers.map((worker) => worker.expect("ready")));
		for (let i = 0; i < ready.length; i++) {
			const error = ready[i].error;
			if (error === undefined) continue;
			await Promise.all(workers.map((worker) => worker.terminate()));
			throw new ECSError(
				ECS_ERROR.WORKERS_ENTRY_UNREACHABLE,
				`workers.attach: worker ${i} did not start from '${String(url)}': ${error}. Pass workerUrl with the URL your bundler emits for the '@oasys/oecs/worker' entry.`
			);
		}

		const pool = new WorkerPool(world, workers, control, joinTimeoutMs);
		for (const plan of world.plans()) pool._pending.push(plan);
		// Kicked even with nothing pending, so the pool always ends up parked on
		// the barrier. A pool left in the message loop would take a later kernel
		// without a yield, and the yield path would then never run in a world that
		// declared no parallel system before the attach.
		pool._kick();
		try {
			await pool.settled();
		} catch (error) {
			// A kernel that will not load rejects the attach. The workers are already
			// running, and a live worker thread keeps a process alive, so the pool
			// ends them before the fault leaves.
			await pool.detach();
			throw error;
		}
		return pool;
	}

	/** Take one kernel. The system runs `fn` until every worker holds it. */
	public register(plan: ParallelPlan): void {
		if (this._state === "detached" || this._state === "failed") return;
		this._pending.push(plan);
		this._kick();
	}

	private _kick(): void {
		this._syncing = this._syncing.then(() => this._sync());
	}

	/** Resolves when every kernel registered so far is loaded on every worker.
	 * Rejects with `PARALLEL_KERNEL_FAILED` when one would not load. */
	public settled(): Promise<void> {
		return this._syncing;
	}

	private async _sync(): Promise<void> {
		// A failed pool holds a worker that never answered its join. A yield
		// would wait on that same worker, so nothing releases it again.
		if (this._state === "detached" || this._state === "failed") return;
		const pending = this._pending;
		this._pending = [];
		if (pending.length > 0 && this._state === "running") await this._park();
		for (const plan of pending) {
			plan.slot = this._nextSlot++;
			const message: HostMessage = {
				type: "kernel",
				slot: plan.slot,
				wasm: plan.kernel.wasm,
				js: plan.kernel.js,
				exportName: plan.exportName,
				specs: plan.specs
			};
			const replies = await Promise.all(
				this._workers.map((worker) => {
					worker.post(message);
					return worker.expect("kernel", plan.slot);
				})
			);
			for (let i = 0; i < replies.length; i++) {
				const error = replies[i].error;
				if (error !== undefined) {
					throw new ECSError(
						ECS_ERROR.PARALLEL_KERNEL_FAILED,
						`worker ${i} could not load the kernel export '${plan.exportName}': ${error}. Check the module and the export name.`
					);
				}
			}
			plan.ready = true;
		}
		this._resume();
	}

	/** Release every worker out of the barrier loop, so each can take a message
	 * again. A parked worker runs no message callback. */
	private async _park(): Promise<void> {
		this._state = "idle";
		const ctl = this._ctl;
		Atomics.store(ctl, CTL_KERNEL, JOB_YIELD);
		Atomics.store(ctl, CTL_EPOCH, ++this._epoch);
		Atomics.notify(ctl, CTL_EPOCH);
		await Promise.all(this._workers.map((worker) => worker.expect("yielded")));
	}

	private _resume(): void {
		if (this._state !== "idle") return;
		for (const worker of this._workers) worker.post({ type: "run" });
		this._state = "running";
	}

	/**
	 * Run one parallel system across the pool, or say no.
	 *
	 * Returns `false` when the kernel is not loaded yet, when the pool is not on
	 * the barrier, when an earlier pass timed out, or when the matched row count
	 * is below the system's threshold. The caller then runs the sequential body,
	 * which is the same answer.
	 *
	 * Throws `PARALLEL_KERNEL_FAILED` when a kernel throws, and when a worker
	 * misses the join inside `joinTimeoutMs`. The second case is a dead or hung
	 * worker, which reports nothing, so the pool fails the pass itself.
	 *
	 * Hot path. The host parks for the length of the pass, so no structural
	 * change can overlap it.
	 */
	public run(plan: ParallelPlan, ctx: SystemContext, deltaTime: number, runTick: number): boolean {
		if (!plan.ready || this._state !== "running") return false;
		// A backend and a worker both read `row_count` and `enabled_count` out of
		// the descriptors, and those are copies. The store gates the walk on a
		// dirty flag, so a clean world pays one flag read for each dispatch.
		ctx.publishRowCounts();
		if (plan.query.entityCount < plan.minRows) return false;

		const ctl = this._ctl;
		const exclude = plan.exclude;
		Atomics.store(ctl, CTL_DONE, 0);
		Atomics.store(ctl, CTL_FAILED, 0);
		for (let w = 0; w < COMPONENT_MASK_WORDS; w++) {
			ctl[CTL_INCLUDE + w] = plan.include[w] | 0;
			ctl[CTL_EXCLUDE + w] = exclude === null ? 0 : exclude[w] | 0;
		}
		ctl[CTL_HAS_EXCLUDE] = exclude === null ? 0 : 1;
		this._ctlF64[CTL_DT] = deltaTime;
		Atomics.store(ctl, CTL_KERNEL, plan.slot);
		Atomics.store(ctl, CTL_EPOCH, ++this._epoch);
		Atomics.notify(ctl, CTL_EPOCH);

		const expected = this._workers.length;
		// The deadline spans the whole pass, not one wait, because a spurious
		// wake would otherwise restart the budget on every loop.
		//
		// One worker notifies the done word. It is the one whose add carried the
		// count to `expected`. So this loop parks once for a pass that every
		// worker finishes.
		//
		// The re-read above the park still earns its place. An early worker can
		// finish before the host reaches the wait. The compare inside
		// `Atomics.wait` is what keeps the host off a stale value.
		const deadline = performance.now() + this._joinTimeoutMs;
		for (;;) {
			const done = Atomics.load(ctl, CTL_DONE);
			if (done === expected) break;
			const left = deadline - performance.now();
			if (left <= 0) {
				// The pass wrote rows before it stalled, and the join is the only
				// place that reports them. Stamping too much is the safe direction.
				this._stamp(plan, runTick);
				this._state = "failed";
				throw new ECSError(
					ECS_ERROR.PARALLEL_KERNEL_FAILED,
					`a worker did not reach the join of the kernel export '${plan.exportName}' within joinTimeoutMs of ${this._joinTimeoutMs}. The world holds whatever the pass wrote, and every later frame runs the sequential body. Detach the pool and fix the kernel.`
				);
			}
			Atomics.wait(ctl, CTL_DONE, done, left);
		}

		this._stamp(plan, runTick);

		const failed = Atomics.load(ctl, CTL_FAILED);
		if (failed !== 0) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_KERNEL_FAILED,
				`worker ${failed - 1} threw inside the kernel export '${plan.exportName}'. The world is unchanged for the rows that worker owned. Fix the kernel, or lower parallel.minRows to keep the system sequential.`
			);
		}
		return true;
	}

	/**
	 * Stamp what the pass changed.
	 *
	 * The row tick plane and the dirty lists are main-thread JS, so the join does
	 * this and not the workers. `columnGroupMut` makes the same archetype stamp a
	 * system body makes, which is why that logic is not written twice here.
	 *
	 * The row ticks follow the same shape a chunk loop takes when it reads
	 * `cols.ticks`: fill the plane, then tell the store to scan it. Without the
	 * fill an entity-level `onSet` observer would see nothing, because the
	 * archetype stamp alone carries no row.
	 *
	 * Coarse on purpose: a parallel system reports every row of every matched
	 * archetype as changed. A finer stamp is open.
	 */
	private _stamp(plan: ParallelPlan, runTick: number): void {
		const archetypes = plan.query.archetypes as unknown as readonly Archetype[];
		const writes = plan.writes;
		for (let a = 0; a < archetypes.length; a++) {
			const archetype = archetypes[a];
			if (!archetype.hasColumns) continue;
			for (let w = 0; w < writes.length; w++) {
				const def = writes[w];
				archetype.columnGroupMut(def, runTick);
				const ticks = archetype.rowTicks[def.id as number];
				if (ticks !== undefined) ticks.fill(runTick, 0, archetype.enabledCount);
			}
		}
		for (let w = 0; w < writes.length; w++) this._world.noteScan(writes[w].id as number);
	}

	/**
	 * Stop every worker and release the pool. Idempotent.
	 *
	 * `terminate` ends a worker that is spinning inside a kernel, so this is the
	 * way out of a pool a join timeout failed. A failed pool is never released
	 * back into the barrier, so no stop job is written for it.
	 */
	public async detach(): Promise<void> {
		if (this._state === "detached") return;
		try {
			await this._syncing;
		} catch {
			// A kernel that would not load already surfaced through `settled`.
		}
		const running = this._state === "running";
		this._state = "detached";
		this._pending.length = 0;
		if (running) {
			const ctl = this._ctl;
			Atomics.store(ctl, CTL_KERNEL, JOB_STOP);
			Atomics.store(ctl, CTL_EPOCH, ++this._epoch);
			Atomics.notify(ctl, CTL_EPOCH);
		}
		await Promise.all(this._workers.map((worker) => worker.terminate()));
		for (const plan of this._world.plans()) {
			plan.ready = false;
			plan.slot = -1;
		}
		this._world.released();
	}
}
