/**
 * P01, the premise and the layout, measured against the library.
 *
 * Substrate experiment 01 measured a hand-written interleaved buffer struct
 * against the best plain-object shape: 1.77x faster, 4x less memory, and
 * 32.01 B/item against a computed layout of exactly 32 B (H1 to H3), with the bytes
 * allocated off the V8 heap (H4). That was a hand-written buffer. A library
 * carries an entity index, an archetype table, a row plane and a query cache
 * that a hand-written loop does not, so the question has to be re-asked.
 *
 * Workload is experiment 01's, unchanged: 1,000,000 particles, one physics step
 * (gravity + integrate) over `{ pos: Vec3<f32>, vel: Vec3<f32>, mass: f32 }`.
 * Computed layout: 7 x f32 = 28 B of component data + 4 B entity id = 32 B/item.
 *
 * ## Two methodology notes, both paid for during this probe
 *
 * **1. `external` is reserved address space, not memory you are using.** The
 * arena is one large `ArrayBuffer`. `process.memoryUsage().external` reports its
 * full byte length the moment it is constructed, but the pages are faulted in
 * lazily. Reading `external` says a default world costs 256 MiB before a single
 * entity exists. RSS says it costs 0.4 MiB. **RSS is the honest number** and is
 * what this probe reports. `external` is shown beside it, labelled as reserved,
 * because the distinction is the whole point.
 *
 * **2. The world must be pinned live across the final measurement.** The first
 * version of this probe reported that spawning 1,000,000 entities *released*
 * 256 MiB, structurally impossible while the world is alive. V8 had collected
 * the world: nothing referenced `ecs` after the spawn loop, so the module-level
 * binding was dead by the time `memoryUsage()` ran. The `KEEP` sink and the
 * liveness assertion below exist for that. This is the study's own lesson,
 * a result that violates a structural expectation is a bug in the measurement
 * until proven otherwise, reproduced here at first-hand cost.
 */
import { emit, iqr, loadOecs, median, runVariant, table, variantArg } from "./harness.mjs";

const N = 1_000_000;
const DT = 1 / 60;
const SAMPLES = 15;
const WARMUP = 3;

/** Nothing pushed here may be collected before the final snapshot. */
const KEEP = [];

function snap() {
	global.gc();
	global.gc();
	return process.memoryUsage();
}

// --- variants ---------------------------------------------------------------

/** `sizing` selects how the arena is sized:
 *   default, `new ECS()`, 256 MiB growable cap, 1024-row columns
 *   budget , `{ entities: N }`, the documented intent arm
 *   pinned , budget + `columnCapacity: N`, so no column ever doubles
 * The third exists because doubling abandons the previous column block inside
 * the arena, and those pages have been touched, so they stay resident. The
 * library's own `memoryPlan.derivation` calls this "double+holes headroom". */
