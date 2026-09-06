/**
 * One system across workers leaves the world the sequential body leaves.
 *
 * The oracle is `stateHash` on a deterministic integer world, over several
 * frames, with three matched archetypes and one the query excludes. The float
 * lane has no engine oracle, so it is checked by an exact value compare against
 * a world that ran the same body on the main thread.
 *
 * Each mutation these tests fail against is named beside the case it breaks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../../core/ecs/schedule";
import type { SystemContext } from "../../../core/ecs/system_context";
import type { WorkerPool } from "../../workers/pool";
import { integrateF32, integrateI32 } from "./parallel_kernels.mjs";
import {
	KERNELS_URL,
	WORKER_URL,
	buildWorld,
	readColumns,
	type Backing
} from "./parallel_fixture";

const BACKINGS: Backing[] = ["shared", "wasm"];
const ENTITIES = 4096;
const DT = 2;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

/** A world whose one system integrates `Pos` by `Vel`, excluding `Frozen`. */
function integrateWorld(backing: Backing, deterministic: boolean, exportName: string) {
	const world = buildWorld({ entities: ENTITIES, backing, deterministic });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).without(Frozen);
	// One variable over two bodies whose columns differ in element type. The
	// lane picks both the body and the element type, and no signature says that,
	// so the column parameters are open here.
	const body: (
		px: any,
		py: any,
		vx: any,
		vy: any,
		begin: number,
		end: number,
		dt: number
	) => void = deterministic ? integrateI32 : integrateF32;
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
			minRows: 1,
			query
		},
		fn: (_ctx: SystemContext, dt: number) => {
			query.forEachChunk((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				body(p.x, p.y, v.vx, v.vy, 0, count, dt);
			});
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return world;
}

async function attach(world: ReturnType<typeof integrateWorld>, count: number) {
	const pool = await world.ecs.workers.attach({ count, workerUrl: WORKER_URL });
	pools.push(pool);
	return pool;
}

describe.each(BACKINGS)("a parallel system on the %s backing", (backing) => {
	it.each([1, 2, 4])(
		"leaves the sequential state hash across %i worker(s)",
		async (count) => {
			const sequential = integrateWorld(backing, true, "integrateI32");
			for (let frame = 0; frame < 4; frame++) sequential.ecs.update(DT);
			const expected = sequential.ecs.snapshots.stateHash();

			const parallel = integrateWorld(backing, true, "integrateI32");
			const pool = await attach(parallel, count);
			expect(pool.count).toBe(count);
			for (let frame = 0; frame < 4; frame++) parallel.ecs.update(DT);

			expect(parallel.ecs.snapshots.stateHash()).toBe(expected);
			// The seed differs from the result, so an equal hash is not the hash
			// of a world nothing touched.
			const untouched = integrateWorld(backing, true, "integrateI32");
			expect(untouched.ecs.snapshots.stateHash()).not.toBe(expected);
		}
	);

	it("leaves the sequential column values on a float world", async () => {
		const sequential = integrateWorld(backing, false, "integrateF32");
		for (let frame = 0; frame < 3; frame++) sequential.ecs.update(0.25);
		const expected = readColumns(sequential.ecs, sequential.Pos, sequential.Vel);

		const parallel = integrateWorld(backing, false, "integrateF32");
		await attach(parallel, 4);
		for (let frame = 0; frame < 3; frame++) parallel.ecs.update(0.25);

		expect(readColumns(parallel.ecs, parallel.Pos, parallel.Vel)).toEqual(expected);
	});

	it("keeps the excluded archetype untouched", async () => {
		const world = integrateWorld(backing, true, "integrateI32");
		const before = readColumns(world.ecs, world.Pos, world.Vel);
		const frozen = world.ecs.query(world.Pos, world.Vel, world.Frozen);
		const frozenBefore: number[] = [];
		frozen.forEachChunk((cols, count) => {
			const p = cols.read(world.Pos);
			for (let i = 0; i < count; i++) frozenBefore.push(p.x[i], p.y[i]);
		});
		expect(frozenBefore.length).toBeGreaterThan(0);

		await attach(world, 4);
		world.ecs.update(DT);

		const frozenAfter: number[] = [];
		frozen.forEachChunk((cols, count) => {
			const p = cols.read(world.Pos);
			for (let i = 0; i < count; i++) frozenAfter.push(p.x[i], p.y[i]);
		});
		expect(frozenAfter).toEqual(frozenBefore);
		expect(readColumns(world.ecs, world.Pos, world.Vel)).not.toEqual(before);
	});
});
