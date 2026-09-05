/**
 * A worker that holds the store buffer and nothing else.
 *
 * It never imports the package. Everything it knows about the world comes from
 * the bytes: the header, the layout descriptor and the columns. This is the
 * whole claim the bytes-view probe tests.
 */
import { parentPort, workerData } from "node:worker_threads";
import { walkArchetypes, bindColumns, foldColumnBytes } from "./view.mjs";

const buffer = workerData.buffer;

parentPort.postMessage({ ready: true });

parentPort.on("message", (msg) => {
	if (msg.op === "stop") process.exit(0);
	if (msg.op === "walk") {
		const w = walkArchetypes(buffer);
		parentPort.postMessage({
			header: w.header,
			archetypes: w.archetypes.map((a) => ({
				archetypeId: a.archetypeId,
				rowCount: a.rowCount,
				rowCapacity: a.rowCapacity,
				enabledCount: a.enabledCount,
				columns: a.columns
			}))
		});
		return;
	}
	if (msg.op === "read") {
		const { bound } = bindColumns(buffer, msg.specs);
		const per = bound.map((b) => {
			// Sum each bound field over the live rows. A sum is enough to catch a
			// wrong offset, a wrong stride or a wrong row count, and it travels
			// back as one number for each field.
			const sums = b.views.map((v) => {
				let s = 0;
				for (let i = 0; i < b.rowCount; i++) s += v[i];
				return s;
			});
			const first = b.views.map((v) => (b.rowCount > 0 ? v[0] : 0));
			const last = b.views.map((v) => (b.rowCount > 0 ? v[b.rowCount - 1] : 0));
			return { archetypeId: b.archetypeId, rowCount: b.rowCount, sums, first, last };
		});
		parentPort.postMessage({ per, fold: foldColumnBytes(bound) });
		return;
	}
	parentPort.postMessage({ error: `unknown op ${msg.op}` });
});
