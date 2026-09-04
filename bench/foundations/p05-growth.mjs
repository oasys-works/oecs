/**
 * P05, does a buffer that can grow in place cost the reader, in the library?
 *
 * The substrate study measured element access over five backings and found that
 * every buffer which can grow in place charges the reader on every access. It
 * charges twice: once because the buffer is growable, and again when the view
 * tracks the buffer length. The worst case measured was a length-tracking view
 * over a growable `SharedArrayBuffer` on V8, and no combination was free on any
 * engine.
 *
 * The library applied half of that finding. `heapArraybufferAllocator` reserves
 * a fixed `ArrayBuffer` at the cap and relocates columns inside it, the 0.5.3
 * iteration fix, and the backing under every sizing arm except two. The two are
 * `memory: { shared: {} }`, which calls `growableSabAllocator` and grows a
 * growable `SharedArrayBuffer`, and `memory: { wasm: ... }`, whose buffer is
 * growable by nature.
 *
 * So the question this probe asks: does the shared profile pay the tax that the
 * heap profile stopped paying? And if it does, does a fixed `SharedArrayBuffer`
 * reserved at the cap remove it, as the fixed `ArrayBuffer` did?
 *
 * ## The three parts
 *
 * **A. The substrate control.** Raw typed-array reads over seven backings, no
 * library. It re-measures the study's finding on this machine and these engine
 * versions. Without it, part B has no baseline: a null result in the library
 * could mean the library hides the cost, or it could mean the engine fixed it.
 *
 * **B. The library A/B.** One workload, one kernel, three backings:
 * heap (fixed `ArrayBuffer`, today's default), shared (growable
 * `SharedArrayBuffer`, today's shared profile), and a fixed
 * `SharedArrayBuffer` through the `memory.allocator` escape hatch. The three
 * worlds are identical in every other respect, and the probe prints each one's
 * resolved plan so the reader can check that.
 *
 * **C. What the reservation costs.** A fixed backing must be born at the cap. A
 * growable one starts small. The heap profile shows that a reserved fixed
 * `ArrayBuffer` faults its pages lazily, so RSS follows real use. A
 * `SharedArrayBuffer` is a different allocation, and nothing here has measured
 * whether it does the same. If a fixed SAB commits eagerly, a read speedup is
 * paid for in resident memory, and that is a trade and not a fix.
 *
 * Part C runs on node alone, because it needs `--expose-gc` for a stable RSS.
 */
import { emit, iqr, median, mib, RUNTIMES, runVariant, runVariantOn, variantArg } from "./harness.mjs";

/** The library's own default ceiling. The reservation question is about this
 * number, so the probe uses it and does not pick a smaller one. */
const CAP = 256 * 1024 * 1024;

// Part A: one f64 column, big enough to leave cache and small enough that a
// growable buffer still has room to grow under the same cap.
const RAW_N = 2_000_000;
const RAW_BYTES = RAW_N * 8;

// Part B: experiment 01's workload, so the kernel is one the library is already
// measured on.
const LIB_N = 1_000_000;
const DT = 1 / 60;

const SAMPLES = 15;
const WARMUP = 5;

/** Nothing here may be collected before the last snapshot. */
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

// ---------------------------------------------------------------------------
// A. The substrate control
// ---------------------------------------------------------------------------

/**
 * The eight backings, all carrying the same bytes and read through the same
 * loop. Only the buffer and the view construction differ.
 *
 * `atCap` reserves the full cap and reads the first part of it. That is what
 * `heapArraybufferAllocator` does, and it is here to show that the reservation
 * itself is not what costs.
 *
 * `track` builds a length-tracking view, which omits the length and re-reads
 * the buffer length on every access. The library never builds one on a column,
 * so it is here as the far end of the scale.
 */
const BACKINGS = {
	fixedAB: { make: (bytes) => new ArrayBuffer(bytes), track: false },
	fixedABatCap: { make: () => new ArrayBuffer(CAP), track: false },
	fixedSAB: { make: (bytes) => new SharedArrayBuffer(bytes), track: false },
	fixedSABatCap: { make: () => new SharedArrayBuffer(CAP), track: false },
	growSAB: { make: (bytes) => new SharedArrayBuffer(bytes, { maxByteLength: CAP }), track: false },
	growSABtrack: { make: (bytes) => new SharedArrayBuffer(bytes, { maxByteLength: CAP }), track: true },
	resizeAB: { make: (bytes) => new ArrayBuffer(bytes, { maxByteLength: CAP }), track: false },
	resizeABtrack: { make: (bytes) => new ArrayBuffer(bytes, { maxByteLength: CAP }), track: true }
};

