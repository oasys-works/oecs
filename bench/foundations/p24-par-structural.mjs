/**
 * P24 structural, a structural change beside a worker iteration.
 *
 * The tree claims a grow or a swap-remove cannot run beside a worker that
 * iterates cached views. The claim rests on reasoning. This probe turns it into
 * a measurement.
 *
 * Three stages, and the first two are staged rather than raced, so the result
 * repeats:
 *
 *   1. **Grow.** The worker binds views. The host spawns past the column
 *      capacity, which forces a grow. The host then writes a marker into every
 *      live row through its own query. The worker reports from its cached views
 *      and never rebinds. What does it read?
 *   2. **Swap-remove.** The host despawns from the middle. The worker reports
 *      from a cached row count. Which rows does it visit, and which entity does
 *      each row hold?
 *   3. **The race.** The worker runs a long pass that adds one to every row it
 *      visits, and the host despawns while the pass runs. The probe then counts
 *      the rows that got the wrong number of adds. A race that does not fire on
 *      one run is not a race that cannot fire.
 *
 * Two backings, because they answer differently: the growable
 * `SharedArrayBuffer` and the fixed-cap `SharedArrayBuffer`.
 *
 * Run: `node bench/foundations/p24-par-structural.mjs`. Also runs under
 * `deno run -A` and under `bun`.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { table } from "./harness.mjs";
import { regionSpec, storeBuffer, kernelSpecs } from "./par/world.mjs";
import { bindColumnsLean, liveRowCount, readHeader } from "./par/view.mjs";

const WORKER = new URL("./par/structural-worker.mjs", import.meta.url);
const CORES = availableParallelism();

function request(w, msg) {
	return new Promise((resolve, reject) => {
		w.once("message", resolve);
		w.once("error", reject);
		w.postMessage(msg);
	});
}

/** A one-archetype world with a small pinned column capacity, so one spawn
 * burst crosses it. `Pos.z` carries the row identity. */
async function makeWorld({ allocator, columnCapacity, entities }) {
	const { ECS } = await import(new URL("../../dist/index.js", import.meta.url).href);
	const memory = allocator
		? { backing: { allocator }, columnCapacity }
		: { backing: "shared", columnCapacity };
	const ecs = new ECS({ memory, regions: [regionSpec()] });
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" }, { name: "Vel" });
	const Target = ecs.registerComponent({ tx: "f32", ty: "f32", tz: "f32" }, { name: "Target" });
	const T = ecs.template(
		Pos({ x: 0, y: 0, z: 0 }),
		Vel({ vx: 1, vy: 1, vz: 1 }),
		Target({ tx: 0, ty: 0, tz: 0 })
	);
	ecs.startup();
	const ids = [];
	for (let i = 0; i < entities; i++) ids.push(ecs.spawn(T));
	// Identity in `Pos.z`, marker in `Pos.x`.
	let n = 0;
	ecs.query(Pos).forEachChunk((cols, count) => {
		const p = cols.mut(Pos);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = 100;
			p.z[i] = n + 1;
		}
	});
	ecs.publishRowCounts();
	return { ecs, Pos, Vel, Target, T, ids };
}

/** The truth, read through the engine. */
function hostTruth(ecs, Pos) {
	let rows = 0;
	let sumX = 0;
	const ids = [];
	ecs.query(Pos).forEachChunk((cols, count) => {
		const p = cols.read(Pos);
		for (let i = 0; i < count; i++) {
			rows++;
			sumX += p.x[i];
			ids.push(p.z[i]);
		}
	});
	return {
		rows,
		sumX,
		distinctIds: new Set(ids).size,
		maxId: ids.length ? Math.max(...ids) : null
	};
}

