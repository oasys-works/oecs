/**
 * P24 crossing, what it costs to reach a worker and come back.
 *
 * A parallel schedule pays this cost twice for every system it splits: once to
 * release the workers, once to learn they finished. Below the crossing cost the
 * split loses whatever the kernel saves. This probe measures the crossing on
 * its own, with an empty worker body, so the number is a floor for every later
 * probe.
 *
 * It also measures the atomic read and the atomic write against their plain
 * forms, because a shared change tick and a barrier counter would use them on
 * paths the sequential engine walks with a plain field.
 *
 * The probe prints raw tables and no verdict. Every number is one machine and
 * one build.
 *
 * Run: `node bench/foundations/p24-par-crossing.mjs`. Also runs under
 * `deno run -A` and under `bun`.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { median, iqr, table, time, emit, variantArg } from "./harness.mjs";
import { startPool } from "./par/pool.mjs";

const WORKER = new URL("./par/crossing-worker.mjs", import.meta.url);

async function timeAsync(fn, { warmup = 20, samples = 21, inner = 200 } = {}) {
	for (let i = 0; i < warmup; i++) await fn();
	const times = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		for (let i = 0; i < inner; i++) await fn();
		times.push(((performance.now() - t0) * 1e6) / inner);
	}
	return { median: median(times), ...iqr(times) };
}

function timeSync(fn, { warmup = 20, samples = 21, inner = 200 } = {}) {
	for (let i = 0; i < warmup; i++) fn();
	const times = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		for (let i = 0; i < inner; i++) fn();
		times.push(((performance.now() - t0) * 1e6) / inner);
	}
	return { median: median(times), ...iqr(times) };
}

/** Worker startup, measured once for each count. Start to first message. */
async function startupCost(counts) {
	const rows = [];
	for (const k of counts) {
		const control = new SharedArrayBuffer(256);
		const t0 = performance.now();
		const ws = [];
		const ready = [];
		for (let i = 0; i < k; i++) {
			const w = new Worker(WORKER, {
				workerData: { control, index: i, workerCount: k, mode: "echo" }
			});
			ws.push(w);
			ready.push(new Promise((r) => w.once("message", r)));
		}
		await Promise.all(ready);
		const ms = performance.now() - t0;
		for (const w of ws) w.postMessage("stop");
		await Promise.all(ws.map((w) => new Promise((r) => w.once("exit", r))));
		rows.push({ workers: k, ms: ms.toFixed(2) });
	}
	return rows;
}

async function crossingRows() {
	const rows = [];

	// (a) postMessage, main to worker to main.
	{
		const control = new SharedArrayBuffer(256);
		const w = new Worker(WORKER, {
			workerData: { control, index: 0, workerCount: 1, mode: "echo" }
		});
		await new Promise((r) => w.once("message", r));
		let inbox = null;
		w.on("message", (m) => {
			if (inbox) {
				const f = inbox;
				inbox = null;
				f(m);
			}
		});
		const round = () =>
			new Promise((resolve) => {
				inbox = resolve;
				w.postMessage(1);
			});
		rows.push({
			path: "postMessage round trip (number)",
			...(await timeAsync(round, { inner: 50 }))
		});

		const payload = new Float64Array(64);
		const roundBig = () =>
			new Promise((resolve) => {
				inbox = resolve;
				w.postMessage(payload);
			});
		rows.push({
			path: "postMessage round trip (512 B copy)",
			...(await timeAsync(roundBig, { inner: 50 }))
		});
		w.postMessage("stop");
		await new Promise((r) => w.once("exit", r));
	}

	// (b) and (c). One worker parked on `Atomics.wait`, three host wait styles.
	for (const wait of ["wait", "hybrid", "spin"]) {
		const pool = await startPool(WORKER, 1, { mode: "barrier" });
		rows.push({
			path: `Atomics wake round trip, host waits by ${wait} (empty body)`,
			...timeSync(() => pool.run(0, wait), { inner: 200 })
		});
		rows.push({
			path: `Atomics wake round trip, host waits by ${wait} (one atomic add)`,
			...timeSync(() => pool.run(1, wait), { inner: 200 })
		});
		await pool.stop();
	}

	// The barrier with more workers. A schedule releases every worker at once,
	// so the cost that matters is the whole release plus the whole join.
	const cores = availableParallelism();
	for (const k of [2, 4, 8].filter((k) => k <= cores)) {
		const pool = await startPool(WORKER, k, { mode: "barrier" });
		for (const wait of ["wait", "hybrid"]) {
			rows.push({
				path: `Atomics barrier, ${k} workers, host waits by ${wait}`,
				...timeSync(() => pool.run(0, wait), { inner: 200 })
			});
		}
		await pool.stop();
	}
	return rows;
}

