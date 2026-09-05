/**
 * Four toolchains, one kernel contract, one answer.
 *
 * The modules in `fixtures/` carry the same four bodies. One is emitted byte by
 * byte with no compiler, and three come from Zig, from Rust and from C through
 * `zig cc`. Every one of them runs on the real pool over several workers, and
 * every one must leave the bytes the sequential TypeScript body leaves. So what
 * passes here is the claim "any module", not the claim "this compiler".
 *
 * The binaries are checked in. A compiler is not a dependency of this suite, so
 * a machine with no toolchain still proves the contract. Rebuild them with
 * `gen_kernel_fixtures.mjs` beside their sources, which also states the exact
 * build line for each one.
 *
 * The `stack_i32` body is the one that matters most. It spills a scratch array
 * to the shadow stack of the module, and every worker instantiates the same
 * module over one memory. Without a private region for each instance the
 * workers overwrite each other's frames, and this file fails.
 *
 * The store sits above everything the modules own. Every compiled fixture puts
 * its `__heap_base` near one megabyte, so a base of four megabytes clears the
 * data, the linked stack and the regions the pool carves.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../system_context";
import { ECS_ERROR, type ECSError } from "../../utils/error";
import type { WorkerPool } from "../../parallel/pool";
import {
	integrateWrapI32,
	mixI32,
	stackI32,
	tableI32,
	type KernelBody
} from "./parallel_kernels.mjs";
import { KERNELS_URL, WORKER_URL, buildWorld, readColumns } from "./parallel_fixture";

/** Above the `__heap_base` of every compiled fixture, with room for one stack
 * region per worker below the header. */
const STORE_BASE = 4 * 1024 * 1024;
const DT = 3;
const ENTITIES = 1024;
const WORKERS = 3;
const FRAMES = 3;

const fixture = (name: string): WebAssembly.Module =>
	new WebAssembly.Module(
		readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)))
	);

/** The four bodies, with the TypeScript twin each one must reproduce. */
const BODIES: readonly [string, KernelBody][] = [
	["integrate_i32", integrateWrapI32],
	["mix_i32", mixI32],
	["stack_i32", stackI32],
	["table_i32", tableI32]
];

/** The two AssemblyScript carries. It has no shadow stack a host can move and
 * its constants live on a runtime heap, which every instance over one memory
 * shares, so the other two bodies have no honest form there. */
const POINTER_ONLY = BODIES.slice(0, 2);

/** One module for each toolchain, with the bodies it carries. */
const TOOLCHAINS: readonly [string, string, readonly [string, KernelBody][]][] = [
	["the emitter", "kernel_emitted.wasm", BODIES],
	["zig", "kernel_zig.wasm", BODIES],
	["rust", "kernel_rust.wasm", BODIES],
	["c through zig cc", "kernel_c.wasm", BODIES],
	["assemblyscript", "kernel_as.wasm", POINTER_ONLY]
];

let pools: WorkerPool[] = [];

afterEach(async () => {
	const open = pools;
	pools = [];
	await Promise.all(open.map((pool) => pool.detach()));
});

interface WorldOptions {
	kernel: { wasm?: WebAssembly.Module; js?: string; export: string };
	body: KernelBody;
	storeBase?: number;
}

function kernelWorld({ kernel, body, storeBase = STORE_BASE }: WorldOptions) {
	const world = buildWorld({ entities: ENTITIES, backing: "wasm", storeBase });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).without(Frozen);
	const system = ecs.registerSystem({
		name: kernel.export,
		reads: [Vel],
		writes: [Pos],
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
				body(p.x, p.y, v.vx, v.vy, 0, count, dt);
			});
		}
	} as never);
	ecs.addSystems(SCHEDULE.UPDATE, system);
	return world;
}

async function attach(world: ReturnType<typeof kernelWorld>, count: number) {
	const pool = await world.ecs.attachWorkers({ count, workerUrl: WORKER_URL });
	pools.push(pool);
	return pool;
}

/** A kernel the registration accepts and no worker ever loads. A world with no
 * pool runs `fn`, and the plan still needs a kernel it can hold. */
const UNUSED_KERNEL = { js: KERNELS_URL, export: "integrateI32" };

