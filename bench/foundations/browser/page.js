/**
 * The page half of the browser matrix. Two cases run here, and the rest run in
 * `host.js`.
 *
 *   `main-refuses`   the main thread calls `workers.attach` and must be refused,
 *                    because it cannot park on `Atomics.wait`
 *   `store-reader`   `store_reader.wasm`, the fixture the vitest suite drives,
 *                    against a live wasm-backed world in the browser
 *
 * The page then starts `host.js` as a module worker and collects what it
 * reports. Every result lands on `window.__oecsResults`, and `__oecsDone` turns
 * true when the worker says it is finished. The driver reads both.
 *
 * A page that throws before the worker starts still reports, because a driver
 * that sees no result cannot tell a crash from a slow run.
 */

import { ECS } from "../../../dist/index.js";
import { workers } from "../../../dist/plugins/workers.js";
import {
	collectColumnValues,
	fnv1aBytes,
	foldLayout,
	maskHas,
	readDescriptors,
	readStoreHeader,
	seedColumns,
	stepF32,
	stepI32
} from "./walk.js";

const READER_URL = new URL(
	"../../../src/core/ecs/__tests__/fixtures/store_reader.wasm",
	import.meta.url
).href;

/** The module declares this maximum, so every world here declares it too. An
 * instantiation against a memory with a different maximum fails. */
const MAXIMUM_PAGES = 512;
/** Small enough that a few hundred spawns force the store to grow a column. */
const COLUMN_CAPACITY = 16;
const ROWS = 40;
/** How long the page waits for the worker before it calls the run a hang. */
const WORKER_TIMEOUT_MS = 120_000;

const results = [];
window.__oecsResults = results;
window.__oecsDone = false;

const out = document.getElementById("out");

function record(result) {
	results.push(result);
	const line = `${result.ok ? "pass" : "FAIL"}  ${result.id}  ${JSON.stringify(result.detail)}`;
	out.textContent += `${line}\n`;
	console.log(line);
}

/** The main thread must refuse to host a pool. A resolve here is the failure,
 * so the race reports a run that answered nothing as its own outcome. */
async function mainRefuses() {
	const ecs = ECS.create({ memory: { backing: "shared" }, plugins: [workers()] });
	try {
		await ecs.workers.attach({ count: 1 });
		record({
			id: "main-refuses",
			ok: false,
			detail: { outcome: "workers.attach resolved on the main thread" }
		});
	} catch (error) {
		// `ECSError` carries its code on `category`.
		const category = error?.category;
		record({
			id: "main-refuses",
			ok: category === "WORKERS_HOST_CANNOT_PARK",
			detail: { name: error?.name, category, message: String(error?.message ?? error) }
		});
	}
	ecs.dispose();
}

/**
 * Three archetypes that hold columns: position and velocity, position alone,
 * and position, velocity and a third component. The masks differ, so a reader
 * that ignores the descriptor and walks every column gets a different answer.
 */
function buildReaderWorld(module, kind) {
	const ecs = new ECS({
		deterministic: kind === "i32",
		memory: { columnCapacity: COLUMN_CAPACITY, backing: { wasm: { maximumPages: MAXIMUM_PAGES } } }
	});
	const field = kind === "f32" ? "f32" : "i32";
	const Pos = ecs.registerComponent({ x: field, y: field, z: field });
	const Vel = ecs.registerComponent({ vx: field, vy: field, vz: field });
	const Mass = ecs.registerComponent({ m: "u32" });
	let headerOff = -1;
	ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
	ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2, z: 3 }), Vel({ vx: 1, vy: 2, vz: 3 })), ROWS);
	ecs.spawnMany(ecs.template(Pos({ x: 7, y: 7, z: 7 })), ROWS);
	ecs.spawnMany(
		ecs.template(Pos({ x: 5, y: 6, z: 7 }), Vel({ vx: 2, vy: 3, vz: 4 }), Mass({ m: 11 })),
		ROWS
	);
	ecs.publishRowCounts();
	const memory = ecs.wasmMemory;
	seedColumns(memory.buffer, headerOff, Pos.id, Vel.id, kind);
	const reader = new WebAssembly.Instance(module, { env: { memory } }).exports;
	return { ecs, memory, headerOff, Pos, Vel, reader };
}

