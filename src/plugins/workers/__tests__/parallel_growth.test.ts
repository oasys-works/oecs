/**
 * A grow between two frames, on both backings.
 *
 * A grow relocates columns and bumps `view_stamp`, and a worker that kept its
 * bind would write into the abandoned block and report success. The two
 * backings grow differently, so both run here. The shared buffer grows in place
 * and keeps its object identity. A `WebAssembly.Memory` hands back a new buffer
 * object and freezes the old one at its pre-grow length, so a worker that held
 * the old object could not reach the new pages at all.
 *
 * The oracle is `stateHash` against a world that ran the same body on the main
 * thread through the same grow.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../../core/ecs/phase";
import type { SystemContext } from "../../../core/ecs/system_context";
import type { WorkerPool } from "../../workers/pool";
import { integrateI32 } from "./parallel_kernels.mjs";
import { KERNELS_URL, WORKER_URL, buildWorld, seed, type Backing } from "./parallel_fixture";

const BACKINGS: Backing[] = ["shared", "wasm"];
const DT = 2;
/** Small enough that a few hundred spawns force a column to grow and move. */
const COLUMN_CAPACITY = 32;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

function integrateWorld(backing: Backing) {
	const world = buildWorld({
		entities: 64,
		backing,
		columnCapacity: COLUMN_CAPACITY
	});
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).not(Frozen);
	const system = ecs.registerSystem({
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
			query.forEachColumns((cols, count) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				integrateI32(p.x, p.y, v.vx, v.vy, 0, count, dt);
			});
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return world;
}

/** Spawn far past the column capacity, so the store grows and moves columns. */
function growPastCapacity(world: ReturnType<typeof integrateWorld>): void {
	const { ecs, Pos, Vel } = world;
	const template = ecs.template(Pos({ x: 0, y: 0 } as never), Vel({ vx: 0, vy: 0 } as never));
	for (let i = 0; i < 600; i++) ecs.spawn(template);
	seed(ecs, Pos, Vel);
	ecs.publishRowCounts();
}

describe.each(BACKINGS)("a grow between two frames on the %s backing", (backing) => {
	it("is followed by the workers", async () => {
		const sequential = integrateWorld(backing);
		sequential.ecs.update(DT);
		growPastCapacity(sequential);
		sequential.ecs.update(DT);
		const expected = sequential.ecs.snapshots.stateHash();

		const parallel = integrateWorld(backing);
		await attach(parallel, 4);
		const beforeStamp = parallel.ecs.columnStore.header.viewStamp;
		const beforeBuffer = parallel.ecs.columnStore.buffer;
		parallel.ecs.update(DT);
		growPastCapacity(parallel);
		// A test that grew nothing would pass whatever the worker cached.
		expect(parallel.ecs.columnStore.header.viewStamp).toBeGreaterThan(beforeStamp);
		// The two backings differ here, and this is the difference the test exists
		// for. The shared buffer grows in place and keeps its identity. The wasm
		// memory hands back a new object, and the old one keeps its pre-grow
		// length, so a worker holding it could not reach the new pages.
		const afterBuffer = parallel.ecs.columnStore.buffer;
		expect(afterBuffer === beforeBuffer).toBe(backing === "shared");
		parallel.ecs.update(DT);

		expect(parallel.ecs.snapshots.stateHash()).toBe(expected);
		// The seeded world is not the answer, so an equal hash is not the hash of
		// a world nothing touched.
		const untouched = integrateWorld(backing);
		untouched.ecs.update(DT);
		growPastCapacity(untouched);
		expect(untouched.ecs.snapshots.stateHash()).not.toBe(expected);
	});
});

async function attach(world: ReturnType<typeof integrateWorld>, count: number) {
	const pool = await world.ecs.workers.attach({ count, workerUrl: WORKER_URL });
	pools.push(pool);
	return pool;
}
