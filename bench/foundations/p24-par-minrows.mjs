/**
 * P24 minRows. Where the pool starts to pay, and what it costs below that.
 *
 * `parallel.minRows` is the total matched row count below which a parallel
 * system runs its sequential `fn`. `p24-par-engine` and `p25-wasm-engine` both
 * pin it at one, so every pooled lane dispatches and neither probe says where
 * the threshold belongs. This probe is that measurement, and it is the evidence
 * behind `DEFAULT_PARALLEL_MIN_ROWS`.
 *
 * The sweep runs the matched row count from one thousand to one million, on:
 *
 *   - a light body, `pos += vel * dt`, memory bound,
 *   - a heavy body, a hash mix with a branch for each row, compute bound,
 *   - each body as a `js` kernel and as a `wasm` kernel,
 *   - two, four and one below the machine's parallelism, as the worker count,
 *   - the shared backing and the wasm backing.
 *
 * A `wasm` kernel needs the wasm backing, because a worker imports the world's
 * memory as `env.memory` and a `SharedArrayBuffer` cannot be a module memory.
 * That cell is refused, and the refusal stays in the output.
 *
 * ## The two lanes are paired, and the pairing is the point
 *
 * The sequential lane is not a world with no pool. It is a second system over
 * the same body, whose `minRows` sits above every size in the sweep, running
 * with the pool attached. So the frame it measures is exactly the frame a world
 * below the threshold pays, down to the declined dispatch.
 *
 * The two lanes run in alternating blocks inside one sample loop, and the probe
 * keeps the ratio of each round as well as the two medians. A machine that
 * changes speed halfway through a variant changes it for both lanes in the same
 * round, so the paired ratio survives what a sequential pass of one lane then
 * the other would not.
 *
 * **The light body needs that pairing.** Its per-row cost on V8 is bimodal, and
 * the switch is not tied to a row count or a call count. The slow state costs
 * several times the fast one. The probe reproduces it with no engine and no
 * pool, over four flat `Int32Array` columns, so it is not the engine's frame and
 * not the split. Every table here therefore carries the minimum beside the
 * median, and the crossover is reported twice: once against the sequential
 * median, and once against the sequential minimum, which is the sequential path
 * at its best and the harder bar for the pool to clear.
 *
 * ## The cost below the crossover
 *
 * A default that is too low dispatches a frame that would have been faster
 * sequentially, and the world pays that on every frame. The tables carry the
 * pooled and the sequential milliseconds side by side at every size, so the loss
 * is readable and not inferred from a ratio.
 *
 * A default that is too high costs the gain the world never takes, plus the
 * standing cost of a gate that declines. The `gate` lane measures that gate
 * against a world with no pool at all.
 *
 * ## Correctness first
 *
 * The world is deterministic and every column is `i32`, which is the only shape
 * `snapshots.stateHash()` will hash. Every lane runs the same frames from the
 * same seeded bytes and must leave the same hash. One archetype is excluded by a
 * tag, and its rows are folded separately, because every lane resolves the same
 * mask and a shared misread would agree with itself.
 *
 * One process for each backing and size. A world of a million entities allocates
 * enough that a second size in the same process would be timed against its
 * garbage.
 *
 * Warmup is counted in row visits and in frames, not in frames alone. A small
 * world needs thousands of frames to reach the state a large world reaches in
 * one, and a probe that warms by row visits alone reads a cold path as a loss.
 *
 * Run: `node bench/foundations/p24-par-minrows.mjs`. The whole sweep also runs
 * under bun and under deno, and the output says what happens there.
 */
import { availableParallelism } from "node:os";
import {
	median,
	iqr,
	table,
	emit,
	variantArg,
	runVariant,
	runVariantOn,
	RUNTIMES
} from "./harness.mjs";
import { emitKernelModule } from "./wasm/kernel_module.mjs";
import { integrateI32, mixI32 } from "./wasm/engine-kernels.mjs";

const KERNELS_URL = new URL("./wasm/engine-kernels.mjs", import.meta.url).href;
const CORES = availableParallelism();

/** A ladder of about two to one. A crossover is a threshold on a log scale, and
 * a linear ladder spends its samples where the answer is already known. */
const SIZES = [
	1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 125_000, 250_000, 500_000, 1_000_000
];

