/**
 * P25 engine, a `wasm` kernel on the shipped pool.
 *
 * `p24-par-engine` drove the engine's own workers with a `js` kernel. The
 * `wasm` kernel form has tests and no measurement, and this probe is the
 * measurement. Everything between the frame and the rows is the engine's code:
 * the dispatch, the plan, the control buffer, the worker entry, the descriptor
 * walk and the join stamp. The probe adds only the kernels.
 *
 * Two bodies run, one memory bound and one compute bound. Each runs on four
 * lanes:
 *
 *   - the sequential `fn`, with no pool attached,
 *   - a `js` kernel, imported by the worker from a module URL,
 *   - a `wasm` kernel emitted byte by byte by `wasm/emit.mjs`,
 *   - the same `wasm` kernel built by Zig, when the compiler is present.
 *
 * A last pass runs every body with no engine around it, so a gap between two
 * lanes can be charged to the kernel or to the frame.
 *
 * The emitted module is the point of the `wasm` lane. It depends on no
 * toolchain, so what it measures is the claim "any module runs on the pool".
 * The Zig lane says what an optimising compiler adds on top of that.
 *
 * **Correctness first.** Every lane runs the same frames from the same seeded
 * bytes and must leave the same `ecs.snapshots.stateHash()`. The world is
 * deterministic and its columns are `i32`, which is the only shape the engine's
 * own oracle will hash. A mismatch is the headline of the output.
 *
 * A `wasm` kernel needs the wasm backing, because a worker imports the world's
 * memory as `env.memory` and a `SharedArrayBuffer` cannot be a module memory.
 * So the store sits above the address the Zig module's stack and data end at,
 * and both modules declare the memory the world holds.
 *
 * One process for each size. A world of a million entities allocates enough
 * that a second size in the same process would be timed against its garbage.
 *
 * Run: `node bench/foundations/p25-wasm-engine.mjs`. The smallest size also
 * runs under bun and under deno, and the output says what happens there.
 *
 * The parent process compiles the Zig module once and every child reuses the
 * binary. So a child never calls the compiler, which a deno child could not do
 * without a run permission.
 */
import { availableParallelism } from "node:os";
import { median, iqr, table, emit, variantArg, runVariant, runVariantOn, RUNTIMES } from "./harness.mjs";
import { emitKernelModule } from "./wasm/kernel_module.mjs";
import { buildZig } from "./wasm/build_zig.mjs";
import { integrateI32, mixI32 } from "./wasm/engine-kernels.mjs";

const KERNELS_URL = new URL("./wasm/engine-kernels.mjs", import.meta.url).href;
const CORES = availableParallelism();
const SIZES = [10_000, 100_000, 1_000_000];
const KS = [1, 2, 4, 8].filter((k) => k <= CORES);

/** An integer step, because an integer world has no fractional one. The `wasm`
 * kernels declare `dt` as `i32`, and the JavaScript twins multiply with
 * `Math.imul`, so every lane runs the same arithmetic. */
const DT = 3;
const FRAMES = 3;

/** The memory every lane shares. The maximum is fixed across the sizes so one
 * Zig binary serves every process: a module refuses a memory whose maximum is
 * above the one the module declares. */
const MAX_PAGES = 2048;
const INITIAL_PAGES = 64;

/**
 * Where the store starts. The Zig module owns every byte below its own
 * `__heap_base`, which is its stack and its data. The store must not touch
 * them.
 *
 * The value is a constant and not a reading. So the world is the same whether
 * or not the compiler is present, and the probe checks the reading against this
 * base instead of following it.
 */
const STORE_BASE = 2 * 1024 * 1024;

const BODIES = [
	{ id: "light", label: "pos += vel * dt", js: "integrateI32", wasm: "integrate_i32", fn: integrateI32 },
	{ id: "heavy", label: "hash mix, branch per row", js: "mixI32", wasm: "mix_i32", fn: mixI32 }
];

function timeIt(fn, { warmup = 3, samples = 15 } = {}) {
	for (let i = 0; i < warmup; i++) fn();
	const times = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}
	return { median: median(times), ...iqr(times) };
}

/** Compile both modules. A missing compiler is a skip and never a pass, so the
 * Zig lane returns its reason and the caller prints it. */
