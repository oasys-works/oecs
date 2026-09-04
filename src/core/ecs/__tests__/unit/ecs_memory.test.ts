/**
 * ECS memory sizing: the single `ECSOptions.memory` surface.
 *
 * Covers: arm resolution + derivation arithmetic, the in-place
 * boundary (type-level brand + runtime backstop, Store constructor assert),
 * the loud migration guard for the removed knobs, and the intent-aware
 * STORE_CAP_EXCEEDED fatal (semantics unchanged, still no fallback).
 */
import { describe, it, expect } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import type { EntityID } from "../../entity";
import {
	resolveECSMemory,
	DEFAULT_ECS_CAP_BYTES,
	BUDGET_GROWTH_HEADROOM,
	BUDGET_DEFAULT_BYTES_PER_ENTITY
} from "../../ecs_memory";
import { DEFAULT_COLUMN_CAPACITY } from "../../utils/constants";
import { ECSError, ECS_ERROR } from "../../utils/error";
import {
	DEFAULT_SAB_ALLOCATOR,
	growableSabAllocator,
	heapArrayBufferAllocator,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	ENTITY_INDEX_BYTES_PER_SLOT,
	type InPlaceBufferAllocator
} from "../../../store";

const MiB = 1024 * 1024;

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

describe("resolve_ecs_memory, axis A: how big", () => {
	it("defaults: 256 MiB cap, 1024 columns, full entity-index reservation", () => {
		const plan = resolveECSMemory();
		expect(plan.source).toBe("heap");
		expect(plan.sizing).toBe("default");
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
		expect(plan.columnCapacity).toBe(DEFAULT_COLUMN_CAPACITY);
		expect(plan.entityIndexCapacity).toBe(ENTITY_INDEX_DEFAULT_CAPACITY);
		expect(plan.allocator.isInPlace).toBe(true);
		expect(plan.wasmMemory).toBeNull();
	});

	it("a columnCapacity pin alone leaves every other number at its default", () => {
		const plan = resolveECSMemory({ columnCapacity: 64 });
		expect(plan.sizing).toBe("default");
		expect(plan.columnCapacity).toBe(64);
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
	});

	it("entities: derives columns, entity index, and cap", () => {
		const entities = 10_000;
		const plan = resolveECSMemory({ entities });
		expect(plan.sizing).toBe("entities");
		// pow2(10_000 / 8 archetypes) = pow2(1250) = 2048
		expect(plan.columnCapacity).toBe(2048);
		// pow2(2 × 10_000) = 32768
		expect(plan.entityIndexCapacity).toBe(32_768);
		// index + columns lands under the 4 MiB floor for this count
		const raw =
			32_768 * ENTITY_INDEX_BYTES_PER_SLOT +
			entities * BUDGET_DEFAULT_BYTES_PER_ENTITY * BUDGET_GROWTH_HEADROOM;
		expect(raw).toBeLessThan(4 * MiB);
		expect(plan.capBytes).toBe(4 * MiB);
		expect(plan.budgetEntities).toBe(entities);
		expect(plan.intentLabel).toContain("10000 entities");
		expect(plan.derivation.length).toBeGreaterThan(0);
	});

	it("entities: a large count sizes the cap above the floor", () => {
		const entities = 500_000;
		const plan = resolveECSMemory({ entities, bytesPerEntity: 64 });
		const indexBytes = plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT;
		const columnBytes = entities * 64 * BUDGET_GROWTH_HEADROOM;
		expect(plan.capBytes).toBeGreaterThanOrEqual(indexBytes + columnBytes);
		// 64 KiB page-aligned
		expect((plan.capBytes as number) % (64 * 1024)).toBe(0);
	});

	it("entities: rejects a count beyond the EntityID index space", () => {
		expectInvalid(() => resolveECSMemory({ entities: (1 << 20) + 1 }), "EntityID index space");
	});

	it("maxBytes: caller-declared cap, index clamped under it", () => {
		const plan = resolveECSMemory({ maxBytes: 8 * MiB });
		expect(plan.sizing).toBe("maxBytes");
		expect(plan.capBytes).toBe(8 * MiB);
		expect(plan.columnCapacity).toBe(DEFAULT_COLUMN_CAPACITY);
		const pinned = resolveECSMemory({ maxBytes: 8 * MiB, columnCapacity: 256 });
		expect(pinned.columnCapacity).toBe(256);
		// entity index reserves at most a quarter of the cap
		expect(plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT).toBeLessThanOrEqual(
			(8 * MiB) / 4
		);
	});

	// The combination the pre-0.6 union made a type error. It is the case where
	// the old shape was most wrong: with no way to say both, the index was sized
	// backwards from the cap and over-reserved by a wide margin.
	it("entities + maxBytes: the count sizes the index, the cap is the caller's", () => {
		const plan = resolveECSMemory({ entities: 50_000, archetypes: 4, maxBytes: 64 * MiB });
		expect(plan.sizing).toBe("entities+maxBytes");
		expect(plan.capBytes).toBe(64 * MiB);
		// pow2(50_000 / 4) = 16384, and pow2(2 × 50_000) = 131072
		expect(plan.columnCapacity).toBe(16_384);
		expect(plan.entityIndexCapacity).toBe(131_072);
		// Sized backwards from a 64 MiB cap the index would have taken the full
		// EntityID space, eight times what the count needs.
		expect(plan.entityIndexCapacity).toBeLessThan(ENTITY_INDEX_DEFAULT_CAPACITY);
	});

	it("rejects a shaping number given without an entity count", () => {
		expectInvalid(() => resolveECSMemory({ archetypes: 4 }), "memory.entities");
		expectInvalid(() => resolveECSMemory({ bytesPerEntity: 32 }), "memory.entities");
	});

	it("rejects a non-positive maxBytes", () => {
		const malformed = JSON.parse('{ "maxBytes": 0 }');
		expectInvalid(() => resolveECSMemory(malformed), "maxBytes");
	});
});

