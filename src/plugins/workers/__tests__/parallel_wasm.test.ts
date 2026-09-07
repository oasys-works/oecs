/**
 * A wasm kernel and a js kernel with the same body leave the same bytes.
 *
 * The module below is emitted byte by byte, with no toolchain, so what passes
 * here is the claim "any module" and not the claim "this compiler". It imports
 * the world's memory as `env.memory` and addresses row `r` of a column at
 * `ptr + r * 4`, where `ptr` is the absolute byte offset the engine hands it.
 * It reads no header and walks no descriptor.
 *
 * A wasm kernel needs the wasm backing, because there is no way to import a
 * plain `SharedArrayBuffer` as a module's memory. The shared backing refuses
 * one, and the refusal is checked here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../../core/ecs/phase";
import type { SystemContext } from "../../../core/ecs/system_context";
import { ECS_ERROR, type ECSError } from "../../../core/ecs/utils/error";
import type { WorkerPool } from "../../workers/pool";
import { integrateI32 } from "./parallel_kernels.mjs";
import { KERNELS_URL, WORKER_URL, buildWorld, readColumns } from "./parallel_fixture";

const DT = 3;
/** The world's memory declares this maximum, and the module must declare the
 * same one or the instantiation fails. */
const MAXIMUM_PAGES = 512;

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

// ── A minimal WebAssembly emitter ───────────────────────────────────────────

function uleb(n: number): number[] {
	const out: number[] = [];
	let v = n >>> 0;
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v !== 0) b |= 0x80;
		out.push(b);
	} while (v !== 0);
	return out;
}

function sleb(n: number): number[] {
	const out: number[] = [];
	let v = n | 0;
	for (;;) {
		const b = v & 0x7f;
		v >>= 7;
		const sign = (b & 0x40) !== 0;
		if ((v === 0 && !sign) || (v === -1 && sign)) {
			out.push(b);
			return out;
		}
		out.push(b | 0x80);
	}
}

const name = (s: string): number[] => {
	const bytes = [...new TextEncoder().encode(s)];
	return [...uleb(bytes.length), ...bytes];
};
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

const I32 = 0x7f;
const get = (i: number) => [0x20, ...uleb(i)];
const set = (i: number) => [0x21, ...uleb(i)];
const constI32 = (n: number) => [0x41, ...sleb(n)];
const load = [0x28, 2, 0];
const store = [0x36, 2, 0];
const add = [0x6a];
const mul = [0x6c];
const geU = [0x4f];

/**
 * `pos += vel * dt` over four i32 columns, addressed by byte offset.
 *
 * Params: `px, py, vx, vy, begin, end, dt`. Locals: the row index and two
 * address scratches.
 */
function integrateModule(): WebAssembly.Module {
	const i = 7;
	const off = 8;
	const addr = 9;
	const column = (posArg: number, velArg: number) => [
		...get(posArg),
		...get(off),
		...add,
		...set(addr),
		...get(addr),
		...get(addr),
		...load,
		...get(velArg),
		...get(off),
		...add,
		...load,
		...get(6),
		...mul,
		...add,
		...store
	];
	const body = [
		...get(4),
		...set(i),
		0x02,
		0x40, // block
		0x03,
		0x40, // loop
		...get(i),
		...get(5),
		...geU,
		0x0d,
		0x01, // br_if 1, out of the block
		...get(i),
		...constI32(4),
		...mul,
		...set(off),
		...column(0, 2),
		...column(1, 3),
		...get(i),
		...constI32(1),
		...add,
		...set(i),
		0x0c,
		0x00, // br 0, next iteration
		0x0b, // end loop
		0x0b, // end block
		0x0b // end function
	];
	const params = [I32, I32, I32, I32, I32, I32, I32];
	const type = [0x60, ...uleb(params.length), ...params, 0x00];
	// A shared memory declares a maximum, so the limits flag is 0x03.
	const memoryImport = [
		...name("env"),
		...name("memory"),
		0x02,
		0x03,
		...uleb(1),
		...uleb(MAXIMUM_PAGES)
	];
	const locals = [...uleb(1), 3, I32];
	const code = [...locals, ...body];
	const bytes = new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(1, vec([type])),
		...section(2, vec([memoryImport])),
		...section(3, vec([[0]])),
		...section(7, vec([[...name("integrate"), 0x00, 0x00]])),
		...section(10, vec([[...uleb(code.length), ...code]]))
	]);
	return new WebAssembly.Module(bytes);
}

// ── The comparison ──────────────────────────────────────────────────────────

function integrateWorld(kernel: { js?: string; wasm?: WebAssembly.Module; export: string }) {
	const world = buildWorld({ entities: 1024, backing: "wasm" });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).not(Frozen);
	const system = ecs.registerSystem({
		reads: [Vel],
		writes: [Pos],
		name: "integrate",
		parallel: {
			kernel,
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
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return world;
}

async function attach(world: ReturnType<typeof integrateWorld>, count: number) {
	const pool = await world.ecs.workers.attach({ count, workerUrl: WORKER_URL });
	pools.push(pool);
	return pool;
}

describe("a wasm kernel", () => {
	it("leaves the bytes a js kernel with the same body leaves", async () => {
		const byJs = integrateWorld({ js: KERNELS_URL, export: "integrateI32" });
		await attach(byJs, 4);
		for (let frame = 0; frame < 3; frame++) byJs.ecs.update(DT);
		const expected = readColumns(byJs.ecs, byJs.Pos, byJs.Vel);

		const byWasm = integrateWorld({ wasm: integrateModule(), export: "integrate" });
		await attach(byWasm, 4);
		for (let frame = 0; frame < 3; frame++) byWasm.ecs.update(DT);

		expect(readColumns(byWasm.ecs, byWasm.Pos, byWasm.Vel)).toEqual(expected);
		expect(byWasm.ecs.snapshots.stateHash()).toBe(byJs.ecs.snapshots.stateHash());
		// A world that ran nothing is not the answer.
		const untouched = integrateWorld({ js: KERNELS_URL, export: "integrateI32" });
		expect(readColumns(untouched.ecs, untouched.Pos, untouched.Vel)).not.toEqual(expected);
	});

	it("is refused on the shared backing, which has no memory to import", async () => {
		const world = buildWorld({ entities: 64, backing: "shared" });
		const { ecs, Pos, Vel } = world;
		const query = ecs.query(Pos, Vel);
		ecs.registerSystem({
			reads: [Vel],
			writes: [Pos],
			name: "integrate",
			parallel: {
				kernel: { wasm: integrateModule(), export: "integrate" },
				columns: [
					[Pos, "x"],
					[Pos, "y"],
					[Vel, "vx"],
					[Vel, "vy"]
				],
				minRows: 1,
				query
			},
			fn: () => {}
		} as never);
		let caught = "no throw";
		try {
			pools.push(await ecs.workers.attach({ count: 1, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = (error as ECSError).category;
		}
		expect(caught).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
	});
});
