/**
 * A world whose store starts above byte 0.
 *
 * The wasm backing shares one linear memory with a module. The module owns the
 * low addresses, so the world must stand above them and must never write below
 * its own base. `memory.storeBase` is that promise, and this file pins it at
 * the world level: the option resolves and reports, the engine keeps the base
 * across a grow and an extend, the bytes below it survive, and the state hash
 * ignores the base entirely.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import { resolveECSMemory, storeBaseAbove, WASM_STORE_BASE_BYTES } from "../../ecs_memory";
import { ECSError, ECS_ERROR } from "../../utils/error";
import {
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	heapArrayBufferAllocator,
	type InPlaceBufferAllocator
} from "../../../store";
import { snapshots } from "../../../../plugins/snapshots";

const CAP = 16 * 1024 * 1024;

const Position = { x: "i32", y: "i32" } as const;
const Velocity = { vx: "i32", vy: "i32" } as const;
const Tag = { v: "u8" } as const;

/** A world at `storeBase` over `allocator`, with the snapshot surface on. The
 * allocator hands the same buffer back on every call, so a test can read the
 * bytes below the base straight from it. */
function world(storeBase: number, allocator: InPlaceBufferAllocator) {
	const w = ECS.create({
		deterministic: true,
		// A declared entity count keeps the entity-index reservation small, so the
		// byte comparisons below stay quick.
		memory: { storeBase, entities: 8192, maxBytes: CAP, backing: { allocator } },
		plugins: [snapshots()]
	});
	const Pos = w.registerComponent(Position);
	const Vel = w.registerComponent(Velocity);
	const Flag = w.registerComponent(Tag);
	return { w, Pos, Vel, Flag };
}

function expectInvalid(fn: () => unknown, fragment: string): void {
	let thrown: unknown;
	try {
		fn();
	} catch (e) {
		thrown = e;
	}
	expect(thrown).toBeInstanceOf(ECSError);
	expect((thrown as ECSError).category).toBe(ECS_ERROR.INVALID_MEMORY_OPTIONS);
	expect((thrown as ECSError).message).toContain(fragment);
}

describe("memory.storeBase, the option", () => {
	it("defaults to 0 on the heap, shared and allocator backings", () => {
		expect(resolveECSMemory().storeBase).toBe(0);
		expect(resolveECSMemory({ backing: "shared" }).storeBase).toBe(0);
		expect(
			resolveECSMemory({ backing: { allocator: heapArrayBufferAllocator(1 << 20) } }).storeBase
		).toBe(0);
	});

	it("defaults to one page on both wasm arms", () => {
		expect(resolveECSMemory({ backing: { wasm: { maximumPages: 64 } } }).storeBase).toBe(
			WASM_STORE_BASE_BYTES
		);
		const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
		expect(resolveECSMemory({ backing: { wasm: { memory } } }).storeBase).toBe(
			WASM_STORE_BASE_BYTES
		);
	});

	// A safe Zig or Rust build cannot read address 0, so 0 is not an answer for
	// a module-hosted store. Say so instead of laying the header there.
	it("rejects an explicit 0 on the wasm backing", () => {
		expectInvalid(
			() => resolveECSMemory({ storeBase: 0, backing: { wasm: { maximumPages: 64 } } }),
			"unreadable from a safe build"
		);
		const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
		expectInvalid(
			() => resolveECSMemory({ storeBase: 0, backing: { wasm: { memory } } }),
			"unreadable from a safe build"
		);
		// 0 stays legal without a module.
		expect(resolveECSMemory({ storeBase: 0 }).storeBase).toBe(0);
	});

	it("rejects a fractional, negative or misaligned base and names the value", () => {
		expectInvalid(() => resolveECSMemory({ storeBase: -16 }), "got -16");
		expectInvalid(() => resolveECSMemory({ storeBase: 1.5 }), "got 1.5");
		expectInvalid(() => resolveECSMemory({ storeBase: 24 }), "multiple of 16");
	});

	it("memoryPlan reports the resolved base", () => {
		const wasm = new ECS({ memory: { backing: { wasm: { maximumPages: 64 } } } });
		expect(wasm.memoryPlan.storeBase).toBe(WASM_STORE_BASE_BYTES);
		expect(wasm.memoryPlan.capBytes).toBe(64 * 64 * 1024);

		const heap = new ECS({ memory: { storeBase: 4096 } });
		expect(heap.memoryPlan.storeBase).toBe(4096);
	});
});

