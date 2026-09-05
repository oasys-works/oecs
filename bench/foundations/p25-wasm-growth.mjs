/**
 * P25 growth. The memory can grow from either side. What survives?
 *
 * The store grows the memory when it needs room, and it relocates a column to
 * the tail while it does so. A module that cached a column address across that
 * moment reads the wrong bytes. The module can also grow the memory itself,
 * without telling the store.
 *
 * The view-validity check runs one process for each runtime, because the claim
 * it tests is a property of the engine.
 */

import { loadOecs, table, variantArg, emit, RUNTIMES, runVariantOn } from "./harness.mjs";
import { emitAbiModule } from "./wasm/abi_module.mjs";
import { buildZig, zigAvailable } from "./wasm/build_zig.mjs";
import { MAX_PAGES, buildWorld, readHeader, readDescriptors, collectColumns } from "./wasm/world.mjs";

const PAGE = 65536;

// ── the one-runtime variant: do views over a shared memory survive a grow? ───
if (variantArg() === "views") {
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
	const oldBuffer = memory.buffer;
	const oldView = new Int32Array(oldBuffer, 128, 16);
	const oldBytes = new Uint8Array(oldBuffer, 0, 1024);
	oldView[0] = 0x1234;
	memory.grow(4);
	const newBuffer = memory.buffer;
	const result = {
		sameBufferObject: newBuffer === oldBuffer,
		oldViewReadable: (() => {
			try {
				return oldView[0];
			} catch (e) {
				return `throws ${e.name}`;
			}
		})(),
		oldViewLength: oldView.length,
		oldBytesLength: oldBytes.length,
		writeThroughOldReadsThroughNew: (() => {
			try {
				oldView[1] = 0x5678;
				return new Int32Array(newBuffer, 128, 16)[1] === 0x5678;
			} catch (e) {
				return `throws ${e.name}`;
			}
		})(),
		writeThroughNewReadsThroughOld: (() => {
			try {
				new Int32Array(newBuffer, 128, 16)[2] = 0x9abc;
				return oldView[2] === 0x9abc;
			} catch (e) {
				return `throws ${e.name}`;
			}
		})(),
		oldBufferByteLength: oldBuffer.byteLength,
		newBufferByteLength: newBuffer.byteLength
	};
	emit(result);
	process.exit(0);
}

const { ECS } = await loadOecs();
const handBytes = emitAbiModule({ minPages: 1, maxPages: MAX_PAGES });

function instantiate(bytes, memory) {
	return new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
}

function columnsOf(buffer, posId, velId, headerOff = 0) {
	for (const d of readDescriptors(buffer, headerOff)) {
		const at = (cid, fid) => d.columns.find((c) => c.componentId === cid && c.fieldId === fid);
		if (at(posId, 0) && at(velId, 0)) {
			return {
				rows: d.enabledCount,
				px: at(posId, 0).address,
				py: at(posId, 1).address,
				pz: at(posId, 2).address,
				vx: at(velId, 0).address,
				vy: at(velId, 1).address,
				vz: at(velId, 2).address
			};
		}
	}
	return null;
}