async function oecsVariant(sizing) {
	const { ECS, SCHEDULE } = await loadOecs();
	const s0 = snap();

	const memory =
		sizing === "default"
			? undefined
			: sizing === "budget"
				? { entities: N }
				: { entities: N, columnCapacity: pow2(N) };

	const ecs = new ECS(memory ? { memory } : {});
	KEEP.push(ecs);
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const Mass = ecs.registerComponent({ m: "f32" });

	const q = ecs.query(Pos, Vel, Mass);
	const step = ecs.registerSystem({
		reads: [Mass],
		writes: [Pos, Vel],
		fn: () => {
			q.forEachColumns((cols, count) => {
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

	// One archetype, zero transitions, the template path. `spawnBundle` would
	// walk {} -> {Pos} -> {Pos,Vel} -> {Pos,Vel,Mass}, leaving capacity behind in
	// every intermediate archetype.
	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }), Vel({ vx: 1, vy: 0, vz: -1 }), Mass({ m: 1 }));
	for (let i = 0; i < N; i++) ecs.spawn(T);
	const s2 = snap();

	if (ecs.entityCount !== N) throw new Error("world was collected or spawn failed");
	const times = timeIt(() => ecs.update(DT));
	if (KEEP.length !== 1) throw new Error("sink broken");

	return {
		name: `oecs (${sizing})`,
		median: median(times),
		spread: iqr(times),
		reserved: s1.external - s0.external,
		resident: s2.rss - s0.rss,
		bytesPerItem: (s2.rss - s0.rss) / N
	};
}

function pow2(n) {
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}

function plainVariant(name, build, stepFn) {
	const s0 = snap();
	const items = build();
	KEEP.push(items);
	const s1 = snap();
	const times = timeIt(() => stepFn(items));
	if (KEEP.length !== 1) throw new Error("sink broken");
	return {
		name,
		median: median(times),
		spread: iqr(times),
		reserved: s1.external - s0.external,
		resident: s1.rss - s0.rss,
		bytesPerItem: (s1.rss - s0.rss) / N
	};
}

const VARIANTS = {
	"oecs-default": () => oecsVariant("default"),
	"oecs-budget": () => oecsVariant("budget"),
	"oecs-pinned": () => oecsVariant("pinned"),

	flatObj: () =>
		plainVariant(
			"flatObj",
			() => {
				const a = new Array(N);
				for (let i = 0; i < N; i++)
					a[i] = { x: i * 0.001, y: i * 0.002, z: i * 0.003, vx: 1, vy: 0, vz: -1, m: 1 };
				return a;
			},
			(items) => {
				for (let i = 0; i < N; i++) {
					const o = items[i];
					o.vy -= 9.81 * DT * o.m;
					o.x += o.vx * DT;
					o.y += o.vy * DT;
					o.z += o.vz * DT;
				}
				return items.length;
			}
		),

	nestedObj: () =>
		plainVariant(
			"nestedObj",
			() => {
				const a = new Array(N);
				for (let i = 0; i < N; i++)
					a[i] = {
						pos: { x: i * 0.001, y: i * 0.002, z: i * 0.003 },
						vel: { x: 1, y: 0, z: -1 },
						m: 1
					};
				return a;
			},
			(items) => {
				for (let i = 0; i < N; i++) {
					const o = items[i];
					o.vel.y -= 9.81 * DT * o.m;
					o.pos.x += o.vel.x * DT;
					o.pos.y += o.vel.y * DT;
					o.pos.z += o.vel.z * DT;
				}
				return items.length;
			}
		),

	/** The floor: raw typed arrays, no library. Not an entry in the comparison,
	 * the limit the library spends its features against. */
	rawSoA: () =>
		plainVariant(
			"rawSoA",
			() => {
				const c = {
					x: new Float32Array(N),
					y: new Float32Array(N),
					z: new Float32Array(N),
					vx: new Float32Array(N),
					vy: new Float32Array(N),
					vz: new Float32Array(N),
					m: new Float32Array(N)
				};
				for (let i = 0; i < N; i++) {
					c.x[i] = i * 0.001;
					c.y[i] = i * 0.002;
					c.z[i] = i * 0.003;
					c.vx[i] = 1;
					c.vy[i] = 0;
					c.vz[i] = -1;
					c.m[i] = 1;
				}
				return c;
			},
			(c) => {
				const { x, y, z, vx, vy, vz, m } = c;
				for (let i = 0; i < N; i++) {
					vy[i] -= 9.81 * DT * m[i];
					x[i] += vx[i] * DT;
					y[i] += vy[i] * DT;
					z[i] += vz[i] * DT;
				}
				return N;
			}
		)
};

function timeIt(fn) {
	for (let i = 0; i < WARMUP; i++) fn();
	const ts = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = performance.now();
		fn();
		ts.push(performance.now() - t0);
	}
	return ts;
}

// --- driver -----------------------------------------------------------------

const which = variantArg();
if (which) {
	emit(await VARIANTS[which]());
} else {
	console.log(`P01, the premise (exp 01 H1 to H4)`);
	console.log(`      ${N.toLocaleString()} particles, one physics step, one process per variant`);
	console.log(`      computed layout: 7 x f32 = 28 B + 4 B entity id = 32 B/item\n`);
	const rows = Object.keys(VARIANTS).map((v) => runVariant(import.meta.url, v, ["--expose-gc"]));
	const base = rows.find((r) => r.name === "flatObj");
	table(rows, [
		{ label: "variant", get: (r) => r.name },
		{ label: "step", get: (r) => `${r.median.toFixed(2)} ms` },
		{ label: "p25..p75", get: (r) => `${r.spread.p25.toFixed(2)}..${r.spread.p75.toFixed(2)}` },
		{ label: "vs flatObj", get: (r) => `${(base.median / r.median).toFixed(2)}x` },
		{ label: "reserved", get: (r) => `${(r.reserved / 1048576).toFixed(0)} MiB` },
		{ label: "resident", get: (r) => `${(r.resident / 1048576).toFixed(1)} MiB` },
		{ label: "B/item", get: (r) => r.bytesPerItem.toFixed(1) }
	]);
	const pinned = rows.find((r) => r.name.includes("pinned"));
	const dflt = rows.find((r) => r.name.includes("default"));
	const raw = rows.find((r) => r.name === "rawSoA");
	console.log("");
	console.log(
		`  H1 premise   : oecs is ${(base.median / dflt.median).toFixed(2)}x flatObj (exp 01 measured 1.77x)`
	);
	console.log(`  library cost : ${(dflt.median / raw.median).toFixed(2)}x raw typed arrays`);
	console.log(
		`  H2 memory    : ${(base.bytesPerItem / pinned.bytesPerItem).toFixed(2)}x less resident than flatObj (exp 01 measured 4x)`
	);
	console.log(
		`  H3 layout    : ${pinned.bytesPerItem.toFixed(1)} B/item resident vs 32 B computed = ${(pinned.bytesPerItem / 32).toFixed(2)}x`
	);
	console.log(
		`  H4 off-heap  : reserved is an ArrayBuffer (external), faulted lazily; heapUsed stays flat`
	);
}