/** Two, four, and one below the machine's parallelism, which is the count
 * `workers.attach` defaults to. One worker is not a split. */
const KS = [...new Set([2, 4, Math.max(2, CORES - 1)])]
	.filter((k) => k <= CORES)
	.sort((a, b) => a - b);

const BACKINGS = ["shared", "wasm"];

/** A region id the engine never interprets. It exists so `regionHandle` gives
 * the probe the store buffer on either backing. */
const PROBE_REGION = 0x504d5231;

/** An integer step, because an integer world has no fractional one. The `wasm`
 * kernels declare `dt` as `i32`, and the JavaScript twins multiply with
 * `Math.imul`, so every lane runs the same arithmetic. */
const DT = 3;

/** Frames behind the hash, before any timing. */
const HASH_FRAMES = 3;

/** The wasm backing, fixed across the sizes so one shape serves every process. */
const MAX_PAGES = 2048;
const INITIAL_PAGES = 64;
const SHARED_MAX_BYTES = MAX_PAGES * 65536;

/** Above every size in the sweep, so the gated lane's dispatch always turns back
 * at the row-count compare. */
const GATE_MIN_ROWS = 4_000_000;

/**
 * The warmup budget for one lane: row visits, frames, and a wall-clock ceiling.
 *
 * All three are needed. A thousand-row frame reaches the row budget in one pass
 * and is still cold, and a million-row frame reaches the frame budget only after
 * seconds. The ceiling keeps the largest sizes from spending minutes, and those
 * sizes are the ones a single frame already warms.
 */
const WARM_ROWS = 20_000_000;
const WARM_FRAMES = 3_000;
const WARM_MS = 600;

/** Row visits inside one timed block, so a frame that takes microseconds is
 * timed as a batch and not against the clock's own noise. */
const SAMPLE_ROWS = 400_000;
const ROUNDS = 15;

const BODIES = [
	{
		id: "light",
		label: "light, pos += vel * dt",
		js: "integrateI32",
		wasm: "integrate_i32",
		fn: integrateI32
	},
	{ id: "heavy", label: "heavy, hash mix", js: "mixI32", wasm: "mix_i32", fn: mixI32 }
];

/** How many frames one timed block holds. */
function batchFor(rows) {
	return Math.max(1, Math.min(500, Math.ceil(SAMPLE_ROWS / rows)));
}

/** Run one lane until every warmup budget is met, or the ceiling expires. */
function warm(run, rows) {
	const target = Math.max(WARM_FRAMES, Math.ceil(WARM_ROWS / rows));
	const t0 = performance.now();
	let frames = 0;
	while (frames < target) {
		run();
		frames++;
		if (frames >= 3 && performance.now() - t0 > WARM_MS) break;
	}
	return frames;
}

/**
 * Time two lanes against each other, alternating block by block.
 *
 * Returns the median and the minimum of each lane, and the median of the
 * per-round ratios. The ratio is the number to trust when the two medians come
 * from different machine states, which the light body makes a real risk.
 */
function pair(runSequential, runPooled, rows) {
	const warmed = warm(runSequential, rows) + warm(runPooled, rows);
	const batch = batchFor(rows);
	const block = (run) => {
		const t0 = performance.now();
		for (let f = 0; f < batch; f++) run();
		return (performance.now() - t0) / batch;
	};
	const sequential = [];
	const pooled = [];
	const ratios = [];
	for (let r = 0; r < ROUNDS; r++) {
		const s = block(runSequential);
		const p = block(runPooled);
		sequential.push(s);
		pooled.push(p);
		ratios.push(p / s);
	}
	return {
		warmed,
		batch,
		sequential: { median: median(sequential), ...iqr(sequential) },
		pooled: { median: median(pooled), ...iqr(pooled) },
		ratio: median(ratios)
	};
}

/**
 * Four archetypes over `Pos` and `Vel`, three matched and one carrying the tag
 * the query excludes. A split then has to cross an archetype boundary, and the
 * excluded archetype has to keep its seeded bytes.
 *
 * `columnCapacity` is pinned so no grow lands inside a timed run.
 */
