/**
 * A comparison of the working tree with a git ref.
 *
 * Each measurement runs in its own child process, and `child.mjs` gives the
 * reason. The rounds change which variant starts first. Therefore the changes in
 * the CPU frequency and in the temperature are equal for both sides of a round.
 *
 * The result is the ORDER-BALANCED median of the paired ratios of the rounds.
 * Each round measures both variants one after the other, and thus its ratio is
 * not sensitive to slow changes. A median then removes the one round that had a
 * garbage collection in a timed part. But a median of ALL the rounds together
 * does not remove a POSITION bias, which is a difference between the first
 * measurement of a round and the second. A position bias divides the ratio of one
 * order and multiplies the ratio of the other. Therefore the set of the ratios has
 * two groups, and a median of the full set falls in one group instead of between
 * them: it keeps the full bias. Thus this tool takes a median in each order and
 * then multiplies the two medians and takes the square root. The bias cancels
 * exactly, and each order keeps its protection against a garbage collection. For
 * the same reason the number of the rounds must be EVEN: an odd number gives one
 * order more weight than the other.
 *
 * The `[lo..hi]` column is the INTERQUARTILE range of the ratios, after this tool
 * moves each order to the common centre. Therefore the range shows the difference
 * between the rounds, and it does not show the position bias again. Refer to the
 * comment about the spread below. If that middle half includes zero, the direction
 * is not reliable, and this tool marks the row NOISY.
 *
 * Always calibrate before you accept a result:
 *
 *   node bench/ab/ref.mjs --null      # the same code on both sides: each row must show ~0%
 *
 * The null run shows the bias of the equipment. It reports two numbers, and you
 * must use both. The largest |Δ| is the limit of a comparison of the MEDIANS. The
 * widest interquartile range is the limit of one ROW: a case whose middle half is
 * wide in a null run cannot support a small delta in a real run, even if the
 * summary number is small. Subtract that bias from a real comparison. It is better
 * to make a change that removes the bias.
 *
 *   node bench/ab/ref.mjs             # compare the working tree with HEAD
 *   node bench/ab/ref.mjs --ref main  # compare with a different ref
 *   node bench/ab/ref.mjs struct/     # select the cases by a part of the name
 *   node bench/ab/ref.mjs --rounds 16 # use more rounds (an even number)
 *
 * `README.md` in this directory gives the complete method.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { buildLib } from "../build.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const benchDir = path.resolve(here, "..");
const root = path.resolve(here, "../..");
// Bundles and saved baselines share one gitignored scratch dir with the rest of
// `bench/`, rather than each tool growing its own.
const outDir = path.join(benchDir, ".out");
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
// The flags that take a VALUE. The list is explicit, because the earlier rule was
// "a word after any `--flag` is that flag's value". `--null` takes no value, and
// thus `--null struct/` made the filter empty and calibrated all the cases. The
// README tells you to use the same filter for both steps, and that rule made the
// instruction impossible to obey.
const VALUE_FLAGS = new Set(["ref", "rounds", "warmup", "samples"]);
const flag = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const isValueOf = (i) => i > 0 && VALUE_FLAGS.has(args[i - 1].replace(/^--/, "")) && args[i - 1].startsWith("--");

const ref = flag("ref", "HEAD");
// EVEN by default. The delta below is a median in each order, and the two orders
// must get an equal number of rounds.
const rounds = Number(flag("rounds", "12"));
const warmup = Number(flag("warmup", "3"));
const samples = Number(flag("samples", "9"));
// --null builds the SAME source for both sides. Therefore each row shows only the
// bias of the equipment. This is the self-test of the equipment.
const nullRun = has("null");
const filter = args.find((a, i) => !a.startsWith("--") && !isValueOf(i)) ?? "";
if (rounds % 2 !== 0) {
	console.error(
		`warning: --rounds ${rounds} is odd, so one order gets more rounds than the other ` +
			`and the position bias does not cancel. Use an even number.`
	);
}

// ── build both variants once ───────────────────────────────────────────────
const stamp = String(process.hrtime.bigint());
const baseFile = path.join(outDir, `ab.base.${stamp}.mjs`);
const workFile = path.join(outDir, `ab.work.${stamp}.mjs`);

await buildLib(workFile, { dev: false, from: root });
if (nullRun) {
	await buildLib(baseFile, { dev: false, from: root });
} else {
	const wt = path.join(os.tmpdir(), `oecs-ab-${ref.replace(/[^\w]/g, "_")}`);
	if (fs.existsSync(wt)) {
		execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root, stdio: "ignore" });
	}
	execFileSync("git", ["worktree", "add", "--detach", wt, ref], { cwd: root, stdio: "inherit" });
	await buildLib(baseFile, { dev: false, from: wt });
	execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root, stdio: "ignore" });
}

// ── run ────────────────────────────────────────────────────────────────────
const child = path.join(here, "child.mjs");
function measure(bundle) {
	const stdout = execFileSync(
		process.execPath,
		[child, bundle, filter, String(warmup), String(samples)],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	);
	return JSON.parse(stdout);
}

const samplesA = new Map();
const samplesB = new Map();
let iters = new Map();

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

fs.rmSync(baseFile, { force: true });
fs.rmSync(workFile, { force: true });

function push(m, k, v) {
	if (!m.has(k)) m.set(k, []);
	m.get(k).push(v);
}
const min = (xs) => xs.reduce((p, c) => (c < p ? c : p), Infinity);
// A median that INTERPOLATES for an even count. `sorted[len/2 | 0]` takes the
// upper of the two middle values, which is biased high, and the bias is worst
// where the count is smallest: for two values it takes the larger one every time.
// The number of the rounds is even by default, and `balance` below halves it
// again, so an even count is the normal condition here.
const median = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** The same, for RATIOS. A ratio is multiplicative, so the middle of two ratios is
 * the geometric mean and not the arithmetic mean. */