/**
 * Two kernels, because a read and a write can take different paths.
 *
 * `sum` is f64 and reads only, which is the shape the study measured. `rmw` is
 * f32 and reads then writes each element, which is the shape of the library's
 * own column loop. A backing that is free to read is not thereby free to write.
 */
const KERNELS = {
	sum: { ctor: Float64Array, bytes: 8 },
	rmw: { ctor: Float32Array, bytes: 4 }
};

function rawVariant(name) {
	const [kind, kernel] = name.split("-");
	const backing = BACKINGS[kind];
	const k = KERNELS[kernel];
	if (!backing || !k) throw new Error(`unknown raw variant ${name}`);

	const bytes = RAW_N * k.bytes;
	const buffer = backing.make(bytes);
	// A fixed-length view names its length. A length-tracking view omits it.
	// `atCap` buffers are longer than the data, so a tracking view over one
	// would walk a different element count and measure a different loop.
	const a = backing.track ? new k.ctor(buffer) : new k.ctor(buffer, 0, RAW_N);
	KEEP.push(a);
	for (let i = 0; i < RAW_N; i++) a[i] = i * 0.5;

	const ts =
		kernel === "sum"
			? timeIt(() => {
					let s = 0;
					for (let i = 0; i < RAW_N; i++) s += a[i];
					return s;
				})
			: timeIt(() => {
					for (let i = 0; i < RAW_N; i++) a[i] = a[i] * 0.999 + 1;
					return a[0];
				});
	if (KEEP.length !== 1) throw new Error("sink broken");
	return { name, median: median(ts), spread: iqr(ts) };
}

/**
 * Reserve a buffer at the cap, touch a small part of it, and report what the
 * process grew by. `growSAB` is the control: it is born small, so its delta is
 * what a page-lazy reservation should look like.
 */
function rssVariant(kind) {
	const backing = BACKINGS[kind];
	if (!backing) throw new Error(`unknown backing ${kind}`);
	const TOUCH = 1 << 20;
	const before = process.memoryUsage().rss;
	const buffer = backing.make(TOUCH);
	const a = new Uint8Array(buffer, 0, TOUCH);
	for (let i = 0; i < TOUCH; i += 4096) a[i] = 1;
	KEEP.push(a);
	const after = process.memoryUsage().rss;
	if (KEEP.length !== 1) throw new Error("sink broken");
	return { name: kind, rss: after - before, touched: TOUCH, reserved: buffer.byteLength };
}

// ---------------------------------------------------------------------------
// B and C. The library
// ---------------------------------------------------------------------------

/**
 * How long a world takes to exist, for each backing.
 *
 * `growableSabAllocator`'s own documentation warns that a larger cap costs more
 * time per allocation, because the engine does per-byte bookkeeping when it
 * constructs the buffer. A backing born at the cap pays whatever that is on
 * every world, and a reader who never spawns a million entities would feel it
 * as startup time. So it is measured and not assumed.
 */
async function startVariant(profile) {
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS } = await import(DIST.href);

	// One allocator instance owns one buffer, so a timed loop needs a fresh one
	// for each world. A shared instance would hand the second world the first
	// world's bytes and measure nothing.
	let makeMemory;
	if (profile === "heap") makeMemory = () => ({ heap: { maxBytes: CAP } });
	else if (profile === "shared") makeMemory = () => ({ shared: { maxBytes: CAP } });
	else {
		const SHARED = new URL("../../dist/shared.js", import.meta.url);
		const mod = await import(SHARED.href);
		if (typeof mod.fixedSabAllocator !== "function") {
			throw new Error("dist/shared.js exports no fixedSabAllocator, build the candidate first");
		}
		makeMemory = () => ({ allocator: mod.fixedSabAllocator(CAP), capBytesHint: CAP });
	}

	// No pinned column capacity here. This is the small world a reader would
	// feel a reservation in, not the million-entity one.
	const ts = timeIt(() => {
		const ecs = new ECS({ memory: makeMemory() });
		const P = ecs.registerComponent({ x: "f32", y: "f32" });
		ecs.startup();
		const e = ecs.spawn(ecs.template(P({ x: 1, y: 2 })));
		return ecs.isAlive(e) ? 1 : 0;
	});
	return { name: profile, median: median(ts), spread: iqr(ts) };
}

