/**
 * The worker half of the join probe. One file for all four join variants,
 * because only `workerJoin` differs and the release side is shared.
 *
 * Three bodies, and the host picks one with the job word.
 *
 *   job 0        return at once, so what the host times is the join alone
 *   job 1        a light kernel, a fixed accumulate over one cache-warm slice
 *   job 2 and up one pass of `pos += vel * dt` over this worker's row range of
 *                the world at index `job - 2`
 *
 * The row range is the same integer arithmetic the engine's worker uses, so the
 * pass timings here answer the same question the engine probe asks.
 */
import { parentPort, workerData } from "node:worker_threads";
import { workerLoop, scratch } from "./join.mjs";

const { control, worlds, index, workerCount, variant, lightElements, dt } = workerData;

const ctl = new Int32Array(control);
const scratchAt = scratch(workerCount, index);
const views = worlds.map((w) => ({
	rows: w.rows,
	px: new Float32Array(w.buffer, 0 * w.rows * 4, w.rows),
	py: new Float32Array(w.buffer, 1 * w.rows * 4, w.rows),
	pz: new Float32Array(w.buffer, 2 * w.rows * 4, w.rows),
	vx: new Float32Array(w.buffer, 3 * w.rows * 4, w.rows),
	vy: new Float32Array(w.buffer, 4 * w.rows * 4, w.rows),
	vz: new Float32Array(w.buffer, 5 * w.rows * 4, w.rows)
}));

function light() {
	const w = views[0];
	const begin = index * lightElements;
	let sum = 0;
	for (let i = begin; i < begin + lightElements; i++) sum += w.px[i];
	// The write keeps the loop alive and lands on this worker's own line.
	ctl[scratchAt] = sum | 0;
}

function pass(world) {
	const w = views[world];
	const rows = w.rows;
	const begin = Math.floor((rows * index) / workerCount);
	const end = Math.floor((rows * (index + 1)) / workerCount);
	const { px, py, pz, vx, vy, vz } = w;
	for (let i = begin; i < end; i++) {
		px[i] += vx[i] * dt;
		py[i] += vy[i] * dt;
		pz[i] += vz[i] * dt;
	}
}

// The host waits for this before it releases anything, so worker startup never
// lands inside a timed pass.
parentPort.postMessage({ ready: index });

workerLoop(variant, ctl, index, workerCount, (job) => {
	if (job === 0) return;
	if (job === 1) {
		light();
		return;
	}
	pass(job - 2);
});