// ── 1. what a store grow changes ─────────────────────────────────────────────
console.log("## what changes when the store grows");
{
	const w = buildWorld(ECS, { kind: "f32", n: 512 });
	const mem = w.ecs.wasmMemory;
	const layoutCalls = [];
	const detach = w.ecs.subscribeLayout({ setLayout: (off) => layoutCalls.push(off) });
	const before = { header: readHeader(mem.buffer, w.headerOff), cols: columnsOf(mem.buffer, w.Pos.id, w.Vel.id, w.headerOff), bytes: mem.buffer.byteLength, calls: layoutCalls.length };
	const T = w.ecs.template(w.Pos({ x: 1, y: 1, z: 1 }), w.Vel({ vx: 1, vy: 1, vz: 1 }));
	w.ecs.spawnMany(T, 40000);
	w.ecs.publishRowCounts();
	const after = { header: readHeader(mem.buffer, w.headerOff), cols: columnsOf(mem.buffer, w.Pos.id, w.Vel.id, w.headerOff), bytes: mem.buffer.byteLength, calls: layoutCalls.length };
	table(
		[
			{ what: "view_stamp", before: before.header.viewStamp, after: after.header.viewStamp },
			{ what: "capacity", before: before.header.capacity, after: after.header.capacity },
			{ what: "memory.buffer.byteLength", before: before.bytes, after: after.bytes },
			{ what: "byte_off of the pos.x column", before: before.cols.px, after: after.cols.px },
			{ what: "enabled rows", before: before.cols.rows, after: after.cols.rows },
			{ what: "setLayout calls so far", before: before.calls, after: after.calls }
		],
		[
			{ label: "field", get: (r) => r.what },
			{ label: "before the grow", get: (r) => r.before },
			{ label: "after the grow", get: (r) => r.after }
		]
	);
	console.log(`  every setLayout call passed the offset ${[...new Set(layoutCalls)].join(",")}`);
	detach();
	w.ecs.dispose?.();
}

// ── 2. a cached column address across a grow ─────────────────────────────────
console.log("\n## a module that cached the column address, against one that re-walks");
{
	const rows = [];
	for (const strategy of ["cached before the grow", "re-walked after the grow", "walks the header every call"]) {
		const w = buildWorld(ECS, { kind: "f32", n: 512 });
		const mem = w.ecs.wasmMemory;
		const ex = instantiate(handBytes, mem);
		const cached = columnsOf(mem.buffer, w.Pos.id, w.Vel.id, w.headerOff);
		const T = w.ecs.template(w.Pos({ x: 1, y: 1, z: 1 }), w.Vel({ vx: 1, vy: 1, vz: 1 }));
		w.ecs.spawnMany(T, 40000);
		w.ecs.publishRowCounts();
		const fresh = columnsOf(mem.buffer, w.Pos.id, w.Vel.id, w.headerOff);
		const before = collectColumns(mem.buffer, readDescriptors(mem.buffer, w.headerOff), w.Pos.id);
		let touched = 0;
		if (strategy === "cached before the grow") {
			touched = ex.step_cached(cached.px, cached.py, cached.pz, cached.vx, cached.vy, cached.vz, cached.rows, 1);
		} else if (strategy === "re-walked after the grow") {
			touched = ex.step_cached(fresh.px, fresh.py, fresh.pz, fresh.vx, fresh.vy, fresh.vz, fresh.rows, 1);
		} else {
			touched = ex.step(w.headerOff, w.Pos.id, w.Vel.id, 1);
		}
		const after = collectColumns(mem.buffer, readDescriptors(mem.buffer, w.headerOff), w.Pos.id);
		let changed = 0;
		for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
		rows.push({
			strategy,
			cachedAt: cached.px,
			freshAt: fresh.px,
			touched,
			changed,
			live: after.length
		});
		w.ecs.dispose?.();
	}
	table(rows, [
		{ label: "what the module holds", get: (r) => r.strategy },
		{ label: "cached pos.x address", get: (r) => r.cachedAt },
		{ label: "live pos.x address", get: (r) => r.freshAt },
		{ label: "rows the module claims", get: (r) => r.touched },
		{ label: "live values it actually changed", get: (r) => `${r.changed} of ${r.live}` }
	]);
}