/**
 * The fixed `SharedArrayBuffer` backing, from the shipped artifact.
 *
 * The probe measures what the library ships and never its own copy of it. An
 * artifact without the export is a result: it says this backing does not exist
 * yet, and the row is reported blocked rather than silently skipped.
 */
async function fixedSab(maxBytes) {
	const SHARED = new URL("../../dist/shared.js", import.meta.url);
	const mod = await import(SHARED.href);
	if (typeof mod.fixedSabAllocator !== "function") {
		throw new Error("dist/shared.js exports no fixedSabAllocator, build the candidate first");
	}
	return mod.fixedSabAllocator(maxBytes);
}

async function memoryFor(profile) {
	const columnCapacity = pow2(LIB_N);
	if (profile === "heap") return { heap: { maxBytes: CAP }, columnCapacity };
	if (profile === "shared") return { shared: { maxBytes: CAP }, columnCapacity };
	if (profile === "fixedsab") {
		return { allocator: await fixedSab(CAP), capBytesHint: CAP, columnCapacity };
	}
	throw new Error(`unknown profile ${profile}`);
}

function snap() {
	if (globalThis.gc) {
		globalThis.gc();
		globalThis.gc();
	}
	return process.memoryUsage();
}

/**
 * One world, one kernel, one backing. `wantMemory` adds the RSS snapshots,
 * which need `--expose-gc` to be worth reading.
 */
async function libVariant(profile, wantMemory) {
	const DIST = new URL("../../dist/index.js", import.meta.url);
	const { ECS, SCHEDULE } = await import(DIST.href);

	const s0 = snap();
	const ecs = new ECS({ memory: await memoryFor(profile) });
	KEEP.push(ecs);

	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const Mass = ecs.registerComponent({ m: "f32" });

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
	const s1 = snap();

	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }), Vel({ vx: 1, vy: 0, vz: -1 }), Mass({ m: 1 }));
	for (let i = 0; i < LIB_N; i++) ecs.spawn(T);
	const s2 = snap();
	if (ecs.entityCount !== LIB_N) throw new Error("world was collected or spawn failed");

	const ts = timeIt(() => {
		ecs.update(DT);
		return 1;
	});

	// Every variant must compute the same answer. A backing that reads faster
	// because it moved fewer bytes is not a result.
	let checksum = 0;
	const readQ = ecs.query(Pos);
	readQ.eachChunk((cols, count) => {
		const { y } = cols.read(Pos);
		for (let i = 0; i < count; i++) checksum += y[i];
	});

	const plan = ecs.memoryPlan;
	if (KEEP.length !== 1) throw new Error("sink broken");

	return {
		name: profile,
		median: median(ts),
		spread: iqr(ts),
		checksum: Math.round(checksum * 1000) / 1000,
		columnCapacity: plan.columnCapacity,
		entityIndex: plan.entityIndexCapacity,
		source: plan.source,
		intent: plan.intentLabel,
		...(wantMemory
			? {
					reserved: s1.external - s0.external,
					resident: s2.rss - s0.rss,
					bytesPerItem: (s2.rss - s0.rss) / LIB_N,
					gc: Boolean(globalThis.gc)
				}
			: {})
	};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const which = variantArg();
