/**
 * The true cost of the lookup of a field name. This probe measures the cost when it
 * removes the lookup.
 *
 * Each indirect method to find this cost was not successful. A synthetic test with 24
 * shapes gave approximately 7 ns (Fix 1 in INVESTIGATION.md). A test on the real code
 * that changed the number of shapes, and that kept each other variable constant, gave
 * approximately 0 ns (`probe-fieldshape.mjs`). But that second test did not change the
 * number of shapes at all, because all the tables from `Object.create(null)` share one
 * dictionary map, and their keys make no difference. A synthetic test measures the
 * code around the lookup, and not the lookup.
 *
 * Therefore this probe measures the cost by DIFFERENCE, on the real code path. It
 * builds the library. It then changes the compiled lookups of
 * `_fieldIndex[cid][field]` to the constant `0`, and it builds a second bundle.
 * `getField(id, P3, "x")` reads field `"x"`, and `"x"` IS ordinal 0. Therefore the
 * second bundle returns equal values for this workload, and its only difference is the
 * lookup that the probe removed. The difference between the two bundles is the cost of
 * the lookup. No other part of the code changed, and no model is necessary.
 *
 * This is an instrument for a measurement, and not a proposal. `fi = 0` is correct
 * only because of the field that this probe reads. The probe gives the limit that any
 * method from a name to an ordinal can reach.
 *
 * This probe uses `../build.mjs`, and thus it does NOT measure the artifacts of the
 * package. It must find a text in the compiled code and replace it, which only the
 * form of `src/` makes possible. Therefore both sides keep the development guards as
 * branches, and the difference between the two sides is still the cost of the
 * lookup. But the absolute values are not the values of the released package. `vs/`
 * and `ab/` measure the artifacts, and `../README.md` gives the table.
 *
 *   node bench/vs/probe-lookupcost.mjs [repoRoot]
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";
import { buildLib } from "../build.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FROM = path.resolve(process.argv[2] ?? "/Users/2khan/dev/oecs");
const outDir = path.join(here, ".out");
fs.mkdirSync(outDir, { recursive: true });

const full = path.join(outDir, "lookup.full.mjs");
await buildLib(full, { dev: false, from: FROM });

const src = fs.readFileSync(full, "utf8");
const LOOKUP = /const fi = this\._fieldIndex\[cid\]\[field\];/g;
const hits = src.match(LOOKUP);
if (!hits) throw new Error("could not find the compiled _fieldIndex lookups — did the source change shape?");
const patched = src.replace(LOOKUP, "const fi = 0;");
const nolookup = path.join(outDir, "lookup.none.mjs");
fs.writeFileSync(nolookup, patched);
console.log(`patched ${hits.length} field-index lookups → constant 0\n`);

// Same in-process measurement for both, one child process each so neither
// bundle's call sites are polluted by the other's.
const CHILD = `
const bundle = process.argv[2];
const { ECS } = await import(bundle);
const N = 10_000;
const ecs = new ECS({ memory: { columnCapacity: Math.round(N * 1.2) } });
const P3 = ecs.registerComponent({ x: "f64", y: "f64", z: "f64" }, { name: "P3" });
const ids = ecs.spawnMany(ecs.template(P3({ x: 1, y: 2, z: 3 })), N);
let sink = 0, checksum = 0;
const fn = () => { let s = 0; for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], P3, "x"); sink = s; return s; };
for (let i = 0; i < 5; i++) checksum = fn();
let best = Infinity;
for (let s = 0; s < 9; s++) {
  const t0 = process.hrtime.bigint();
  fn();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  if (dt < best) best = dt;
}
console.log(JSON.stringify({ ns: (best * 1e6) / (20 * N), checksum }));
`;
const childPath = path.join(outDir, "lookup-child.mjs");
fs.writeFileSync(childPath, CHILD);

const measure = (bundle) =>
	JSON.parse(execFileSync(process.execPath, [childPath, bundle], { encoding: "utf8", cwd: here }));

// Alternate the order across rounds so drift is not assigned to one bundle.
const runs = { full: [], none: [] };
let refChecksum = null;
for (let r = 0; r < 5; r++) {
	for (const [name, bundle] of r % 2 === 0
		? [["full", full], ["none", nolookup]]
		: [["none", nolookup], ["full", full]]) {
		const { ns, checksum } = measure(bundle);
		if (refChecksum === null) refChecksum = checksum;
		else if (checksum !== refChecksum)
			throw new Error(`checksum split: ${name} read different data (${checksum} vs ${refChecksum})`);
		runs[name].push(ns);
	}
}
const median = (xs) => [...xs].sort((a, b) => a - b)[(xs.length / 2) | 0];
const f = median(runs.full);
const n = median(runs.none);
console.log(`  getField, field-index lookup present          ${f.toFixed(2).padStart(7)} ns/op`);
console.log(`  getField, lookup replaced by a constant       ${n.toFixed(2).padStart(7)} ns/op`);
console.log(`\n  the lookup costs ${(f - n).toFixed(2)} ns  (INVESTIGATION.md fix 1 projects −7.00)`);
console.log(`  checksums identical across both bundles (${refChecksum}) — same data read\n`);
