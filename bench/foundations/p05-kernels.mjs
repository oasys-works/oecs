/**
 * P05-kernels, the three backings, across five kernels.
 *
 * `p05-growth.mjs` measured one kernel: a dense physics step over a million
 * entities. It found that the shared profile's growable `SharedArrayBuffer`
 * costs several times the heap profile on JavaScriptCore, and nothing on V8,
 * and that a fixed `SharedArrayBuffer` removes the cost.
 *
 * One kernel is one point. A point is not a curve, and a backing decision that
 * rests on a single workload is a rule shaped by whatever that workload
 * happened to stress. This probe asks the same question of the paths the first
 * one did not touch:
 *
 *   physics-small  the same dense loop, small enough to stay in cache, so
 *                  bandwidth cannot hide or invent a per-access cost
 *   churn          add and remove a tag, which runs the archetype transition
 *                  and its column copy loop
 *   byid           shuffled reads through a cursor, the pointer-chase path
 *   spawn          build and tear down a population, which writes columns and
 *                  the entity index
 *   sparse         a sparse component's own store, which is not a column
 *
 * Read the columns against each other, never the milliseconds. Each row is one
 * runtime and one kernel, and the ratio is against the heap backing, which is
 * the library default.
 */
import { emit, iqr, median, RUNTIMES, runVariantOn, variantArg } from "./harness.mjs";

const CAP = 256 * 1024 * 1024;
const DT = 1 / 60;
const SAMPLES = 15;
const WARMUP = 5;

/** Each kernel names its own population. A churn pass over a million entities
 * measures patience, not the backing. */
const SIZES = {
	"physics-small": 10_000,
	churn: 200_000,
	byid: 200_000,
	spawn: 100_000,
	sparse: 200_000
};

const KEEP = [];

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

function timeIt(fn) {
	let sink = 0;
	for (let i = 0; i < WARMUP; i++) sink += fn();
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		sink += fn();
		ts.push(performance.now() - t0);
	}
	globalThis.__sink = sink;
	return ts;
}

/** Fisher-Yates over xorshift32, as P09 uses. A modulo stride would walk a
 * pattern the prefetcher can learn, and this must not. */
function shuffled(n) {
	const a = new Uint32Array(n);
	for (let i = 0; i < n; i++) a[i] = i;
	let x = 0x9e3779b9;
	for (let i = n - 1; i > 0; i--) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		const j = x % (i + 1);
		const t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return a;
}

async function memoryFor(profile, columnCapacity) {
	if (profile === "heap") return { heap: { maxBytes: CAP }, columnCapacity };
	if (profile === "shared") return { shared: { maxBytes: CAP }, columnCapacity };
	if (profile === "fixedsab") {
		const SHARED = new URL("../../dist/shared.js", import.meta.url);
		const mod = await import(SHARED.href);
		if (typeof mod.fixedSabAllocator !== "function") {
			throw new Error("dist/shared.js exports no fixedSabAllocator, build the candidate first");
		}
		return { allocator: mod.fixedSabAllocator(CAP), capBytesHint: CAP, columnCapacity };
	}
	throw new Error(`unknown profile ${profile}`);
}

