/**
 * P25 ABI. Can a module from any toolchain run a system body over the columns?
 *
 * The probe answers with three readers of one world: JavaScript, a module
 * emitted byte by byte in `wasm/emit.mjs`, and a module compiled by Zig. All
 * three walk the header, walk the archetype descriptors, resolve columns by
 * (component_id, field_id), and integrate over the live rows. The probe then
 * compares the bytes.
 *
 * It prints digests and counts. It prints no verdict.
 */

import { loadOecs, table } from "./harness.mjs";
import { emitAbiModule, walkInJs } from "./wasm/abi_module.mjs";
import { buildZig, zigAvailable } from "./wasm/build_zig.mjs";
import {
	MAX_PAGES,
	MAX_BYTES,
	buildWorld,
	bufferFnv,
	readHeader,
	readDescriptors,
	tsStepFromDescriptors,
	tsStepI32FromDescriptors,
	sampleColumn,
	collectColumns
} from "./wasm/world.mjs";

const { ECS } = await loadOecs();
const N = 4096;
const DT = 0.1;
const STEPS = 8;

const handBytes = emitAbiModule({ minPages: 1, maxPages: MAX_PAGES });
const zigBytes = buildZig("abi.zig", "abi.wasm", { maxMemoryBytes: MAX_BYTES });
if (zigBytes === null)
	console.log("zig is absent, the compiled data point is a skip and not a pass");
else if (zigBytes.error) console.log(`zig build failed:\n${zigBytes.error}`);

function instantiate(bytes, memory) {
	const mod = new WebAssembly.Module(bytes);
	return new WebAssembly.Instance(mod, { env: { memory } }).exports;
}

const readers = [{ name: "hand-emitted", bytes: handBytes }];
if (zigBytes && !zigBytes.error) readers.push({ name: "zig 0.16", bytes: zigBytes });

console.log(
	`module sizes: hand-emitted ${handBytes.length} B` +
		(readers.length > 1 ? `, zig ${zigBytes.length} B` : "")
);

// ── 1. the layout every reader sees ──────────────────────────────────────────
{
	const { ecs, Pos, Vel, headerOff } = buildWorld(ECS, { kind: "f32", n: N });
	const mem = ecs.wasmMemory;
	const header = readHeader(mem.buffer, headerOff);
	const descs = readDescriptors(mem.buffer, headerOff);
	console.log("\n## header of the store");
	table(
		Object.entries(header).map(([field, value]) => ({ field, value })),
		[
			{ label: "field", get: (r) => r.field },
			{ label: "value", get: (r) => r.value }
		]
	);
	console.log("\n## archetype descriptors, as a module walks them");
	table(descs, [
		{ label: "arch", get: (d) => d.id },
		{ label: "mask word 0", get: (d) => `0x${d.mask.toString(16)}` },
		{ label: "row_count", get: (d) => d.rowCount },
		{ label: "enabled", get: (d) => d.enabledCount },
		{ label: "columns", get: (d) => d.columnCount },
		{ label: "first byte_off", get: (d) => (d.columns[0] ? d.columns[0].byteOff : "-") }
	]);

	const jsWalk = walkInJs(new DataView(mem.buffer), headerOff);
	const jsFnv = bufferFnv(mem.buffer, header.capacity, headerOff);
	const rows = [{ reader: "javascript", walk: jsWalk, fnv: jsFnv }];
	for (const r of readers) {
		const ex = instantiate(r.bytes, mem);
		rows.push({
			reader: r.name,
			walk: ex.walk(headerOff) >>> 0,
			fnv: ex.fnv1a(headerOff, header.capacity) >>> 0
		});
	}
	console.log(`\n## layout fold and byte digest, one world, three readers, header at ${headerOff}`);
	table(rows, [
		{ label: "reader", get: (r) => r.reader },
		{ label: "walk fold", get: (r) => r.walk },
		{ label: "fnv1a over the store span", get: (r) => r.fnv },
		{
			label: "agrees",
			get: (r) => (r.walk === rows[0].walk && r.fnv === rows[0].fnv ? "yes" : "NO")
		}
	]);
	ecs.dispose?.();
	void Pos;
	void Vel;
}

