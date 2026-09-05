/**
 * A real WebAssembly module reads the store, and the engine has to agree with
 * it.
 *
 * `store_reader.wasm` is a checked-in binary. It imports the world's memory and
 * exports the five entries the test drives:
 *
 *   `fnv1a(off, len)`        folds raw bytes, the store-level digest
 *   `walk(headerOff)`        folds every archetype descriptor field by field
 *   `step(headerOff, posId, velId, dt)`   `pos += vel * dt` over enabled rows
 *   `step_i32(headerOff, posId, velId, dt)`   the integer twin
 *   `step_cached(px, py, pz, vx, vy, vz, rows, dt)`  the same over six
 *                            addresses the caller resolved earlier
 *
 * The module reads the header, the descriptor region and the columns itself. It
 * addresses a column as `headerOff + byte_off`, because every offset the store
 * writes is measured from the header. The test learns `headerOff` from
 * `subscribeLayout` and never assumes a value for it.
 *
 * The TypeScript side of every comparison is derived from the store's own ABI
 * constants, and the module carries those offsets baked into its code. A field
 * that moves in one and not the other fails here.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ECS } from "../../ecs";
import type { ComponentDef } from "../../component";
import {
	collectColumnValues,
	fnv1aBytes,
	foldLayout,
	maskHas,
	readDescriptors,
	readStoreHeader,
	resolveXyz,
	seedColumns,
	stepF32,
	stepI32
} from "../fixtures/store_walk";

/** The module declares this maximum, so every world here declares it too. An
 * instantiation against a memory with a different maximum fails. */
const MAXIMUM_PAGES = 512;

/** Small enough that a few hundred spawns force the store to grow a column and
 * relocate it. */
const COLUMN_CAPACITY = 16;

interface StoreReader {
	fnv1a(off: number, len: number): number;
	walk(headerOff: number): number;
	step(headerOff: number, posId: number, velId: number, dt: number): number;
	step_i32(headerOff: number, posId: number, velId: number, dt: number): number;
	step_cached(
		px: number,
		py: number,
		pz: number,
		vx: number,
		vy: number,
		vz: number,
		rows: number,
		dt: number
	): number;
}

const READER_BYTES = readFileSync(
	fileURLToPath(new URL("../fixtures/store_reader.wasm", import.meta.url))
);
const READER_MODULE = new WebAssembly.Module(READER_BYTES);

function instantiate(memory: WebAssembly.Memory): StoreReader {
	const instance = new WebAssembly.Instance(READER_MODULE, { env: { memory } });
	return instance.exports as unknown as StoreReader;
}

interface Fixture {
	ecs: ECS;
	memory: WebAssembly.Memory;
	headerOff: number;
	Pos: ComponentDef<{ x: "f32"; y: "f32"; z: "f32" }>;
	Vel: ComponentDef<{ vx: "f32"; vy: "f32"; vz: "f32" }>;
	reader: StoreReader;
}

/**
 * Three archetypes that hold columns: position and velocity, position alone,
 * and position, velocity and a third component. The masks differ, so a reader
 * that ignores the descriptor and walks every column gets a different answer.
 */
function buildWorld(rows: number): Fixture {
	const ecs = new ECS({
		memory: { columnCapacity: COLUMN_CAPACITY, backing: { wasm: { maximumPages: MAXIMUM_PAGES } } }
	});
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const Mass = ecs.registerComponent({ m: "u32" });
	let headerOff = -1;
	ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
	ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2, z: 3 }), Vel({ vx: 1, vy: 2, vz: 3 })), rows);
	ecs.spawnMany(ecs.template(Pos({ x: 7, y: 7, z: 7 })), rows);
	ecs.spawnMany(
		ecs.template(Pos({ x: 5, y: 6, z: 7 }), Vel({ vx: 2, vy: 3, vz: 4 }), Mass({ m: 11 })),
		rows
	);
	ecs.publishRowCounts();
	const memory = ecs.wasmMemory!;
	seedColumns(memory.buffer, headerOff, Pos.id, Vel.id, "f32");
	return { ecs, memory, headerOff, Pos, Vel, reader: instantiate(memory) };
}

/** The integer twin. A deterministic world refuses a float column, so the state
 * hash needs integer fields. */
function buildIntegerWorld(rows: number): {
	ecs: ECS;
	memory: WebAssembly.Memory;
	headerOff: number;
	posId: number;
	velId: number;
	reader: StoreReader;
} {
	const ecs = new ECS({
		deterministic: true,
		memory: { columnCapacity: COLUMN_CAPACITY, backing: { wasm: { maximumPages: MAXIMUM_PAGES } } }
	});
	const Pos = ecs.registerComponent({ x: "i32", y: "i32", z: "i32" });
	const Vel = ecs.registerComponent({ vx: "i32", vy: "i32", vz: "i32" });
	const Mass = ecs.registerComponent({ m: "u32" });
	let headerOff = -1;
	ecs.subscribeLayout({ setLayout: (off) => (headerOff = off) })();
	ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2, z: 3 }), Vel({ vx: 1, vy: 2, vz: 3 })), rows);
	ecs.spawnMany(ecs.template(Pos({ x: 7, y: 7, z: 7 })), rows);
	ecs.spawnMany(
		ecs.template(Pos({ x: 5, y: 6, z: 7 }), Vel({ vx: 2, vy: 3, vz: 4 }), Mass({ m: 11 })),
		rows
	);
	ecs.publishRowCounts();
	const memory = ecs.wasmMemory!;
	seedColumns(memory.buffer, headerOff, Pos.id, Vel.id, "i32");
	return { ecs, memory, headerOff, posId: Pos.id, velId: Vel.id, reader: instantiate(memory) };
}