async function buildWorld(entities, backing) {
	const { ECS } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const { workers } = await import(new URL("../../dist/plugins/workers.js", import.meta.url).href);
	const columnCapacity = Math.ceil(entities / 4) + 64;
	const memory =
		backing === "wasm"
			? {
					backing: { wasm: { maximumPages: MAX_PAGES, initialPages: INITIAL_PAGES } },
					columnCapacity
				}
			: { backing: "shared", maxBytes: SHARED_MAX_BYTES, columnCapacity };
	// One declared region, because `regionHandle` is the public seam to the store
	// buffer and the shared backing exposes no other. One path here keeps the two
	// backings identical.
	const ecs = ECS.create({
		deterministic: true,
		memory,
		regions: [{ id: PROBE_REGION, name: "p24-minrows", bytes: 64, init: () => {} }],
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

/** The store buffer, through the public region seam. Both backings answer here,
 * so the seed and the restore are one path. */
function storeBytes(ecs) {
	const handle = ecs.regionHandle(PROBE_REGION);
	if (handle === null) throw new Error("probe region missing, pass it in ECSOptions.regions");
	return handle.buffer;
}

/** Register a `wasm` kernel on the shared backing and try to attach. The engine
 * refuses it, and the refusal belongs in the output beside the cells that ran. */
async function sharedWasmRefusal(module) {
	const { ecs, Pos, Vel } = await buildWorld(64, "shared");
	const { SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const query = ecs.query(Pos, Vel);
	const system = ecs.registerSystem({
		name: "wasm_on_shared",
		reads: [Vel],
		writes: [Pos],
		parallel: {
			kernel: { wasm: module, export: "integrate_i32" },
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
	});
	ecs.addSystems(SCHEDULE.UPDATE, system);
	try {
		const pool = await ecs.workers.attach({ count: 2 });
		await pool.detach();
		return "attached, which the worker entry was expected to refuse";
	} catch (error) {
		return `refused: ${error.message}`;
	}
}

/**
 * The kernel with no engine and no pool, over four flat columns.
 *
 * The light body's per-row cost on V8 flips between two states, and this lane
 * says the flip is the kernel's and not the frame's. It reports the minimum and
 * the maximum block, because the median hides a lane that changed state halfway
 * through.
 */
function kernelAlone(rows) {
	const px = new Int32Array(rows);
	const py = new Int32Array(rows);
	const vx = new Int32Array(rows);
	const vy = new Int32Array(rows);
	for (let i = 0; i < rows; i++) {
		px[i] = i % 1000;
		py[i] = i % 977;
		vx[i] = (i % 13) - 6;
		vy[i] = (i % 17) - 8;
	}
	const out = [];
	for (const body of BODIES) {
		const run = () => body.fn(px, py, vx, vy, 0, rows, DT);
		warm(run, rows);
		const batch = batchFor(rows);
		const times = [];
		for (let r = 0; r < ROUNDS; r++) {
			const t0 = performance.now();
			for (let f = 0; f < batch; f++) run();
			times.push((performance.now() - t0) / batch);
		}
		out.push({ body: body.id, ...iqr(times), median: median(times) });
	}
	return out;
}

async function runOne(backing, entities) {
	const module = new WebAssembly.Module(emitKernelModule({ minPages: 1, maxPages: MAX_PAGES }));
	const { ecs, Pos, Vel, Frozen } = await buildWorld(entities, backing);
	const { SCHEDULE } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const query = ecs.query(Pos, Vel).not(Frozen);
	const rows = query.entityCount;

	const columns = [
		[Pos, "x"],
		[Pos, "y"],
		[Vel, "vx"],
		[Vel, "vy"]
	];

	// A wasm kernel cannot load on the shared backing, so the lane is absent and
	// not zero. `sharedWasmRefusal` reports why, once.
	const lanes = [
		{ id: "js", label: "js kernel", kernel: (body) => ({ js: KERNELS_URL, export: body.js }) }
	];
	if (backing === "wasm") {
		lanes.push({
			id: "wasm",
			label: "wasm kernel",
			kernel: (body) => ({ wasm: module, export: body.wasm })
		});
	}

	// One system for each body and lane, all registered, one enabled at a time. A
	// run condition and not a removal, because a removed system's plan would leave
	// the pool holding a kernel nothing dispatches.
	let active = "";
	const systems = [];
	const register = (name, body, kernel, minRows) => {
		const system = ecs.registerSystem({
			name,
			reads: [Vel],
			writes: [Pos],
			parallel: { kernel, columns, minRows, query },
			fn: (_ctx, dt) => {
				query.forEachChunk((cols, count) => {
					const p = cols.mut(Pos);
					const v = cols.read(Vel);
					body.fn(p.x, p.y, v.vx, v.vy, 0, count, dt);
				});
			}
		});
		systems.push({ system, runIf: { name: `only_${name}`, evaluate: () => active === name } });
	};

	for (const body of BODIES) {
		for (const lane of lanes) register(`${body.id}_${lane.id}`, body, lane.kernel(body), 1);
		// The sequential half of every pair. Same body, same kernel declaration, a
		// threshold no size here reaches, so the dispatch declines and `fn` runs.
		register(`${body.id}_gate`, body, { js: KERNELS_URL, export: body.js }, GATE_MIN_ROWS);
	}
	ecs.addSystems(SCHEDULE.UPDATE, ...systems);

	// The seeded bytes, so every lane starts from the same state. The store never
	// grows after this point, so the buffer reference stays valid.
	const store = storeBytes(ecs);
	const seed = new Uint8Array(store.byteLength);
	seed.set(new Uint8Array(store));
	const restore = () => new Uint8Array(store).set(seed);

	// The rows the query excludes. Every lane must leave them exactly as the seed
	// left them.
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
	const gateRows = [];
	let poolNote = "attached";

	/** Restore the seeded bytes, run the frames the hash covers, and report what
	 * the lane left. The caller times afterwards, from the hashed state, which an
	 * integer body leaves in the same shape it started in. */
	const check = (name) => {
		active = name;
		restore();
		for (let f = 0; f < HASH_FRAMES; f++) ecs.update(DT);
		correctness.push({
			lane: name,
			hash: ecs.snapshots.stateHash(),
			untouched: excludedFold() === seededExcluded
		});
	};

	// The gate, measured against a world with no pool at all. Not paired, because
	// the two halves cannot both hold the pool. It runs first and again last, and
	// the two readings bracket what an attach and a detach leave behind.
	const frameCost = (body) => {
		active = `${body.id}_gate`;
		warm(() => ecs.update(DT), rows);
		const batch = batchFor(rows);
		const times = [];
		for (let r = 0; r < ROUNDS; r++) {
			const t0 = performance.now();
			for (let f = 0; f < batch; f++) ecs.update(DT);
			times.push((performance.now() - t0) / batch);
		}
		return { median: median(times), ...iqr(times) };
	};

	for (const body of BODIES) check(`${body.id}_gate`);
	const beforePool = BODIES.map((body) => ({ body: body.id, ...frameCost(body) }));

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
				check(`${body.id}_${lane.id}`);
				const gate = `${body.id}_gate`;
				const dispatch = `${body.id}_${lane.id}`;
				const measured = pair(
					() => {
						active = gate;
						ecs.update(DT);
					},
					() => {
						active = dispatch;
						ecs.update(DT);
					},
					rows
				);
				timings.push({ body: body.id, lane: lane.label, k, ...measured });
			}
			// The gate again, with the pool attached. The difference from the no-pool
			// reading is the standing cost of a threshold nothing reaches. Once, at
			// the first worker count, because the dispatch turns back at the row
			// compare before it reads the worker count at all.
			if (k === KS[0]) {
				active = `${body.id}_gate`;
				gateRows.push({ body: body.id, k, ...frameCost(body) });
			}
		}
		await pool.detach();
	}

	const afterPool = BODIES.map((body) => ({ body: body.id, ...frameCost(body) }));

	return {
		backing,
		entities,
		rows,
		cores: CORES,
		ks: KS,
		poolNote,
		correctness,
		timings,
		gate: { beforePool, afterPool, attached: gateRows },
		alone: kernelAlone(rows)
	};
}

/**
 * The smallest size that wins and keeps winning, for each series.
 *
 * A single winning size proves nothing, because a sweep of eleven sizes over a
 * machine that changes speed wins one of them by accident. `sustained` is the
 * start of the winning run that reaches the largest size, and it is the number a
 * default has to serve.
 *
 * Two bars. `median` compares the pooled median against the sequential median.
 * `best` compares it against the sequential minimum, which is the sequential
 * path in its fast state and the harder bar.
 */
function crossovers(rows) {
	const keys = [...new Set(rows.map((r) => `${r.backing}|${r.body}|${r.lane}|${r.k}`))];
	const out = [];
	for (const key of keys) {
		const [backing, body, lane, k] = key.split("|");
		const series = rows
			.filter((r) => `${r.backing}|${r.body}|${r.lane}|${r.k}` === key)
			.sort((a, b) => a.rows - b.rows);
		const sustained = (wins) => {
			let start = null;
			for (const point of series) {
				if (!wins(point)) start = null;
				else if (start === null) start = point.rows;
			}
			return start;
		};
		const byMedian = sustained((p) => p.pooled < p.sequential);
		const byBest = sustained((p) => p.pooled < p.sequentialMin);
		const worst = series
			.filter((p) => p.pooled >= p.sequential)
			.reduce((acc, p) => Math.max(acc, p.pooled - p.sequential), 0);
		out.push({ backing, body, lane, k: Number(k), byMedian, byBest, worstLossMs: worst });
	}
	return out.sort(
		(a, b) =>
			a.backing.localeCompare(b.backing) ||
			a.body.localeCompare(b.body) ||
			a.lane.localeCompare(b.lane) ||
			a.k - b.k
	);
}

function flatten(results) {
	const rows = [];
	for (const r of results) {
		for (const t of r.timings) {
			rows.push({
				backing: r.backing,
				entities: r.entities,
				rows: r.rows,
				body: t.body,
				lane: t.lane,
				k: t.k,
				sequential: t.sequential.median,
				sequentialMin: t.sequential.min,
				pooled: t.pooled.median,
				pooledMin: t.pooled.min,
				ratio: t.ratio
			});
		}
	}
	return rows;
}

function report(results, title) {
	console.log(`\n### ${title}\n`);

	// The gated lane of each body runs first and sets the expected hash for that
	// body. Two bodies leave two different states, so the key carries the body.
	const expected = new Map();
	for (const r of results) {
		for (const c of r.correctness) {
			const key = `${r.backing}|${r.entities}|${c.lane.split("_")[0]}`;
			if (!expected.has(key)) expected.set(key, c.hash);
		}
	}
	let compared = 0;
	let bad = 0;
	for (const r of results) {
		for (const c of r.correctness) {
			compared++;
			if (
				c.hash !== expected.get(`${r.backing}|${r.entities}|${c.lane.split("_")[0]}`) ||
				!c.untouched
			)
				bad++;
		}
	}
	console.log(
		`  lanes compared: ${compared}. lanes that disagree or touched an excluded row: ${bad}${bad ? "  <-- READ THESE" : ""}`
	);
	for (const r of results) {
		if (r.poolNote !== "attached") console.log(`  ${r.backing} ${r.entities}: pool ${r.poolNote}`);
	}

	const rows = flatten(results);
	for (const backing of BACKINGS) {
		const here = rows.filter((r) => r.backing === backing);
		if (here.length === 0) continue;
		console.log(
			`\n  ${backing} backing, milliseconds for one frame. Both lanes hold the pool, and only the pooled one dispatches`
		);
		table(here, [
			{ label: "rows", get: (x) => x.rows },
			{ label: "body", get: (x) => x.body },
			{ label: "kernel", get: (x) => x.lane },
			{ label: "K", get: (x) => x.k },
			{ label: "sequential", get: (x) => x.sequential.toFixed(4) },
			{ label: "its best block", get: (x) => x.sequentialMin.toFixed(4) },
			{ label: "pooled", get: (x) => x.pooled.toFixed(4) },
			{ label: "pooled - sequential", get: (x) => (x.pooled - x.sequential).toFixed(4) },
			{ label: "paired ratio", get: (x) => x.ratio.toFixed(2) },
			{ label: "wins", get: (x) => (x.pooled < x.sequential ? "yes" : "no") },
			{ label: "wins on its best", get: (x) => (x.pooled < x.sequentialMin ? "yes" : "no") }
		]);
	}

	console.log(
		`\n  the gate. An attached pool whose minRows the row count never reaches, against no pool at all`
	);
	const gate = [];
	for (const r of results) {
		for (const attached of r.gate.attached) {
			const before = r.gate.beforePool.find((x) => x.body === attached.body);
			const after = r.gate.afterPool.find((x) => x.body === attached.body);
			gate.push({
				backing: r.backing,
				rows: r.rows,
				body: attached.body,
				k: attached.k,
				before: before.median,
				attached: attached.median,
				after: after.median
			});
		}
	}
	table(gate, [
		{ label: "backing", get: (x) => x.backing },
		{ label: "rows", get: (x) => x.rows },
		{ label: "body", get: (x) => x.body },
		{ label: "K", get: (x) => x.k },
		{ label: "no pool, before", get: (x) => x.before.toFixed(4) },
		{ label: "pool attached, declines", get: (x) => x.attached.toFixed(4) },
		{ label: "no pool, after", get: (x) => x.after.toFixed(4) },
		{ label: "gate - before", get: (x) => (x.attached - x.before).toFixed(4) }
	]);

	console.log(
		`\n  the kernels alone, no engine and no pool. A wide min-to-max span is the bimodal state, not noise`
	);
	table(
		results.flatMap((r) => r.alone.map((a) => ({ backing: r.backing, rows: r.rows, ...a }))),
		[
			{ label: "backing", get: (x) => x.backing },
			{ label: "rows", get: (x) => x.rows },
			{ label: "body", get: (x) => x.body },
			{ label: "min ns/row", get: (x) => ((x.min * 1e6) / x.rows).toFixed(2) },
			{ label: "median ns/row", get: (x) => ((x.median * 1e6) / x.rows).toFixed(2) },
			{ label: "max ns/row", get: (x) => ((x.max * 1e6) / x.rows).toFixed(2) },
			{ label: "max / min", get: (x) => (x.max / x.min).toFixed(2) }
		]
	);

	console.log(
		`\n  crossovers, in matched rows. The smallest row count that wins and keeps winning`
	);
	table(crossovers(rows), [
		{ label: "backing", get: (x) => x.backing },
		{ label: "body", get: (x) => x.body },
		{ label: "kernel", get: (x) => x.lane },
		{ label: "K", get: (x) => x.k },
		{ label: "against the median", get: (x) => x.byMedian ?? "never" },
		{ label: "against its best block", get: (x) => x.byBest ?? "never" },
		{
			label: "rows for each worker, best",
			get: (x) => (x.byBest === null ? "-" : Math.round(x.byBest / x.k))
		},
		{ label: "worst loss, ms/frame", get: (x) => x.worstLossMs.toFixed(4) }
	]);
	console.log("");
}

async function main() {
	const variant = variantArg();
	if (variant) {
		const [backing, size] = variant.split(":");
		if (backing === "refusal") {
			const module = new WebAssembly.Module(emitKernelModule({ minPages: 1, maxPages: MAX_PAGES }));
			emit({ refusal: await sharedWasmRefusal(module) });
			// The attach rejects and leaves its worker threads running, so this
			// process never reaches its own exit. The parent reads the result line
			// from a `spawnSync`, which waits for the child to end. Leave loudly, and
			// read the note this prints as the defect it is.
			process.stderr.write(
				"  the refusal variant exits itself: the failed attach left its workers running\n"
			);
			process.exit(0);
		}
		emit(await runOne(backing, Number(size)));
		return;
	}

	console.log(
		`\nP24 minRows. availableParallelism() = ${CORES}, K in ${KS.join(", ")}, sizes ${SIZES[0].toLocaleString()} to ${SIZES[SIZES.length - 1].toLocaleString()}`
	);
	const refusal = runVariant(import.meta.url, "refusal:0");
	console.log(`  a wasm kernel on the shared backing: ${refusal.refusal}\n`);

	const results = [];
	for (const backing of BACKINGS) {
		for (const size of SIZES) {
			process.stderr.write(`  running node ${backing}:${size}\n`);
			results.push(runVariant(import.meta.url, `${backing}:${size}`));
		}
	}
	report(results, "node, V8");

	for (const runtime of RUNTIMES.filter((x) => x.cmd !== "node")) {
		const here = [];
		let missing = 0;
		for (const backing of BACKINGS) {
			for (const size of SIZES) {
				process.stderr.write(`  running ${runtime.cmd} ${backing}:${size}\n`);
				const result = runVariantOn(runtime, import.meta.url, `${backing}:${size}`);
				if (result === null) missing++;
				else here.push(result);
			}
		}
		if (here.length === 0) {
			console.log(`\n  ${runtime.cmd}: no result, see the error above\n`);
			continue;
		}
		report(
			here,
			`${runtime.cmd}, ${runtime.engine}${missing ? `, ${missing} variants produced no result` : ""}`
		);
	}
}

await main();