// ── 2. the kernel, f32 columns ───────────────────────────────────────────────
{
	console.log(`\n## ${STEPS} steps of pos += vel * dt over f32 columns, dt = ${DT}`);
	const variants = [
		{
			name: "ts, fround",
			run: (w) => {
				let rows = 0;
				for (let s = 0; s < STEPS; s++)
					rows = tsStepFromDescriptors(w.ecs.wasmMemory.buffer, w.Pos.id, w.Vel.id, DT, {
						round: "fround",
						headerOff: w.headerOff
					});
				return rows;
			}
		},
		{
			name: "ts, native",
			run: (w) => {
				let rows = 0;
				for (let s = 0; s < STEPS; s++)
					rows = tsStepFromDescriptors(w.ecs.wasmMemory.buffer, w.Pos.id, w.Vel.id, DT, {
						round: "native",
						headerOff: w.headerOff
					});
				return rows;
			}
		}
	];
	for (const r of readers) {
		variants.push({
			name: r.name,
			run: (w) => {
				const ex = instantiate(r.bytes, w.ecs.wasmMemory);
				let rows = 0;
				for (let s = 0; s < STEPS; s++) rows = ex.step(w.headerOff, w.Pos.id, w.Vel.id, DT);
				return rows;
			}
		});
	}
	const rows = [];
	for (const v of variants) {
		const w = buildWorld(ECS, { kind: "f32", n: N });
		const rowsTouched = v.run(w);
		const cap = readHeader(w.ecs.wasmMemory.buffer, w.headerOff).capacity;
		const descs = readDescriptors(w.ecs.wasmMemory.buffer, w.headerOff);
		rows.push({
			body: v.name,
			rows: rowsTouched,
			digest: bufferFnv(w.ecs.wasmMemory.buffer, cap, w.headerOff),
			values: collectColumns(w.ecs.wasmMemory.buffer, descs, w.Pos.id),
			sample: sampleColumn(w.ecs.wasmMemory.buffer, descs, w.Pos.id, 0, 2, "f32").join(" ")
		});
		w.ecs.dispose?.();
	}
	const differing = (r) => {
		let d = 0;
		for (let i = 0; i < r.values.length; i++) if (r.values[i] !== rows[0].values[i]) d++;
		return d;
	};
	table(rows, [
		{ label: "body", get: (r) => r.body },
		{ label: "rows touched", get: (r) => r.rows },
		{ label: "fnv1a of the whole store", get: (r) => r.digest },
		{
			label: "pos values off the ts fround body",
			get: (r) => `${differing(r)} of ${r.values.length}`
		},
		{ label: "pos.x[0..2]", get: (r) => r.sample }
	]);
}

// ── 3. the kernel, i32 columns, and the state hash of the world ──────────────
{
	console.log("\n## one step of pos += vel * dt over i32 columns, deterministic world");
	const variants = [
		{
			name: "ts",
			run: (w) =>
				tsStepI32FromDescriptors(w.ecs.wasmMemory.buffer, w.Pos.id, w.Vel.id, 3, w.headerOff)
		}
	];
	for (const r of readers) {
		variants.push({
			name: r.name,
			run: (w) =>
				instantiate(r.bytes, w.ecs.wasmMemory).step_i32(w.headerOff, w.Pos.id, w.Vel.id, 3)
		});
	}
	const rows = [];
	for (const v of variants) {
		const w = buildWorld(ECS, { kind: "i32", n: N, deterministic: true });
		const touched = v.run(w);
		const cap = readHeader(w.ecs.wasmMemory.buffer, w.headerOff).capacity;
		rows.push({
			body: v.name,
			rows: touched,
			stateHash: w.ecs.snapshots.stateHash() >>> 0,
			digest: bufferFnv(w.ecs.wasmMemory.buffer, cap, w.headerOff)
		});
		w.ecs.dispose?.();
	}
	table(rows, [
		{ label: "body", get: (r) => r.body },
		{ label: "rows touched", get: (r) => r.rows },
		{ label: "ecs.snapshots.stateHash()", get: (r) => r.stateHash },
		{ label: "fnv1a of the whole store", get: (r) => r.digest },
		{
			label: "matches ts",
			get: (r) => (r.stateHash === rows[0].stateHash && r.digest === rows[0].digest ? "yes" : "NO")
		}
	]);
}