describe("resolve_ecs_memory, axis B: what backs it", () => {
	it("heap (the default): a plain ArrayBuffer, never a SharedArrayBuffer", () => {
		const plan = resolveECSMemory({ backing: "heap" });
		expect(plan.source).toBe("heap");
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
		expect(plan.allocator.isInPlace).toBe(true);
		expect(plan.wasmMemory).toBeNull();
		const buf = plan.allocator(1024);
		expect(buf).toBeInstanceOf(ArrayBuffer);
		expect(buf instanceof SharedArrayBuffer).toBe(false);
	});

	it("shared: a SharedArrayBuffer backing", () => {
		const plan = resolveECSMemory({ backing: "shared" });
		expect(plan.source).toBe("shared");
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
		expect(plan.allocator.isInPlace).toBe(true);
		expect(plan.allocator(1024)).toBeInstanceOf(SharedArrayBuffer);
	});

	it("wasm (engine-constructed): cap from maximumPages, Memory exposed", () => {
		const plan = resolveECSMemory({ backing: { wasm: { maximumPages: 256 } } });
		expect(plan.source).toBe("wasm");
		expect(plan.capBytes).toBe(256 * 64 * 1024);
		expect(plan.wasmMemory).toBeInstanceOf(WebAssembly.Memory);
		expect(plan.allocator.isInPlace).toBe(true);
	});

	it("wasm (bring-your-own): accepts a shared Memory, cap unknowable", () => {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
		const plan = resolveECSMemory({ backing: { wasm: { memory } } });
		expect(plan.wasmMemory).toBe(memory);
		expect(plan.capBytes).toBeNull();
	});

	it("wasm (bring-your-own): rejects a non-shared Memory at construction", () => {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64 });
		expectInvalid(() => resolveECSMemory({ backing: { wasm: { memory } } }), "shared: true");
	});

	it("wasm: rejects initialPages above maximumPages", () => {
		expectInvalid(
			() => resolveECSMemory({ backing: { wasm: { maximumPages: 4, initialPages: 8 } } }),
			"exceeds maximumPages"
		);
	});

	// The one place the two axes really do collide: a WASM Memory's page maximum
	// is the ceiling, so a second ceiling beside it would be two answers to one
	// question. Named as a conflict rather than silently ignored.
	it("wasm: rejects a maxBytes beside the page maximum", () => {
		expectInvalid(
			() => resolveECSMemory({ maxBytes: 8 * MiB, backing: { wasm: { maximumPages: 256 } } }),
			"Declare it once, in pages"
		);
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
		expectInvalid(
			() => resolveECSMemory({ maxBytes: 8 * MiB, backing: { wasm: { memory } } }),
			"declares its own ceiling"
		);
	});

	it("allocator: accepts an in-place allocator and takes maxBytes as the declared cap", () => {
		const plan = resolveECSMemory({
			maxBytes: 16 * MiB,
			backing: { allocator: growableSabAllocator(16 * MiB) }
		});
		expect(plan.source).toBe("allocator");
		expect(plan.capBytes).toBe(16 * MiB);
	});

	it("allocator: runtime backstop rejects a non-in-place allocator", () => {
		// boundary: deliberately defeating the InPlaceBufferAllocator brand, the
		// whole point of this test is that the *runtime* backstop catches what an
		// untyped JS caller could pass despite the compile-time boundary.
		const defeated = DEFAULT_SAB_ALLOCATOR as InPlaceBufferAllocator;
		expectInvalid(
			() => resolveECSMemory({ backing: { allocator: defeated } }),
			"must declare `isInPlace: true`"
		);
	});

	// Regression, found by the P11 grid probe. Before 0.6 this branch hardcoded
	// the full EntityID reservation and ignored the declared cap, so the index
	// alone (about 12.6 MiB) did not fit and the world could not be built at all.
	// Every other backing already derived the index from the cap.
	it("allocator: a small declared cap sizes the index to fit under it", () => {
		const cap = 4 * MiB;
		const plan = resolveECSMemory({
			maxBytes: cap,
			backing: { allocator: heapArrayBufferAllocator(cap) }
		});
		expect(plan.entityIndexCapacity).toBeLessThan(ENTITY_INDEX_DEFAULT_CAPACITY);
		expect(plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT).toBeLessThanOrEqual(cap / 4);
		// And the world actually builds, which is the part that used to throw.
		const world = new ECS({
			memory: { maxBytes: cap, backing: { allocator: heapArrayBufferAllocator(cap) } }
		});
		const Pos = world.registerComponent({ x: "i32" });
		world.startup();
		const T = world.template(Pos({ x: 1 }));
		for (let i = 0; i < 500; i++) world.spawn(T);
		expect(world.entityCount).toBe(500);
	});

	it("rejects a backing that is neither a known name nor a known shape", () => {
		const malformed = JSON.parse('{ "backing": "gpu" }');
		expectInvalid(() => resolveECSMemory(malformed), "memory.backing must be");
	});
});