async function run(name) {
	const [profile, ...rest] = name.split("+");
	const kernel = rest.join("+");
	const N = SIZES[kernel];
	if (!N) throw new Error(`unknown kernel ${kernel}`);

	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS, SCHEDULE } = await import(DIST.href);
	// Pin the column capacity everywhere. An unpinned world doubles its columns
	// mid-run, and a backing that doubled once more than another would be
	// measured on the doubling and not on the access.
	const ecs = new ECS({ memory: await memoryFor(profile, pow2(N)) });
	KEEP.push(ecs);

	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const Mass = ecs.registerComponent({ m: "f32" });
	const Tag = ecs.registerTag();
	const Cool = ecs.registerSparseComponent({ ready: "u32" });

	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }), Vel({ vx: 1, vy: 0, vz: -1 }), Mass({ m: 1 }));

	let times;
	let checksum = 0;

	if (kernel === "physics-small") {
		const q = ecs.query(Pos, Vel, Mass);
		const step = ecs.registerSystem({
			reads: [Mass],
			writes: [Pos, Vel],
			fn: () => {
				q.eachChunk((cols, count) => {
					const { x, y, z } = cols.mut(Pos);
					const { vx, vy, vz } = cols.mut(Vel);
					const { m } = cols.read(Mass);
					for (let i = 0; i < count; i++) {
						vy[i] -= 9.81 * DT * m[i];
						x[i] += vx[i] * DT;
						y[i] += vy[i] * DT;
						z[i] += vz[i] * DT;
					}
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, step);
		ecs.startup();
		for (let i = 0; i < N; i++) ecs.spawn(T);
		// One tick over 10,000 entities is too short to time. A hundred ticks
		// per sample puts the sample above the clock's own noise, and the ratio
		// between backings is what this reads anyway.
		const TICKS = 100;
		times = timeIt(() => {
			for (let t = 0; t < TICKS; t++) ecs.update(DT);
			return TICKS;
		});
		const readQ = ecs.query(Pos);
		readQ.eachChunk((cols, count) => {
			const { y } = cols.read(Pos);
			for (let i = 0; i < count; i++) checksum += y[i];
		});
	} else if (kernel === "churn") {
		ecs.startup();
		const ids = new Uint32Array(N);
		for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
		// Each pass is one transition per entity, so one run of the column copy
		// loop per entity per direction.
		let on = false;
		times = timeIt(() => {
			on = !on;
			if (on) for (let i = 0; i < N; i++) ecs.addComponent(ids[i], Tag);
			else for (let i = 0; i < N; i++) ecs.removeComponent(ids[i], Tag);
			return N;
		});
		checksum = ecs.entityCount;
	} else if (kernel === "byid") {
		ecs.startup();
		const ids = new Uint32Array(N);
		for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
		const order = shuffled(N);
		const cur = ecs.cursorRead(Pos);
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) s += cur.at(ids[order[i]]).x;
			return s;
		});
		checksum = N;
	} else if (kernel === "spawn") {
		ecs.startup();
		// Build and tear down the same population every sample. The pool is
		// warm after the first pass, so this measures the write path and not the
		// first-touch page faults.
		const ids = new Uint32Array(N);
		times = timeIt(() => {
			for (let i = 0; i < N; i++) ids[i] = ecs.spawn(T);
			for (let i = 0; i < N; i++) ecs.despawn(ids[i]);
			ecs.flush();
			return N;
		});
		checksum = ecs.entityCount;
	} else if (kernel === "sparse") {
		ecs.startup();
		const ids = new Uint32Array(N);
		for (let i = 0; i < N; i++) {
			ids[i] = ecs.spawn(T);
			ecs.addSparse(ids[i], Cool, { ready: i & 0xff });
		}
		times = timeIt(() => {
			let s = 0;
			for (let i = 0; i < N; i++) {
				const v = ecs.getSparseField(ids[i], Cool, "ready");
				ecs.setSparseField(ids[i], Cool, "ready", v + 1);
				s += v;
			}
			return s;
		});
		checksum = ecs.getSparseField(ids[0], Cool, "ready");
	} else {
		throw new Error(`unknown kernel ${kernel}`);
	}

	if (KEEP.length !== 1) throw new Error("sink broken");
	return {
		name,
		median: median(times),
		spread: iqr(times),
		checksum: Math.round(checksum * 1000) / 1000,
		n: N
	};
}

const which = variantArg();
if (which) {
	try {
		emit(await run(which));
	} catch (e) {
		emit({ name: which, blocked: String(e && e.message ? e.message : e) });
	}
} else {
	console.log(`P05-kernels, three backings, five kernels`);
	console.log(`      heap = fixed ArrayBuffer (default), shared = growable SAB (today),`);
	console.log(`      fixedsab = fixed SharedArrayBuffer (the candidate)\n`);
	console.log(
		`  ${"kernel".padEnd(14)} ${"n".padEnd(9)} ${"runtime".padEnd(12)} ${"heap".padEnd(10)} ${"shared".padEnd(16)} ${"fixedsab".padEnd(16)} ${"checksums".padEnd(9)} heap p25-p75`
	);
	console.log(
		`  ${"-".repeat(14)} ${"-".repeat(9)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(16)} ${"-".repeat(16)} ---------`
	);

	// `node p05-kernels.mjs byid churn` runs those kernels only. A cell that
	// looks like a result gets re-run before it becomes one.
	const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const kernels = Object.keys(SIZES).filter((k) => want.length === 0 || want.includes(k));
	for (const kernel of kernels) {
		for (const rt of RUNTIMES) {
			const got = {};
			for (const p of ["heap", "shared", "fixedsab"]) {
				got[p] = runVariantOn(rt, import.meta.url, `${p}+${kernel}`);
			}
			if (!got.heap || got.heap.blocked) {
				console.log(`  ${kernel.padEnd(14)} ${String(SIZES[kernel]).padEnd(9)} ${rt.cmd.padEnd(12)} ! no heap baseline`);
				continue;
			}
			const cell = (p) => {
				const r = got[p];
				if (!r) return "!";
				if (r.blocked) return "blocked";
				return `${r.median.toFixed(3)} (${(r.median / got.heap.median).toFixed(2)}x)`;
			};
			// The heap column carries its own spread, because every ratio in the
			// row divides by it. A ratio inside the spread is not a finding.
			const band = `${got.heap.spread.p25.toFixed(2)}-${got.heap.spread.p75.toFixed(2)}`;
			const sums = new Set(
				["heap", "shared", "fixedsab"].map((p) => got[p]?.checksum).filter((c) => c !== undefined)
			);
			console.log(
				`  ${kernel.padEnd(14)} ${String(got.heap.n).padEnd(9)} ${`${rt.cmd} (${rt.engine})`.padEnd(12)} ` +
					`${got.heap.median.toFixed(3).padEnd(10)} ${cell("shared").padEnd(16)} ${cell("fixedsab").padEnd(16)} ` +
					`${(sums.size === 1 ? "agree" : `DISAGREE ${[...sums].join("/")}`).padEnd(9)} ${band}`
			);
		}
	}
	console.log(`\n  A ratio near 1.00x is the backing costing nothing on that path.`);
	console.log(`  Checksums must agree across the three backings, or the row means nothing.`);
}