describe("memory.storeBase, the world", () => {
	it("mounts the header at the base and leaves buffer byte 0 alone", () => {
		const storeBase = 65536;
		const store = new Store({
			storeBase,
			bufferAllocator: heapArrayBufferAllocator(CAP),
			entityIndexCapacity: 1 << 12
		});
		const buffer = store.columnStore.buffer;
		expect(new DataView(buffer, storeBase).getUint32(STORE_HEADER_OFFSETS.magic, true)).toBe(
			STORE_MAGIC
		);
		expect(new DataView(buffer).getUint32(0, true)).toBe(0);
		expect(store.columnStore.storeBase).toBe(storeBase);
	});

	// The collision this file exists for, driven through the world rather than
	// the store primitive: spawns force a column grow, despawns move rows, and
	// each new component set forces an extend.
	it("a grow, a despawn and an extend leave every byte below the base untouched", () => {
		const storeBase = 65536;
		const allocator = heapArrayBufferAllocator(CAP);
		// Claim the low addresses the way a module's data segment does, before
		// the world exists.
		const claimed = new Uint8Array(allocator(storeBase), 0, storeBase);
		const pattern = (i: number): number => (i * 31 + 17) & 0xff;
		for (let i = 0; i < claimed.length; i++) claimed[i] = pattern(i);

		const { w, Pos, Vel, Flag } = world(storeBase, allocator);
		const ids = [];
		// Past the default column capacity, so the columns double at least once.
		for (let i = 0; i < 4096; i++) {
			const e = w.spawn();
			w.addComponent(e, Pos, { x: i, y: -i });
			ids.push(e);
		}
		w.flush();
		for (let i = 0; i < 2048; i += 2) w.despawn(ids[i]);
		w.flush();
		// Two more component sets, two more extends.
		for (let i = 1; i < 512; i += 2) w.addComponent(ids[i], Vel, { vx: i, vy: i });
		w.flush();
		for (let i = 1; i < 256; i += 2) w.addComponent(ids[i], Flag, { v: 1 });
		w.flush();

		const after = new Uint8Array(allocator(storeBase), 0, storeBase);
		for (let i = 0; i < storeBase; i++) {
			// Report the first offending byte rather than a whole-array diff.
			if (after[i] !== pattern(i)) {
				throw new Error(`byte ${i} below the base changed to ${after[i]}`);
			}
		}
		// The world still works after all of that.
		expect(w.isAlive(ids[1])).toBe(true);
		expect(w.getField(ids[1], Pos, "x")).toBe(1);
	});

	// The default that matters: an engine-constructed WASM memory puts the
	// header one page up, and the world still grows and extends from there.
	it("a wasm-backed world lives above the first page and keeps ticking", () => {
		const w = ECS.create({
			memory: { entities: 4096, backing: { wasm: { maximumPages: 512 } } },
			plugins: [snapshots()]
		});
		const Pos = w.registerComponent(Position);
		const Vel = w.registerComponent(Velocity);
		const memory = w.wasmMemory!;
		expect(new DataView(memory.buffer, WASM_STORE_BASE_BYTES).getUint32(0, true)).toBe(STORE_MAGIC);

		const ids = [];
		for (let i = 0; i < 4000; i++) {
			const e = w.spawn();
			w.addComponent(e, Pos, { x: i, y: i });
			ids.push(e);
		}
		w.flush();
		for (let i = 0; i < 500; i++) w.addComponent(ids[i], Vel, { vx: i, vy: i });
		w.flush();

		// The first page still belongs to nobody, which is the whole point. Read
		// it off the live ref, a grow replaces the buffer object.
		const after = new Uint8Array(memory.buffer, 0, WASM_STORE_BASE_BYTES);
		expect(after.some((b) => b !== 0)).toBe(false);
		expect(w.getField(ids[10], Pos, "x")).toBe(10);
	});

	// A layout listener is how a module learns where the header is. The seam
	// used to publish the constant 0, which is the one address a safe module
	// cannot read.
	it("publishes the base to a layout listener, at seed and after a grow", () => {
		const storeBase = 4096;
		const { w, Pos } = world(storeBase, heapArrayBufferAllocator(CAP));
		const seen: number[] = [];
		w.subscribeLayout({ setLayout: (off) => seen.push(off) });
		expect(seen).toEqual([storeBase]);

		// Spawn past the column capacity so the store grows and republishes.
		for (let i = 0; i < 4096; i++) {
			const e = w.spawn();
			w.addComponent(e, Pos, { x: i, y: i });
		}
		w.flush();
		expect(seen.length).toBeGreaterThan(1);
		for (const off of seen) expect(off).toBe(storeBase);
	});

	// A consumer region handle pairs an offset with the backing buffer, so its
	// offset stays buffer absolute. The bytes still carry the store-relative
	// value, which is what a module reads.
	it("a consumer region handle resolves against the buffer at a nonzero base", () => {
		const storeBase = 4096;
		const SEED = 0xabcdef01;
		const w = new ECS({
			memory: { storeBase, entities: 512, backing: "heap" },
			regions: [
				{
					id: 21,
					name: "probe",
					bytes: 32,
					init: (view, off) => view.setUint32(off, SEED, true)
				}
			]
		});
		const handle = w.regionHandle(21)!;
		expect(handle.view.byteOffset).toBe(storeBase);
		expect(handle.offset).toBe(w.regionOffset(21));
		expect(handle.offset).toBeGreaterThan(storeBase);
		expect(new DataView(handle.buffer).getUint32(handle.offset, true)).toBe(SEED);
		expect(handle.view.getUint32(handle.offset - handle.view.byteOffset, true)).toBe(SEED);
		expect(w.regionOffset(999)).toBe(0);
	});

	it("the state hash and the snapshot ignore the base", () => {
		const build = (storeBase: number) => {
			const { w, Pos, Vel } = world(storeBase, heapArrayBufferAllocator(CAP));
			for (let i = 0; i < 200; i++) {
				const e = w.spawn();
				w.addComponent(e, Pos, { x: i, y: i * 3 });
				if (i % 3 === 0) w.addComponent(e, Vel, { vx: i, vy: -i });
			}
			w.flush();
			return w;
		};
		const zero = build(0);
		const high = build(65536);
		expect(high.snapshots.stateHash()).toBe(zero.snapshots.stateHash());
		expect(new Uint8Array(high.snapshots.capture())).toEqual(
			new Uint8Array(zero.snapshots.capture())
		);
	});

	// A snapshot carries no base, so a heap world's bytes mount into a world
	// hosted inside a WASM memory, and the reverse.
	it("a snapshot taken at one base restores into a world at another", () => {
		const pattern = (i: number): number => (i * 13 + 5) & 0xff;
		const build = (storeBase: number) => {
			const allocator = heapArrayBufferAllocator(CAP);
			if (storeBase > 0) {
				const claimed = new Uint8Array(allocator(storeBase), 0, storeBase);
				for (let i = 0; i < claimed.length; i++) claimed[i] = pattern(i);
			}
			const { w, Pos } = world(storeBase, allocator);
			// Both worlds must reach the same archetype set before the mount.
			for (let i = 0; i < 64; i++) {
				const e = w.spawn();
				w.addComponent(e, Pos, { x: 0, y: 0 });
			}
			w.flush();
			return { w, Pos, allocator };
		};
		const source = build(0);
		const target = build(65536);
		let i = 0;
		source.w.query(source.Pos).forEachEntity((eid) => {
			source.w.setField(eid, source.Pos, "x", i++);
		});

		target.w.snapshots.restore(source.w.snapshots.capture());
		expect(target.w.snapshots.stateHash()).toBe(source.w.snapshots.stateHash());
		// The mount must land at the target's base. A restore that placed the
		// store at 0 would still agree on the hash, and would have eaten the
		// bytes a module owns.
		const below = new Uint8Array(target.allocator(65536), 0, 65536);
		for (let b = 0; b < below.length; b++) {
			if (below[b] !== pattern(b)) {
				throw new Error(`byte ${b} below the base changed to ${below[b]}`);
			}
		}
	});
});

