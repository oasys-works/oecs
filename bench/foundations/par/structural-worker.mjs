/**
 * A worker that caches its column views and refuses to rebind unless told to.
 *
 * The point of the probe is what a worker sees when the host moves the ground
 * under it. A worker that rebinds on every access would see nothing, so this
 * one binds once and reports from the cache. `rebind` is the control.
 */
import { parentPort, workerData } from "node:worker_threads";
import { bindColumnsLean, readHeader, liveRowCount } from "./view.mjs";

const buffer = workerData.buffer;
const specs = workerData.specs;
// The host watches this word to learn how far the pass has run. Without it the
// host's structural change finishes before the worker even wakes, and the probe
// measures nothing.
const progress = workerData.progress ? new Int32Array(workerData.progress) : null;

let bound = null;
let cachedRows = null;

function bind() {
	bound = bindColumnsLean(buffer, specs);
	cachedRows = bound.map((b) => liveRowCount(buffer, b.descriptorOff));
}

/** What the worker believes, read only through the views it already holds. */
function report(label) {
	const h = readHeader(buffer);
	const per = bound.map((b, i) => {
		const px = b.views[0];
		const pz = b.views[2];
		let sum = 0;
		const rows = cachedRows[i];
		for (let r = 0; r < rows; r++) sum += px[r];
		// `Pos.z` carries a row identity, so a duplicated or a vanished row is
		// visible as a repeated or a missing number and not only as a bad sum.
		const ids = [];
		for (let r = 0; r < rows; r++) ids.push(pz[r]);
		return {
			archetypeId: b.archetypeId,
			byteOff: px.byteOffset,
			cachedRows: rows,
			liveRows: liveRowCount(buffer, b.descriptorOff),
			sum,
			firstX: rows > 0 ? px[0] : null,
			distinctIds: new Set(ids).size,
			maxId: rows > 0 ? Math.max(...ids) : null
		};
	});
	return {
		label,
		viewStamp: h.viewStamp,
		capacity: h.capacity,
		bufferBytes: buffer.byteLength,
		archetypeCount: h.archetypeCount,
		per
	};
}

parentPort.postMessage({ ready: true });

parentPort.on("message", (msg) => {
	if (msg.op === "stop") process.exit(0);
	if (msg.op === "bind") {
		bind();
		parentPort.postMessage(report("after bind"));
		return;
	}
	if (msg.op === "report") {
		parentPort.postMessage(report(msg.label ?? "report"));
		return;
	}
	if (msg.op === "rebind") {
		bind();
		parentPort.postMessage(report(msg.label ?? "after rebind"));
		return;
	}
	if (msg.op === "spin") {
		// A long pass over the cached rows, so the host has time to make a
		// structural change while this runs. Each visited row adds its own
		// identity, not a constant. A swap remove copies a whole row, so a
		// constant add would survive the copy and hide the defect.
		const passes = msg.passes;
		for (let p = 0; p < passes; p++) {
			if (progress !== null) Atomics.store(progress, 0, p + 1);
			for (let b = 0; b < bound.length; b++) {
				const px = bound[b].views[0];
				const pz = bound[b].views[2];
				const rows = cachedRows[b];
				for (let r = 0; r < rows; r++) px[r] += pz[r];
			}
		}
		parentPort.postMessage(report("after spin"));
		return;
	}
	parentPort.postMessage({ error: `unknown op ${msg.op}` });
});