// ── 4. what the public state hash actually hashes ────────────────────────────
{
	console.log("\n## is ecs.snapshots.stateHash() the fnv1a of the buffer?");
	const w = buildWorld(ECS, { kind: "i32", n: 16, deterministic: true });
	const cap = readHeader(w.ecs.wasmMemory.buffer, w.headerOff).capacity;
	const ex = instantiate(handBytes, w.ecs.wasmMemory);
	table(
		[
			{ what: "ecs.snapshots.stateHash()", value: w.ecs.snapshots.stateHash() >>> 0 },
			{ what: "module fnv1a over the store span", value: ex.fnv1a(w.headerOff, cap) >>> 0 },
			{
				what: "javascript fnv1a over the store span",
				value: bufferFnv(w.ecs.wasmMemory.buffer, cap, w.headerOff)
			}
		],
		[
			{ label: "digest", get: (r) => r.what },
			{ label: "value", get: (r) => r.value }
		]
	);
	w.ecs.dispose?.();
}

// ── 5. the row count a module reads is published, not live ───────────────────
{
	console.log("\n## does a module see rows the host has not published?");
	const ecs = ECS.create({ memory: { backing: { wasm: { maximumPages: MAX_PAGES } } } });
	let headerOff = 0;
	ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const T = ecs.template(Pos({ x: 0, y: 0, z: 0 }), Vel({ vx: 1, vy: 1, vz: 1 }));
	ecs.spawnMany(T, 100);
	const buf = ecs.wasmMemory.buffer;
	const before = readDescriptors(buf, headerOff).map((d) => d.enabledCount);
	ecs.publishRowCounts();
	const after = readDescriptors(buf, headerOff).map((d) => d.enabledCount);
	const ex = instantiate(handBytes, ecs.wasmMemory);
	ecs.spawnMany(T, 100);
	const staleRows = ex.step(headerOff, Pos.id, Vel.id, 1);
	ecs.publishRowCounts();
	const freshRows = ex.step(headerOff, Pos.id, Vel.id, 1);
	ecs.spawnMany(T, 100);
	ecs.update(1);
	const afterUpdate = ex.step(headerOff, Pos.id, Vel.id, 1);
	table(
		[
			{ moment: "after 100 spawns, before publishRowCounts", value: before.join(",") },
			{ moment: "after publishRowCounts", value: after.join(",") },
			{ moment: "module rows after 100 more spawns, unpublished", value: staleRows },
			{ moment: "module rows after publishRowCounts", value: freshRows },
			{ moment: "module rows after 100 more spawns and one ecs.update", value: afterUpdate }
		],
		[
			{ label: "moment", get: (r) => r.moment },
			{ label: "enabled rows a module sees", get: (r) => r.value }
		]
	);
	ecs.dispose?.();
}

// ── 6. the header sits at address 0, and a pointer to address 0 is special ───
{
	console.log("\n## can each build mode of one compiler read the header at address 0?");
	const rows = [];
	for (const optimize of ["Debug", "ReleaseSafe", "ReleaseFast", "ReleaseSmall"]) {
		const bytes = buildZig("abi.zig", `abi-${optimize}.wasm`, {
			maxMemoryBytes: MAX_BYTES,
			optimize
		});
		if (bytes === null || bytes.error) {
			rows.push({ optimize, atZero: "skip", atHigh: "skip" });
			continue;
		}
		const w = buildWorld(ECS, { kind: "f32", n: 64 });
		const ex = instantiate(bytes, w.ecs.wasmMemory);
		const cap = readHeader(w.ecs.wasmMemory.buffer, w.headerOff).capacity;
		const attempt = (fn) => {
			try {
				return String(fn() >>> 0);
			} catch (e) {
				return `trap: ${e.message}`;
			}
		};
		rows.push({
			optimize,
			atZero: attempt(() => ex.fnv1a(0, 64)),
			atHigh: attempt(() => ex.fnv1a(w.headerOff, cap))
		});
		w.ecs.dispose?.();
	}
	table(rows, [
		{ label: "zig -O", get: (r) => r.optimize },
		{ label: "fnv1a from address 0", get: (r) => r.atZero },
		{ label: "fnv1a from the header offset", get: (r) => r.atHigh }
	]);
}

console.log(`\nzig: ${zigAvailable() ?? "absent"}`);
