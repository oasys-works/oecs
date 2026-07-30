/**
 * A comparison of oecs with bitECS, koota, becsy, miniplex, harmony-ecs, wolf-ecs
 * and piecs, and with raw typed arrays as the limit. `cases.mjs::IMPLS` is the
 * authority on that list; this comment is not.
 *
 * The libraries come from `bench/vs/node_modules`. Install them with `npm ci` in
 * this directory, and NOT with `npm install`: `package.json` uses `^` ranges for
 * four of them, and thus a plain install can give versions that are different from
 * the versions in `README.md`. `package-lock.json` pins the documented versions.
 *
 * The method, and the reason for each part of it:
 *
 *   ONE PROCESS FOR EACH MEASUREMENT OF A LIBRARY AND A CASE — refer to
 *     `child.mjs`. All the libraries in one process give many shapes at each
 *     measured call site. No library operates in that condition.
 *
 *   EACH ROUND CHANGES THE SEQUENCE OF THE LIBRARIES — round `r` starts the list
 *     of the libraries at offset `r`. Therefore no library is always first, when
 *     the page cache is warm and the CPU is cold. No library is always last, when
 *     the CPU is hot and its frequency is low. But each library receives an equal
 *     part of the slow changes ONLY IF `rounds % libraries === 0`. With fewer
 *     rounds than libraries, the libraries at the end of the list are never first,
 *     and each library gets a different set of positions. The tool gives a warning
 *     for that condition. A measurement at 5 rounds and at 9 rounds moved no ratio
 *     of this table outside its own spread, so the effect is small here — but the
 *     warning keeps the claim above true.
 *
 *   THE MEDIAN OF THE BEST VALUE OF EACH ROUND — in one round, the best value has
 *     the least noise, because noise only adds time. The median across the rounds
 *     then removes the round that had a garbage collection, or an interruption from
 *     the scheduler, in a timed part.
 *
 *   THE TOOL SHOWS THE SPREAD — the range `[min..max]` across the rounds, as a
 *     percentage of the median. A wide spread shows that you must not use this row.
 *     The tool shows the spread, and therefore one round with a low value cannot
 *     look like a result.
 *
 *   CALIBRATION WITH --null — the tool runs oecs in EVERY position of the library
 *     list, with a different label in each position. Each row of that report must
 *     show approximately 1.00×. A different value is the bias of the equipment, and
 *     it is also the limit of the method: the method cannot measure a difference
 *     that is smaller than the bias. The null run must have the same width as the
 *     real run. An earlier version ran only two positions, and thus a null round
 *     was a small part of the length of a real round. That short null reported a
 *     limit of approximately 1%, but a null run at the full width reports
 *     approximately 3% on the ratios and much wider spreads on some rows. Use the
 *     full-width figure.
 *
 *   ABSENT, AND NOT EMULATED — if a library has no API for a case, the tool shows
 *     `—  (no API for this case)`. It writes no substitute, because a substitute
 *     measures itself. A measurement that FAILED is a different condition, and the
 *     tool shows it as `failed`. The two must never look the same: an absent row is
 *     a statement about the library, and a failed row is a statement about this
 *     machine.
 *
 * Usage:
 *   node bench/vs/vs.mjs                 # all libraries, all cases
 *   node bench/vs/vs.mjs --rounds 9      # a multiple of the number of libraries
 *   node bench/vs/vs.mjs --case iter2
 *   node bench/vs/vs.mjs --null          # calibration: oecs in every position
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { buildDist } from "../dist.mjs";
import { CASES, IMPLS } from "./cases.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const ROUNDS = Number(flag("rounds", 5));
const WARMUP = Number(flag("warmup", 3));
const SAMPLES = Number(flag("samples", 7));
const ONLY = flag("case", null);
const NULL_RUN = argv.includes("--null");

// Derived from IMPLS rather than hand-listed: a hand-listed copy silently dropped
// three libraries that had already been added to `cases.mjs`, and the run looked
// perfectly healthy without them.
const ONLY_LIBS = flag("libs", null);
const ALL_LIBS = Object.keys(IMPLS);
// A null run puts oecs in EVERY position of the list, and not in two positions.
// The width of the list sets the number of measurements in a round, and thus the
// length of a round and the heat that it makes. A two-wide null calibrated
// conditions that no real run has, and it reported a limit that was too small.
const NULL_LIBS = ALL_LIBS.map(() => "oecs");
const LIBS = NULL_RUN
	? NULL_LIBS
	: ONLY_LIBS
		? ONLY_LIBS.split(",").map((s) => s.trim())
		: ALL_LIBS;
const LABELS = NULL_RUN ? ALL_LIBS.map((_, i) => `oecs#${i + 1}`) : LIBS;
for (const l of LIBS) if (!(l in IMPLS)) throw new Error(`unknown library ${l}`);
const cases = ONLY ? [ONLY] : CASES;
if (ROUNDS % LIBS.length !== 0) {
	console.error(
		`warning: ${ROUNDS} rounds over ${LIBS.length} libraries. The rotation gives each library a ` +
			`different set of positions, and ${LIBS.length - (ROUNDS % LIBS.length)} of them are never ` +
			`first. Use a multiple of ${LIBS.length} (--rounds ${LIBS.length}).`
	);
}

// oecs is built once, and the tool measures the ARTIFACT of the package. Each
// other library comes from `node_modules` as its author released it. Therefore
// both sides of the comparison are a released build, and no library gets an
// advantage from the form of its code. `dist.mjs` gives the reason that a bundle
// of `src/` is not the same as the artifact.
//
// `--from <repoRoot>` builds oecs from a different checkout. Thus a dirty working
// tree in another directory can be measured, and a copy into this directory is not
// necessary. The default is the checkout that holds this program.
const outDir = path.join(here, ".out");
fs.mkdirSync(outDir, { recursive: true });
const FROM = path.resolve(flag("from", path.resolve(here, "../..")));
const tag = flag("tag", "prod");
const bundle = buildDist(FROM, path.join(outDir, `oecs.${tag}`));
{
	const v = JSON.parse(fs.readFileSync(path.join(FROM, "package.json"), "utf8")).version;
	console.error(`oecs built from ${FROM} (package version ${v})`);
}

const results = new Map(); // `${label}|${case}` -> number[] of per-round bests
const iters = new Map(); // case -> iters
const checksums = new Map(); // `${label}|${case}` -> number, compared across libraries
// Two different reasons for an empty cell, kept apart. `absent` is a statement
// about the LIBRARY: it has no API for this case, and `child.mjs` says so. `failed`
// is a statement about this MACHINE: the measurement did not run. An earlier
// version put both into one set and printed "no API for this case" for both, and
// thus a module that was not installed read as a gap in the design of a competitor.
const absent = new Set();
const failed = new Map(); // `${label}|${case}` -> the reason

const key = (l, c) => `${l}|${c}`;

/** The line of a child failure that names the cause. It prefers an `Error:` line,
 * or a line with a Node error code, over the boilerplate around it. */