async function growStage(backingName, allocator) {
	const CAP = 4096;
	const START = 3000;
	const { ecs, Pos, Vel, Target, T } = await makeWorld({
		allocator,
		columnCapacity: CAP,
		entities: START
	});
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const bufferBefore = buffer;
	const w = new Worker(WORKER, { workerData: { buffer, specs } });
	await new Promise((r) => w.once("message", r));

	const before = await request(w, { op: "bind" });

	// Spawn past the pinned capacity. This is the grow.
	for (let i = 0; i < CAP; i++) ecs.spawn(T);
	ecs.publishRowCounts();
	// A marker no cached view can predict, written through the engine.
	let n = 0;
	ecs.query(Pos).forEachChunk((cols, count) => {
		const p = cols.mut(Pos);
		for (let i = 0; i < count; i++, n++) {
			p.x[i] = 777;
			p.z[i] = n + 1;
		}
	});
	ecs.publishRowCounts();

	const stale = await request(w, { op: "report", label: "cached views, after the grow" });
	const fresh = await request(w, { op: "rebind", label: "rebound, after the grow" });
	w.postMessage({ op: "stop" });
	await new Promise((r) => w.once("exit", r));

	const bufferAfter = storeBuffer(ecs);
	const truth = hostTruth(ecs, Pos);
	const hostBound = bindColumnsLean(bufferAfter, specs);

	return {
		backing: backingName,
		sameBufferRef: bufferBefore === bufferAfter,
		bytesBefore: before.bufferBytes,
		bytesAfter: bufferAfter.byteLength,
		stampBefore: before.viewStamp,
		stampAfter: readHeader(bufferAfter).viewStamp,
		offBefore: before.per[0].byteOff,
		offAfter: hostBound[0].views[0].byteOffset,
		staleRows: stale.per[0].cachedRows,
		staleLiveRows: stale.per[0].liveRows,
		staleSum: stale.per[0].sum,
		staleFirstX: stale.per[0].firstX,
		freshRows: fresh.per[0].cachedRows,
		freshSum: fresh.per[0].sum,
		truthRows: truth.rows,
		truthSum: truth.sumX
	};
}

async function swapRemoveStage() {
	const CAP = 1 << 14;
	const START = 10_000;
	const REMOVE = 2000;
	const { ecs, Pos, Vel, Target, ids } = await makeWorld({
		columnCapacity: CAP,
		entities: START
	});
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const w = new Worker(WORKER, { workerData: { buffer, specs } });
	await new Promise((r) => w.once("message", r));
	const before = await request(w, { op: "bind" });

	// Despawn a contiguous block from the middle. Each despawn is a swap
	// remove, so the tail row lands in the hole.
	const from = Math.floor(START / 2) - REMOVE / 2;
	for (let i = 0; i < REMOVE; i++) ecs.despawn(ids[from + i]);
	ecs.publishRowCounts();

	const stale = await request(w, { op: "report", label: "cached row count" });
	const fresh = await request(w, { op: "rebind", label: "fresh row count" });
	w.postMessage({ op: "stop" });
	await new Promise((r) => w.once("exit", r));
	const truth = hostTruth(ecs, Pos);
	const bound = bindColumnsLean(buffer, specs);

	// Which identities does a worker with the stale count read, and which does
	// the world actually hold?
	const pz = bound[0].views[2];
	const liveRows = liveRowCount(buffer, bound[0].descriptorOff);
	const staleIds = [];
	for (let r = 0; r < before.per[0].cachedRows; r++) staleIds.push(pz[r]);
	const liveIds = [];
	for (let r = 0; r < liveRows; r++) liveIds.push(pz[r]);
	const liveSet = new Set(liveIds);
	const readTwice = staleIds.length - new Set(staleIds).size;
	const readDead = staleIds.filter((id) => !liveSet.has(id)).length;

	return {
		startRows: START,
		despawned: REMOVE,
		cachedRows: before.per[0].cachedRows,
		liveRows,
		truthRows: truth.rows,
		staleVisits: staleIds.length,
		staleReadsPastTail: Math.max(0, staleIds.length - liveRows),
		staleDuplicateIds: readTwice,
		staleDeadIds: readDead,
		freshRows: fresh.per[0].cachedRows,
		byteOffMoved: before.per[0].byteOff !== bound[0].views[0].byteOffset
	};
}

/** The invariant a clean run leaves: every live row holds `100 + passes * id`.
 * The quotient is the number of passes that reached that row. */
function quotients(px, pz, rows, passes) {
	let full = 0;
	let minQ = Infinity;
	let maxQ = -Infinity;
	let ragged = 0;
	for (let r = 0; r < rows; r++) {
		const id = pz[r];
		if (id === 0) continue;
		const q = (px[r] - 100) / id;
		if (!Number.isInteger(q)) ragged++;
		else {
			if (q < minQ) minQ = q;
			if (q > maxQ) maxQ = q;
			if (q === passes) full++;
		}
	}
	return {
		full,
		minQ: minQ === Infinity ? null : minQ,
		maxQ: maxQ === -Infinity ? null : maxQ,
		ragged
	};
}

/** The worker adds its own identity to every cached row while the host
 * despawns. A swap remove copies a whole row, so this catches only the
 * interleavings that land inside one row's read, add and store. */
