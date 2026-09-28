/**
 * P24 bytes-view, a worker sees bytes and not the world.
 *
 * The question: can a worker that receives only the store `SharedArrayBuffer`
 * find the same column values the main thread's query reads? The worker
 * imports nothing from the package. It walks the header, then the layout
 * descriptor, then builds a typed-array view for each `(component_id, field_id)`
 * it was asked for.
 *
 * The probe also times the walk, because a layout republish forces every worker
 * to redo it. If the walk is expensive, a grow is expensive for every worker at
 * once.
 *
 * The comparison is exact. The worker returns the sum, the first row and the
 * last row of each bound field, and an FNV fold over the live bytes. The host
 * derives all four from `query.forEachColumns`. A mismatch on any one fails the
 * probe.
 *
 * Run: `node bench/foundations/p24-par-bytes-view.mjs`. Also runs under
 * `deno run -A` and under `bun`.
 */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { table, time } from "./harness.mjs";
import { buildWorld, seedWorld, storeBuffer } from "./par/world.mjs";
import { walkArchetypes, bindColumns, bindColumnsLean, foldColumnBytes } from "./par/view.mjs";

const WORKER = new URL("./par/view-worker.mjs", import.meta.url);

function request(worker, msg) {
	return new Promise((resolve, reject) => {
		worker.once("message", resolve);
		worker.once("error", reject);
		worker.postMessage(msg);
	});
}

/** The same four figures the worker returns, derived from the engine's query
 * instead of from the raw bytes. One entry for each archetype the query hits,
 * in the query's own chunk order. */
function hostSide(ecs, defs, fields) {
	const q = ecs.query(...defs);
	const per = [];
	q.forEachColumns((cols, count) => {
		const views = fields.map(([def, name]) => cols.read(def)[name]);
		const sums = views.map((v) => {
			let s = 0;
			for (let i = 0; i < count; i++) s += v[i];
			return s;
		});
		per.push({
			rowCount: count,
			sums,
			first: views.map((v) => (count > 0 ? v[0] : 0)),
			last: views.map((v) => (count > 0 ? v[count - 1] : 0))
		});
	});
	return per;
}