describe("resolve_ecs_memory, the axes are independent", () => {
	// The claim the flattening rests on, and the reason the P11 probe ran first:
	// one sizing intent must give one set of numbers on every backing.
	it("one entity count gives the same sizing on every backing", () => {
		const entities = 50_000;
		const plans = [
			resolveECSMemory({ entities, backing: "heap" }),
			resolveECSMemory({ entities, backing: "shared" }),
			resolveECSMemory({ entities, backing: { allocator: heapArrayBufferAllocator(32 * MiB) } }),
			resolveECSMemory({ entities, backing: { wasm: { maximumPages: 512 } } })
		];
		for (const plan of plans) {
			expect(plan.columnCapacity).toBe(plans[0].columnCapacity);
			expect(plan.entityIndexCapacity).toBe(plans[0].entityIndexCapacity);
			expect(plan.budgetEntities).toBe(entities);
		}
		// And it is the count that decided it, not the default.
		expect(plans[0].entityIndexCapacity).toBe(131_072);
	});

	it("every backing accepts a column pin without disturbing the rest", () => {
		for (const backing of ["heap", "shared"] as const) {
			const plan = resolveECSMemory({ entities: 10_000, columnCapacity: 512, backing });
			expect(plan.columnCapacity).toBe(512);
			expect(plan.entityIndexCapacity).toBe(32_768);
		}
	});
});

describe("ECS memory wiring", () => {
	it("exposes the resolved plan and the wasm Memory", () => {
		const world = new ECS({ memory: { backing: { wasm: { maximumPages: 64 } } } });
		expect(world.memoryPlan.source).toBe("wasm");
		expect(world.wasmMemory).toBeInstanceOf(WebAssembly.Memory);
	});

	it("throws loudly on the removed pre-0.5 memory knobs", () => {
		// boundary: the removed keys no longer typecheck. JSON-ingress shape
		// mimics an unmigrated untyped caller.
		const stale = JSON.parse('{ "initial_capacity": 64 }');
		expectInvalid(() => new ECS(stale), "replaced by ECSOptions.memory");
	});

	// The pre-0.6 arms are removed, not aliased. A silently-ignored `budget`
	// would size a world wrong and only surface as a cap failure much later.
	it("throws loudly on each removed pre-0.6 arm and names the rewrite", () => {
		const cases: readonly [string, string][] = [
			['{ "budget": { "entities": 10 } }', "{ entities: N }"],
			['{ "heap": { "maxBytes": 1048576 } }', 'backing: "heap"'],
			['{ "shared": {} }', 'backing: "shared"'],
			['{ "wasm": { "maximumPages": 4 } }', "backing: { wasm: W }"],
			['{ "capBytesHint": 1048576 }', "{ maxBytes: X }"]
		];
		for (const [json, fragment] of cases) {
			expectInvalid(() => resolveECSMemory(JSON.parse(json)), fragment);
		}
	});

	it("an entity count enforces the entity-index reservation it derives", () => {
		const world = new ECS({ memory: { entities: 100 } });
		// pow2(2 × 100) = 256, floored at 4096 slots
		expect(world.memoryPlan.entityIndexCapacity).toBe(4096);
	});
});