async function storeReader() {
	const module = await WebAssembly.compileStreaming(fetch(READER_URL));

	// The layout walk and the byte digest, on a float world.
	const w = buildReaderWorld(module, "f32");
	const view = new DataView(w.memory.buffer);
	const descriptors = readDescriptors(view, w.headerOff);
	const withColumns = descriptors.filter((d) => d.columns.length > 0);
	const shape =
		withColumns.length >= 3 &&
		withColumns.some((d) => maskHas(d.mask, w.Vel.id)) &&
		withColumns.some((d) => !maskHas(d.mask, w.Vel.id));
	const header = readStoreHeader(view, w.headerOff);
	const moduleWalk = w.reader.walk(w.headerOff) >>> 0;
	const pageWalk = foldLayout(view, w.headerOff);
	const moduleDigest = w.reader.fnv1a(w.headerOff, header.capacity) >>> 0;
	const pageDigest = fnv1aBytes(w.memory.buffer, w.headerOff, header.capacity);

	// The f32 step, byte for byte, over two worlds built by the same calls.
	const byTs = buildReaderWorld(module, "f32");
	const byModule = buildReaderWorld(module, "f32");
	const sameStart =
		JSON.stringify(collectColumnValues(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, "f32")) ===
		JSON.stringify(
			collectColumnValues(byModule.memory.buffer, byModule.headerOff, byModule.Pos.id, "f32")
		);
	const pageRows = stepF32(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, byTs.Vel.id, 0.1);
	const moduleRows = byModule.reader.step(
		byModule.headerOff,
		byModule.Pos.id,
		byModule.Vel.id,
		0.1
	);
	const sameAfter =
		JSON.stringify(collectColumnValues(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, "f32")) ===
		JSON.stringify(
			collectColumnValues(byModule.memory.buffer, byModule.headerOff, byModule.Pos.id, "f32")
		);

	// The state hash, on the integer twin. A deterministic world refuses a float
	// column, so the engine's own oracle needs integer fields.
	const intTs = buildReaderWorld(module, "i32");
	const intModule = buildReaderWorld(module, "i32");
	const hashBefore = intTs.ecs.snapshots.stateHash() === intModule.ecs.snapshots.stateHash();
	const pageIntRows = stepI32(
		intTs.memory.buffer,
		intTs.headerOff,
		intTs.Pos.id,
		intTs.Vel.id,
		3
	);
	const moduleIntRows = intModule.reader.step_i32(
		intModule.headerOff,
		intModule.Pos.id,
		intModule.Vel.id,
		3
	);
	const hashAfter = intTs.ecs.snapshots.stateHash() === intModule.ecs.snapshots.stateHash();

	// Two of the three archetypes hold both components, so a kernel that skipped
	// the mask test would report every row instead.
	const expectedRows = ROWS * 2;
	record({
		id: "store-reader",
		ok:
			shape &&
			moduleWalk === pageWalk &&
			moduleDigest === pageDigest &&
			sameStart &&
			sameAfter &&
			moduleRows === pageRows &&
			pageRows === expectedRows &&
			hashBefore &&
			hashAfter &&
			moduleIntRows === pageIntRows &&
			pageIntRows === expectedRows,
		detail: {
			headerOff: w.headerOff,
			archetypesWithColumns: withColumns.length,
			maskShapeCovered: shape,
			moduleWalk,
			pageWalk,
			moduleDigest,
			pageDigest,
			f32ColumnsAgreeBefore: sameStart,
			f32ColumnsAgreeAfter: sameAfter,
			moduleRows,
			pageRows,
			expectedRows,
			stateHashAgreesBefore: hashBefore,
			stateHashAgreesAfter: hashAfter,
			moduleIntRows,
			pageIntRows
		}
	});
	for (const world of [w, byTs, byModule, intTs, intModule]) world.ecs.dispose();
}

function runWorker() {
	return new Promise((resolve) => {
		const worker = new Worker(new URL("./host.js", import.meta.url), { type: "module" });
		const timer = setTimeout(() => {
			record({
				id: "worker-host",
				ok: false,
				detail: { outcome: `the worker reported nothing final within ${WORKER_TIMEOUT_MS} ms` }
			});
			worker.terminate();
			resolve();
		}, WORKER_TIMEOUT_MS);
		worker.addEventListener("message", (event) => {
			if (event.data.id === "worker-done") {
				clearTimeout(timer);
				worker.terminate();
				resolve();
				return;
			}
			record(event.data);
		});
		// A module worker that will not load raises an event here, and the shape of
		// that event differs by browser. The URL is the fact worth reporting.
		worker.addEventListener("error", (event) => {
			clearTimeout(timer);
			record({
				id: "worker-host",
				ok: false,
				detail: {
					outcome: "the host worker raised an error",
					eventType: event?.constructor?.name,
					message: String(event?.message ?? ""),
					filename: String(event?.filename ?? ""),
					lineno: event?.lineno
				}
			});
			resolve();
		});
	});
}

async function main() {
	record({
		id: "page-env",
		ok: window.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined",
		detail: {
			crossOriginIsolated: window.crossOriginIsolated,
			sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
			userAgent: navigator.userAgent
		}
	});
	for (const [id, run] of [
		["main-refuses", mainRefuses],
		["store-reader", storeReader]
	]) {
		try {
			await run();
		} catch (error) {
			record({
				id,
				ok: false,
				detail: {
					outcome: "threw",
					name: error?.name,
					category: error?.category,
					message: String(error?.message ?? error),
					stack: String(error?.stack ?? "")
				}
			});
		}
	}
	await runWorker();
	window.__oecsDone = true;
}

void main().catch((error) => {
	record({
		id: "page-fatal",
		ok: false,
		detail: { message: String(error?.message ?? error), stack: String(error?.stack ?? "") }
	});
	window.__oecsDone = true;
});