/** The atomic against the plain form, on one uncontended word. The change tick
 * is one plain increment per system today. A shared tick would be an atomic. */
function atomicRows() {
	const shared = new Int32Array(new SharedArrayBuffer(64));
	const heap = new Int32Array(16);
	const plain = { tick: 0 };
	const N = 1000;
	const rows = [];
	rows.push({
		op: "plain field ++ (object)",
		...time(
			() => {
				for (let i = 0; i < N; i++) plain.tick++;
				return plain.tick;
			},
			{ samples: 25 }
		)
	});
	rows.push({
		op: "plain store, heap Int32Array",
		...time(
			() => {
				for (let i = 0; i < N; i++) heap[0]++;
				return heap[0];
			},
			{ samples: 25 }
		)
	});
	rows.push({
		op: "plain store, shared Int32Array",
		...time(
			() => {
				for (let i = 0; i < N; i++) shared[0]++;
				return shared[0];
			},
			{ samples: 25 }
		)
	});
	rows.push({
		op: "Atomics.add, shared Int32Array",
		...time(
			() => {
				for (let i = 0; i < N; i++) Atomics.add(shared, 1, 1);
				return Atomics.load(shared, 1);
			},
			{ samples: 25 }
		)
	});
	let sink = 0;
	rows.push({
		op: "plain read, shared Int32Array",
		...time(
			() => {
				for (let i = 0; i < N; i++) sink += shared[2];
				return sink;
			},
			{ samples: 25 }
		)
	});
	rows.push({
		op: "Atomics.load, shared Int32Array",
		...time(
			() => {
				for (let i = 0; i < N; i++) sink += Atomics.load(shared, 2);
				return sink;
			},
			{ samples: 25 }
		)
	});
	return rows.map((r) => ({
		op: r.op,
		ns: ((r.median * 1e6) / N).toFixed(2),
		p25: ((r.p25 * 1e6) / N).toFixed(2),
		p75: ((r.p75 * 1e6) / N).toFixed(2)
	}));
}

const ns = (x) => x.toFixed(0);

async function main() {
	const variant = variantArg();
	const cores = availableParallelism();
	const crossing = await crossingRows();
	const atomics = atomicRows();
	const startup = await startupCost([1, 2, 4, 8].filter((k) => k <= cores));

	if (variant === "json") {
		emit({ cores, crossing, atomics, startup });
		return;
	}

	console.log(`\nP24 crossing. availableParallelism() = ${cores}\n`);
	console.log("Round trip to a worker and back, nanoseconds for one crossing pair.\n");
	table(crossing, [
		{ label: "path", get: (r) => r.path },
		{ label: "median ns", get: (r) => ns(r.median) },
		{ label: "p25", get: (r) => ns(r.p25) },
		{ label: "p75", get: (r) => ns(r.p75) },
		{ label: "min", get: (r) => ns(r.min) },
		{ label: "max", get: (r) => ns(r.max) }
	]);

	console.log("\nOne word, atomic against plain. Nanoseconds for one operation.\n");
	table(atomics, [
		{ label: "op", get: (r) => r.op },
		{ label: "median ns", get: (r) => r.ns },
		{ label: "p25", get: (r) => r.p25 },
		{ label: "p75", get: (r) => r.p75 }
	]);

	console.log("\nWorker startup, construction to the first message. Once, not per frame.\n");
	table(startup, [
		{ label: "workers", get: (r) => r.workers },
		{ label: "ms", get: (r) => r.ms }
	]);
	console.log("");
}

await main();
