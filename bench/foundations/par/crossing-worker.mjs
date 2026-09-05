/**
 * The worker half of the crossing probe. The body is as small as it can be, so
 * what the host times is the crossing and not the work.
 *
 * Two modes, and they cannot share one worker. `Atomics.wait` parks the whole
 * thread, so a worker inside the barrier loop never runs its message callback.
 * A host that wants both pays for two workers.
 *
 *   mode "echo"     post the same message straight back
 *   mode "barrier"  sleep on the epoch word, wake, report done
 */
import { parentPort, workerData } from "node:worker_threads";
import { workerLoop, slotBase } from "./pool.mjs";

const ctl = new Int32Array(workerData.control);
const base = slotBase(workerData.index);

parentPort.postMessage({ ready: workerData.index });

if (workerData.mode === "echo") {
	parentPort.on("message", (m) => {
		if (m === "stop") process.exit(0);
		parentPort.postMessage(m);
	});
} else {
	workerLoop(ctl, (job) => {
		// Job 1 touches one shared word, the smallest real body a woken worker
		// can have. Job 0 returns at once.
		if (job === 1) Atomics.add(ctl, base, 1);
	});
}
