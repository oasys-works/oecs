/**
 * A comparison of the suite between two bundles that you made before. It does not
 * compare the working tree with a git ref.
 *
 * `ref.mjs` makes its baseline from a git ref in a temporary worktree, and this is
 * the correct default. But `ref.mjs` cannot measure one change alone, if the
 * working tree holds other changes that you did not commit. The difference between
 * the ref and the tree then includes all of those changes. This program receives
 * the two bundles directly. Therefore you can compare a bundle from before a
 * change with a bundle from after the change. You do not need to commit the
 * change, to stash it, or to make any other change to the tree.
 *
 * The method is the method of `ref.mjs`, and the reasons are the same. There is
 * one child process for each measurement (`child.mjs`). The rounds change which
 * side starts first, and thus slow changes are equal for both sides of a round.
 * The result is the ORDER-BALANCED median of the paired ratios of the rounds:
 * a median in each order, and then the square root of the product of the two.
 * `ref.mjs` records why a median of all the rounds together keeps a position bias
 * at its full strength. The tool also shows the spread, and therefore a row with
 * much noise cannot look like a result.
 *
 * There is one difference from `ref.mjs`. The spread here is the full `[min..max]`
 * of the ratios of the rounds, and there is no NOISY verdict. Therefore one round
 * with a garbage collection in a timed part makes a row look wider here than in
 * `ref.mjs`, and a row can show REGRESSED with no support from the spread. Read the
 * spread. Do not read the delta only. Use `ref.mjs` when you need a verdict.
 *
 *   node bench/ab/bundles.mjs <base.mjs> <work.mjs> [filter] [--rounds 12]
 *   node bench/ab/bundles.mjs <same.mjs> <same.mjs>    # calibrate with a null comparison
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};
// The flags that take a VALUE, listed explicitly. `ref.mjs` records why the rule
// "a word after any `--flag` is that flag's value" is wrong: a flag with no value
// then eats the positional word after it.
const VALUE_FLAGS = new Set(["rounds", "warmup", "samples"]);
const positional = args.filter(
	(a, i) =>
		!a.startsWith("--") &&
		!(i > 0 && args[i - 1].startsWith("--") && VALUE_FLAGS.has(args[i - 1].slice(2)))
);
const [baseFile, workFile] = positional;
if (!baseFile || !workFile) {
	console.error("usage: node bench/ab/bundles.mjs <base.mjs> <work.mjs> [filter] [--rounds N]");
	process.exit(2);
}
const filter = positional[2] ?? "";
// EVEN by default: the delta is a median in each order, and the two orders must
// get an equal number of rounds.
const rounds = Number(flag("rounds", "12"));
const warmup = Number(flag("warmup", "3"));
const samples = Number(flag("samples", "9"));
const isNull = path.resolve(baseFile) === path.resolve(workFile);

const child = path.join(here, "child.mjs");
const measure = (bundle) =>
	JSON.parse(
		execFileSync(process.execPath, [child, bundle, filter, String(warmup), String(samples)], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024
		})
	);

const samplesA = new Map();
const samplesB = new Map();
const iters = new Map();
const push = (m, k, v) => {
	if (!m.has(k)) m.set(k, []);
	m.get(k).push(v);
};

for (let r = 0; r < rounds; r++) {
	const aFirst = r % 2 === 0;
	const first = measure(aFirst ? baseFile : workFile);
	const second = measure(aFirst ? workFile : baseFile);
	const a = aFirst ? first : second;
	const b = aFirst ? second : first;
	for (const name of Object.keys(a)) {
		if (b[name] === undefined) continue;
		push(samplesA, name, a[name].ms);
		push(samplesB, name, b[name].ms);
		iters.set(name, a[name].iters);
	}
	process.stderr.write(`round ${r + 1}/${rounds}\n`);
}

// Both medians INTERPOLATE for an even count — `ref.mjs` records why. A ratio is
// multiplicative, so the middle of two ratios is their geometric mean.
const median = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const medianRatio = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m] : Math.sqrt(s[m - 1] * s[m]);
};
/** The order-balanced centre of the paired ratios. `ref.mjs::balance` gives the
 * complete reason: round `r` measures the base side first when `r` is even, so a
 * position bias multiplies one order and divides the other, and a median of all
 * the rounds together keeps that bias. */
function balancedCentre(ratios) {
	const even = ratios.filter((_, i) => i % 2 === 0);
	const odd = ratios.filter((_, i) => i % 2 === 1);
	if (even.length === 0 || odd.length === 0) return medianRatio(ratios);
	return Math.sqrt(medianRatio(even) * medianRatio(odd));
}
const names = [...samplesA.keys()];
const w = Math.max(...names.map((n) => n.length), 4);
console.log(
	`\n${isNull ? "NULL CALIBRATION (same bundle both sides — every row should read ~0%)" : "A/B"}` +
		`  ·  ${rounds} rounds, paired, alternating order`
);
console.log(`\n${"case".padEnd(w)}  ${"base".padStart(10)}  ${"work".padStart(10)}   median Δ    spread`);
console.log("─".repeat(w + 50));

let regressed = 0;
let improved = 0;
let worst = 0;
for (const name of names) {
	const a = samplesA.get(name);
	const b = samplesB.get(name);
	// The paired ratio of each round: the round measured both sides one after the
	// other. Therefore the ratio is not sensitive to slow changes, but the absolute
	// values are sensitive to them.
	const ratios = a.map((v, i) => b[i] / v);
	const delta = (balancedCentre(ratios) - 1) * 100;
	const lo = (Math.min(...ratios) - 1) * 100;
	const hi = (Math.max(...ratios) - 1) * 100;
	const it = iters.get(name) ?? 1;
	const nsA = (median(a) * 1e6) / it;
	const nsB = (median(b) * 1e6) / it;
	if (Math.abs(delta) > Math.abs(worst)) worst = delta;
	if (delta > 3) regressed++;
	else if (delta < -3) improved++;
	const mark = delta > 3 ? " REGRESSED" : delta < -3 ? " improved" : "";
	console.log(
		`${name.padEnd(w)}  ${nsA.toFixed(2).padStart(10)}  ${nsB.toFixed(2).padStart(10)}   ` +
			`${(delta >= 0 ? "+" : "") + delta.toFixed(1)}%`.padStart(8) +
			`   [${lo.toFixed(1)}..${hi.toFixed(1)}]%${mark}`
	);
}
console.log(
	`\n${names.length} cases · ${improved} improved >3% · ${regressed} regressed >3% · largest |Δ| ${worst.toFixed(1)}%`
);
if (isNull) console.log(`(null run: everything above is harness bias, not a result)`);