// ── 3. the module grows the memory, and the store did not ask ────────────────
console.log("\n## the module grows the memory by itself");
if (zigAvailable() === null) {
	console.log("  zig is absent, so this section is a skip and not a pass");
} else {
	const squat = buildZig("squatter.zig", "squatter-growth.wasm", {
		maxMemoryBytes: 1024 * PAGE,
		flags: ["--export=__heap_base", "--export=__data_end"]
	});
	if (squat === null || squat.error) {
		console.log(`  build failed: ${squat && squat.error}`);
	} else {
		const memory = new WebAssembly.Memory({ initial: 200, maximum: 1024, shared: true });
		const ecs = ECS.create({ deterministic: true, memory: { backing: { wasm: { memory } } } });
		let headerOff = 0;
		ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
		const Pos = ecs.registerComponent({ x: "i32", y: "i32", z: "i32" });
		const T = ecs.template(Pos({ x: 1, y: 2, z: 3 }));
		const ids = ecs.spawnMany(T, 4096);
		ecs.publishRowCounts();
		const ex = instantiate(squat, memory);
		const before = {
			header: readHeader(memory.buffer, headerOff),
			pages: ex.page_count(),
			hash: ecs.snapshots.stateHash() >>> 0,
			descs: readDescriptors(memory.buffer, headerOff).length
		};
		const grew = ex.grow_pages(8);
		const after = {
			header: readHeader(memory.buffer, headerOff),
			pages: ex.page_count(),
			hash: ecs.snapshots.stateHash() >>> 0,
			descs: readDescriptors(memory.buffer, headerOff).length
		};
		let spawnError = "none";
		let updateError = "none";
		try {
			ecs.spawnMany(T, 40000);
			ecs.publishRowCounts();
		} catch (e) {
			spawnError = `${e.name}: ${e.message}`.slice(0, 80);
		}
		try {
			ecs.update(1);
		} catch (e) {
			updateError = `${e.name}: ${e.message}`.slice(0, 80);
		}
		table(
			[
				{ what: "memory.grow returned the old page count", before: "-", after: grew },
				{ what: "pages the module sees", before: before.pages, after: after.pages },
				{ what: "header capacity", before: before.header.capacity, after: after.header.capacity },
				{ what: "header view_stamp", before: before.header.viewStamp, after: after.header.viewStamp },
				{ what: "archetypes in the descriptor region", before: before.descs, after: after.descs },
				{ what: "stateHash", before: before.hash, after: after.hash },
				{ what: "entities alive", before: ids.length, after: ids.filter((id) => ecs.isAlive(id)).length },
				{ what: "spawn after the module grew", before: "-", after: spawnError },
				{ what: "update after the module grew", before: "-", after: updateError },
				{ what: "capacity after that spawn", before: "-", after: readHeader(memory.buffer, headerOff).capacity }
			],
			[
				{ label: "fact", get: (r) => r.what },
				{ label: "before the module grew", get: (r) => r.before },
				{ label: "after", get: (r) => r.after }
			]
		);
		ecs.dispose?.();
	}
}

// ── 4. do views over a shared memory survive a grow, on each engine? ─────────
console.log("\n## views over a shared WebAssembly.Memory across memory.grow");
{
	const rows = [];
	for (const rt of RUNTIMES) {
		const r = runVariantOn(rt, import.meta.url, "views");
		if (r === null) {
			rows.push({ runtime: rt.cmd, engine: rt.engine, note: "skip, the runtime is absent or it failed" });
			continue;
		}
		rows.push({ runtime: rt.cmd, engine: rt.engine, ...r });
	}
	table(rows, [
		{ label: "runtime", get: (r) => r.runtime },
		{ label: "engine", get: (r) => r.engine },
		{ label: "same buffer object", get: (r) => (r.note ? r.note : r.sameBufferObject) },
		{ label: "old view still reads", get: (r) => (r.note ? "-" : r.oldViewReadable) },
		{ label: "old write seen through new", get: (r) => (r.note ? "-" : r.writeThroughOldReadsThroughNew) },
		{ label: "new write seen through old", get: (r) => (r.note ? "-" : r.writeThroughNewReadsThroughOld) },
		{ label: "old buffer byteLength", get: (r) => (r.note ? "-" : r.oldBufferByteLength) },
		{ label: "new buffer byteLength", get: (r) => (r.note ? "-" : r.newBufferByteLength) }
	]);
}
