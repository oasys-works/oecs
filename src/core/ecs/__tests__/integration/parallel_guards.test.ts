/**
 * What a parallel registration and a pool attach refuse.
 *
 * A worker sees bytes and nothing else: no sparse store, no relation, no
 * resource, no command buffer, no observer and no row-to-entity table. Every
 * declaration that reaches one of those is refused at registration, where the
 * fault names the config. A backing a worker cannot read is refused at attach.
 *
 * A kernel that throws is a fault the world survives. The pass leaves the rows
 * that worker owned alone, the frame reports the worker index and the export
 * name, and the next frame runs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { resourceKey } from "../../resource";
import { SCHEDULE } from "../../schedule";
import { ECS_ERROR, ECSError } from "../../utils/error";
import type { WorkerPool } from "../../parallel/pool";
import type { ParallelColumn } from "../../system";
import { KERNELS_URL, WORKER_URL, buildWorld } from "./parallel_fixture";

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

function category(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof ECSError ? error.category : `${(error as Error).name}`;
	}
	return "no throw";
}

describe("a parallel registration", () => {
	function fixture() {
		const ecs = ECS.create({
			deterministic: true,
			memory: { backing: "shared", maxBytes: 8 * 1024 * 1024 }
		});
		const Pos = ecs.registerComponent({ x: "i32" }, { name: "Pos" });
		const Vel = ecs.registerComponent({ vx: "i32" }, { name: "Vel" });
		const Sparse = ecs.registerSparseComponent({ s: "i32" });
		const parallel = {
			kernel: { js: KERNELS_URL, export: "integrateI32" },
			columns: [
				[Pos, "x"],
				[Vel, "vx"]
			],
			minRows: 1
		};
		const base = {
			reads: [Vel],
			writes: [Pos],
			queries: [[Pos, Vel]],
			parallel,
			fn: () => {}
		};
		return { ecs, Pos, Vel, Sparse, base };
	}

	it("refuses a sparse term", () => {
		const { ecs, Sparse, base } = fixture();
		expect(category(() => ecs.registerSystem({ ...base, sparseReads: [Sparse] } as never))).toBe(
			ECS_ERROR.PARALLEL_ACCESS
		);
	});

	it("refuses a resource", () => {
		const { ecs, base } = fixture();
		const key = resourceKey<number>("count");
		expect(category(() => ecs.registerSystem({ ...base, resourceReads: [key] } as never))).toBe(
			ECS_ERROR.PARALLEL_ACCESS
		);
	});

	it("refuses a spawn declaration", () => {
		const { ecs, Pos, base } = fixture();
		expect(category(() => ecs.registerSystem({ ...base, spawns: [[Pos]] } as never))).toBe(
			ECS_ERROR.PARALLEL_ACCESS
		);
	});

	it("refuses exclusive", () => {
		const { ecs, base } = fixture();
		expect(category(() => ecs.registerSystem({ ...base, exclusive: true } as never))).toBe(
			ECS_ERROR.PARALLEL_ACCESS
		);
	});

	it("refuses a query that carries a sparse term", () => {
		const { ecs, Pos, Vel, Sparse, base } = fixture();
		const query = ecs.query(Pos, Vel).withSparse(Sparse);
		expect(
			category(() =>
				ecs.registerSystem({ ...base, parallel: { ...base.parallel, query } } as never)
			)
		).toBe(ECS_ERROR.PARALLEL_ACCESS);
	});

	it("refuses a query that includes disabled rows", () => {
		const { ecs, Pos, Vel, base } = fixture();
		const query = ecs.query(Pos, Vel).includeDisabled();
		expect(
			category(() =>
				ecs.registerSystem({ ...base, parallel: { ...base.parallel, query } } as never)
			)
		).toBe(ECS_ERROR.PARALLEL_ACCESS);
	});

	it("refuses a write the column list does not name", () => {
		const { ecs, Pos, Vel, base } = fixture();
		const parallel = { ...base.parallel, columns: [[Pos, "x"]] };
		expect(
			category(() =>
				ecs.registerSystem({ ...base, writes: [Pos, Vel], parallel } as never)
			)
		).toBe(ECS_ERROR.PARALLEL_ACCESS);
	});

	it("accepts the declaration the engine serves", () => {
		const { ecs, base } = fixture();
		expect(category(() => ecs.registerSystem(base as never))).toBe("no throw");
	});

	it("takes the config with no cast, and holds each field name to its schema", () => {
		const ecs = ECS.create({
			deterministic: true,
			memory: { backing: "shared", maxBytes: 8 * 1024 * 1024 }
		});
		const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
		const Vel = ecs.registerComponent({ vx: "i32" }, { name: "Vel" });
		const query = ecs.query(Pos, Vel);
		const system = ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			queries: [[Pos, Vel]],
			parallel: {
				kernel: { js: KERNELS_URL, export: "integrateI32" },
				columns: [
					[Pos, "x"],
					[Pos, "y"],
					[Vel, "vx"]
				],
				minRows: 1,
				query
			},
			fn: () => {}
		});
		expect(system.parallelPlan).toBeDefined();

		// A field the component does not declare fails to compile. The runtime
		// guard would catch it too, and this catches it a build earlier.
		const wrongField: ParallelColumn<typeof Pos> =
			// @ts-expect-error 'z' is not a field of Pos
			[Pos, "z"];
		expect(wrongField[0]).toBe(Pos);
	});
});

describe("attachWorkers", () => {
	it("refuses a heap world", async () => {
		const ecs = ECS.create({ memory: { maxBytes: 4 * 1024 * 1024 } });
		let caught = "no throw";
		try {
			pools.push(await ecs.attachWorkers({ count: 1, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = (error as ECSError).category;
		}
		expect(caught).toBe(ECS_ERROR.WORKERS_NEED_SHARED_BACKING);
	});

	it("refuses a second pool on one world", async () => {
		const world = buildWorld({ entities: 16, backing: "shared" });
		pools.push(await world.ecs.attachWorkers({ count: 1, workerUrl: WORKER_URL }));
		let caught = "no throw";
		try {
			pools.push(await world.ecs.attachWorkers({ count: 1, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = (error as ECSError).category;
		}
		expect(caught).toBe(ECS_ERROR.WORKERS_ATTACHED);
	});

	it("refuses a worker count below one", async () => {
		const world = buildWorld({ entities: 16, backing: "shared" });
		let caught = "no throw";
		try {
			pools.push(await world.ecs.attachWorkers({ count: 0, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = (error as ECSError).category;
		}
		expect(caught).toBe(ECS_ERROR.WORKERS_COUNT_INVALID);
	});

	it("refuses a worker entry that is not there, instead of waiting for it", async () => {
		// A worker whose script does not load answers no `ready`. The attach used
		// to wait on that answer for the life of the process, which is what a
		// bundled app hits when it keeps the default URL. The fault names the URL
		// and the option that fixes it.
		const world = buildWorld({ entities: 16, backing: "shared" });
		const missing = new URL("./no_such_worker.ts", WORKER_URL);
		let caught = "no throw";
		let message = "";
		try {
			pools.push(await world.ecs.attachWorkers({ count: 1, workerUrl: missing }));
		} catch (error) {
			caught = (error as ECSError).category;
			message = (error as ECSError).message;
		}
		expect(caught).toBe(ECS_ERROR.WORKERS_ENTRY_UNREACHABLE);
		expect(message).toContain("no_such_worker.ts");
		expect(message).toContain("workerUrl");
		// The world is free to try again with the right URL.
		pools.push(await world.ecs.attachWorkers({ count: 1, workerUrl: WORKER_URL }));
	});
});

describe("a kernel that throws", () => {
	it("names the worker and the export, and the world runs the next frame", async () => {
		const world = buildWorld({ entities: 256, backing: "shared" });
		const { ecs, Pos, Vel } = world;
		const query = ecs.query(Pos, Vel);
		let sequentialRuns = 0;
		const failing = ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			name: "failing",
			parallel: {
				kernel: { js: KERNELS_URL, export: "throwing" },
				columns: [
					[Pos, "x"],
					[Vel, "vx"]
				],
				minRows: 1,
				query
			},
			fn: () => {}
		} as never);
		const counter = ecs.registerSystem({
			reads: [],
			writes: [],
			name: "counter",
			fn: () => {
				sequentialRuns++;
			}
		} as never);
		ecs.addSystems(SCHEDULE.UPDATE, counter, failing);
		pools.push(await ecs.attachWorkers({ count: 2, workerUrl: WORKER_URL }));

		let message = "";
		try {
			ecs.update(1);
		} catch (error) {
			message = (error as ECSError).message;
			expect((error as ECSError).category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		}
		expect(message).toContain("throwing");
		expect(message).toMatch(/worker [01]/);

		// The failure did not leave the pool parked or the barrier out of step.
		expect(() => ecs.update(1)).toThrow();
		expect(sequentialRuns).toBe(2);
	});

	it("refuses a kernel export that does not exist, at attach", async () => {
		const world = buildWorld({ entities: 16, backing: "shared" });
		const { ecs, Pos, Vel } = world;
		const query = ecs.query(Pos, Vel);
		ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			name: "missing",
			parallel: {
				kernel: { js: KERNELS_URL, export: "notThere" },
				columns: [
					[Pos, "x"],
					[Vel, "vx"]
				],
				minRows: 1,
				query
			},
			fn: () => {}
		} as never);
		let caught = "no throw";
		try {
			pools.push(await ecs.attachWorkers({ count: 1, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = (error as ECSError).category;
		}
		expect(caught).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
	});
});
