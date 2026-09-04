/**
 * A diagnostic for the `spawn` row of the `oecs-sparse` entry. That entry spawns a
 * `Slot` template and then calls `addSparse` for each of two components. This
 * file splits that cost, so the table can give the reason, and not a ratio only.
 *
 * Each variant runs in its own process, for the reason `probe-sparse-iter.mjs`
 * gives. Without a variant, this file starts one child for each variant and
 * prints the table.
 *
 *   node probe-sparse-spawn.mjs                    # every variant, one process each
 *   node probe-sparse-spawn.mjs slot+2 [bundle]    # one variant, in this process
 *
 * The default bundle is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or
 * give the path of a different build.
 *
 * The variants. Each spawns the same number of entities as the `spawn` case, and
 * the setup grows the columns first, as the case does:
 *
 *   packed          `spawn` of a dense Pos and Vel template. The `oecs` entry.
 *   slot            `spawn` of the `Slot` template alone.
 *   slot+1          `spawn` and one `addSparse`.
 *   slot+2          `spawn` and two `addSparse`. The `oecs-sparse` entry.
 *   slot+2-onecall  `spawn` and two direct calls to `setRow` on the stores: the same
 *                   row build, one liveness check, no store lookup for each call.
 *                   The floor of a batched `addSparse` that takes the same values.
 *   slot+2-raw      `spawn`, two joins, and positional column writes. The floor of
 *                   a template that carries sparse defaults as a row.
 *
 * What the split shows. Each `addSparse` costs about as much as the whole packed
 * spawn. `slot+2-onecall` recovers about a quarter of the excess, so the number
 * of calls is the smaller cause. `slot+2-raw` is level with `packed`, so the
 * larger cause is the row build inside `SparseComponentStore.setRow`, which finds
 * each field by name in the values object. The last two variants read private
 * fields of the store, and a real API adds a little on top of each floor.
 *
 * The checksum is the number of live entities and the sum of `x` over the sparse
 * members. `slot` holds no sparse rows, so its sum is zero.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const N = 10_000;
const COUNT = 3 * N;
const INDEX_MASK = 0xfffff;
const VARIANTS = ["packed", "slot", "slot+1", "slot+2", "slot+2-onecall", "slot+2-raw"];

const self = url.fileURLToPath(import.meta.url);
const here = path.dirname(self);
const variant = process.argv[2];
const bundle = path.resolve(process.argv[3] ?? path.join(here, ".out/oecs.prod/index.js"));
if (!fs.existsSync(bundle)) {
	throw new Error(`no bundle at ${bundle}. Run vs.mjs first, or give the path of a build`);
}

if (variant === undefined) {
	console.log(`sparse spawn, ns for each spawn, best of 7 samples, one process for each variant`);
	for (const v of VARIANTS) {
		process.stdout.write(execFileSync(process.execPath, [self, v, bundle], { encoding: "utf8" }));
	}
	process.exit(0);
}
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}: ${VARIANTS.join(", ")}`);

const { ECS } = await import(url.pathToFileURL(bundle).href);
const PRESIZED_BULK = { memory: { columnCapacity: N * 6 } };

/** A fresh world for one sample, with the columns grown outside the timed part. */
function setup() {
	const ecs = new ECS(PRESIZED_BULK);
	if (variant === "packed") {
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
		const t = ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0, vy: 0 }));
		const q = ecs.query(Pos);
		const check = () => {
			let s = 0;
			q.eachChunk((cols, count) => {
				const { x } = cols.read(Pos);
				for (let i = 0; i < count; i++) s += x[i];
			});
			return `${ecs.entityCount} entities, sum x ${s}`;
		};
		return { ecs, t, check };
	}
	const Slot = ecs.registerTag();
	const Pos = ecs.registerSparseComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerSparseComponent({ vx: "f64", vy: "f64" });
	const t = ecs.template(Slot);
	// The sparse columns grow with the highest member index. The setup spawns the
	// full population one time, gives the last entity both components, and
	// despawns them all, so the columns cover every index the timed loop reuses.
	const warm = ecs.spawnMany(t, COUNT);
	ecs.addSparse(warm[warm.length - 1], Pos, { x: 0, y: 0 });
	ecs.addSparse(warm[warm.length - 1], Vel, { vx: 0, vy: 0 });
	for (let i = 0; i < warm.length; i++) ecs.despawn(warm[i]);
	const posS = ecs.store.sparseStores[Pos];
	const velS = ecs.store.sparseStores[Vel];
	if (!posS?._dense || !posS._cols || typeof posS._join !== "function" || !velS) {
		throw new Error("a private field of the store is not reachable, update this probe");
	}
	const check = () => {
		let s = 0;
		const d = posS._dense;
		const x = posS._cols[0];
		for (let i = 0; i < posS._size; i++) s += x[d[i]];
		return `${ecs.entityCount} entities, sum x ${s}`;
	};
	return { ecs, t, Pos, Vel, posS, velS, pv: { x: 1, y: 2 }, vv: { vx: 0, vy: 0 }, check };
}

const FN = {
	packed: (s) => {
		for (let i = 0; i < COUNT; i++) s.ecs.spawn(s.t);
	},
	slot: (s) => {
		for (let i = 0; i < COUNT; i++) s.ecs.spawn(s.t);
	},
	"slot+1": (s) => {
		const { ecs, t, Pos, pv } = s;
		for (let i = 0; i < COUNT; i++) {
			const e = ecs.spawn(t);
			ecs.addSparse(e, Pos, pv);
		}
	},
	"slot+2": (s) => {
		const { ecs, t, Pos, Vel, pv, vv } = s;
		for (let i = 0; i < COUNT; i++) {
			const e = ecs.spawn(t);
			ecs.addSparse(e, Pos, pv);
			ecs.addSparse(e, Vel, vv);
		}
	},
	"slot+2-onecall": (s) => {
		const { ecs, t, posS, velS, pv, vv } = s;
		for (let i = 0; i < COUNT; i++) {
			const idx = ecs.spawn(t) & INDEX_MASK;
			posS.setRow(idx, pv);
			velS.setRow(idx, vv);
		}
	},
	"slot+2-raw": (s) => {
		const { ecs, t, posS, velS } = s;
		const px = posS._cols[0];
		const py = posS._cols[1];
		const vx = velS._cols[0];
		const vy = velS._cols[1];
		for (let i = 0; i < COUNT; i++) {
			const idx = ecs.spawn(t) & INDEX_MASK;
			posS._join(idx);
			px[idx] = 1;
			py[idx] = 2;
			velS._join(idx);
			vx[idx] = 0;
			vy[idx] = 0;
		}
	}
};

const fn = FN[variant];
let state;
for (let i = 0; i < 3; i++) {
	state = setup();
	fn(state);
}
let best = Infinity;
for (let s = 0; s < 7; s++) {
	state = setup();
	const t0 = process.hrtime.bigint();
	fn(state);
	const dt = Number(process.hrtime.bigint() - t0) / 1e6;
	if (dt < best) best = dt;
}
const ns = ((best * 1e6) / COUNT).toFixed(2).padStart(7);
console.log(`  ${variant.padEnd(15)} ${ns} ns   checksum ${state.check()}`);
