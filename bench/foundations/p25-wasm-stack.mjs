/**
 * P25 stack, one shadow stack under several instances of one module.
 *
 * Every worker of a pool instantiates the same module over one memory. A
 * compiled module keeps a shadow stack in that memory and addresses it through
 * the mutable global `__stack_pointer`. Each instance gets its own copy of that
 * global, and every copy starts at the address the linker chose, so every
 * worker writes its frames to the same bytes. A kernel that spills anything
 * then reads back what another worker wrote.
 *
 * No probe before this one saw it. Their kernels hold every value in a wasm
 * local, so no frame ever reaches memory.
 *
 * Three lanes over one module:
 *
 *   - **shared**, every instance keeps the linked `__stack_pointer`,
 *   - **private**, each instance moves it to the top of its own region,
 *   - **engine**, the shipped pool loads the same module and the same export.
 *
 * The reference is the JavaScript twin of the body, run on one thread.
 *
 * The probe times the two hand lanes as well, so a reader can charge the region
 * assignment. The assignment runs once for each kernel load, so a pass cannot
 * pay for it, and the two lanes must land on top of each other.
 *
 * The `table` body is the control. It reads the module's data segment and
 * spills nothing, so both lanes must agree at every worker count.
 *
 * Run: `node bench/foundations/p25-wasm-stack.mjs`. It needs Zig and reports a
 * skip without it. Node only, because it drives `node:worker_threads` itself.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { median, table, loadOecs } from "./harness.mjs";
import { controlBuffer, EPOCH, DONE, JOB } from "./par/pool.mjs";
import { buildZig } from "./wasm/build_zig.mjs";
import { stackI32, tableI32 } from "./wasm/engine-kernels.mjs";

const WORKER = new URL("./wasm/stack-worker.mjs", import.meta.url);
const CORES = availableParallelism();
const KS = [2, 4, 8].filter((k) => k <= CORES);
const ROWS = 20_000;
const RUNS = 5;
const DT = 3;
const MAX_PAGES = 2048;
const PAGE = 65_536;
/** Where the four columns start in the hand lanes. Far above anything the
 * module owns, so those lanes measure the stack and nothing else. */
const COLUMN_BASE = 16 * 1024 * 1024;
/** What the caller reserves above `__heap_base` for the worker stacks. */
const RESERVE = 4 * 1024 * 1024;
/** The frame alignment every LLVM wasm target uses. */
const FRAME_ALIGN = 16;

/** `table` wants a label and a reader for each column, and every row here is a
 * plain record whose keys are the labels. */
const cols = (...keys) => keys.map((key) => ({ label: key, get: (row) => row[key] }));

function buildModule() {
	const bytes = buildZig("kernel.zig", "kernel_stack.wasm", {
		maxMemoryBytes: MAX_PAGES * PAGE,
		flags: ["--export=__heap_base", "--export=__stack_pointer"],
		optimize: "ReleaseFast"
	});
	if (bytes === null) return { skip: "zig is not installed, so the probe has no compiled module" };
	if (bytes.error) return { skip: `zig failed: ${bytes.error}` };
	return { module: new WebAssembly.Module(bytes) };
}

function seed(i32, base) {
	for (let r = 0; r < ROWS; r++) {
		i32[base + r] = (r % 1000) - 500;
		i32[base + ROWS + r] = r % 977;
		i32[base + 2 * ROWS + r] = (r % 13) - 6;
		i32[base + 3 * ROWS + r] = (r % 17) - 8;
	}
}

function fnv(i32, base, words) {
	let h = 0x811c9dc5;
	for (let i = 0; i < words; i++) {
		h ^= i32[base + i] >>> 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** The digest the module lanes must reproduce, computed on one thread. */
function reference(body) {
	const buffer = new ArrayBuffer(ROWS * 4 * 4);
	const i32 = new Int32Array(buffer);
	seed(i32, 0);
	const view = (c) => new Int32Array(buffer, c * ROWS * 4, ROWS);
	body(view(0), view(1), view(2), view(3), 0, ROWS, DT);
	return fnv(i32, 0, ROWS * 4);
}

/** The top of each worker's stack region, carved from `[heapBase, storeBase)`.
 * The same arithmetic the engine runs, written here so the probe measures the
 * rule and not the implementation. */
function stackTopsFor(heapBase, storeBase, count) {
	const region = Math.floor((storeBase - heapBase) / count / FRAME_ALIGN) * FRAME_ALIGN;
	if (region <= 0) return null;
	const tops = new Array(count);
	for (let i = 0; i < count; i++) tops[i] = heapBase + (i + 1) * region;
	return tops;
}

/** A pool whose start payload differs for each worker, which `par/pool.mjs`
 * does not do. The stack top is exactly what differs. */
async function startLane({ module, memory, exportName, count, stackTops }) {
	const columns = [0, 1, 2, 3].map((c) => COLUMN_BASE + c * ROWS * 4);
	const control = controlBuffer(count);
	const ctl = new Int32Array(control);
	const workers = [];
	const ready = [];
	for (let i = 0; i < count; i++) {
		const w = new Worker(WORKER, {
			workerData: {
				control,
				index: i,
				workerCount: count,
				module,
				memory,
				columns,
				rows: ROWS,
				dt: DT,
				exportName,
				stackTop: stackTops === null ? null : stackTops[i]
			}
		});
		workers.push(w);
		ready.push(
			new Promise((resolve, reject) => {
				w.once("message", resolve);
				w.once("error", reject);
			})
		);
	}
	await Promise.all(ready);
	let epoch = 0;
	return {
		run() {
			Atomics.store(ctl, DONE, 0);
			Atomics.store(ctl, JOB, 1);
			Atomics.store(ctl, EPOCH, ++epoch);
			Atomics.notify(ctl, EPOCH);
			for (;;) {
				const seen = Atomics.load(ctl, DONE);
				if (seen === count) return;
				Atomics.wait(ctl, DONE, seen);
			}
		},
		async stop() {
			Atomics.store(ctl, JOB, -1);
			Atomics.store(ctl, EPOCH, ++epoch);
			Atomics.notify(ctl, EPOCH);
			await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
		}
	};
}

/** One deterministic world, seeded from the row index, over one archetype. */
async function buildWorld({ ECS, SCHEDULE, snapshots }, module, storeBase, exportName) {
	const memory = new WebAssembly.Memory({ initial: 512, maximum: MAX_PAGES, shared: true });
	const ecs = ECS.create({
		deterministic: true,
		memory: { backing: { wasm: { memory } }, storeBase },
		plugins: [snapshots()]
	});
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" }, { name: "Vel" });
	const query = ecs.query(Pos, Vel);
	const system = ecs.registerSystem({
		name: "stack",
		reads: [Vel],
		writes: [Pos],
		parallel: {
			kernel: { wasm: module, export: exportName },
			columns: [
				[Pos, "x"],
				[Pos, "y"],
				[Vel, "vx"],
				[Vel, "vy"]
			],
			minRows: 1,
			query
		},
		fn: (_ctx, dt) => {
			query.forEachChunk((cols, n) => {
				const p = cols.mut(Pos);
				const v = cols.read(Vel);
				stackI32(p.x, p.y, v.vx, v.vy, 0, n, dt);
			});
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, system);
	ecs.startup();
	const template = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 }));
	for (let i = 0; i < ROWS; i++) ecs.spawn(template);
	query.forEachChunk((cols, n) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		for (let i = 0; i < n; i++) {
			p.x[i] = (i % 1000) - 500;
			p.y[i] = i % 977;
			v.vx[i] = (i % 13) - 6;
			v.vy[i] = (i % 17) - 8;
		}
	});
	ecs.publishRowCounts();
	return ecs;
}

