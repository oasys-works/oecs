/**
 * A diagnostic for the `iter2` row of the `oecs-sparse` entry. It splits the cost
 * of `query(Slot).andSparse(Pos, Vel).forEachEntity` into its parts, so the table
 * can give the reason, and not a ratio only.
 *
 * Each variant runs in its own process. All the variants in one process give more
 * than one shape at the call sites they share, and no user's program operates in
 * that condition. Without a variant, this file starts one child for each variant
 * and prints the table.
 *
 *   node probe-sparse-iter.mjs                 # every variant, one process each
 *   node probe-sparse-iter.mjs fe [bundle]     # one variant, in this process
 *
 * The default bundle is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or
 * give the path of a different build.
 *
 * The variants, from the entry to the floor:
 *
 *   packed         dense Pos and Vel through `forEachColumns`. The `oecs` entry.
 *   fe             `forEachEntity` with two sparse cursors. The `oecs-sparse` entry.
 *   fe-shared      `fe` after six other callbacks ran through the driver. An app
 *                  with many queries has this. The callback does not inline.
 *   batch          `forEachIds` with the same cursors. One call for each run.
 *   batch-shared   `batch` after six other callbacks ran through the driver.
 *   fe-empty       the same driver with an empty callback. The driver alone.
 *   tight-full-cb  a loop over the member list of Pos, with the filters the query
 *                  keeps: Vel membership, the dense mask, the enabled row. It
 *                  composes the id and calls the cursor callback of `fe`. The
 *                  driver body is gone, the callback and the id round trip stay.
 *   tight-full     the same loop with direct column writes. The floor of a tight
 *                  API with the same semantics.
 *   tight-2store   the loop with the Vel filter alone. The semantics of a bitECS
 *                  query, computed at each pass.
 *   raw            the loop with no filter. The floor of a gather through the id
 *                  list, which is the loop the id-indexed libraries run.
 *
 * Result: `fe-empty` costs the same as `tight-full`. The filters are the cost,
 * not the driver. `raw` ties the id-indexed libraries. They keep a member list
 * for each query, and a filter for each entity cannot match that. The tight
 * variants read private fields, so a real API costs a little more.
 *
 * The checksum is the sum of `x` after every run. Each variant must give the same
 * sum, except `fe-empty`, which writes nothing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const N = 10_000;
const DT = 0.016;
const REPS = 100;
const UNASSIGNED = -1;
const INDEX_BITS = 20;
const VARIANTS = [
	"packed",
	"fe",
	"fe-shared",
	"batch",
	"batch-shared",
	"fe-empty",
	"tight-full-cb",
	"tight-full",
	"tight-2store",
	"raw"
];

const self = url.fileURLToPath(import.meta.url);
const here = path.dirname(self);
const variant = process.argv[2];
const bundle = path.resolve(process.argv[3] ?? path.join(here, ".out/oecs.prod/index.js"));
if (!fs.existsSync(bundle)) {
	throw new Error(`no bundle at ${bundle}. Run vs.mjs first, or give the path of a build`);
}

if (variant === undefined) {
	console.log(
		`sparse iteration, ns for each entity, best of 7 samples, one process for each variant`
	);
	for (const v of VARIANTS) {
		process.stdout.write(execFileSync(process.execPath, [self, v, bundle], { encoding: "utf8" }));
	}
	process.exit(0);
}
if (!VARIANTS.includes(variant))
	throw new Error(`unknown variant ${variant}: ${VARIANTS.join(", ")}`);

const { ECS } = await import(url.pathToFileURL(bundle).href);
const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
let fn;
let check;

if (variant === "packed") {
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	ecs.spawnMany(ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 1 })), N);
	const q = ecs.query(Pos, Vel);
	fn = () => {
		for (let r = 0; r < REPS; r++) {
			q.forEachColumns((cols, count) => {
				const { x, y } = cols.mut(Pos);
				const { vx, vy } = cols.read(Vel);
				for (let i = 0; i < count; i++) {
					x[i] += vx[i] * DT;
					y[i] += vy[i] * DT;
				}
			});
		}
	};
	check = () => {
		let s = 0;
		q.forEachColumns((cols, count) => {
			const { x } = cols.read(Pos);
			for (let i = 0; i < count; i++) s += x[i];
		});
		return s;
	};
} else {
	const Slot = ecs.registerTag();
	const Pos = ecs.registerSparseComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerSparseComponent({ vx: "f64", vy: "f64" });
	const ids = ecs.spawnMany(ecs.template(Slot), N);
	for (let i = 0; i < N; i++) {
		ecs.addSparse(ids[i], Pos, { x: 0, y: 0 });
		ecs.addSparse(ids[i], Vel, { vx: 1, vy: 1 });
	}
	const q = ecs.query(Slot).andSparse(Pos, Vel);
	const p = ecs.sparseCursor(Pos);
	const v = ecs.sparseCursorRead(Vel);
	const step = (e) => {
		p.at(e);
		v.at(e);
		p.x += v.vx * DT;
		p.y += v.vy * DT;
	};
	check = () => {
		let s = 0;
		q.forEachEntity((e) => {
			p.at(e);
			s += p.x;
		});
		return s;
	};

	// The tight variants read the store through its private fields. The build
	// keeps the names, and this file breaks loudly when a rename removes one.
	const store = ecs._store;
	const posS = store._sparseStores[Pos];
	const velS = store._sparseStores[Vel];
	const entArch = store._entityArchetypes;
	const entRow = store._entityRows;
	const archetypes = store._archGraph.archetypes;
	const gens = store._entityAllocator.generations;
	if (!posS?._dense || !posS._cols || !velS?._pos || !entArch || !entRow || !archetypes || !gens) {
		throw new Error("a private field of the store is not reachable, update this probe");
	}
	// The dense verdict of each archetype, as the driver memoizes it. The query's
	// archetype list is the truth, so the table comes from it at each pass.
	const okArch = () => {
		const ok = new Uint8Array(archetypes.length + 1);
		for (const a of q._archetypes) ok[a.id] = 1;
		return ok;
	};

	// Distinct literals. Closures of one literal share call feedback, and V8 can
	// still inline them.
	const k = new Float64Array(1);
	const others = [
		(e) => (k[0] += e),
		(e) => (k[0] -= e),
		(e) => (k[0] += e * 2),
		(e) => (k[0] += e * 3),
		(e) => (k[0] += e * 4),
		(e) => (k[0] += e * 5)
	];
	const batchStep = (ids, count) => {
		for (let i = 0; i < count; i++) {
			const e = ids[i];
			p.at(e);
			v.at(e);
			p.x += v.vx * DT;
			p.y += v.vy * DT;
		}
	};

	if (variant === "fe" || variant === "fe-shared") {
		if (variant === "fe-shared")
			for (let r = 0; r < 20; r++) for (const o of others) q.forEachEntity(o);
		fn = () => {
			for (let r = 0; r < REPS; r++) q.forEachEntity(step);
		};
	} else if (variant === "batch" || variant === "batch-shared") {
		if (variant === "batch-shared") {
			const wrap = [
				(ids, n) => {
					for (let i = 0; i < n; i++) others[0](ids[i]);
				},
				(ids, n) => {
					for (let i = 0; i < n; i++) others[1](ids[i]);
				},
				(ids, n) => {
					for (let i = 0; i < n; i++) others[2](ids[i]);
				},
				(ids, n) => {
					for (let i = 0; i < n; i++) others[3](ids[i]);
				},
				(ids, n) => {
					for (let i = 0; i < n; i++) others[4](ids[i]);
				},
				(ids, n) => {
					for (let i = 0; i < n; i++) others[5](ids[i]);
				}
			];
			for (let r = 0; r < 20; r++) for (const w of wrap) q.forEachIds(w);
		}
		fn = () => {
			for (let r = 0; r < REPS; r++) q.forEachIds(batchStep);
		};
	} else if (variant === "fe-empty") {
		// Sum into a typed array. A captured `let` leaves the small-integer range
		// and boxes on each store, which costs more than the driver.
		const nop = (e) => {
			k[0] += e;
		};
		fn = () => {
			for (let r = 0; r < REPS; r++) q.forEachEntity(nop);
		};
	} else if (variant === "tight-full-cb") {
		fn = () => {
			const ok = okArch();
			for (let r = 0; r < REPS; r++) {
				const dense = posS._dense;
				const n = posS._size;
				const vpos = velS._pos;
				let memoArch = -2;
				let memoOk = false;
				let memoEnabled = 0;
				for (let i = 0; i < n; i++) {
					const idx = dense[i];
					if (vpos[idx] < 0) continue;
					const archId = entArch[idx];
					if (archId === UNASSIGNED) continue;
					if (archId !== memoArch) {
						memoArch = archId;
						memoOk = ok[archId] === 1;
						memoEnabled = archetypes[archId].enabledCount;
					}
					if (!memoOk) continue;
					const row = entRow[idx];
					if (row !== UNASSIGNED && row >= memoEnabled) continue;
					step((gens[idx] << INDEX_BITS) | idx);
				}
			}
		};
	} else if (variant === "tight-full") {
		fn = () => {
			const ok = okArch();
			for (let r = 0; r < REPS; r++) {
				const dense = posS._dense;
				const n = posS._size;
				const vpos = velS._pos;
				const x = posS._cols[0];
				const y = posS._cols[1];
				const vx = velS._cols[0];
				const vy = velS._cols[1];
				let memoArch = -2;
				let memoOk = false;
				let memoEnabled = 0;
				for (let i = 0; i < n; i++) {
					const idx = dense[i];
					if (vpos[idx] < 0) continue;
					const archId = entArch[idx];
					if (archId === UNASSIGNED) continue;
					if (archId !== memoArch) {
						memoArch = archId;
						memoOk = ok[archId] === 1;
						memoEnabled = archetypes[archId].enabledCount;
					}
					if (!memoOk) continue;
					const row = entRow[idx];
					if (row !== UNASSIGNED && row >= memoEnabled) continue;
					x[idx] += vx[idx] * DT;
					y[idx] += vy[idx] * DT;
				}
			}
		};
	} else if (variant === "tight-2store") {
		fn = () => {
			for (let r = 0; r < REPS; r++) {
				const dense = posS._dense;
				const n = posS._size;
				const vpos = velS._pos;
				const x = posS._cols[0];
				const y = posS._cols[1];
				const vx = velS._cols[0];
				const vy = velS._cols[1];
				for (let i = 0; i < n; i++) {
					const idx = dense[i];
					if (vpos[idx] < 0) continue;
					x[idx] += vx[idx] * DT;
					y[idx] += vy[idx] * DT;
				}
			}
		};
	} else {
		fn = () => {
			for (let r = 0; r < REPS; r++) {
				const dense = posS._dense;
				const n = posS._size;
				const x = posS._cols[0];
				const y = posS._cols[1];
				const vx = velS._cols[0];
				const vy = velS._cols[1];
				for (let i = 0; i < n; i++) {
					const idx = dense[i];
					x[idx] += vx[idx] * DT;
					y[idx] += vy[idx] * DT;
				}
			}
		};
	}
}

for (let i = 0; i < 3; i++) fn();
let best = Infinity;
for (let s = 0; s < 7; s++) {
	const t0 = process.hrtime.bigint();
	fn();
	const dt = Number(process.hrtime.bigint() - t0) / 1e6;
	if (dt < best) best = dt;
}
const ns = ((best * 1e6) / (REPS * N)).toFixed(2).padStart(7);
console.log(`  ${variant.padEnd(14)} ${ns} ns   checksum ${check()}`);
