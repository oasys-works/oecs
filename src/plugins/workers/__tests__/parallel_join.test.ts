/**
 * What the join owes the rest of the world.
 *
 * A pass writes columns from another thread, so nothing on the main thread
 * notices it. The join stamps each declared write: the archetype's changed tick,
 * so a `changed()` query sees it, and the row tick plane, so an entity-level
 * `onSet` observer fires for the rows the kernel wrote.
 *
 * The row threshold routes the same system two ways, and the two ways must
 * leave the same world.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ECS } from "../../../core/ecs/ecs";
import { SCHEDULE } from "../../../core/ecs/phase";
import type { SystemContext } from "../../../core/ecs/system_context";
import { getEntityIndex } from "../../../core/ecs/entity";
import type { WorkerPool } from "../../workers/pool";
import { observers } from "../../observers";
import { events } from "../../events";
import { workers, type WorkersPlugin } from "../../workers";
import { KERNEL_MARK, SEQUENTIAL_MARK, integrateI32 } from "./parallel_kernels.mjs";
import { KERNELS_URL, WORKER_URL, buildWorld, readColumns } from "./parallel_fixture";

const DT = 2;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

function integrateWorld(entities: number, minRows: number, exportName = "integrateI32") {
	const world = buildWorld({ entities, backing: "shared" });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).not(Frozen);
	const system = ecs.registerSystem({
		reads: [Vel],
		writes: [Pos],
		name: "integrate",
		parallel: {
			kernel: { js: KERNELS_URL, export: exportName },
			columns: [
				[Pos, "x"],
				[Pos, "y"],
				[Vel, "vx"],
				[Vel, "vy"]
			],
			minRows,
			query
		},
		fn: (_ctx: SystemContext, dt: number) => {
			query.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				if (exportName === "markKernel") {
					// The sequential twin of `markKernel` writes the other mark, so the
					// values say which path ran.
					for (let i = 0; i < count; i++) {
						p.x[i] = SEQUENTIAL_MARK;
						p.y[i] = SEQUENTIAL_MARK;
					}
					return;
				}
				integrateI32(p.x, p.y, v.vx, v.vy, 0, count, dt);
			});
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return { ...world, query };
}

async function attach(ecs: WorkersPlugin, count: number) {
	const pool = await ecs.workers.attach({ count, workerUrl: WORKER_URL });
	pools.push(pool);
	return pool;
}

describe("the row threshold", () => {
	it("runs fn below it and the kernel above it", async () => {
		const below = integrateWorld(512, 1_000_000, "markKernel");
		await attach(below.ecs, 2);
		below.ecs.update(DT);
		const belowValues = readColumns(below.ecs, below.Pos, below.Vel);

		const above = integrateWorld(512, 1, "markKernel");
		await attach(above.ecs, 2);
		above.ecs.update(DT);
		const aboveValues = readColumns(above.ecs, above.Pos, above.Vel);

		// Each mark sits outside the seeded range, so the value alone names the
		// path that ran.
		expect(belowValues).toContain(SEQUENTIAL_MARK);
		expect(belowValues).not.toContain(KERNEL_MARK);
		expect(aboveValues).toContain(KERNEL_MARK);
		expect(aboveValues).not.toContain(SEQUENTIAL_MARK);
	});

	it("leaves the same world with a pool and without one", async () => {
		const withoutPool = integrateWorld(2048, 1);
		for (let frame = 0; frame < 3; frame++) withoutPool.ecs.update(DT);

		const withPool = integrateWorld(2048, 1);
		await attach(withPool.ecs, 4);
		for (let frame = 0; frame < 3; frame++) withPool.ecs.update(DT);

		expect(withPool.ecs.snapshots.stateHash()).toBe(withoutPool.ecs.snapshots.stateHash());
	});
});

describe("a system registered after the attach", () => {
	it("runs fn until the workers hold its kernel, then runs the kernel", async () => {
		const world = buildWorld({ entities: 512, backing: "shared" });
		const { ecs, Pos, Vel, Frozen } = world;
		const pool = await attach(ecs, 2);
		const query = ecs.query(Pos, Vel).not(Frozen);
		const system = ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			name: "late",
			parallel: {
				kernel: { js: KERNELS_URL, export: "markKernel" },
				columns: [
					[Pos, "x"],
					[Pos, "y"],
					[Vel, "vx"],
					[Vel, "vy"]
				],
				minRows: 1,
				query
			},
			fn: () => {
				query.forEachChunk((cols, count) => {
					const p = cols.mut(Pos);
					for (let i = 0; i < count; i++) {
						p.x[i] = SEQUENTIAL_MARK;
						p.y[i] = SEQUENTIAL_MARK;
					}
				});
			}
		} as never);
		ecs.addSystems(SCHEDULE.UPDATE, system);

		// The registration is a message to every worker, and a parked worker runs
		// no message callback. So the frame before `settled` is the sequential one.
		ecs.update(DT);
		expect(readColumns(ecs, Pos, Vel)).toContain(SEQUENTIAL_MARK);

		await pool.settled();
		ecs.update(DT);
		expect(readColumns(ecs, Pos, Vel)).toContain(KERNEL_MARK);
	});
});

describe("the join stamp", () => {
	it("lets a changed query see every matched archetype", async () => {
		const world = integrateWorld(2048, 1);
		await attach(world.ecs, 4);
		const changed = world.query.changed(world.Pos);
		const matched = world.query.archetypeCount;
		expect(matched).toBeGreaterThan(1);

		let seen = 0;
		const reader = world.ecs.registerSystem({
			reads: [world.Pos, world.Vel],
			writes: [],
			name: "reader",
			fn: () => {
				seen = 0;
				changed.forEachChunk(() => {
					seen++;
				});
			}
		} as never);
		world.ecs.addSystems(SCHEDULE.UPDATE, reader);
		world.ecs.update(DT);

		expect(seen).toBe(matched);
	});

	it("fires an entity-level onSet for the rows the kernel wrote", async () => {
		const world = ECS.create({
			deterministic: true,
			memory: { backing: "shared", columnCapacity: 256, maxBytes: 8 * 1024 * 1024 },
			plugins: [events(), observers(), workers()]
		});
		const Pos = world.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
		const Vel = world.registerComponent({ vx: "i32", vy: "i32" }, { name: "Vel" });
		const fired: number[] = [];
		world.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: {
				reads: [Pos],
				writes: [Pos],
				spawns: [],
				despawns: [],
				transitions: [],
				resourceReads: [],
				resourceWrites: [],
				sparseReads: [],
				sparseWrites: [],
				relationReads: [],
				relationWrites: []
			}
		});
		const template = world.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 1 }));
		world.startup();
		const ids = [];
		for (let i = 0; i < 64; i++) ids.push(world.spawn(template));
		world.publishRowCounts();

		const query = world.query(Pos, Vel);
		const system = world.registerSystem({
			reads: [Vel],
			writes: [Pos],
			name: "integrate",
			parallel: {
				kernel: { js: KERNELS_URL, export: "integrateI32" },
				columns: [
					[Pos, "x"],
					[Pos, "y"],
					[Vel, "vx"],
					[Vel, "vy"]
				],
				minRows: 1,
				query
			},
			fn: (_ctx: SystemContext, dt: number) => {
				query.forEachChunk((cols, count) => {
					const p = cols.mut(Pos);
					const v = cols.read(Vel);
					integrateI32(p.x, p.y, v.vx, v.vy, 0, count, dt);
				});
			}
		} as never);
		world.addSystems(SCHEDULE.UPDATE, system);
		await attach(world, 2);

		world.update(DT);

		expect(fired.slice().sort((a, b) => a - b)).toEqual(
			ids.map((e) => getEntityIndex(e)).sort((a, b) => a - b)
		);
	});
});