async function despawnRace(attempt) {
	const CAP = 1 << 15;
	const START = 20_000;
	const REMOVE = 6000;
	const PASSES = 300;
	const { ecs, Pos, Vel, Target, ids } = await makeWorld({ columnCapacity: CAP, entities: START });
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const progress = new SharedArrayBuffer(4);
	const pg = new Int32Array(progress);
	const w = new Worker(WORKER, { workerData: { buffer, specs, progress } });
	await new Promise((r) => w.once("message", r));
	await request(w, { op: "bind" });

	const done = new Promise((resolve) => w.once("message", resolve));
	w.postMessage({ op: "spin", passes: PASSES });
	// Wait for the pass to be well under way. Without this the host finishes
	// its despawns before the worker wakes, and nothing overlaps.
	const until = Math.floor(PASSES / 3);
	while (Atomics.load(pg, 0) < until) {}
	const startedAt = Atomics.load(pg, 0);
	const from = Math.floor(START / 2);
	for (let i = 0; i < REMOVE; i++) ecs.despawn(ids[from + i]);
	ecs.publishRowCounts();
	const endedAt = Atomics.load(pg, 0);
	await done;
	w.postMessage({ op: "stop" });
	await new Promise((r) => w.once("exit", r));

	const bound = bindColumnsLean(buffer, specs);
	const rows = liveRowCount(buffer, bound[0].descriptorOff);
	const q = quotients(bound[0].views[0], bound[0].views[2], rows, PASSES);
	return {
		attempt,
		startRows: START,
		despawned: REMOVE,
		liveRows: rows,
		passes: PASSES,
		overlap: `${startedAt}..${endedAt}`,
		fullyApplied: q.full,
		wrongRows: rows - q.full,
		minPasses: q.minQ,
		maxPasses: q.maxQ,
		notAWholeNumber: q.ragged
	};
}

/** The worker adds its own identity to every cached row while the host grows
 * the store. The grow relocates the archetype, so every write after the
 * relocation lands in the block the store abandoned. */
async function growRace() {
	const CAP = 8192;
	const START = 6000;
	const PASSES = 400;
	const { ecs, Pos, Vel, Target, T } = await makeWorld({ columnCapacity: CAP, entities: START });
	const buffer = storeBuffer(ecs);
	const specs = kernelSpecs(ecs, Pos, Vel, Target);
	const offBefore = bindColumnsLean(buffer, specs)[0].views[0].byteOffset;
	const progress = new SharedArrayBuffer(4);
	const pg = new Int32Array(progress);
	const w = new Worker(WORKER, { workerData: { buffer, specs, progress } });
	await new Promise((r) => w.once("message", r));
	await request(w, { op: "bind" });

	const done = new Promise((resolve) => w.once("message", resolve));
	w.postMessage({ op: "spin", passes: PASSES });
	const until = Math.floor(PASSES / 3);
	while (Atomics.load(pg, 0) < until) {}
	const startedAt = Atomics.load(pg, 0);
	// Spawn past the pinned capacity while the worker writes. This is the grow.
	for (let i = 0; i < CAP; i++) ecs.spawn(T);
	ecs.publishRowCounts();
	const endedAt = Atomics.load(pg, 0);
	await done;
	w.postMessage({ op: "stop" });
	await new Promise((r) => w.once("exit", r));

	const bound = bindColumnsLean(storeBuffer(ecs), specs);
	const offAfter = bound[0].views[0].byteOffset;
	const rows = liveRowCount(storeBuffer(ecs), bound[0].descriptorOff);
	// Only the rows that existed at bind time carry the identity marker. The
	// rows spawned during the race carry zero, and `quotients` skips them.
	const q = quotients(bound[0].views[0], bound[0].views[2], rows, PASSES);
	return {
		startRows: START,
		spawnedDuring: CAP,
		liveRows: rows,
		passes: PASSES,
		overlap: `${startedAt}..${endedAt}`,
		columnMoved: offBefore !== offAfter,
		fullyApplied: q.full,
		minPasses: q.minQ,
		maxPasses: q.maxQ,
		notAWholeNumber: q.ragged
	};
}

