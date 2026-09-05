/**
 * P24 join, what the last part of the barrier costs and whether it scales.
 *
 * The crossing probe measured the whole barrier and reported that the join
 * grows faster than the worker count. It never took the join apart. This probe
 * does, and it changes one thing at a time: the release side is identical in
 * every variant, and only the way K workers report a finished pass differs.
 *
 *   a  one counter, every worker adds and notifies. What the engine ships.
 *   b  one counter, only the worker whose add returned K-1 notifies.
 *   c  one word for each worker, one cache line apart, host scans the K words.
 *   d  a tree, worker i carries 2i+1 and 2i+2, host waits on one word.
 *
 * Three measurements for each variant and each K.
 *
 *   **Empty body.** Release to the host's return, with no work in the worker.
 *   This is the join and nothing else, and it is the floor a split has to clear.
 *   **Light body.** The same with a short fixed kernel, so the workers finish
 *   close together but not at the same instant.
 *   **A real pass.** `pos += vel * dt` over a shared world, split by row range
 *   with the same integer arithmetic the engine's worker uses. This answers the
 *   only question that decides an engine change: does a cheaper join move a pass
 *   a user would run?
 *
 * The probe also counts host wakes for each pass. A join that scales wakes the
 * host once per pass whatever K is. The shipped join wakes it once per worker.
 *
 * One process for each variant and each K, because a pool of eight workers and
 * a world of a million rows both contaminate a later variant in the same
 * process. The parent spawns node, deno and bun and prints all three.
 *
 * Run: `node bench/foundations/p24-par-join.mjs`. Also runs under `deno run -A`
 * and under `bun`.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { emit, iqr, median, RUNTIMES, runVariantOn, table, variantArg } from "./harness.mjs";
import { controlBuffer, hostJoin, hostRelease, JOB_STOP, VARIANTS, variantLabel } from "./par/join.mjs";

const WORKER = new URL("./par/join-worker.mjs", import.meta.url);
const DT = 1 / 60;
const CORES = availableParallelism();
/** The counts the handoff named, plus this machine's parallelism. */
const KS = [...new Set([2, 4, 8, CORES].filter((k) => k >= 2 && k <= CORES))].sort((a, b) => a - b);
const SIZES = [10_000, 100_000, 1_000_000];
/** Elements one worker touches in the light body. Small enough to stay warm. */
const LIGHT_ELEMENTS = 256;

/** Six columns of one world, laid out one after another in shared bytes. The
 * layout only has to be the same for every variant, so a plain split is enough. */
function makeWorld(rows) {
	const buffer = new SharedArrayBuffer(rows * 6 * 4);
	const px = new Float32Array(buffer, 0 * rows * 4, rows);
	const vx = new Float32Array(buffer, 3 * rows * 4, rows);
	const vy = new Float32Array(buffer, 4 * rows * 4, rows);
	const vz = new Float32Array(buffer, 5 * rows * 4, rows);
	for (let i = 0; i < rows; i++) {
		px[i] = i % 1000;
		vx[i] = (i % 13) - 6;
		vy[i] = (i % 17) - 8;
		vz[i] = (i % 7) - 3;
	}
	return { rows, buffer };
}

async function startPool(variant, workerCount, worlds) {
	const control = controlBuffer(workerCount);
	const ctl = new Int32Array(control);
	const workers = [];
	const ready = [];
	for (let i = 0; i < workerCount; i++) {
		const w = new Worker(WORKER, {
			workerData: {
				control,
				worlds,
				index: i,
				workerCount,
				variant,
				lightElements: LIGHT_ELEMENTS,
				dt: DT
			}
		});
		workers.push(w);
		ready.push(
			new Promise((resolve, reject) => {
				w.once("message", resolve);
				w.once("error", reject);
			})
		);
	}
	await Promise.all(ready);

	let epoch = 0;
	let wakes = 0;
	let passes = 0;

	function run(job) {
		epoch += 1;
		hostRelease(variant, ctl, epoch, job);
		wakes += hostJoin(variant, ctl, workerCount, epoch);
		passes += 1;
	}

	/** One pass, with the clock read between the release and the join. The
	 * release side is the same in every variant, so this says whether a variant
	 * can move the pass at all. One clock read for each part costs more than the
	 * amortised loop, so read this as a split and not as a total. */
	function runSplit(job) {
		epoch += 1;
		const t0 = performance.now();
		hostRelease(variant, ctl, epoch, job);
		const t1 = performance.now();
		hostJoin(variant, ctl, workerCount, epoch);
		const t2 = performance.now();
		return { release: (t1 - t0) * 1e6, join: (t2 - t1) * 1e6 };
	}

	async function stop() {
		epoch += 1;
		hostRelease(variant, ctl, epoch, JOB_STOP);
		await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
	}

	return {
		run,
		runSplit,
		stop,
		takeWakes() {
			const out = passes === 0 ? 0 : wakes / passes;
			wakes = 0;
			passes = 0;
			return out;
		}
	};
}