describe("a WASM module reads the store layout", () => {
	it("folds the descriptor region to the value TypeScript folds", () => {
		const w = buildWorld(40);
		const view = new DataView(w.memory.buffer);

		// The shape the fold has to cover: three archetypes with columns, and
		// masks that differ. A world with one archetype would pass a fold that
		// walks nothing.
		const descriptors = readDescriptors(view, w.headerOff);
		const withColumns = descriptors.filter((d) => d.columns.length > 0);
		expect(withColumns.length).toBeGreaterThanOrEqual(3);
		expect(withColumns.some((d) => maskHas(d.mask, w.Vel.id))).toBe(true);
		expect(withColumns.some((d) => !maskHas(d.mask, w.Vel.id))).toBe(true);

		expect(w.reader.walk(w.headerOff) >>> 0).toBe(foldLayout(view, w.headerOff));
		w.ecs.dispose();
	});

	it("digests the same bytes over the range the header claims", () => {
		const w = buildWorld(40);
		const header = readStoreHeader(new DataView(w.memory.buffer), w.headerOff);
		expect(header.capacity).toBeGreaterThan(0);
		expect(w.reader.fnv1a(w.headerOff, header.capacity) >>> 0).toBe(
			fnv1aBytes(w.memory.buffer, w.headerOff, header.capacity)
		);
		w.ecs.dispose();
	});

	it("leaves the column bytes the TypeScript kernel leaves", () => {
		const dt = 0.1;
		const byTs = buildWorld(40);
		const byModule = buildWorld(40);

		// Two worlds built by the same calls hold the same bytes. Without that
		// the comparison below would report a difference the kernels did not make.
		expect(collectColumnValues(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, "f32")).toEqual(
			collectColumnValues(byModule.memory.buffer, byModule.headerOff, byModule.Pos.id, "f32")
		);

		const tsRows = stepF32(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, byTs.Vel.id, dt);
		const moduleRows = byModule.reader.step(
			byModule.headerOff,
			byModule.Pos.id,
			byModule.Vel.id,
			dt
		);
		expect(moduleRows).toBe(tsRows);
		// Two of the three archetypes hold both components, so a kernel that
		// skipped the mask test would report every row instead.
		expect(tsRows).toBe(80);

		const after = collectColumnValues(byTs.memory.buffer, byTs.headerOff, byTs.Pos.id, "f32");
		expect(collectColumnValues(byModule.memory.buffer, byModule.headerOff, byModule.Pos.id, "f32")).toEqual(
			after
		);
		byTs.ecs.dispose();
		byModule.ecs.dispose();
	});

	it("leaves an integer world at the state hash the TypeScript kernel leaves", () => {
		const byTs = buildIntegerWorld(40);
		const byModule = buildIntegerWorld(40);
		expect(byModule.ecs.snapshots.stateHash()).toBe(byTs.ecs.snapshots.stateHash());

		const tsRows = stepI32(byTs.memory.buffer, byTs.headerOff, byTs.posId, byTs.velId, 3);
		const moduleRows = byModule.reader.step_i32(
			byModule.headerOff,
			byModule.posId,
			byModule.velId,
			3
		);
		expect(moduleRows).toBe(tsRows);

		// The state hash folds live rows and the sparse stores, not the buffer.
		// It is the engine's own oracle, so an agreement here is an agreement
		// about the world and not about the bytes around it.
		expect(byModule.ecs.snapshots.stateHash()).toBe(byTs.ecs.snapshots.stateHash());
		byTs.ecs.dispose();
		byModule.ecs.dispose();
	});

	it("writes nothing the world reads through a column address cached across a grow", () => {
		const w = buildWorld(8);
		const before = readDescriptors(new DataView(w.memory.buffer), w.headerOff);
		const target = before.find((d) => resolveXyz(d, w.Pos.id, w.Vel.id) !== null)!;
		const cached = resolveXyz(target, w.Pos.id, w.Vel.id)!;
		const cachedRows = target.enabledCount;

		// Force the store to grow past the column capacity. A grow relocates the
		// columns of the archetype it grows and abandons the block they sat in.
		w.ecs.spawnMany(
			w.ecs.template(w.Pos({ x: 1, y: 1, z: 1 }), w.Vel({ vx: 1, vy: 1, vz: 1 })),
			COLUMN_CAPACITY * 8
		);
		w.ecs.publishRowCounts();

		const grown = readDescriptors(new DataView(w.memory.buffer), w.headerOff).find(
			(d) => d.archetypeId === target.archetypeId
		)!;
		const fresh = resolveXyz(grown, w.Pos.id, w.Vel.id)!;
		// Without a relocation the rest of this test proves nothing.
		expect(fresh.pos[0]).not.toBe(cached.pos[0]);

		const live = (): number[] =>
			collectColumnValues(w.memory.buffer, w.headerOff, w.Pos.id, "f32");
		const untouched = live();
		const touchedRows = w.reader.step_cached(
			cached.pos[0],
			cached.pos[1],
			cached.pos[2],
			cached.vel[0],
			cached.vel[1],
			cached.vel[2],
			cachedRows,
			1
		);
		// The module reports success. It wrote into the abandoned block, so the
		// world sees nothing. That silence is why a module walks from the header
		// on every call.
		expect(touchedRows).toBe(cachedRows);
		expect(live()).toEqual(untouched);

		expect(w.reader.step(w.headerOff, w.Pos.id, w.Vel.id, 1)).toBeGreaterThan(cachedRows);
		expect(live()).not.toEqual(untouched);
		w.ecs.dispose();
	});
});
