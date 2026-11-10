/**
 * A diagnostic for the cost of writing component values by field name when the
 * call site sees many component shapes. `Archetype.writeFields` and
 * `SparseComponentStore.setRow` read `values[names[i]]`. With one shape that keyed
 * load is monomorphic. A world with many components makes it megamorphic.
 * `struct/addComponent_valued_manyDefs`, `cmd/add_valued_manyDefs` and
 * `sparse/addSparse_valued_manyDefs` in `suite.mjs` measure the by-name case. This
 * file adds the two references that bound what a fix could win.
 *
 * Each variant runs in its own process, for the reason `probe-sparse-iter.mjs`
 * gives. Without a variant, this file starts one child for each variant and prints
 * the table.
 *
 *   node probe-manynames.mjs                     # every variant, one process each
 *   node probe-manynames.mjs add/names [bundle]  # one variant, in this process
 *
 * The default bundle is the artifact that `vs.mjs` makes. Give the path of a
 * different build (for example one from `dist.mjs`) as the second argument.
 *
 * A variant is `op/mode`. The op is `add` (immediate `addComponent`), `cmd`
 * (deferred `ctx.commands.add`, then the phase flush) or `sparse` (`addSparse`).
 * Each op attaches 24 components, three f64 fields each, to 30000 entities, round
 * robin, with the archetypes (or sparse columns) planted and presized.
 *
 *   names       24 shapes with 72 distinct field names. The suite row.
 *   mono        24 components that all name their fields a, b, c, so the keyed
 *               load sees one shape. Same archetype pattern, no megamorphism. This
 *               is what the existing monomorphic rows measure.
 *   positional  The shapes of `names`, but `writeFields` (or `setRow`) is replaced
 *               on the prototype by a loop that reads `values[i]`, and the caller
 *               passes arrays. The floor of any fix that resolves names before the
 *               write. It reads private fields, and a real fix adds a little on top.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const N = 10_000;
const COUNT = 3 * N;
const OPS = ["add", "cmd", "sparse"];
const MODES = ["names", "mono", "positional"];
const VARIANTS = OPS.flatMap((o) => MODES.map((m) => `${o}/${m}`));

const self = url.fileURLToPath(import.meta.url);
const here = path.dirname(self);
const variant = process.argv[2];
const bundle = path.resolve(process.argv[3] ?? path.join(here, ".out/oecs.prod/index.js"));
if (!fs.existsSync(bundle)) {
	throw new Error(`no bundle at ${bundle}. Run vs.mjs first, or give the path of a build`);
}

if (variant === undefined) {
	console.log(`many shapes, ns for each attach, best of 9 samples, one process for each variant`);
	for (const v of VARIANTS) {
		process.stdout.write(execFileSync(process.execPath, [self, v, bundle], { encoding: "utf8" }));
	}
	process.exit(0);
}
if (!VARIANTS.includes(variant))
	throw new Error(`unknown variant ${variant}: ${VARIANTS.join(", ")}`);
const [op, mode] = variant.split("/");

const { ECS, SCHEDULE } = await import(url.pathToFileURL(bundle).href);

function setup() {
	const ecs = new ECS({ memory: { columnCapacity: N * 6 } });
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const defs = [];
	const vals = [];
	for (let c = 0; c < 24; c++) {
		const f = mode === "mono" ? ["a", "b", "c"] : [`c${c}_a`, `c${c}_b`, `c${c}_c`];
		const schema = { [f[0]]: "f64", [f[1]]: "f64", [f[2]]: "f64" };
		defs.push(
			op === "sparse" ? ecs.registerSparseComponent(schema) : ecs.registerComponent(schema)
		);
		vals.push(mode === "positional" ? [1, 2, 3] : { [f[0]]: 1, [f[1]]: 2, [f[2]]: 3 });
	}
	const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), COUNT);
	const attach = op === "sparse" ? "addSparse" : "addComponent";
	const detach = op === "sparse" ? "removeSparse" : "removeComponent";
	const plant = op === "sparse" ? ids[ids.length - 1] : ids[0];
	for (let c = 0; c < 24; c++) {
		const v = mode === "positional" ? { [`c${c}_a`]: 1, [`c${c}_b`]: 2, [`c${c}_c`]: 3 } : vals[c];
		ecs[attach](plant, defs[c], v);
		ecs[detach](plant, defs[c]);
	}
	if (mode === "positional") {
		if (op === "sparse") {
			const proto = Object.getPrototypeOf(ecs._store._sparseStores[defs[0]]);
			if (typeof proto.setRow !== "function" || typeof proto._join !== "function")
				throw new Error("a private field of the store is not reachable, update this probe");
			proto.setRow = function (index, values) {
				this._join(index);
				const cols = this._cols;
				for (let f = 0; f < cols.length; f++) cols[f][index] = values[f];
			};
		} else {
			const proto = Object.getPrototypeOf(ecs._store._archGraph.archetypes[0]);
			if (typeof proto.writeFields !== "function" || !proto.writeFieldsPositional)
				throw new Error("a private field of the store is not reachable, update this probe");
			proto.writeFields = function (row, cid, values, tick) {
				const off = this.colOffset[cid];
				if (off === undefined) return;
				this.changedTick[cid] = tick;
				const bufs = this.bufs;
				const n = this._fieldNames[cid].length;
				for (let i = 0; i < n; i++) bufs[off + i][row] = values[i];
			};
		}
	}
	if (op === "cmd") {
		ecs.addSystems(
			SCHEDULE.UPDATE,
			ecs.registerSystem({
				fn: (ctx) => {
					for (let i = 0; i < ids.length; i++) ctx.commands.add(ids[i], defs[i % 24], vals[i % 24]);
				}
			})
		);
		ecs.startup();
	}
	const check = () => {
		let s = 0;
		for (let i = 0; i < ids.length; i += 7) {
			const d = defs[i % 24];
			const f = mode === "mono" ? "c" : `c${i % 24}_c`;
			s += op === "sparse" ? ecs.getSparseField(ids[i], d, f) : ecs.getField(ids[i], d, f);
		}
		return `sum ${s}`;
	};
	return { ecs, ids, defs, vals, check };
}

const FN = {
	add: (s) => {
		const { ecs, ids, defs, vals } = s;
		for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], defs[i % 24], vals[i % 24]);
	},
	cmd: (s) => {
		s.ecs.update(0.016);
	},
	sparse: (s) => {
		const { ecs, ids, defs, vals } = s;
		for (let i = 0; i < ids.length; i++) ecs.addSparse(ids[i], defs[i % 24], vals[i % 24]);
	}
};

const fn = FN[op];
let state;
for (let i = 0; i < 3; i++) {
	state = setup();
	fn(state);
}
let best = Infinity;
for (let s = 0; s < 9; s++) {
	state = setup();
	const t0 = process.hrtime.bigint();
	fn(state);
	const dt = Number(process.hrtime.bigint() - t0) / 1e6;
	if (dt < best) best = dt;
}
const ns = ((best * 1e6) / COUNT).toFixed(2).padStart(7);
console.log(`  ${variant.padEnd(16)} ${ns} ns   checksum ${state.check()}`);