/** What the sequential body leaves after `FRAMES` frames, with no pool. */
function sequential(body: KernelBody) {
	const world = kernelWorld({ kernel: UNUSED_KERNEL, body });
	for (let frame = 0; frame < FRAMES; frame++) world.ecs.update(DT);
	return {
		columns: readColumns(world.ecs, world.Pos, world.Vel),
		hash: world.ecs.snapshots.stateHash()
	};
}

describe("a wasm kernel from any toolchain", () => {
	for (const [toolchain, file, bodies] of TOOLCHAINS) {
		for (const [exportName, body] of bodies) {
			it(
				`leaves the sequential bytes: ${toolchain}, ${exportName}`,
				async () => {
					const expected = sequential(body);
					const world = kernelWorld({ kernel: { wasm: fixture(file), export: exportName }, body });
					await attach(world, WORKERS);
					for (let frame = 0; frame < FRAMES; frame++) world.ecs.update(DT);

					expect(readColumns(world.ecs, world.Pos, world.Vel)).toEqual(expected.columns);
					expect(world.ecs.snapshots.stateHash()).toBe(expected.hash);
					// A world that ran nothing is not the answer.
					const untouched = kernelWorld({ kernel: UNUSED_KERNEL, body });
					expect(readColumns(untouched.ecs, untouched.Pos, untouched.Vel)).not.toEqual(
						expected.columns
					);
				},
				30_000
			);
		}
	}
});

/**
 * One world, two parallel systems, in order: a body that pushes frames, then a
 * body that reads the module's constant table.
 *
 * A module's data segment is written once, at instantiation, and every instance
 * over one memory shares it. So a stack region that reaches below `__heap_base`
 * writes over the table, and the second pass then reads whatever the first
 * pass's frames left. The two systems in one world are what make that visible.
 */