const medianRatio = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m] : Math.sqrt(s[m - 1] * s[m]);
};

/**
 * The paired ratios of the rounds, moved to one common centre.
 *
 * Round `r` measures the base side first when `r` is even, and the working side
 * first when `r` is odd. Thus a position bias `P` between the first measurement
 * and the second multiplies the ratios of one order and divides the ratios of the
 * other. This function takes a median in each order, and it then gives the centre
 * as the square root of the product of the two medians: `P` cancels exactly, and
 * each median still removes the round that had a garbage collection.
 *
 * It also returns the ratios after it moves each order onto that centre. Use those
 * for the spread, because the raw ratios include `P` two times — one time in each
 * direction — and thus a large `P` alone makes a row look noisy.
 */
function balance(ratios) {
	const even = ratios.filter((_, i) => i % 2 === 0);
	const odd = ratios.filter((_, i) => i % 2 === 1);
	// One round only, or a filter that removed one order: there is nothing to
	// balance, so use the plain median and report the ratios as they are.
	if (even.length === 0 || odd.length === 0) {
		return { centre: medianRatio(ratios), balanced: [...ratios] };
	}
	const mEven = medianRatio(even);
	const mOdd = medianRatio(odd);
	const centre = Math.sqrt(mEven * mOdd);
	const kEven = centre / mEven;
	const kOdd = centre / mOdd;
	return {
		centre,
		balanced: ratios.map((r, i) => r * (i % 2 === 0 ? kEven : kOdd)),
	};
}