describe("Store in-place backstop + intent-aware cap fatal", () => {
	it("Store rejects a non-in-place allocator at construction", () => {
		// boundary: brand deliberately defeated to exercise the runtime assert.
		const defeated = DEFAULT_SAB_ALLOCATOR as InPlaceBufferAllocator;
		expectInvalid(
			() => new Store({ bufferAllocator: defeated }),
			"requires an in-place SAB allocator"
		);
	});

	it("cap hit stays fatal and names the declared intent and budget ratio", () => {
		const cap = 1 * MiB;
		const store = new Store({
			initialCapacity: 4,
			entityIndexCapacity: 1 << 16,
			bufferAllocator: growableSabAllocator(cap),
			capContext: {
				capBytes: cap,
				intentLabel: "budget of 1000 entities",
				budgetEntities: 1000
			}
		});
		const Pos = store.registerComponent({ x: "f64", y: "f64" } as const);
		let thrown: unknown;
		try {
			// Push column doubling past the 1 MiB cap. Each entity is 16 B of
			// column data. Doublings march 4 → ... → 65536 rows (1 MiB) and the
			// next grow request crosses the cap well before the index ceiling.
			for (let i = 0; i < 1 << 16; i++) {
				const e = store.createEntity();
				store.addComponent(e, Pos, { x: i, y: i });
			}
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ECSError);
		const err = thrown as ECSError;
		expect(err.category).toBe(ECS_ERROR.STORE_CAP_EXCEEDED);
		expect(err.message).toContain("budget of 1000 entities");
		expect(err.message).toContain("× the budget");
		expect(err.message).toContain("hard ceiling");
	});

	// Spawn-path counterpart of the clean `addComponent` cap test above.
	// `spawn` and `spawnMany` used to commit the entity slot before the column write
	// that can throw, so a cap hit mid-spawn left a phantom-alive slot: counts
	// over-counted by one, the id unreachable. The fix reserves column capacity
	// before committing the slot, so the throw lands with the world untouched.
	it("spawn cap hit leaves no phantom-alive slot", () => {
		const cap = 1 * MiB;
		const store = new Store({
			initialCapacity: 4,
			entityIndexCapacity: 1 << 16,
			bufferAllocator: growableSabAllocator(cap)
		});
		const Pos = store.registerComponent({ x: "f64", y: "f64" } as const);
		const tmpl = store.createTemplate([{ def: Pos }]);

		const ids: EntityID[] = [];
		let thrown: unknown;
		try {
			// 16 B/row. Column doublings march to the 1 MiB cap, then the next
			// spawn's grow request overflows it, well before the index ceiling.
			for (let i = 0; i < 1 << 16; i++) ids.push(store.spawn(tmpl));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ECSError);
		expect((thrown as ECSError).category).toBe(ECS_ERROR.STORE_CAP_EXCEEDED);

		// We actually drove into the cap (not an empty / off-by-one loop).
		expect(ids.length).toBeGreaterThan(0);
		// No phantom-alive slot: the live count equals exactly the ids handed back,
		// the failed spawn committed nothing, and every returned id is alive.
		expect(store.entityCount).toBe(ids.length);
		for (const id of ids) expect(store.isAlive(id)).toBe(true);
	});

	it("spawn_many cap hit is atomic, no partial or phantom batch", () => {
		const cap = 1 * MiB;
		// Same index sizing as the clean-path test: 1<<16 slots reserve ~0.75 MiB,
		// which fits under the 1 MiB cap at construction and leaves the SAB *column*
		// grow, not the index ceiling or a construction-time reservation, as the
		// cap throw under test.
		const store = new Store({
			initialCapacity: 4,
			entityIndexCapacity: 1 << 16,
			bufferAllocator: growableSabAllocator(cap)
		});
		const Pos = store.registerComponent({ x: "f64", y: "f64" } as const);
		const tmpl = store.createTemplate([{ def: Pos }]);

		// One bulk spawn whose column reservation (1<<16 rows × 16 B = 1 MiB, atop
		// the index region) blows past the cap. The index pre-check passes (count
		// fits the index space), so `reserveRows` is the throw, and it
		// fires before any slot is committed.
		const before = store.entityCount;
		let thrown: unknown;
		try {
			store.spawnMany(tmpl, 1 << 16);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ECSError);
		expect((thrown as ECSError).category).toBe(ECS_ERROR.STORE_CAP_EXCEEDED);
		// All-or-nothing: the overflowing batch rolled back to the pre-call count.
		expect(store.entityCount).toBe(before);
	});
});