function kernelModules() {
	const emitted = new WebAssembly.Module(emitKernelModule({ minPages: 1, maxPages: MAX_PAGES }));
	const built = buildZig("kernel.zig", "kernel.wasm", {
		maxMemoryBytes: MAX_PAGES * 65536,
		optimize: "ReleaseFast",
		flags: ["--export=__heap_base"],
		reuse: true
	});
	if (built === null) return { emitted, zig: null, zigNote: "zig is not installed, the Zig lane is skipped" };
	if (built.error !== undefined) {
		return { emitted, zig: null, zigNote: `zig failed to build kernel.zig: ${built.error.split("\n")[0]}` };
	}
	const zig = new WebAssembly.Module(built);
	// The module's own bytes must end below the store. A probe that assumed this
	// would let the module's stack overwrite the header, and the output would
	// blame the kernel.
	const probe = new WebAssembly.Instance(zig, {
		env: { memory: new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAX_PAGES, shared: true }) }
	});
	const heapBase = Number(probe.exports.__heap_base?.value ?? probe.exports.__heap_base);
	if (!Number.isFinite(heapBase) || heapBase > STORE_BASE) {
		return { emitted, zig: null, zigNote: `the Zig module owns memory up to ${heapBase}, which the store base ${STORE_BASE} does not clear` };
	}
	return { emitted, zig, zigNote: `built, __heap_base = ${heapBase}, store base = ${STORE_BASE}` };
}

/**
 * The same bodies with no engine around them, over four flat columns in a
 * memory the world never sees.
 *
 * A pooled number answers "what does the frame cost". It cannot say whether a
 * gap between two lanes came from the kernel or from the crossing, because a
 * frame holds both. This lane holds only the kernel, so the reader can subtract
 * one from the other.
 *
 * Timing only. The correctness table above is the oracle for these bodies, and
 * this memory carries no store to hash.
 */
function kernelsAlone(entities, emitted, zig) {
	const base = 4 * 1024 * 1024;
	const bytes = base + 4 * entities * 4;
	const pages = Math.ceil(bytes / 65536) + 16;
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
	const instances = {
		"wasm kernel (emitted)": new WebAssembly.Instance(emitted, { env: { memory } }),
		...(zig === null ? {} : { "wasm kernel (zig)": new WebAssembly.Instance(zig, { env: { memory } }) })
	};
	const address = [0, 1, 2, 3].map((c) => base + c * entities * 4);
	const views = address.map((a) => new Int32Array(memory.buffer, a, entities));
	for (let i = 0; i < entities; i++) {
		views[0][i] = i % 1000;
		views[1][i] = i % 977;
		views[2][i] = (i % 13) - 6;
		views[3][i] = (i % 17) - 8;
	}
	const out = [];
	for (const body of BODIES) {
		out.push({
			body: body.label,
			lane: "js kernel",
			...timeIt(() => body.fn(views[0], views[1], views[2], views[3], 0, entities, DT))
		});
		for (const [label, instance] of Object.entries(instances)) {
			const call = instance.exports[body.wasm];
			out.push({
				body: body.label,
				lane: label,
				...timeIt(() => call(address[0], address[1], address[2], address[3], 0, entities, DT))
			});
		}
	}
	return out;
}

/**
 * Four archetypes over `Pos` and `Vel`, three matched and one carrying the tag
 * the query excludes. A split then has to cross an archetype boundary. The
 * excluded archetype has to keep its seeded bytes, which a separate fold
 * checks.
 */
async function buildWorld(entities) {
	const { ECS } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { workers } = await import(
		new URL("../../dist/plugins/workers.js", import.meta.url).href
	);
	const ecs = ECS.create({
		deterministic: true,
		memory: {
			backing: { wasm: { maximumPages: MAX_PAGES, initialPages: INITIAL_PAGES } },
			storeBase: STORE_BASE,
			columnCapacity: Math.ceil(entities / 4) + 64
		},
		plugins: [workers()]
	});
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" }, { name: "Vel" });
	const TagOne = ecs.registerTag();
	const TagTwo = ecs.registerTag();
	const Frozen = ecs.registerTag();

	const parts = () => [Pos({ x: 0, y: 0 }), Vel({ vx: 0, vy: 0 })];
	const templates = [
		ecs.template(...parts()),
		ecs.template(...parts(), TagOne),
		ecs.template(...parts(), TagOne, TagTwo),
		ecs.template(...parts(), Frozen)
	];
	ecs.startup();
	for (let i = 0; i < entities; i++) ecs.spawn(templates[i % 4]);

	// Seed from the row index, through the engine's own query path. The values
	// repeat on a short cycle, so a wrong offset gives a wrong value and not a
	// plausible one.
	let n = 0;
	ecs.query(Pos, Vel).forEachChunk((cols, count) => {
		const p = cols.mut(Pos);
		const v = cols.mut(Vel);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = n % 1000;
			p.y[i] = n % 977;
			v.vx[i] = (n % 13) - 6;
			v.vy[i] = (n % 17) - 8;
		}
	});
	ecs.publishRowCounts();
	return { ecs, Pos, Vel, Frozen };
}