// ── report ─────────────────────────────────────────────────────────────────
const names = [...samplesA.keys()];
const w = Math.max(...names.map((n) => n.length), 4);
const label = nullRun ? "null-A" : ref;
console.log(`\n${"case".padEnd(w)}  ${label.padStart(10)}      working    median Δ`);
console.log("─".repeat(w + 46));
let improved = 0;
let regressed = 0;
let worstNull = 0;
let noisyRows = 0;
let widestIqr = 0;
let widestIqrRow = "";
for (const name of names) {
	const sa = samplesA.get(name);
	const sb = samplesB.get(name);
	const it = iters.get(name);
	// Use the median, and do not use the minimum. Then these two columns and the Δ
	// beside them are the same statistic. A pair from the minimum values can show
	// "7.4ns vs 8.5ns … +0.1%", and that line is not consistent.
	const na = (median(sa) * 1e6) / it;
	const nb = (median(sb) * 1e6) / it;
	const { centre, balanced } = balance(sa.map((v, i) => sb[i] / v));
	const delta = (centre - 1) * 100;
	// The spread is the INTERQUARTILE range of the balanced ratios of the rounds. It
	// is not the range from the minimum to the maximum. With approximately 12 rounds,
	// one round with a garbage collection is normal. If that one round can reject the
	// case (min..max), the tool marks rows whose middle half is very close.
	const sorted = [...balanced].sort((x, y) => x - y);
	const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
	const lo = (q(0.25) - 1) * 100;
	const hi = (q(0.75) - 1) * 100;
	const spread = `${lo.toFixed(0)}..${hi.toFixed(0)}%`;
	// NOISY shows that this row cannot support its verdict. Therefore the test uses
	// the verdict, and it does not use only the value of the spread:
	//   - A verdict of FASTER or SLOWER needs the middle half of the rounds to
	//     agree about the SIGN. If the IQR includes zero, the direction is random.
	//   - A verdict of "no change" permits some difference between the rounds. But
	//     the middle half must not be wide enough to hide a real effect.
	// A constant limit for the IQR does neither test correctly. It marked a
	// decisive -18.9% with a small IQR (-22..-17%). It also accepted rows whose
	// middle half included zero.
	const decisive = Math.abs(delta) > 3;
	const noisy = decisive ? lo * hi <= 0 : hi - lo > 10;
	const mark = noisy
		? "NOISY "
		: delta < -3
			? "FASTER"
			: delta > 3
				? "SLOWER"
				: "  ~   ";
	if (!noisy && delta < -3) improved++;
	if (!noisy && delta > 3) regressed++;
	// The floor takes EVERY row, and it does not exclude the NOISY rows. A NOISY row
	// in a null run is a row whose rounds disagree about equal code. Therefore it is
	// the strongest evidence about the floor, and not a row to discard.
	if (Math.abs(delta) > Math.abs(worstNull)) worstNull = delta;
	if (hi - lo > widestIqr) {
		widestIqr = hi - lo;
		widestIqrRow = name;
	}
	if (noisy) noisyRows++;
	console.log(
		`${name.padEnd(w)}  ${na.toFixed(1).padStart(8)}ns  ${nb.toFixed(1).padStart(8)}ns  ` +
			`${(delta >= 0 ? "+" : "") + delta.toFixed(1)}%`.padStart(8) +
			`  ${mark}  [${spread}]`
	);
}
if (nullRun) {
	// TWO numbers, because one number cannot describe this. The largest |Δ| is the
	// floor of the MEDIANS, and it is usually small. The widest interquartile range
	// is the floor of the WORST ROW, and it can be many times larger. A row whose
	// middle half is wide under equal code cannot support a small delta under
	// different code, and the summary number alone hides that.
	console.log(
		`\nnull run over ${names.length} case(s), ${rounds} rounds:` +
			`\n  largest |Δ| across all rows   ${Math.abs(worstNull).toFixed(1)}%` +
			`   ← the floor of a median` +
			`\n  widest middle half of rounds  ${widestIqr.toFixed(1)}%` +
			`   ← ${widestIqrRow}: the floor of the worst row` +
			`\n  ${noisyRows} row(s) flagged NOISY` +
			`\nA real delta must clear the first number, and a delta on ONE row must also` +
			` clear that row's own middle half.`
	);
} else {
	console.log(
		`\n${improved} faster, ${regressed} slower, ${noisyRows} noisy ` +
			`(median Δ, threshold ±3%; NOISY rows excluded from the tally)`
	);
}