function stackThenTableWorld(kernel: { wasm?: WebAssembly.Module; js?: string }) {
	const world = buildWorld({ entities: ENTITIES, backing: "wasm", storeBase: STORE_BASE });
	const { ecs, Pos, Vel, Frozen } = world;
	const query = ecs.query(Pos, Vel).without(Frozen);
	const columns = [
		[Pos, "x"],
		[Pos, "y"],
		[Vel, "vx"],
		[Vel, "vy"]
	];
	const system = (exportName: string, body: KernelBody) =>
		ecs.registerSystem({
			name: exportName,
			reads: [Vel],
			writes: [Pos],
			parallel: {
				kernel: kernel.wasm === undefined ? UNUSED_KERNEL : { ...kernel, export: exportName },
				columns,
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
	const first = system("stack_i32", stackI32);
	const second = system("table_i32", tableI32);
	ecs.addSystems(SCHEDULE.UPDATE, first, { system: second, ordering: { after: [first] } });
	return world;
}

describe("a module's data segment under several instances", () => {
	it("survives the stack regions, so a table read after a stack pass is right", async () => {
		const reference = stackThenTableWorld({});
		for (let frame = 0; frame < FRAMES; frame++) reference.ecs.update(DT);
		const expected = readColumns(reference.ecs, reference.Pos, reference.Vel);

		const world = stackThenTableWorld({ wasm: fixture("kernel_zig.wasm") });
		await attach(world, WORKERS);
		for (let frame = 0; frame < FRAMES; frame++) world.ecs.update(DT);
		expect(readColumns(world.ecs, world.Pos, world.Vel)).toEqual(expected);
	}, 30_000);

	it("sits below the store base, where the store never writes", () => {
		const world = buildWorld({ entities: 8, backing: "wasm", storeBase: STORE_BASE });
		// A host instance addresses the same bytes the workers address, because
		// they share the memory. So the table's own address is readable here.
		const memory = world.ecs.wasmMemory as WebAssembly.Memory;
		const probe = new WebAssembly.Instance(fixture("kernel_zig.wasm"), { env: { memory } });
		const heapBase = (probe.exports.__heap_base as WebAssembly.Global).value as number;
		expect(heapBase).toBeLessThan(STORE_BASE);
	});
});

describe("a kernel module the pool refuses", () => {
	const registering = (file: string, exportName: string): { category: string; message: string } => {
		const world = buildWorld({ entities: 8, backing: "wasm", storeBase: STORE_BASE });
		const { ecs, Pos, Vel } = world;
		const query = ecs.query(Pos, Vel);
		try {
			ecs.registerSystem({
				name: exportName,
				reads: [Vel],
				writes: [Pos],
				parallel: {
					kernel: { wasm: fixture(file), export: exportName },
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
		} catch (error) {
			return { category: (error as ECSError).category, message: (error as Error).message };
		}
		return { category: "no throw", message: "" };
	};

	it("names the import no worker supplies", () => {
		const caught = registering("kernel_bad_import.wasm", "integrate_i32");
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_MODULE);
		expect(caught.message).toContain("env.log");
	});

	it("refuses a module that imports no memory, because it never reaches the store", () => {
		const caught = registering("kernel_no_memory.wasm", "integrate_i32");
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_MODULE);
		expect(caught.message).toContain("--import-memory");
	});

	it("refuses an export name the module does not carry", () => {
		const caught = registering("kernel_zig.wasm", "integrate_f32");
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_MODULE);
		expect(caught.message).toContain("integrate_f32");
	});

	it("refuses an export that is a global and not a function", () => {
		const caught = registering("kernel_zig.wasm", "__heap_base");
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_MODULE);
		expect(caught.message).toContain("global");
	});

	it("fails the attach when the export takes the wrong number of parameters", async () => {
		const world = kernelWorld({
			kernel: { wasm: fixture("kernel_bad_arity.wasm"), export: "integrate_i32" },
			body: integrateWrapI32
		});
		let caught = { category: "no throw", message: "" };
		try {
			pools.push(await world.ecs.attachWorkers({ count: 2, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = { category: (error as ECSError).category, message: (error as Error).message };
		}
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		// Six parameters against the seven four columns need.
		expect(caught.message).toContain("6 parameters");
		expect(caught.message).toContain("needs 7");
	}, 30_000);

	it("fails the attach when the store leaves no stack region for each worker", async () => {
		// The default base for the wasm backing is one page, and every compiled
		// fixture puts its heap base far above that. So the span the regions come
		// from is empty, and the pool says so instead of letting the workers share
		// one stack.
		const world = kernelWorld({
			kernel: { wasm: fixture("kernel_zig.wasm"), export: "stack_i32" },
			body: stackI32,
			storeBase: 65_536
		});
		let caught = { category: "no throw", message: "" };
		try {
			pools.push(await world.ecs.attachWorkers({ count: 2, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = { category: (error as ECSError).category, message: (error as Error).message };
		}
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		expect(caught.message).toContain("stack region");
		expect(caught.message).toContain("memory.storeBase");
	}, 30_000);

	it("fails the attach when '__stack_pointer' is immutable", async () => {
		const world = kernelWorld({
			kernel: { wasm: fixture("kernel_frozen_stack.wasm"), export: "integrate_i32" },
			body: integrateWrapI32
		});
		let caught = { category: "no throw", message: "" };
		try {
			pools.push(await world.ecs.attachWorkers({ count: 2, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = { category: (error as ECSError).category, message: (error as Error).message };
		}
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		expect(caught.message).toContain("immutable");
	}, 30_000);

	it("fails the attach when a module with a stack pointer exports no heap base", async () => {
		const world = kernelWorld({
			kernel: { wasm: fixture("kernel_no_heap_base.wasm"), export: "stack_i32" },
			body: stackI32
		});
		let caught = { category: "no throw", message: "" };
		try {
			pools.push(await world.ecs.attachWorkers({ count: 2, workerUrl: WORKER_URL }));
		} catch (error) {
			caught = { category: (error as ECSError).category, message: (error as Error).message };
		}
		expect(caught.category).toBe(ECS_ERROR.PARALLEL_KERNEL_FAILED);
		expect(caught.message).toContain("--export=__heap_base");
	}, 30_000);

	it("takes a module with one worker whatever its stack pointer says", async () => {
		// One instance owns the linked stack alone, so the pool needs no region and
		// refuses nothing. The same world at two workers throws above.
		const world = kernelWorld({
			kernel: { wasm: fixture("kernel_zig.wasm"), export: "integrate_i32" },
			body: integrateWrapI32,
			storeBase: 65_536
		});
		await attach(world, 1);
		expect(world.ecs.workers?.count).toBe(1);
	}, 30_000);
});