/** Nanoseconds for one release and one join. The inner loop amortises the
 * clock, and the median of many samples keeps one descheduled pass out of the
 * answer. */
function timeJoin(run, job, { warmup = 200, samples = 21, inner = 200 } = {}) {
	for (let i = 0; i < warmup; i++) run(job);
	const times = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		for (let i = 0; i < inner; i++) run(job);
		times.push(((performance.now() - t0) * 1e6) / inner);
	}
	return { median: median(times), ...iqr(times) };
}

/** The release side against the join side, nanoseconds, empty body. The two
 * add up to more than `timeJoin` reports, because each pass here pays two clock
 * reads that the amortised loop does not. */
function timeSplit(runSplit, { warmup = 200, samples = 400 } = {}) {
	for (let i = 0; i < warmup; i++) runSplit(0);
	const release = [];
	const join = [];
	for (let s = 0; s < samples; s++) {
		const one = runSplit(0);
		release.push(one.release);
		join.push(one.join);
	}
	return { release: median(release), join: median(join) };
}

/** Milliseconds for one whole pass over a world, the shape the engine probe
 * times. A big world needs fewer passes for each sample. */
function timePass(run, job, rows) {
	const inner = rows >= 1_000_000 ? 5 : rows >= 100_000 ? 20 : 100;
	for (let i = 0; i < 3 * inner; i++) run(job);
	const times = [];
	for (let s = 0; s < 15; s++) {
		const t0 = performance.now();
		for (let i = 0; i < inner; i++) run(job);
		times.push((performance.now() - t0) / inner);
	}
	return { median: median(times), ...iqr(times) };
}

async function measure(variant, workerCount) {
	const worlds = SIZES.map((n) => makeWorld(n));
	const pool = await startPool(
		variant,
		workerCount,
		worlds.map((w) => ({ rows: w.rows, buffer: w.buffer }))
	);

	const empty = timeJoin(pool.run, 0);
	const emptyWakes = pool.takeWakes();
	const lightBody = timeJoin(pool.run, 1);
	const lightWakes = pool.takeWakes();
	const split = timeSplit(pool.runSplit);
	pool.takeWakes();

	const passes = [];
	for (let i = 0; i < SIZES.length; i++) {
		const t = timePass(pool.run, 2 + i, SIZES[i]);
		passes.push({ entities: SIZES[i], ...t, wakes: pool.takeWakes() });
	}

	await pool.stop();
	return {
		variant,
		workerCount,
		empty: { ...empty, wakes: emptyWakes },
		light: { ...lightBody, wakes: lightWakes },
		split,
		passes
	};
}

const ns = (x) => x.toFixed(0);
const ms = (x) => x.toFixed(4);