function sameNumbers(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

async function verify() {
	const { ecs, Pos, Vel, Target } = await buildWorld({ entities: 50_000, columnCapacity: 1 << 16 });
	seedWorld(ecs, Pos, Vel, Target);
	ecs.publishRowCounts();
	const buffer = storeBuffer(ecs);

	const specs = [
		[Pos.id, ecs.fieldId(Pos, "x")],
		[Pos.id, ecs.fieldId(Pos, "y")],
		[Pos.id, ecs.fieldId(Pos, "z")],
		[Vel.id, ecs.fieldId(Vel, "vx")]
	];
	const fields = [
		[Pos, "x"],
		[Pos, "y"],
		[Pos, "z"],
		[Vel, "vx"]
	];

	const w = new Worker(WORKER, { workerData: { buffer } });
	await new Promise((r) => w.once("message", r));

	const walk = await request(w, { op: "walk" });
	const read = await request(w, { op: "read", specs });
	const host = hostSide(ecs, [Pos, Vel], fields);
	w.postMessage({ op: "stop" });
	await new Promise((r) => w.once("exit", r));

	// The worker walks descriptors in descriptor order. The query walks the
	// archetypes it matches. Both are archetype-id order, so a positional
	// compare is the strict test.
	const rows = [];
	const n = Math.max(host.length, read.per.length);
	let allSame = host.length === read.per.length;
	for (let i = 0; i < n; i++) {
		const h = host[i];
		const p = read.per[i];
		const same =
			h !== undefined &&
			p !== undefined &&
			h.rowCount === p.rowCount &&
			sameNumbers(h.sums, p.sums) &&
			sameNumbers(h.first, p.first) &&
			sameNumbers(h.last, p.last);
		if (!same) allSame = false;
		rows.push({
			slot: i,
			archId: p ? p.archetypeId : "-",
			hostRows: h ? h.rowCount : "-",
			workerRows: p ? p.rowCount : "-",
			hostSumX: h ? h.sums[0] : "-",
			workerSumX: p ? p.sums[0] : "-",
			match: same ? "yes" : "NO"
		});
	}

	// The host's own fold, over the same bound views, must equal the worker's.
	const hostFold = foldColumnBytes(bindColumns(buffer, specs).bound);
	// The lean walk must agree with the object walk, field for field.
	const leanFold = foldColumnBytes(bindColumnsLean(buffer, specs));

	return {
		rows,
		allSame,
		foldMatch: hostFold === read.fold,
		hostFold,
		leanFold,
		workerFold: read.fold,
		walk,
		ecs,
		buffer,
		Pos,
		Vel,
		Target
	};
}

/** What one republish costs a worker: the descriptor walk, and the walk plus
 * the typed-array construction for a bound field list. */
function walkCost(buffer, specs) {
	const rows = [];
	const w = walkArchetypes(buffer);
	const totalColumns = w.archetypes.reduce((s, a) => s + a.columns.length, 0);
	rows.push({
		what: `walkArchetypes (${w.archetypes.length} archetypes, ${totalColumns} columns)`,
		...time(() => walkArchetypes(buffer).archetypes.length, { samples: 25 })
	});
	rows.push({
		what: `walk + bindColumns (${specs.length} fields)`,
		...time(() => bindColumns(buffer, specs).bound.length, { samples: 25 })
	});
	rows.push({
		what: `bindColumns only, walk cached (${specs.length} fields)`,
		...time(() => bindColumns(buffer, specs, w).bound.length, { samples: 25 })
	});
	rows.push({
		what: `bindColumnsLean, no per-column object (${specs.length} fields)`,
		...time(() => bindColumnsLean(buffer, specs).length, { samples: 25 })
	});
	return { rows, archetypes: w.archetypes.length, totalColumns };
}

/** Grow the archetype count and re-time the walk. The walk is sequential, so a
 * world with many archetypes pays on every republish. */
async function walkScale() {
	const rows = [];
	for (const archCount of [4, 16, 64, 256]) {
		const { ECS } = await import(new URL("../../dist/index.js", import.meta.url).href);
		const { regionSpec } = await import("./par/world.mjs");
		const ecs = new ECS({
			memory: { backing: "shared", columnCapacity: 64 },
			regions: [regionSpec()]
		});
		const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
		const tags = [];
		// One tag for each archetype, so `archCount` distinct signatures exist
		// and each carries the same three real columns.
		const bits = Math.ceil(Math.log2(archCount));
		for (let i = 0; i < bits; i++) tags.push(ecs.registerTag());
		ecs.startup();
		for (let a = 0; a < archCount; a++) {
			const parts = [Pos({ x: a, y: a, z: a })];
			for (let i = 0; i < bits; i++) if (a & (1 << i)) parts.push(tags[i]);
			ecs.spawn(ecs.template(...parts));
		}
		ecs.publishRowCounts();
		const buffer = storeBuffer(ecs);
		const w = walkArchetypes(buffer);
		const specs = [[Pos.id, ecs.fieldId(Pos, "x")]];
		const walkT = time(() => walkArchetypes(buffer).archetypes.length, { samples: 21 });
		const bindT = time(() => bindColumns(buffer, specs).bound.length, { samples: 21 });
		const leanT = time(() => bindColumnsLean(buffer, specs).length, { samples: 21 });
		rows.push({
			asked: archCount,
			found: w.archetypes.length,
			columns: w.archetypes.reduce((s, a) => s + a.columns.length, 0),
			walkUs: (walkT.median * 1000).toFixed(2),
			walkP75: (walkT.p75 * 1000).toFixed(2),
			bindUs: (bindT.median * 1000).toFixed(2),
			bindP75: (bindT.p75 * 1000).toFixed(2),
			leanUs: (leanT.median * 1000).toFixed(2),
			leanP75: (leanT.p75 * 1000).toFixed(2)
		});
	}
	return rows;
}

async function main() {
	console.log(`\nP24 bytes-view. availableParallelism() = ${availableParallelism()}\n`);
	const v = await verify();

	console.log("Does the worker read what the query reads? 50,000 entities, three archetypes.\n");
	table(v.rows, [
		{ label: "slot", get: (r) => r.slot },
		{ label: "arch id", get: (r) => r.archId },
		{ label: "host rows", get: (r) => r.hostRows },
		{ label: "worker rows", get: (r) => r.workerRows },
		{ label: "host sum Pos.x", get: (r) => r.hostSumX },
		{ label: "worker sum Pos.x", get: (r) => r.workerSumX },
		{ label: "match", get: (r) => r.match }
	]);
	console.log(`\n  per-archetype match: ${v.allSame ? "every slot" : "MISMATCH"}`);
	console.log(
		`  byte fold: host ${v.hostFold}, worker ${v.workerFold}, ${v.foldMatch ? "equal" : "DIFFERENT"}`
	);
	console.log(
		`  lean walk fold: ${v.leanFold}, ${v.leanFold === v.hostFold ? "equal to the object walk" : "DIFFERENT"}`
	);
	console.log(
		`  header the worker read: view_stamp ${v.walk.header.viewStamp}, capacity ${v.walk.header.capacity}, archetype_count ${v.walk.header.archetypeCount}`
	);

	const specs = [
		[v.Pos.id, v.ecs.fieldId(v.Pos, "x")],
		[v.Pos.id, v.ecs.fieldId(v.Pos, "y")],
		[v.Pos.id, v.ecs.fieldId(v.Pos, "z")],
		[v.Vel.id, v.ecs.fieldId(v.Vel, "vx")]
	];
	const wc = walkCost(v.buffer, specs);
	console.log("\nWhat one layout republish costs a worker. Microseconds.\n");
	table(wc.rows, [
		{ label: "what", get: (r) => r.what },
		{ label: "median us", get: (r) => (r.median * 1000).toFixed(2) },
		{ label: "p25", get: (r) => (r.p25 * 1000).toFixed(2) },
		{ label: "p75", get: (r) => (r.p75 * 1000).toFixed(2) }
	]);

	console.log("\nThe walk against the archetype count. Microseconds.\n");
	table(await walkScale(), [
		{ label: "archetypes asked", get: (r) => r.asked },
		{ label: "found in buffer", get: (r) => r.found },
		{ label: "columns", get: (r) => r.columns },
		{ label: "walk us", get: (r) => r.walkUs },
		{ label: "walk p75", get: (r) => r.walkP75 },
		{ label: "walk+bind us", get: (r) => r.bindUs },
		{ label: "bind p75", get: (r) => r.bindP75 },
		{ label: "lean us", get: (r) => r.leanUs },
		{ label: "lean p75", get: (r) => r.leanP75 }
	]);
	console.log("");
}

await main();
