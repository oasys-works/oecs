/**
 * A persistent worker pool with an `Atomics` barrier.
 *
 * The pool exists because worker startup is a fixed cost that must not land in
 * a per-frame sample. The workers start once, then sleep on one control word.
 * A frame writes its job, bumps the epoch and wakes them. Each worker adds one
 * to a done counter when it finishes, and the host waits for the count to reach
 * the worker count.
 *
 * The control array holds:
 *   [0] EPOCH   the frame number, and the word every worker sleeps on
 *   [1] DONE    how many workers finished this epoch
 *   [2] JOB     which kernel to run
 *   [3..]       per-worker job words, `SLOTS` for each worker
 *
 * `Atomics.wait` blocks a node, bun and deno main thread. A browser main thread
 * refuses it. A browser host has to poll instead, and this pool does not cover
 * that case.
 */
import { Worker } from "node:worker_threads";

export const EPOCH = 0;
export const DONE = 1;
export const JOB = 2;
export const HEAD = 8;
/** Words each worker owns: begin row, end row, archetype index, spare. */
export const SLOTS = 8;

export function controlBuffer(workerCount) {
	return new SharedArrayBuffer((HEAD + workerCount * SLOTS) * 4);
}

export function slotBase(workerIndex) {
	return HEAD + workerIndex * SLOTS;
}

/**
 * Start `workerCount` workers on `workerUrl` and wait for each to report ready.
 * `workerUrl` must be absolute, a caller builds it with `new URL(..., import.meta.url)`
 * from its own file. Every worker gets `{ control, index, workerCount, ...payload }`
 * as its `workerData`. Returns a handle with `run` and `stop`.
 */
export async function startPool(workerUrl, workerCount, payload) {
	const control = controlBuffer(workerCount);
	const ctl = new Int32Array(control);
	const workers = [];
	const ready = [];
	for (let i = 0; i < workerCount; i++) {
		const w = new Worker(workerUrl, {
			workerData: { control, index: i, workerCount, ...payload }
		});
		workers.push(w);
		ready.push(new Promise((resolve, reject) => {
			w.once("message", resolve);
			w.once("error", reject);
		}));
	}
	const readyPayloads = await Promise.all(ready);

	let epoch = 0;

	/** Release every worker for one job, then block until all report done.
	 * `waitDone` picks how the host waits: "wait" parks on `Atomics.wait`,
	 * "spin" burns the core, "hybrid" spins a little then parks. */
	function run(job, waitDone = "hybrid") {
		Atomics.store(ctl, DONE, 0);
		Atomics.store(ctl, JOB, job);
		epoch += 1;
		Atomics.store(ctl, EPOCH, epoch);
		Atomics.notify(ctl, EPOCH);
		if (waitDone === "spin") {
			while (Atomics.load(ctl, DONE) !== workerCount) {}
			return epoch;
		}
		if (waitDone === "hybrid") {
			for (let i = 0; i < 2000; i++) {
				if (Atomics.load(ctl, DONE) === workerCount) return epoch;
			}
		}
		while (true) {
			const seen = Atomics.load(ctl, DONE);
			if (seen === workerCount) return epoch;
			Atomics.wait(ctl, DONE, seen);
		}
	}

	async function stop() {
		Atomics.store(ctl, DONE, 0);
		Atomics.store(ctl, JOB, -1);
		epoch += 1;
		Atomics.store(ctl, EPOCH, epoch);
		Atomics.notify(ctl, EPOCH);
		await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
	}

	return { control, ctl, workers, workerCount, run, stop, ready: readyPayloads };
}

/**
 * The worker half of the barrier. Sleeps on the epoch word, runs `body(job)`,
 * then reports done. `body` returning `false` ends the loop, which the stop job
 * also does.
 */
export function workerLoop(ctl, body) {
	let seen = 0;
	while (true) {
		while (Atomics.load(ctl, EPOCH) === seen) {
			Atomics.wait(ctl, EPOCH, seen);
		}
		seen = Atomics.load(ctl, EPOCH);
		const job = Atomics.load(ctl, JOB);
		if (job < 0) return;
		body(job);
		Atomics.add(ctl, DONE, 1);
		Atomics.notify(ctl, DONE);
	}
}