if (which) {
	const [part, name] = [which.slice(0, which.indexOf("-")), which.slice(which.indexOf("-") + 1)];
	if (part === "raw") emit(rawVariant(name));
	else if (part === "rss") emit(rssVariant(name));
	else if (part === "start") emit(await startVariant(name));
	else if (part === "lib" || part === "mem") {
		// A backing the library cannot carry is a result, and the probe must
		// report it as one. A crash here would read as a broken probe.
		try {
			emit(await libVariant(name, part === "mem"));
		} catch (e) {
			emit({ name, blocked: String(e && e.message ? e.message : e) });
		}
	} else throw new Error(`unknown variant ${which}`);
} else {
	console.log(`P05, a buffer that can grow in place costs its reader (exp 05 / S3)`);
	console.log(`      A: ${RAW_N.toLocaleString()} elements, eight backings, two kernels, no library`);
	console.log(`      B: ${LIB_N.toLocaleString()} entities, one physics step, three backings`);
	console.log(`      C: what the reservation costs in resident memory (node only)\n`);

	// `--only=a` / `--only=b` keeps one part while the probe is being written.
	const only = (process.argv.find((x) => x.startsWith("--only=")) ?? "--only=abcde").slice("--only=".length);

	// --- A -----------------------------------------------------------------
	const rawNames = Object.keys(BACKINGS);
	for (const kernel of only.includes("a") ? Object.keys(KERNELS) : []) {
		console.log(
			kernel === "sum"
				? `A1. the substrate, f64, read only`
				: `\nA2. the substrate, f32, read then write, the library's own column loop`
		);
		const rawRows = [];
		for (const rt of RUNTIMES) {
			const got = {};
			for (const k of rawNames) got[k] = runVariantOn(rt, import.meta.url, `raw-${k}-${kernel}`);
			if (!got.fixedAB) {
				console.log(`  ! ${rt.cmd} produced no baseline, skipped`);
				continue;
			}
			for (const k of rawNames) {
				if (!got[k]) continue;
				rawRows.push({
					runtime: `${rt.cmd} (${rt.engine})`,
					backing: k,
					ms: got[k].median.toFixed(3),
					vsFixed: (got[k].median / got.fixedAB.median).toFixed(2) + "x",
					spread: `${got[k].spread.p25.toFixed(2)} to ${got[k].spread.p75.toFixed(2)}`
				});
			}
		}
		if (rawRows.length === 0) console.log(`  ! no runtime produced a result`);
		else {
			console.log(
				`  ${"runtime".padEnd(12)} ${"backing".padEnd(15)} ${"median".padEnd(9)} ${"vs fixedAB".padEnd(11)} p25 to p75`
			);
			console.log(`  ${"-".repeat(12)} ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(14)}`);
			for (const r of rawRows) {
				console.log(
					`  ${r.runtime.padEnd(12)} ${r.backing.padEnd(15)} ${r.ms.padEnd(9)} ${r.vsFixed.padEnd(11)} ${r.spread}`
				);
			}
		}
	}

	// --- D -----------------------------------------------------------------
	// Part C reads RSS on node alone. A reservation is an allocation, and each
	// engine makes it its own way, so the engine that would pay for it is the
	// one this must ask. No library, no gc, and a delta large enough to read
	// without one.
	if (only.includes("d")) {
		console.log(`\nD. what a reserved buffer costs in resident memory, every runtime`);
		console.log(
			`  ${"runtime".padEnd(12)} ${"backing".padEnd(15)} ${"rss delta".padEnd(12)} touched`
		);
		console.log(`  ${"-".repeat(12)} ${"-".repeat(15)} ${"-".repeat(12)} ${"-".repeat(10)}`);
		for (const rt of RUNTIMES) {
			for (const k of ["fixedABatCap", "fixedSABatCap", "growSAB"]) {
				const r = runVariantOn(rt, import.meta.url, `rss-${k}`);
				if (!r) continue;
				console.log(
					`  ${`${rt.cmd} (${rt.engine})`.padEnd(12)} ${k.padEnd(15)} ${mib(r.rss).padEnd(12)} ${mib(r.touched)}`
				);
			}
		}
		console.log(`\n  A lazily faulted reservation shows an rss delta near the touched bytes.`);
		console.log(`  An eagerly committed one shows the whole cap.`);
	}

	// --- E -----------------------------------------------------------------
	if (only.includes("e")) {
		console.log(`\nE. what a world costs to construct, each backing`);
		console.log(`  ${"runtime".padEnd(12)} ${"backing".padEnd(15)} ${"median".padEnd(9)} vs heap`);
		console.log(`  ${"-".repeat(12)} ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(8)}`);
		for (const rt of RUNTIMES) {
			const got = {};
			for (const p of ["heap", "shared", "fixedsab"]) got[p] = runVariantOn(rt, import.meta.url, `start-${p}`);
			if (!got.heap) continue;
			for (const p of ["heap", "shared", "fixedsab"]) {
				const r = got[p];
				if (!r || r.blocked) continue;
				console.log(
					`  ${`${rt.cmd} (${rt.engine})`.padEnd(12)} ${p.padEnd(15)} ${r.median.toFixed(3).padEnd(9)} ${(r.median / got.heap.median).toFixed(2)}x`
				);
			}
		}
	}

	// --- B -----------------------------------------------------------------
	if (!only.includes("b")) process.exit(0);
	console.log(`\nB. the library, one kernel, three backings`);
	const libRows = [];
	const checksums = new Set();
	const plans = [];
	for (const rt of RUNTIMES) {
		const got = {};
		for (const p of ["heap", "shared", "fixedsab"]) got[p] = runVariantOn(rt, import.meta.url, `lib-${p}`);
		if (!got.heap) {
			console.log(`  ! ${rt.cmd} produced no heap baseline, skipped`);
			continue;
		}
		for (const p of ["heap", "shared", "fixedsab"]) {
			const r = got[p];
			if (!r) continue;
			if (r.blocked) {
				console.log(`  ! ${rt.cmd} ${p}: the library refused this backing, ${r.blocked}`);
				continue;
			}
			checksums.add(r.checksum);
			plans.push(`${rt.cmd}/${p}: ${r.source}, columns ${r.columnCapacity}, index ${r.entityIndex}`);
			libRows.push({
				runtime: `${rt.cmd} (${rt.engine})`,
				backing: p,
				ms: r.median.toFixed(3),
				vsHeap: (r.median / got.heap.median).toFixed(2) + "x",
				spread: `${r.spread.p25.toFixed(2)} to ${r.spread.p75.toFixed(2)}`
			});
		}
	}
	if (libRows.length === 0) console.log(`  ! no runtime produced a result`);
	else {
		console.log(
			`  ${"runtime".padEnd(12)} ${"backing".padEnd(15)} ${"median".padEnd(9)} ${"vs heap".padEnd(11)} p25 to p75`
		);
		console.log(`  ${"-".repeat(12)} ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(14)}`);
		for (const r of libRows) {
			console.log(
				`  ${r.runtime.padEnd(12)} ${r.backing.padEnd(15)} ${r.ms.padEnd(9)} ${r.vsHeap.padEnd(11)} ${r.spread}`
			);
		}
		console.log(
			`\n  checksum: ${checksums.size === 1 ? "all variants agree" : `DISAGREE (${[...checksums].join(", ")}). The comparison is void`}`
		);
		for (const p of plans) console.log(`  plan  ${p}`);
	}

	// --- C -----------------------------------------------------------------
	if (!only.includes("c")) process.exit(0);
	console.log(`\nC. what the reservation costs, node with --expose-gc`);
	const memRows = [];
	for (const p of ["heap", "shared", "fixedsab"]) {
		const r = runVariant(import.meta.url, `mem-${p}`, ["--expose-gc"]);
		if (r.blocked) {
			console.log(`  ! ${p}: the library refused this backing, ${r.blocked}`);
			continue;
		}
		if (!r.gc) console.log(`  ! --expose-gc did not reach the child, RSS is noisy`);
		memRows.push({
			backing: p,
			reserved: mib(r.reserved),
			resident: mib(r.resident),
			perItem: `${r.bytesPerItem.toFixed(1)} B`
		});
	}
	console.log(`  ${"backing".padEnd(15)} ${"reserved".padEnd(12)} ${"resident".padEnd(12)} B/item`);
	console.log(`  ${"-".repeat(15)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(8)}`);
	for (const r of memRows) {
		console.log(`  ${r.backing.padEnd(15)} ${r.reserved.padEnd(12)} ${r.resident.padEnd(12)} ${r.perItem}`);
	}
	console.log(`\n  reserved is address space and not memory in use. resident is RSS.`);
	console.log(`  A fixed backing is born at the cap, so its reserved number says nothing`);
	console.log(`  about what it costs. Read the resident column.`);
}