function failureReason(err) {
	const lines = String(err.stderr ?? err.message ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// The line where the error was THROWN, and not the source line that node echoes
	// above it. Node prints `  throw new ERR_MODULE_NOT_FOUND(...)` before the real
	// message, and that line names the code but says nothing about the cause.
	const thrown = lines.find((l) => /^\w*Error\b[^\n]*:/.test(l));
	const coded = lines.find((l) => /ERR_[A-Z_]+/.test(l));
	return (thrown ?? coded ?? lines[0] ?? "(no output)").slice(0, 200);
}

for (let r = 0; r < ROUNDS; r++) {
	// Rotate which library goes first each round.
	const order = LIBS.map((_, i) => (i + r) % LIBS.length);
	for (const li of order) {
		const lib = LIBS[li];
		const label = LABELS[li];
		for (const c of cases) {
			if (absent.has(key(label, c)) || failed.has(key(label, c))) continue;
			let out;
			try {
				out = execFileSync(
					process.execPath,
					[path.join(here, "child.mjs"), lib, c, bundle, String(WARMUP), String(SAMPLES)],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: here }
				);
			} catch (err) {
				// The FIRST informative line, and not the last three. Node puts its own
				// version banner at the end of a stack, so `slice(-3)` kept the banner
				// and discarded the line that names the cause — `ERR_MODULE_NOT_FOUND`
				// for a library that is not installed, for example.
				console.error(`  ! ${label}/${c} FAILED: ${failureReason(err)}`);
				failed.set(key(label, c), failureReason(err));
				continue;
			}
			const j = JSON.parse(out);
			if (j.absent) {
				absent.add(key(label, c));
				continue;
			}
			iters.set(c, j.iters);
			if (j.checksum !== null && j.checksum !== undefined) checksums.set(key(label, c), j.checksum);
			const k = key(label, c);
			if (!results.has(k)) results.set(k, []);
			results.get(k).push(j.bestMs);
		}
	}
	process.stderr.write(`round ${r + 1}/${ROUNDS} done\n`);
}

