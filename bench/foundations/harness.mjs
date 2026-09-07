/**
 * Shared measurement harness for the foundation probes.
 *
 * The rules here are the ones the substrate study paid for:
 *
 *  - **A median of many samples, after warmup.** A single sample measures the
 *    jit, not the code.
 *  - **Report the spread, always.** A ratio without a spread cannot be judged.
 *    Several assertions in the study flipped between runs because the threshold
 *    sat on the measured value.
 *  - **One process for each variant** where the heap can contaminate the result.
 *    The study's first experiment reported a structurally impossible result
 *    (the best plain-object shape slower than the worst) because all variants
 *    were built before timing and ~500 MB of heap put GC inside the samples.
 *    `runVariant` exists for that. Use it whenever a variant allocates.
 *  - **A result that agrees with you gets more scrutiny, not less.** Probes here
 *    print the raw numbers, not a verdict, so the reader can disbelieve them.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DIST = new URL("../../dist/index.js", import.meta.url);

export function requireDist() {
	if (!existsSync(fileURLToPath(DIST))) {
		console.error("dist/index.js is missing, run `pnpm build` first.");
		process.exit(1);
	}
}

/** Import the shipped artifact, not a bundle of `src/`. The dev guards are
 * removed from it, and guard removal changes function size, which changes the
 * compiler's inlining decisions. Measuring `src/` measures code no user gets. */
export async function loadOecs() {
	requireDist();
	return await import(DIST.href);
}

export function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The middle half, the range a delta must clear to be worth reporting. */
export function iqr(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { p25: q(0.25), p75: q(0.75), min: s[0], max: s[s.length - 1] };
}

/**
 * Warm up, then take `samples` timed runs of `fn`. Returns the median and the
 * spread. `fn` must return a value, and we consume it so the optimiser cannot
 * delete the work. The study lost one measurement to exactly that (a large
 * apparent speedup that was V8 removing the slow variant before it ran).
 */
export function time(fn, { warmup = 5, samples = 15 } = {}) {
	let sink = 0;
    for (let i = 0; i < warmup; i++) sink += consume(fn());
	const times = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		const out = fn();
		const t1 = performance.now();
		sink += consume(out);
		times.push(t1 - t0);
	}
	globalThis.__sink = sink;
	return { median: median(times), ...iqr(times), samples: times };
}

function consume(v) {
	if (typeof v === "number") return v;
	if (v == null) return 0;
	if (typeof v === "object") return Object.keys(v).length;
	return 1;
}

/**
 * Re-run this file in a fresh process with `--variant=<name>`, and return the
 * JSON the child printed on its `__RESULT__` line. Use for any variant whose
 * allocation would otherwise land in another variant's samples.
 */
export function runVariant(fileUrl, name, nodeArgs = []) {
	const file = fileURLToPath(fileUrl);
	const run = spawnSync(process.execPath, [...nodeArgs, file, `--variant=${name}`], {
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "" }
	});
	const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("__RESULT__"));
	if (!line) {
		console.error(`variant ${name} produced no result (exit ${run.status})`);
		if (run.stdout) console.error(run.stdout.trim());
		if (run.stderr) console.error(run.stderr.trim());
		process.exit(1);
	}
	return JSON.parse(line.slice("__RESULT__".length));
}

export function emit(obj) {
	console.log(`__RESULT__${JSON.stringify(obj)}`);
}

export function variantArg() {
	const a = process.argv.find((x) => x.startsWith("--variant="));
	return a ? a.slice("--variant=".length) : null;
}

/** Bytes the V8 heap holds, and bytes held outside it. The study's H4 turned on
 * this split: buffer bytes are `external`, so the collector traces one handle
 * regardless of buffer size. `heapUsed` alone under-reports them. */
export function memory() {
	if (global.gc) {
		global.gc();
		global.gc();
	}
	const m = process.memoryUsage();
	return { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}

export function mib(bytes) {
	return `${(bytes / 1048576).toFixed(2)} MiB`;
}

export function table(rows, cols) {
	const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
	const line = (cells) => "  " + cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
	console.log(line(cols.map((c) => c.label)));
	console.log(line(widths.map((w) => "-".repeat(w))));
	for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

/** The runtimes present on this machine, and the engine family each uses.
 * Round 3 of the study overturned a design rule by adding a second engine. A
 * probe that reports only V8 is reporting half a result. */
export const RUNTIMES = [
	{ cmd: "node", engine: "V8", args: (f, v) => [f, v] },
	{ cmd: "deno", engine: "V8", args: (f, v) => ["run", "--allow-read", "--allow-env", f, v] },
	{ cmd: "bun", engine: "JSC", args: (f, v) => [f, v] }
];

/** Run `--variant=<name>` of `fileUrl` under `runtime`, in a fresh process.
 * Returns null when the runtime is absent, a skip, which the caller must
 * report as a skip and never as a pass. */
export function runVariantOn(runtime, fileUrl, name) {
	const file = fileURLToPath(fileUrl);
	if (spawnSync(runtime.cmd, ["--version"], { stdio: "ignore" }).error) return null;
	const run = spawnSync(runtime.cmd, runtime.args(file, `--variant=${name}`), {
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "" }
	});
	const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("__RESULT__"));
	if (!line) {
		console.error(`  ! ${runtime.cmd} ${name} failed (exit ${run.status})`);
		if (run.stderr) console.error(run.stderr.trim().split("\n").slice(0, 6).join("\n"));
		return null;
	}
	return JSON.parse(line.slice("__RESULT__".length));
}
