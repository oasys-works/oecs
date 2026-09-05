/**
 * One worker of the split pool. It holds the store buffer, binds its columns
 * once, and runs its own row range of one kernel on every barrier release.
 *
 * It rebinds only when `view_stamp` moves. A frame that does not grow the store
 * pays one descriptor read for each archetype's row count and nothing else.
 */
import { parentPort, workerData } from "node:worker_threads";
import { workerLoop } from "./pool.mjs";
import { bindColumnsLean, readHeader, liveRowCount } from "./view.mjs";
import { runKernel, partition } from "./kernels.mjs";

const buffer = workerData.buffer;
const ctl = new Int32Array(workerData.control);
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
	for (let i = 0; i < bound.length; i++) {
		rowCounts[i] = liveRowCount(buffer, bound[i].descriptorOff);
	}
}

parentPort.postMessage({ ready: index });

workerLoop(ctl, (job) => {
	refresh();
	const parts = partition(rowCounts, index, count);
	for (let p = 0; p < parts.length; p++) {
		const seg = parts[p];
		runKernel(job, bound[seg.boundIndex].views, seg.begin, seg.end, dt);
	}
});