// ── report ──────────────────────────────────────────────────────────────────
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[(s.length / 2) | 0];
};

const nsOf = (label, c) => {
	const xs = results.get(key(label, c));
	if (xs === undefined || xs.length === 0) return null;
	return {
		ns: (median(xs) * 1e6) / iters.get(c),
		min: Math.min(...xs),
		max: Math.max(...xs),
		med: median(xs),
		rounds: xs.length,
	};
};

console.log(
	`\n${NULL_RUN ? "NULL CALIBRATION (oecs vs oecs — every ratio should read ~1.00×)" : "head-to-head"}` +
		`  ·  ${ROUNDS} rounds × ${SAMPLES} samples, one process per measurement, rotated order`
);
console.log(`node ${process.version}  ·  ns/op, lower is better  ·  ratio = library ÷ oecs\n`);

const W = 12;
for (const c of cases) {
	const base = nsOf(LABELS[0], c);
	console.log(`── ${c}${iters.has(c) ? `  (${iters.get(c).toLocaleString()} ops/sample)` : ""}`);
	for (const label of LABELS) {
		const v = nsOf(label, c);
		if (v === null) {
			const why = failed.get(key(label, c));
			console.log(
				why === undefined
					? `   ${label.padEnd(W)}        —      (no API for this case)`
					: `   ${label.padEnd(W)}        ✗      FAILED — ${why.slice(0, 90)}`
			);
			continue;
		}
		// One round gives `min === max`, and thus a spread of 0.0% — which reads as
		// "very stable" when it means "one sample". Say which it is.
		const spread = ((v.max - v.min) / v.med) * 100;
		const ratio = base === null ? null : v.ns / base.ns;
		console.log(
			`   ${label.padEnd(W)} ${v.ns.toFixed(2).padStart(8)} ns` +
				`   ${ratio === null ? "" : `${ratio.toFixed(2)}×`.padStart(7)}` +
				`   ${v.rounds < 2 ? "spread  n/a  (1 round)" : `spread ${spread.toFixed(1).padStart(5)}%`}`
		);
	}
	console.log();
}

// ── cross-library correctness ───────────────────────────────────────────────
// Every library ran `fn` the same number of times against the same starting
// state, so for a case with a checksum all of them must agree. A disagreement
// means someone iterated a different entity set or dropped writes, and any
// timing comparison against them is meaningless — so this is reported loudly
// rather than as a footnote.
{
	let checked = 0;
	const bad = [];
	for (const c of cases) {
		const vals = LABELS.map((l) => [l, checksums.get(key(l, c))]).filter(([, v]) => v !== undefined);
		if (vals.length < 2) continue;
		checked++;
		const [, ref] = vals[0];
		for (const [l, v] of vals.slice(1)) {
			// Float accumulation order differs between a dense column walk and an
			// id-indexed walk, so an exact match is not required — a relative
			// tolerance well below any real "wrong entity set" error is.
			if (Math.abs(v - ref) > Math.abs(ref) * 1e-9 + 1e-9) {
				bad.push(`${c}: ${vals[0][0]}=${ref} but ${l}=${v}`);
			}
		}
	}
	if (bad.length > 0) {
		console.log(`\n!! CHECKSUM DISAGREEMENT — the libraries did not do the same work:`);
		for (const b of bad) console.log(`   ${b}`);
		console.log(`   Timings above are not comparable until this is fixed.\n`);
	} else if (checked > 0) {
		console.log(`checksums agree across all libraries on ${checked}/${cases.length} cases\n`);
	}
}

// A failure is not a result. Say so once, loudly, so that a table with a hole in
// it is never read as a complete comparison.
if (failed.size > 0) {
	console.log(`!! ${failed.size} measurement(s) FAILED — this table is not complete:`);
	for (const [k, why] of failed) console.log(`   ${k.replace("|", "/")}: ${why.slice(0, 120)}`);
	console.log(`   A failed cell is a fault of this machine, and not a gap in a library.\n`);
}

// `null` for an absent case, and the string "failed" for a measurement that did
// not run. A reader of this file must not have to guess which one an empty cell is.
const json = {};
for (const c of cases) {
	json[c] = {};
	for (const label of LABELS) {
		const v = nsOf(label, c);
		json[c][label] =
			v !== null ? Number(v.ns.toFixed(3)) : failed.has(key(label, c)) ? "failed" : null;
	}
}
const jsonPath = path.join(outDir, NULL_RUN ? `null.${tag}.json` : `vs.${tag}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
console.log(`→ ${jsonPath}`);
