/***
 * The workers plugin. One pool of workers, and the systems it runs.
 *
 * Install it to give a world `ecs.workers`, which starts a pool, reports it and
 * stops it. A world that does not install it carries neither the pool, nor the
 * plan builder, nor the shim that reaches the node threads module. That is the
 * reason this is a plugin: the pool is the share of the package every program
 * shipped and almost no program used.
 *
 * The `parallel` config on a system stays in the core, because it is a type and
 * it erases. So does the routing in the schedule, which reads one opaque field
 * on the frozen descriptor. A world without this plugin builds no plan, leaves
 * that field undefined, and runs the system's own `fn`.
 *
 * One thing goes with the plugin, and a caller has to know it. A world without
 * the plugin validates no `parallel` config, because the refusals live in the
 * plan builder. A mistyped column list surfaces once the plugin is installed.
 *
 * Cold path. Install once, attach once, and the frame path is untouched.
 ***/

import { WorkerPool, type AttachWorkersOptions } from "./pool";
import { assertParallelConfig, createParallelPlan, type ParallelPlan } from "./plan";
import type { Plugin, PluginHost, WorkerHooks, WorkerWorld } from "../../core/ecs/plugin";
import type { ComponentDef } from "../../core/ecs/component";
import type { Query } from "../../core/ecs/query";
import type { SystemConfig } from "../../core/ecs/system";
import { ECS_ERROR, ECSError } from "../../core/ecs/utils/error";
import { DEV } from "../../dev_flag";

export { WorkerPool, DEFAULT_JOIN_TIMEOUT_MS } from "./pool";
export type { AttachWorkersOptions } from "./pool";

/**
 * Start, report and stop the one pool a world runs its parallel systems on.
 *
 * It is also what the world calls back into. `plan` runs at registration, for
 * a system that declares `parallel`. `dispose` runs with the world. Both are
 * the plugin's half of the seam, not surface a caller uses.
 */
export class ECSWorkers implements WorkerHooks {
	private readonly _world: WorkerWorld;
	/** Resolve the default query of a `parallel` config, which is the first
	 * entry of `queries` read as a with-only query. */
	private readonly _resolveQuery: (defs: ComponentDef[]) => Query<any>;
	private readonly _fieldId: (def: ComponentDef<any>, field: string) => number;
	/** Every parallel plan, in registration order. The pool loads a kernel for
	 * each and clears them all on detach. */
	private readonly _plans: ParallelPlan[] = [];
	private _pool: WorkerPool | null = null;

	/** @internal Built by `workers()`, never by a caller. */
	constructor(host: PluginHost) {
		const store = host.store;
		const world = host.world;
		this._resolveQuery = (defs) => world.query(...defs);
		this._fieldId = (def, field) => store.fieldIdOf(def, field);
		// Last, because it hands `this` to the world. The world stores the
		// reference and calls nothing back during the install.
		this._world = host.installWorkers(this);
	}

	/** The attached pool, or `null`. */
	public get pool(): WorkerPool | null {
		return this._pool;
	}

	/**
	 * Start a pool of workers and run this world's parallel systems on it.
	 *
	 * Each worker gets the store bytes, the store base and a control buffer, and
	 * loads the kernel of every parallel system already registered. The promise
	 * resolves when every worker is parked on the barrier with its kernels in
	 * hand. A system registered later runs `fn` until `pool.settled()` resolves.
	 *
	 * The world's backing must be `shared` or `wasm`, because a worker reads the
	 * bytes directly. The host must be able to block on `Atomics.wait`, which a
	 * browser main thread refuses. One pool per world.
	 *
	 * The host parks on every pass, so a worker that dies would park it for the
	 * life of the process. `joinTimeoutMs` bounds that wait, fails the frame
	 * with `PARALLEL_KERNEL_FAILED`, and leaves every later frame on the
	 * sequential body until the caller detaches.
	 *
	 * Cold path. Call it once, outside any frame.
	 *
	 * @example
	 * const pool = await world.workers.attach({ count: 4 });
	 * // later
	 * await world.workers.detach();
	 */
	public async attach(options?: AttachWorkersOptions): Promise<WorkerPool> {
		if (this._pool !== null) {
			throw new ECSError(
				ECS_ERROR.WORKERS_ATTACHED,
				"workers.attach: this world already holds a pool. One pool per world, detach it before you attach another."
			);
		}
		const store = this._world.backing;
		if (store === null) {
			throw new ECSError(
				ECS_ERROR.WORKERS_NEED_SHARED_BACKING,
				`workers.attach: this world's backing is '${this._world.backingSource}', and a worker cannot reach its bytes. Build the world with memory.backing "shared" or { wasm }.`
			);
		}
		const pool = await WorkerPool.attach(
			{
				store,
				storeBase: this._world.storeBase,
				noteScan: (componentId: number) => this._world.noteScan(componentId),
				plans: () => this._plans,
				released: () => {
					this._pool = null;
					this._world.route(null);
				}
			},
			options
		);
		// A detach that raced this line would leave the schedule holding a dead
		// pool, so the assignment happens after `attach` resolves and never
		// before.
		this._pool = pool;
		this._world.route(pool);
		return pool;
	}

	/** Stop the workers and put every parallel system back on its `fn`.
	 * Resolves at once on a world that holds no pool. */
	public async detach(): Promise<void> {
		const pool = this._pool;
		if (pool === null) return;
		await pool.detach();
	}

	/** @internal The registration seam. Resolves one `parallel` config into the
	 * plan the dispatch reads, and refuses what a worker cannot serve. */
	public plan(config: SystemConfig): ParallelPlan {
		const parallel = config.parallel!;
		let query = parallel.query;
		if (query === undefined) {
			const group = config.queries?.[0];
			if (group === undefined) {
				throw new ECSError(
					ECS_ERROR.PARALLEL_ACCESS,
					`registerSystem: config${config.name ? ` '${config.name}'` : ""} declares 'parallel' with neither 'parallel.query' nor a first entry in 'queries'. A worker resolves the matched archetypes from a query, so one is required.`
				);
			}
			query = this._resolveQuery(group as ComponentDef[]);
		}
		if (DEV) assertParallelConfig(config, query);
		const plan = createParallelPlan(parallel, query, config.writes, this._fieldId);
		this._plans.push(plan);
		// A pool that is already attached takes the kernel now. The system runs
		// `fn` until every worker holds it, which `pool.settled()` awaits.
		this._pool?.register(plan);
		return plan;
	}

	/** @internal The world is going away. The workers hold the store bytes and
	 * keep the process alive, so they stop with it. `ECS.dispose` is
	 * synchronous and the stop is not, so this starts it and awaits nothing. */
	public dispose(): void {
		void this._pool?.detach();
		this._plans.length = 0;
	}
}

/** The world surface this plugin adds. */
export interface WorkersPlugin {
	readonly workers: ECSWorkers;
}

/** The workers plugin, for `ECS.create({ plugins: [workers()] })`. */
export function workers(): Plugin<WorkersPlugin> {
	return {
		name: "workers",
		install(host: PluginHost): WorkersPlugin {
			return { workers: new ECSWorkers(host) };
		}
	};
}
