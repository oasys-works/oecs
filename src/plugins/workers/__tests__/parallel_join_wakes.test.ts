/**
 * How many times the host comes out of the park for one pass.
 *
 * Every worker adds one to the done word, and one of them notifies it: the
 * worker whose add carried the count to the worker count. An earlier notify can
 * only wake a host that reads a short count and parks again, so the wake count
 * used to rise with the worker count and now does not.
 *
 * The count is only observable when the host actually parks, so the kernel here
 * spreads the reports over milliseconds. Worker zero reports at once and the
 * last worker reports well after it. A kernel every worker finished together
 * would leave the host free to find a complete count on its first read, and the
 * test would pass against any join at all.
 *
 * The second test drives the loop's other duty. A host that woke and then
 * stopped checking would stamp a pass the workers had not finished.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../../core/ecs/phase";
import { CTL_DONE } from "../../workers/protocol";
import type { WorkerPool } from "../../workers/pool";
import { WORKER_URL, buildWorld } from "./parallel_fixture";

const KERNELS_URL = new URL("./parallel_join_kernels.mjs", import.meta.url).href;
const WORKERS = 4;
const ENTITIES = 4096;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

/** A world whose only parallel system copies `vx` into `x`, one worker range at
 * a time, after a spin proportional to the range's first row. `fn` writes a
 * value the kernel never writes, so a sequential frame is visible in the data. */
function staggeredWorld() {
	const world = buildWorld({ entities: ENTITIES, backing: "shared" });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).not(Frozen);
	const system = ecs.registerSystem({
		reads: [Vel],
		writes: [Pos],
		name: "staggered",
		parallel: {
			kernel: { js: KERNELS_URL, export: "staggered" },
			columns: [
				[Pos, "x"],
				[Vel, "vx"]
			],
			minRows: 1,
			query
		},
		fn: () => {
			query.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				for (let i = 0; i < count; i++) p.x[i] = -1;
			});
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return { ...world, query };
}

/** Whether every matched row holds what the kernel writes. A host that returned
 * before the last worker finished leaves the tail of some range untouched. */
function everyRowCopied(world: ReturnType<typeof staggeredWorld>): boolean {
	let ok = true;
	world.query.forEachChunk((cols, count) => {
		const p = cols.read(world.Pos);
		const v = cols.read(world.Vel);
		for (let i = 0; i < count; i++) if (p.x[i] !== v.vx[i]) ok = false;
	});
	return ok;
}

/** The `Atomics.wait` the pool calls. The intrinsic also takes a
 * `BigInt64Array`, and nothing in the pool does, so the wrapper narrows to the
 * one form and casts at the two boundaries. */
type Int32Wait = (
	array: Int32Array,
	index: number,
	value: number,
	timeout?: number
) => "ok" | "not-equal" | "timed-out";

/** Run `frame` with `Atomics.wait` replaced, and give the replacement back the
 * real one. Restores on the way out, because every later test in this process
 * shares the intrinsic. */
function withWait<T>(replacement: (real: Int32Wait) => Int32Wait, frame: () => T): T {
	const real = Atomics.wait as unknown as Int32Wait;
	Atomics.wait = replacement(real) as unknown as typeof Atomics.wait;
	try {
		return frame();
	} finally {
		Atomics.wait = real as unknown as typeof Atomics.wait;
	}
}

describe("the host park", () => {
	it("wakes once for a pass, not once for each worker", async () => {
		const world = staggeredWorld();
		pools.push(await world.ecs.workers.attach({ count: WORKERS, workerUrl: WORKER_URL }));

		let wakes = 0;
		withWait(
			(real) => (array, index, value, timeout) => {
				const out = real(array, index, value, timeout);
				// "not-equal" means the host never parked, and "timed-out" means
				// nothing woke it. Only "ok" is a wake a worker paid for.
				if (index === CTL_DONE && out === "ok") wakes++;
				return out;
			},
			() => world.ecs.update(1)
		);

		expect(everyRowCopied(world)).toBe(true);
		expect(wakes).toBe(1);
	});

	it("re-reads the count after a wake that carries no worker", async () => {
		const world = staggeredWorld();
		pools.push(await world.ecs.workers.attach({ count: WORKERS, workerUrl: WORKER_URL }));

		let spurious = 0;
		withWait(
			(real) => (array, index, value, timeout) => {
				// The first park of the pass returns as if something notified it,
				// with the count still short. A host that trusted one wake would
				// stamp the pass here.
				if (index === CTL_DONE && spurious === 0) {
					spurious++;
					return "ok";
				}
				return real(array, index, value, timeout);
			},
			() => world.ecs.update(1)
		);

		expect(spurious).toBe(1);
		expect(everyRowCopied(world)).toBe(true);
	});
});
