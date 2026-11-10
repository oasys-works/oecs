/**
 * A diagnostic for the cost of a fragmented `forEachColumns` pass, and for the
 * best a pull-style column table could reach. `bench/vs/README.md` says oecs is
 * second to harmony-ecs on `iter2` and `iter_frag`, and that harmony hands the
 * caller an array of column tuples for each archetype. This probe prices that
 * difference in ns for each archetype, so the answer is a number.
 *
 * The rows are constant: 16,384 entities with `Pos{x,y}` and `Vel{vx,vy}`, all
 * f64, spread over 1, 8, 64, 512 or 4096 archetypes by extra tags. Each variant
 * runs in its own process, and with no variant this file starts one child for each
 * (shape, variant) pair and prints a table.
 *
 *   node probe-columns.mjs                          # every shape, every variant
 *   node probe-columns.mjs <archs> <variant> [bundle]   # one cell, in this process
 *
 * The default bundle is the artifact that `vs.mjs` makes. Run `vs.mjs` first, or
 * build one with `buildDist` from `bench/dist.mjs`.
 *
 * The variants:
 *
 *   a          `forEachColumns`, body `x[i] += vx[i]; y[i] += vy[i]`.
 *   b          `forEachColumns`, takes `cols.mut(Pos)` and `cols.read(Vel)`, loops
 *              nothing. The per-archetype cost alone.
 *   c          `forEachArchetype` with `getColumnRead` for all four columns (the
 *              suite row `iter/forEach_getColumnRead`), the same body as `a`.
 *   d          a flat table `[x, y, vx, vy, count]` for each archetype, built once
 *              outside the timed loop and walked by a loop in this file. No tick
 *              stamp. A pull API with no obligation.
 *   d2         `d` plus the stamp `changedTick[Pos] = tick` for each archetype,
 *              which is what the engine must pay for a mutable column.
 *   a-mega     `a` after twelve other queries ran distinct callbacks through
 *              `forEachColumns`, so the call site of the callback is megamorphic.
 *   b-mega     `b` after the same warm-up.
 *   c-mega     `c` after twelve other callbacks went through `forEachArchetype`.
 *
 * The checksum is the sum of `x` after the run. Each pass adds 0.5 to every `x`, so
 * the sum must equal `0.5 * rows * passes`, and `b` must leave it at 0. A wrong
 * loop prints MISMATCH.
 *
 * The floor variants read the archetypes through the public accessors of the
 * archetype and the query (`nonEmptyArchs`, `getColumnRead`, `changedTick`) and
 * the resolver through `_resolver`. The build keeps the names, and this file breaks
 * loudly when a rename removes one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROWS = 16384;
const REPS = 400;
const SAMPLES = 9;
const SHAPES = [1, 8, 64, 512, 4096];
const VARIANTS = ["a", "b", "c", "d", "d2", "a-mega", "b-mega", "c-mega"];

const self = url.fileURLToPath(import.meta.url);
const here = path.dirname(self);
const archsArg = process.argv[2];
const variant = process.argv[3];
const bundle = path.resolve(process.argv[4] ?? path.join(here, ".out/oecs.prod/index.js"));
if (!fs.existsSync(bundle)) {
	throw new Error(`no bundle at ${bundle}. Run vs.mjs first, or give the path of a build`);
}

if (archsArg === undefined) {
	const cells = {};
	for (const n of SHAPES) {
		for (const v of VARIANTS) {
			const out = execFileSync(process.execPath, [self, String(n), v, bundle], {
				encoding: "utf8"
			});
			cells[`${n}/${v}`] = JSON.parse(out);
		}
	}
	const pad = (s, w) => String(s).padStart(w);
	console.log(
		`fragmented forEachColumns, ${ROWS} rows, best of ${SAMPLES} samples, one process per cell`
	);
	console.log(`ns for each pass, then ns for each archetype (pass / archetypes)`);
	console.log(["archs", ...VARIANTS].map((s, i) => (i === 0 ? pad(s, 6) : pad(s, 9))).join(""));
	for (const n of SHAPES) {
		const row = VARIANTS.map((v) => {
			const c = cells[`${n}/${v}`];
			return pad(c.nsPass.toFixed(0), 9) + (c.ok ? "" : "!");
		});
		console.log(pad(n, 6) + row.join(""));
	}
	console.log(`\nper archetype (ns): overhead and share of the pass`);
	console.log(
		["archs", "rows/arch", "a-d2", "b", "c-d2", "a-mega -d2", "b-mega", "a-d2 %", "a-mega-d2 %"]
			.map((s, i) => pad(s, i === 0 ? 6 : 12))
			.join("")
	);
	for (const n of SHAPES) {
		const g = (v) => cells[`${n}/${v}`].nsPass;
		console.log(
			pad(n, 6) +
				pad(ROWS / n, 12) +
				pad(((g("a") - g("d2")) / n).toFixed(1), 12) +
				pad((g("b") / n).toFixed(1), 12) +
				pad(((g("c") - g("d2")) / n).toFixed(1), 12) +
				pad(((g("a-mega") - g("d2")) / n).toFixed(1), 12) +
				pad((g("b-mega") / n).toFixed(1), 12) +
				pad((((g("a") - g("d2")) / g("a")) * 100).toFixed(1), 12) +
				pad((((g("a-mega") - g("d2")) / g("a-mega")) * 100).toFixed(1), 12)
		);
	}
	const bad = Object.entries(cells).filter(([, c]) => !c.ok);
	if (bad.length > 0) console.log(`\nMISMATCH in: ${bad.map(([k]) => k).join(", ")}`);
	process.exit(0);
}

const A = Number(archsArg);
if (!SHAPES.includes(A)) throw new Error(`unknown shape ${archsArg}: ${SHAPES.join(", ")}`);
if (!VARIANTS.includes(variant))
	throw new Error(`unknown variant ${variant}: ${VARIANTS.join(", ")}`);

const { ECS } = await import(url.pathToFileURL(bundle).href);

// The measured world.
const per = ROWS / A;
const ecs = new ECS({ memory: { columnCapacity: Math.max(8, per * 2) } });
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
const bits = Math.round(Math.log2(A));
const tags = [];
for (let i = 0; i < bits; i++) tags.push(ecs.registerTag());
for (let mask = 0; mask < A; mask++) {
	const items = [Pos({ x: 0, y: 0 }), Vel({ vx: 0.5, vy: 0.5 })];
	for (let b = 0; b < bits; b++) if (mask & (1 << b)) items.push(tags[b]);
	ecs.spawnMany(ecs.template(...items), per);
}
const q = ecs.query(Pos, Vel);

let sink = 0;
let passes = 0;
let fn;

// Distinct function bodies, not closures of one literal: closures of one literal
// share call feedback and V8 can still inline them. `new Function` gives each its
// own shared function info.
const distinct = (n, make) => {
	const out = [];
	for (let i = 0; i < n; i++) out.push(make(i));
	return out;
};

// The warm-up world: twelve more queries, each with its own callback, through the
// same `forEachColumns` and `forEachArchetype` code the measured query uses.
function warmMega(kind) {
	const w = new ECS();
	const P = w.registerComponent({ x: "f64", y: "f64" });
	const V = w.registerComponent({ vx: "f64", vy: "f64" });
	const T = w.registerComponent({ t: "f64" });
	const tg = w.registerTag();
	const combos = [
		[P],
		[V],
		[T],
		[P, V],
		[P, T],
		[V, T],
		[P, V, T],
		[P, tg],
		[V, tg],
		[T, tg],
		[P, V, tg],
		[P, V, T, tg]
	];
	for (const c of combos) {
		const items = c.map((d) => (d === tg ? tg : d({})));
		w.spawnMany(w.template(...items), 32);
	}
	for (let k = 0; k < combos.length; k++) {
		const wq = w.query(...combos[k].filter((d) => d !== tg));
		const def = combos[k][0];
		const first = def === P ? "x" : def === V ? "vx" : def === T ? "t" : "x";
		let cb;
		if (kind === "cols") {
			cb = new Function(
				"def",
				`return (cols, count) => { const g = cols.read(def); const c = g.${first}; let s = ${k}; for (let i = 0; i < count; i++) s += c[i] * ${k + 1}; return s; };`
			)(def);
		} else {
			cb = new Function(
				"def",
				`return (arch) => { const c = arch.getColumnRead(def, "${first}"); const n = arch.entityCount; let s = ${k}; for (let i = 0; i < n; i++) s += c[i] * ${k + 1}; return s; };`
			)(def);
		}
		for (let r = 0; r < 300; r++) {
			if (kind === "cols") wq.forEachColumns(cb);
			else wq.forEachArchetype(cb);
		}
	}
}

// The floor reads the matched archetypes once, outside the timed loop.
function floorTable() {
	const archs = q.nonEmptyArchs();
	const n = archs.length;
	const tbl = new Array(n * 6);
	for (let k = 0; k < n; k++) {
		const a = archs[k];
		tbl[k * 6] = a.getColumnRead(Pos, "x");
		tbl[k * 6 + 1] = a.getColumnRead(Pos, "y");
		tbl[k * 6 + 2] = a.getColumnRead(Vel, "vx");
		tbl[k * 6 + 3] = a.getColumnRead(Vel, "vy");
		tbl[k * 6 + 4] = a.entityCount;
		tbl[k * 6 + 5] = a.changedTick;
	}
	return { tbl, n };
}

if (variant === "a" || variant === "a-mega") {
	if (variant === "a-mega") warmMega("cols");
	fn = () => {
		for (let r = 0; r < REPS; r++) {
			q.forEachColumns((cols, count) => {
				const { x, y } = cols.mut(Pos);
				const { vx, vy } = cols.read(Vel);
				for (let i = 0; i < count; i++) {
					x[i] += vx[i];
					y[i] += vy[i];
				}
			});
		}
		passes += REPS;
	};
} else if (variant === "b" || variant === "b-mega") {
	if (variant === "b-mega") warmMega("cols");
	fn = () => {
		for (let r = 0; r < REPS; r++) {
			q.forEachColumns((cols, count) => {
				const m = cols.mut(Pos);
				const v = cols.read(Vel);
				sink = count + (m === v ? 1 : 0);
			});
		}
		passes += REPS;
	};
} else if (variant === "c" || variant === "c-mega") {
	if (variant === "c-mega") warmMega("arch");
	fn = () => {
		for (let r = 0; r < REPS; r++) {
			q.forEachArchetype((arch) => {
				const x = arch.getColumnRead(Pos, "x");
				const y = arch.getColumnRead(Pos, "y");
				const vx = arch.getColumnRead(Vel, "vx");
				const vy = arch.getColumnRead(Vel, "vy");
				const n = arch.entityCount;
				for (let i = 0; i < n; i++) {
					x[i] += vx[i];
					y[i] += vy[i];
				}
			});
		}
		passes += REPS;
	};
} else {
	const { tbl, n } = floorTable();
	const cid = Pos.id;
	const stamp = variant === "d2";
	const tick = q._resolver.getChangeTick();
	if (stamp) {
		fn = () => {
			for (let r = 0; r < REPS; r++) {
				for (let k = 0; k < n; k++) {
					const o = k * 6;
					const x = tbl[o];
					const y = tbl[o + 1];
					const vx = tbl[o + 2];
					const vy = tbl[o + 3];
					const count = tbl[o + 4];
					tbl[o + 5][cid] = tick;
					for (let i = 0; i < count; i++) {
						x[i] += vx[i];
						y[i] += vy[i];
					}
				}
			}
			passes += REPS;
		};
	} else {
		fn = () => {
			for (let r = 0; r < REPS; r++) {
				for (let k = 0; k < n; k++) {
					const o = k * 6;
					const x = tbl[o];
					const y = tbl[o + 1];
					const vx = tbl[o + 2];
					const vy = tbl[o + 3];
					const count = tbl[o + 4];
					for (let i = 0; i < count; i++) {
						x[i] += vx[i];
						y[i] += vy[i];
					}
				}
			}
			passes += REPS;
		};
	}
}

for (let i = 0; i < 5; i++) fn();
let best = Infinity;
for (let s = 0; s < SAMPLES; s++) {
	const t0 = process.hrtime.bigint();
	fn();
	const dt = Number(process.hrtime.bigint() - t0);
	if (dt < best) best = dt;
}

let sum = 0;
q.forEachArchetype((arch) => {
	const x = arch.getColumnRead(Pos, "x");
	const n = arch.entityCount;
	for (let i = 0; i < n; i++) sum += x[i];
});
const expected = variant.startsWith("b") ? 0 : 0.5 * ROWS * passes;
const ok = sum === expected;
console.log(JSON.stringify({ nsPass: best / REPS, ok, sum, expected, sink }));