function present(results) {
	const runtimes = Object.keys(results);
	const rows = [];
	for (const k of KS) {
		for (const v of VARIANTS) {
			const row = { k, variant: v };
			for (const rt of runtimes) {
				const r = results[rt]?.[`${v}:${k}`];
				row[`${rt}.empty`] = r ? ns(r.empty.median) : "skip";
				row[`${rt}.light`] = r ? ns(r.light.median) : "skip";
				row[`${rt}.wakes`] = r ? r.empty.wakes.toFixed(2) : "skip";
				row[`${rt}.release`] = r ? ns(r.split.release) : "skip";
				row[`${rt}.joinOnly`] = r ? ns(r.split.join) : "skip";
			}
			rows.push(row);
		}
	}

	console.log("\nRelease to the host's return, nanoseconds for one pass, empty body.\n");
	table(rows, [
		{ label: "K", get: (r) => r.k },
		{ label: "join", get: (r) => r.variant },
		...runtimes.map((rt) => ({ label: rt, get: (r) => r[`${rt}.empty`] }))
	]);

	console.log("\nThe same with a light body, nanoseconds for one pass.\n");
	table(rows, [
		{ label: "K", get: (r) => r.k },
		{ label: "join", get: (r) => r.variant },
		...runtimes.map((rt) => ({ label: rt, get: (r) => r[`${rt}.light`] }))
	]);

	console.log("\nHost wakes for one pass, empty body. One is the floor.\n");
	table(rows, [
		{ label: "K", get: (r) => r.k },
		{ label: "join", get: (r) => r.variant },
		...runtimes.map((rt) => ({ label: rt, get: (r) => r[`${rt}.wakes`] }))
	]);

	console.log("\nThe pass split in two, nanoseconds, empty body. Release, then join.\n");
	table(rows, [
		{ label: "K", get: (r) => r.k },
		{ label: "join", get: (r) => r.variant },
		...runtimes.flatMap((rt) => [
			{ label: `${rt} release`, get: (r) => r[`${rt}.release`] },
			{ label: `${rt} join`, get: (r) => r[`${rt}.joinOnly`] }
		])
	]);

	for (const n of SIZES) {
		console.log(`\nOne whole pass of pos += vel * dt over ${n.toLocaleString()} rows, milliseconds.\n`);
		const passRows = [];
		for (const k of KS) {
			for (const v of VARIANTS) {
				const row = { k, variant: v };
				for (const rt of runtimes) {
					const r = results[rt]?.[`${v}:${k}`];
					const p = r?.passes.find((x) => x.entities === n);
					row[rt] = p ? ms(p.median) : "skip";
				}
				passRows.push(row);
			}
		}
		table(passRows, [
			{ label: "K", get: (r) => r.k },
			{ label: "join", get: (r) => r.variant },
			...runtimes.map((rt) => ({ label: rt, get: (r) => r[rt] }))
		]);
	}

	console.log("\nSpread of the empty-body join, this runtime only.\n");
	const first = runtimes[0];
	const spread = [];
	for (const k of KS) {
		for (const v of VARIANTS) {
			const r = results[first]?.[`${v}:${k}`];
			if (!r) continue;
			spread.push({
				k,
				variant: v,
				median: ns(r.empty.median),
				p25: ns(r.empty.p25),
				p75: ns(r.empty.p75),
				min: ns(r.empty.min),
				max: ns(r.empty.max)
			});
		}
	}
	table(spread, [
		{ label: "K", get: (r) => r.k },
		{ label: "join", get: (r) => r.variant },
		{ label: `${first} median ns`, get: (r) => r.median },
		{ label: "p25", get: (r) => r.p25 },
		{ label: "p75", get: (r) => r.p75 },
		{ label: "min", get: (r) => r.min },
		{ label: "max", get: (r) => r.max }
	]);
}

async function main() {
	const variant = variantArg();
	if (variant !== null) {
		const [name, k] = variant.split(":");
		emit(await measure(name, Number(k)));
		return;
	}

	console.log(`\nP24 join. availableParallelism() = ${CORES}, K in ${KS.join(", ")}\n`);
	for (const v of VARIANTS) console.log(`  ${variantLabel(v)}`);

	const results = {};
	for (const rt of RUNTIMES) {
		const got = {};
		let any = false;
		for (const k of KS) {
			for (const v of VARIANTS) {
				const r = runVariantOn(rt, import.meta.url, `${v}:${k}`);
				if (r === null) continue;
				got[`${v}:${k}`] = r;
				any = true;
			}
		}
		if (any) results[rt.cmd] = got;
		else console.log(`\n  ! ${rt.cmd} produced nothing, reported as a skip and never as a pass`);
	}

	present(results);
	console.log("");
}

await main();