async function runOne(entities) {
	const { emitted, zig, zigNote } = kernelModules();
	const { ecs, Pos, Vel, Frozen } = await buildWorld(entities);
	const { SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const query = ecs.query(Pos, Vel).without(Frozen);

	const lanes = [
		{ id: "js", label: "js kernel", kernel: (body) => ({ js: KERNELS_URL, export: body.js }) },
		{ id: "wasm", label: "wasm kernel (emitted)", kernel: (body) => ({ wasm: emitted, export: body.wasm }) }
	];
	if (zig !== null) {
		lanes.push({ id: "zig", label: "wasm kernel (zig)", kernel: (body) => ({ wasm: zig, export: body.wasm }) });
	}

	// One system for each body and lane, all registered, one enabled at a time.
	// A run condition and not a removal, because a removed system's plan would
	// leave the pool holding a kernel nothing dispatches.
	let active = "";
	const systems = [];
	for (const body of BODIES) {
		for (const lane of lanes) {
			const name = `${body.id}_${lane.id}`;
			const system = ecs.registerSystem({
				name,
				reads: [Vel],
				writes: [Pos],
				parallel: {
					kernel: lane.kernel(body),
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
					query.forEachChunk((cols, count) => {
						const p = cols.mut(Pos);
						const v = cols.read(Vel);
						body.fn(p.x, p.y, v.vx, v.vy, 0, count, dt);
					});
				}
			});
			systems.push({ system, runIf: { name: `only_${name}`, evaluate: () => active === name } });
		}
	}
	ecs.addSystems(SCHEDULE.UPDATE, ...systems);

	// The seeded bytes, so every lane starts from the same state. The store
	// never grows after this point, so the buffer reference stays valid.
	const buffer = ecs.wasmMemory.buffer;
	const seed = new Uint8Array(buffer.byteLength);
	seed.set(new Uint8Array(buffer));
	const restore = () => new Uint8Array(buffer).set(seed);

	// The rows the query excludes. Every lane must leave them exactly as the
	// seed left them. The state hash alone would not say so, because every lane
	// resolves the same exclude mask and a shared misread would agree with
	// itself.
	const excluded = ecs.query(Pos, Vel, Frozen);
	const excludedFold = () => {
		let h = 0x811c9dc5;
		excluded.forEachChunk((cols, count) => {
			const p = cols.read(Pos);
			for (let i = 0; i < count; i++) {
				h = Math.imul(h ^ p.x[i], 16777619) >>> 0;
				h = Math.imul(h ^ p.y[i], 16777619) >>> 0;
			}
		});
		return h >>> 0;
	};
	const seededExcluded = excludedFold();

	const correctness = [];
	const timings = [];
	let poolNote = "attached";

	/** Restore the seeded bytes, run the frames the hash covers, then time one
	 * frame. The timing runs on from the hashed state, which an integer body
	 * leaves in the same shape it started in. */
	const measure = (body, laneId) => {
		active = `${body.id}_${laneId}`;
		restore();
		for (let f = 0; f < FRAMES; f++) ecs.update(DT);
		const hash = ecs.snapshots.stateHash();
		const untouched = excludedFold() === seededExcluded;
		const t = timeIt(() => ecs.update(DT));
		return { hash, untouched, t };
	};

	// The sequential lane first, with no pool attached. Every system runs its
	// `fn`, and the `fn` imports the same module the `js` kernel does.
	for (const body of BODIES) {
		const { hash, untouched, t } = measure(body, "js");
		correctness.push({ body: body.label, lane: "sequential fn (no pool)", k: "-", hash, untouched });
		timings.push({ body: body.label, lane: "sequential fn (no pool)", k: "-", ...t });
	}

	for (const k of KS) {
		let pool;
		try {
			pool = await ecs.workers.attach({ count: k });
		} catch (error) {
			poolNote = `workers.attach({ count: ${k} }) failed: ${error.message}`;
			break;
		}
		for (const body of BODIES) {
			for (const lane of lanes) {
				const { hash, untouched, t } = measure(body, lane.id);
				correctness.push({ body: body.label, lane: lane.label, k, hash, untouched });
				timings.push({ body: body.label, lane: lane.label, k, ...t });
			}
		}
		await pool.detach();
	}

	// Last, so its memory lands outside every pooled sample.
	const alone = kernelsAlone(entities, emitted, zig);

	return {
		entities,
		frames: FRAMES,
		cores: CORES,
		zigNote,
		poolNote,
		lanes: lanes.map((l) => l.label),
		correctness,
		timings,
		alone
	};
}

function report(r) {
	console.log(
		`\n--- ${r.entities.toLocaleString()} entities, four archetypes, one excluded by a tag, ${r.frames} frames for the hash`
	);
	console.log(`    zig: ${r.zigNote}`);
	console.log(`    pool: ${r.poolNote}\n`);

	const baseline = new Map(
		r.correctness.filter((x) => x.k === "-").map((x) => [x.body, x.hash])
	);
	table(
		r.correctness.map((x) => ({ ...x, agrees: x.hash === baseline.get(x.body) ? "yes" : "NO" })),
		[
			{ label: "body", get: (x) => x.body },
			{ label: "lane", get: (x) => x.lane },
			{ label: "workers", get: (x) => x.k },
			{ label: "stateHash", get: (x) => x.hash },
			{ label: "agrees with sequential fn", get: (x) => x.agrees },
			{ label: "excluded rows untouched", get: (x) => (x.untouched ? "yes" : "NO") }
		]
	);
	const bad = r.correctness.filter((x) => x.hash !== baseline.get(x.body) || !x.untouched);
	console.log(
		`\n  lanes compared: ${r.correctness.length}. lanes that disagree or touched an excluded row: ${bad.length}${bad.length ? "  <-- READ THESE" : ""}\n`
	);

	for (const body of BODIES) {
		const rows = r.timings.filter((x) => x.body === body.label);
		if (rows.length === 0) continue;
		const base = rows.find((x) => x.k === "-");
		console.log(`  ${body.label}, one frame`);
		table(rows, [
			{ label: "lane", get: (x) => x.lane },
			{ label: "workers", get: (x) => x.k },
			{ label: "ms/frame", get: (x) => x.median.toFixed(4) },
			{ label: "p25", get: (x) => x.p25.toFixed(4) },
			{ label: "p75", get: (x) => x.p75.toFixed(4) },
			{ label: "vs sequential fn", get: (x) => `${(base.median / x.median).toFixed(2)}x` }
		]);
		console.log("");
	}

	console.log(`  the kernels alone, one pass over ${r.entities.toLocaleString()} rows, no engine and no pool`);
	const jsAlone = new Map(r.alone.filter((x) => x.lane === "js kernel").map((x) => [x.body, x.median]));
	table(r.alone, [
		{ label: "body", get: (x) => x.body },
		{ label: "lane", get: (x) => x.lane },
		{ label: "ms/pass", get: (x) => x.median.toFixed(4) },
		{ label: "p25", get: (x) => x.p25.toFixed(4) },
		{ label: "p75", get: (x) => x.p75.toFixed(4) },
		{ label: "vs js kernel", get: (x) => `${(jsAlone.get(x.body) / x.median).toFixed(2)}x` }
	]);
	console.log("");
}

async function main() {
	const variant = variantArg();
	if (variant) {
		emit(await runOne(Number(variant)));
		return;
	}

	console.log(`\nP25 engine, a wasm kernel on the shipped pool. availableParallelism() = ${CORES}, K capped at ${Math.max(...KS)}`);
	// Build the Zig module once here. Each child reuses the binary, so a slow
	// compile does not land inside three processes.
	console.log(`  ${kernelModules().zigNote}`);

	for (const n of SIZES) report(runVariant(import.meta.url, String(n)));

	console.log("\nThe other runtimes, smallest size only.\n");
	for (const runtime of RUNTIMES.filter((x) => x.cmd !== "node")) {
		const result = runVariantOn(runtime, import.meta.url, String(SIZES[0]));
		if (result === null) {
			console.log(`  ${runtime.cmd}: no result, see the error above`);
			continue;
		}
		console.log(`  ${runtime.cmd} (${runtime.engine}): pool ${result.poolNote}, lanes ${result.lanes.join(", ")}`);
		report(result);
	}
	console.log("");
}

await main();
