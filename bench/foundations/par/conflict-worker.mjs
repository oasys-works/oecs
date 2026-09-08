/**
 * The worker half of the negative control. Every job here is a conflict the
 * access declarations are meant to forbid, written on purpose.
 *
 *   job 0  every worker writes every row. Two writers, one column.
 *   job 1  every worker folds its rows into one shared cell, without an atomic.
 *   job 2  every worker folds its rows into its own cell, and records the order
 *          it finished in.
 *   job 3  the same, with each worker's partial scaled to a different
 *          magnitude, so the host's fold order can change the answer.
 *
 * Job 2 is the honest control: no two workers touch the same word, so the
 * column state is deterministic. Only the host's later fold over the partials
 * can go wrong, and only if the host folds in completion order.
 */
import { parentPort, workerData } from "node:worker_threads";
import { workerLoop } from "./pool.mjs";
import { bindColumnsLean, readHeader, liveRowCount } from "./view.mjs";
import { partition } from "./kernels.mjs";

const buffer = workerData.buffer;
const ctl = new Int32Array(workerData.control);
const acc = new Float64Array(workerData.scratch);
const order = new Int32Array(workerData.order);
const specs = workerData.specs;
const dt = workerData.dt;
const index = workerData.index;
const count = workerData.workerCount;

let stamp = -1;
let bound = null;
let rowCounts = null;

function refresh() {
	const h = readHeader(buffer);
	if (h.viewStamp !== stamp) {
		stamp = h.viewStamp;
		bound = bindColumnsLean(buffer, specs);
		rowCounts = new Array(bound.length);
	}
	for (let i = 0; i < bound.length; i++)
		rowCounts[i] = liveRowCount(buffer, bound[i].descriptorOff);
}

parentPort.postMessage({ ready: index });

workerLoop(ctl, (job) => {
	refresh();
	if (job === 0) {
		// Every worker over every row. The read, the add and the store are three
		// steps, so one worker's store lands on a value the other already read.
		for (let b = 0; b < bound.length; b++) {
			const px = bound[b].views[0];
			const vx = bound[b].views[3];
			const n = rowCounts[b];
			for (let i = 0; i < n; i++) px[i] += vx[i] * dt;
		}
		return;
	}
	const parts = partition(rowCounts, index, count);
	if (job === 1) {
		// One shared cell, no atomic. A lost update for every interleaving.
		for (let p = 0; p < parts.length; p++) {
			const seg = parts[p];
			const px = bound[seg.boundIndex].views[0];
			for (let i = seg.begin; i < seg.end; i++) acc[0] += px[i];
		}
		return;
	}
	// job 2 and job 3: a private cell for each worker, and the completion order.
	// Job 3 scales each worker's partial by a different power of ten, so the
	// partials span magnitudes a float sum cannot reassociate through. Job 2
	// leaves the values as the world holds them.
	const scale = job === 3 ? Math.pow(1e7, index - (count - 1) / 2) : 1;
	let s = 0;
	for (let p = 0; p < parts.length; p++) {
		const seg = parts[p];
		const px = bound[seg.boundIndex].views[0];
		for (let i = seg.begin; i < seg.end; i++) s += px[i] * scale;
	}
	acc[1 + index] = s;
	const slot = Atomics.add(order, 0, 1);
	Atomics.store(order, 1 + slot, index);
});
