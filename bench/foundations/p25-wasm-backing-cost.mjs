/**
 * P25 backing cost. Does a TypeScript body pay for the WASM backing?
 *
 * The foundations README reports that JavaScriptCore has no fast store path
 * for a view over a growable `SharedArrayBuffer`. A shared `WebAssembly.Memory`
 * gives a growable `SharedArrayBuffer` and can give nothing else, so a world
 * that opts into WASM should pay the same cost. This probe asks whether it
 * does.
 *
 * The body here is TypeScript on every row. No module runs. The only thing
 * that changes is what holds the bytes.
 */

import { loadOecs, time, table, variantArg, emit, RUNTIMES, runVariantOn } from "./harness.mjs";

const N = 100000;
const CAP = 128 * 1024 * 1024;
const BACKINGS = ["heap", "shared", "fixed shared", "wasm"];

function memoryOption(name, shared) {
	if (name === "heap") return { maxBytes: CAP, backing: "heap" };
	if (name === "shared") return { maxBytes: CAP, backing: "shared" };
	if (name === "fixed shared") return { backing: { allocator: shared.fixedSabAllocator(CAP) } };
	return { backing: { wasm: { maximumPages: CAP / 65536 } } };
}

const variant = variantArg();
if (variant !== null) {
	const { ECS, SCHEDULE } = await loadOecs();
	const shared = await import(new URL("../../dist/shared.js", import.meta.url).href);
	const ecs = ECS.create({ memory: memoryOption(variant, shared) });
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const T = ecs.template(Pos({ x: 1, y: 1, z: 1 }), Vel({ vx: 1, vy: 1, vz: 1 }));
	ecs.spawnMany(T, N);
	const movers = ecs.query(Pos, Vel);
	const readOnly = ecs.registerSystem({
		name: "read",
		reads: [Pos, Vel],
		queries: [[Pos, Vel]],
		fn: () => {
			let s = 0;
			movers.forEachChunk((cols, count) => {
				const { x, y, z } = cols.read(Pos);
				for (let i = 0; i < count; i++) s += x[i] + y[i] + z[i];
			});
			globalThis.__sink = s;
		}
	});
	const readWrite = ecs.registerSystem({
		name: "move",
		reads: [Vel],
		writes: [Pos],
		queries: [[Pos, Vel]],
		fn: () => {
			movers.forEachChunk((cols, count) => {
				const { x, y, z } = cols.mut(Pos);
				const { vx, vy, vz } = cols.read(Vel);
				for (let i = 0; i < count; i++) {
					x[i] += vx[i] * 0.5;
					y[i] += vy[i] * 0.5;
					z[i] += vz[i] * 0.5;
				}
			});
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, readOnly, readWrite);
	ecs.startup();

	// Time the two shapes apart, because the README's finding is about the
	// store path and not the load path.
	const readTime = time(() => {
		let s = 0;
		movers.forEachChunk((cols, count) => {
			const { x, y, z } = cols.read(Pos);
			for (let i = 0; i < count; i++) s += x[i] + y[i] + z[i];
		});
		return s;
	});
	const writeTime = time(() => {
		movers.forEachChunk((cols, count) => {
			const { x, y, z } = cols.mut(Pos);
			const { vx, vy, vz } = cols.read(Vel);
			for (let i = 0; i < count; i++) {
				x[i] += vx[i] * 0.5;
				y[i] += vy[i] * 0.5;
				z[i] += vz[i] * 0.5;
			}
		});
		return 1;
	});
	const frameTime = time(() => {
		ecs.update(0.5);
		return 1;
	});
	emit({
		read: { median: readTime.median, p25: readTime.p25, p75: readTime.p75 },
		write: { median: writeTime.median, p25: writeTime.p25, p75: writeTime.p75 },
		frame: { median: frameTime.median, p25: frameTime.p25, p75: frameTime.p75 }
	});
	process.exit(0);
}

console.log(`## a TypeScript body over ${N} entities, one process for each backing`);
for (const rt of RUNTIMES) {
	const rows = [];
	for (const backing of BACKINGS) {
		const r = runVariantOn(rt, import.meta.url, backing);
		rows.push({ backing, r });
	}
	const base = rows.find((x) => x.backing === "heap");
	console.log(`\n### ${rt.cmd}, ${rt.engine}, median ms, p25 to p75 in brackets`);
	const cell = (row, kind) =>
		row.r === null
			? "skip"
			: `${row.r[kind].median.toFixed(3)} [${row.r[kind].p25.toFixed(3)}, ${row.r[kind].p75.toFixed(3)}]`;
	const ratio = (row, kind) =>
		row.r === null || base.r === null
			? "skip"
			: `${(row.r[kind].median / base.r[kind].median).toFixed(2)}x`;
	table(rows, [
		{ label: "backing", get: (r) => r.backing },
		{ label: "read only", get: (r) => cell(r, "read") },
		{ label: "against heap", get: (r) => ratio(r, "read") },
		{ label: "read and write", get: (r) => cell(r, "write") },
		{ label: "against heap", get: (r) => ratio(r, "write") },
		{ label: "one frame", get: (r) => cell(r, "frame") }
	]);
}