async function main() {
	console.log(`\nP24 structural. availableParallelism() = ${CORES}\n`);

	const { growableSabAllocator, fixedSabAllocator } = await import(
		new URL("../../dist/shared.js", import.meta.url).href
	);
	const CAP_BYTES = 64 * 1024 * 1024;
	const growRows = [
		await growStage("shared, growable", null),
		await growStage("shared, fixed at the cap", fixedSabAllocator(CAP_BYTES))
	];

	console.log(
		"Stage 1. The host grows the store while a worker holds cached views. 3,000 rows, column capacity 4,096, then 4,096 more spawns.\n"
	);
	table(growRows, [
		{ label: "backing", get: (r) => r.backing },
		{ label: "same buffer ref", get: (r) => (r.sameBufferRef ? "yes" : "no") },
		{ label: "bytes before", get: (r) => r.bytesBefore },
		{ label: "bytes after", get: (r) => r.bytesAfter },
		{ label: "view_stamp", get: (r) => `${r.stampBefore} -> ${r.stampAfter}` },
		{ label: "Pos.x byte offset", get: (r) => `${r.offBefore} -> ${r.offAfter}` },
		{ label: "column moved", get: (r) => (r.offBefore !== r.offAfter ? "yes" : "no") }
	]);
	console.log("\n  What the worker read afterwards, from views it never rebound.\n");
	table(growRows, [
		{ label: "backing", get: (r) => r.backing },
		{ label: "worker rows", get: (r) => r.staleRows },
		{ label: "live rows in descriptor", get: (r) => r.staleLiveRows },
		{ label: "host rows", get: (r) => r.truthRows },
		{ label: "worker sum Pos.x", get: (r) => r.staleSum },
		{ label: "host sum Pos.x", get: (r) => r.truthSum },
		{ label: "worker Pos.x[0]", get: (r) => r.staleFirstX },
		{ label: "after a rebind", get: (r) => `${r.freshRows} rows, sum ${r.freshSum}` }
	]);

	const swap = await swapRemoveStage();
	console.log(
		"\nStage 2. The host despawns a block from the middle. Every despawn is a swap remove.\n"
	);
	table(
		[swap],
		[
			{ label: "rows at bind", get: (r) => r.cachedRows },
			{ label: "despawned", get: (r) => r.despawned },
			{ label: "live rows after", get: (r) => r.liveRows },
			{ label: "host rows after", get: (r) => r.truthRows },
			{ label: "column moved", get: (r) => (r.byteOffMoved ? "yes" : "no") },
			{ label: "stale pass visits", get: (r) => r.staleVisits },
			{ label: "visits past the live tail", get: (r) => r.staleReadsPastTail },
			{ label: "identities read twice", get: (r) => r.staleDuplicateIds },
			{ label: "identities no longer live", get: (r) => r.staleDeadIds },
			{ label: "rows after a rebind", get: (r) => r.freshRows }
		]
	);

	const races = [];
	for (let a = 0; a < 3; a++) races.push(await despawnRace(a));
	console.log(
		"\nStage 3a. The worker adds each row's own identity while the host despawns from the middle. A clean run leaves every live row at 100 + passes * identity.\n"
	);
	table(races, [
		{ label: "attempt", get: (r) => r.attempt },
		{ label: "rows at bind", get: (r) => r.startRows },
		{ label: "despawned mid pass", get: (r) => r.despawned },
		{ label: "live rows after", get: (r) => r.liveRows },
		{ label: "passes", get: (r) => r.passes },
		{ label: "host ran during passes", get: (r) => r.overlap },
		{ label: "rows with all passes", get: (r) => r.fullyApplied },
		{ label: "rows without", get: (r) => r.wrongRows },
		{ label: "min passes seen", get: (r) => r.minPasses },
		{ label: "max passes seen", get: (r) => r.maxPasses },
		{ label: "value off the lattice", get: (r) => r.notAWholeNumber }
	]);
	console.log(
		"\n  A run that shows no wrong row does not show the race cannot fire. It shows this run did not catch it."
	);

	const gr = await growRace();
	console.log(
		"\nStage 3b. The same pass, and the host grows instead of despawning. The grow relocates the archetype.\n"
	);
	table(
		[gr],
		[
			{ label: "rows at bind", get: (r) => r.startRows },
			{ label: "spawned mid pass", get: (r) => r.spawnedDuring },
			{ label: "live rows after", get: (r) => r.liveRows },
			{ label: "passes", get: (r) => r.passes },
			{ label: "host ran during passes", get: (r) => r.overlap },
			{ label: "column moved", get: (r) => (r.columnMoved ? "yes" : "no") },
			{ label: "rows with all passes", get: (r) => r.fullyApplied },
			{ label: "min passes seen", get: (r) => r.minPasses },
			{ label: "max passes seen", get: (r) => r.maxPasses },
			{ label: "value off the lattice", get: (r) => r.notAWholeNumber }
		]
	);
	console.log("");
}

await main();
