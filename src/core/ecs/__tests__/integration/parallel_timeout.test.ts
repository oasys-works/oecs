/**
 * What the host does when a worker never reaches the join.
 *
 * A kernel that throws is caught inside the worker and reported through the
 * failed word. A worker that dies, or spins, reports nothing. The done word
 * never reaches the worker count, and a host parked on `Atomics.wait` with no
 * deadline waits for the life of the process. `joinTimeoutMs` is the deadline.
 *
 * The kernel here spins on purpose, because a spinning worker is what a dead
 * one looks like from the host, and `terminate` is the only way to end either.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../schedule";
import { ECS_ERROR, ECSError } from "../../utils/error";
import type { WorkerPool } from "../../../../plugins/workers/pool";
import { KERNELS_URL, WORKER_URL, buildWorld } from "./parallel_fixture";

const JOIN_MS = 60;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

/** A world whose only parallel system never returns from its kernel. `fn`
 * counts its own runs, so a later frame can say which path ran. */
function spinningWorld() {
	const world = buildWorld({ entities: 256, backing: "shared" });
	const { ecs, Pos, Vel } = world;
	const query = ecs.query(Pos, Vel);
	let sequentialRuns = 0;
	const system = ecs.registerSystem({
		reads: [Vel],
		writes: [Pos],
		name: "spinner",
		parallel: {
			kernel: { js: KERNELS_URL, export: "spinning" },
			columns: [
				[Pos, "x"],
				[Vel, "vx"]
			],
			minRows: 1,
			query
		},
		fn: () => {
			sequentialRuns++;
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return { ...world, runs: () => sequentialRuns };
}

describe("a worker that never reaches the join", () => {
	it("fails the frame, names the export and the budget, and leaves the world on fn", async () => {
		const world = spinningWorld();
		const pool = await world.ecs.workers.attach({
			count: 1,
			workerUrl: WORKER_URL,
			joinTimeoutMs: JOIN_MS
		});
		pools.push(pool);

		let category = "no throw";
		let message = "";
		try {
			world.ecs.update(1);
		} catch (error) {
			category = (error as ECSError).category;
			message = (error as ECSError).message;
		}
		expect(category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		expect(message).toContain("spinning");
		expect(message).toContain(String(JOIN_MS));
		expect(world.runs()).toBe(0);

		// The pool holds a worker that is still spinning, so it refuses every
		// later dispatch and the sequential body runs instead.
		expect(() => world.ecs.update(1)).not.toThrow();
		expect(world.runs()).toBe(1);

		// `terminate` ends a spinning thread, which is the only way out.
		await expect(pool.detach()).resolves.toBeUndefined();
	});
});

describe("joinTimeoutMs", () => {
	async function attachWith(value: number) {
		const world = buildWorld({ entities: 16, backing: "shared" });
		try {
			pools.push(
				await world.ecs.workers.attach({
					count: 1,
					workerUrl: WORKER_URL,
					joinTimeoutMs: value
				})
			);
		} catch (error) {
			return (error as ECSError).category;
		}
		return "no throw";
	}

	it("refuses zero, a negative value and a fraction", async () => {
		expect(await attachWith(0)).toBe(ECS_ERROR.WORKERS_COUNT_INVALID);
		expect(await attachWith(-1)).toBe(ECS_ERROR.WORKERS_COUNT_INVALID);
		expect(await attachWith(1.5)).toBe(ECS_ERROR.WORKERS_COUNT_INVALID);
	});
});