/**
 * The base a caller reads out of a module.
 *
 * `storeBaseAbove` exists because the engine cannot read `__heap_base` before
 * the module is instantiated, and a base below it corrupts in silence.
 */
describe("storeBaseAbove", () => {
	const PAGE = WASM_STORE_BASE_BYTES;

	it("rounds a WebAssembly.Global up to the next whole page", () => {
		const exports = {
			__heap_base: new WebAssembly.Global({ value: "i32", mutable: false }, PAGE + 464)
		};
		// Derived from the contract, and not read off a run: one page holds the
		// module's own data, the extra byte pushes into the next one.
		expect(storeBaseAbove(exports)).toBe(2 * PAGE);
		expect(storeBaseAbove(exports) % PAGE).toBe(0);
	});

	it("takes a plain number, and adds the module's run-time heap", () => {
		expect(storeBaseAbove({ __heap_base: PAGE })).toBe(PAGE);
		expect(storeBaseAbove({ __heap_base: PAGE }, 1)).toBe(2 * PAGE);
		expect(storeBaseAbove({ __heap_base: PAGE }, 4 * PAGE)).toBe(5 * PAGE);
	});

	it("never gives a base of 0, which a safe build cannot read", () => {
		expect(storeBaseAbove({ __heap_base: 0 })).toBe(PAGE);
	});

	it("gives a base the wasm arm accepts", () => {
		const storeBase = storeBaseAbove({ __heap_base: 3 * PAGE + 17 });
		const plan = resolveECSMemory({
			storeBase,
			entities: 1024,
			backing: { wasm: { maximumPages: 512 } }
		});
		expect(plan.storeBase).toBe(4 * PAGE);
	});

	it("names the export when the module does not carry it", () => {
		let category = "no throw";
		let message = "";
		try {
			storeBaseAbove({ memory: null });
		} catch (error) {
			category = (error as ECSError).category;
			message = (error as ECSError).message;
		}
		expect(category).toBe(ECS_ERROR.INVALID_MEMORY_OPTIONS);
		expect(message).toContain("__heap_base");
		expect(message).toContain("--export=__heap_base");
	});

	it("refuses an extraBytes that is not a number >= 0", () => {
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			let category = "no throw";
			try {
				storeBaseAbove({ __heap_base: PAGE }, bad);
			} catch (error) {
				category = (error as ECSError).category;
			}
			expect(category).toBe(ECS_ERROR.INVALID_MEMORY_OPTIONS);
		}
	});
});