/** The same module and the same export on the shipped pool, against the
 * sequential body of the same world. */
async function engineLane(module, storeBase) {
	const oecs = await loadOecs();
	const { snapshots } = await import(
		new URL("../../dist/plugins/snapshots.js", import.meta.url).href
	);
	const deps = { ECS: oecs.ECS, SCHEDULE: oecs.SCHEDULE, snapshots };
	const rows = [];
	for (const count of KS) {
		const sequential = await buildWorld(deps, module, storeBase, "stack_i32");
		sequential.update(DT);
		const expected = sequential.snapshots.stateHash();

		const pooled = await buildWorld(deps, module, storeBase, "stack_i32");
		let got = "threw";
		try {
			const pool = await pooled.attachWorkers({ count });
			pooled.update(DT);
			got = String(pooled.snapshots.stateHash());
			await pool.detach();
		} catch (error) {
			got = `${error.category ?? "Error"}: ${error.message}`.slice(0, 100);
		}
		rows.push({ workers: count, sequential: String(expected), pooled: got, agrees: got === String(expected) ? "yes" : "NO" });
	}
	console.log("\n## The same module on the shipped pool, stack body\n");
	table(rows, cols("workers", "sequential", "pooled", "agrees"));
}

async function main() {
	const built = buildModule();
	if (built.skip !== undefined) {
		console.log(`SKIP: ${built.skip}`);
		return;
	}
	const module = built.module;
	const memory = new WebAssembly.Memory({ initial: 512, maximum: MAX_PAGES, shared: true });
	const probe = new WebAssembly.Instance(module, { env: { memory } });
	const heapBase = probe.exports.__heap_base.value;
	const storeBase = Math.ceil((heapBase + RESERVE) / PAGE) * PAGE;

	console.log("# P25 stack, one shadow stack under several instances\n");
	console.log(`rows ${ROWS}, runs for each lane ${RUNS}`);
	console.log(`__heap_base ${heapBase}, __stack_pointer at link time ${probe.exports.__stack_pointer.value}`);
	console.log(`reserve ${RESERVE}, store base ${storeBase}, columns at ${COLUMN_BASE}\n`);

	const i32 = new Int32Array(memory.buffer);
	const base = COLUMN_BASE / 4;
	const bodies = [
		["stack", "stack_i32", stackI32],
		["table", "table_i32", tableI32]
	];

	const wrongRows = [];
	const timings = [];
	for (const [label, exportName, twin] of bodies) {
		const expected = reference(twin);
		for (const count of KS) {
			for (const [laneName, tops] of [
				["shared", null],
				["private", stackTopsFor(heapBase, storeBase, count)]
			]) {
				const lane = await startLane({ module, memory, exportName, count, stackTops: tops });
				let wrong = 0;
				const samples = [];
				for (let r = 0; r < RUNS; r++) {
					seed(i32, base);
					const t0 = performance.now();
					lane.run();
					samples.push(performance.now() - t0);
					if (fnv(i32, base, ROWS * 4) !== expected) wrong++;
				}
				await lane.stop();
				wrongRows.push({ body: label, workers: count, lane: laneName, wrong: `${wrong} of ${RUNS}` });
				timings.push({ body: label, workers: count, lane: laneName, ms: median(samples).toFixed(4) });
			}
		}
	}

	console.log("## Runs that disagree with the one-thread reference\n");
	table(wrongRows, cols("body", "workers", "lane", "wrong"));
	console.log("\n## Median milliseconds for one pass\n");
	table(timings, cols("body", "workers", "lane", "ms"));

	await engineLane(module, storeBase);
}

await main();
