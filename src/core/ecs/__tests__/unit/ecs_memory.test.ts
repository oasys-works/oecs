/**
 * ECS memory sizing (#682): the single `ECSOptions.memory` surface.
 *
 * Covers: arm resolution + derivation arithmetic, the ADR-0008 in-place
 * boundary (type-level brand + runtime backstop, Store constructor assert),
 * the loud migration guard for the removed knobs, and the intent-aware
 * STORE_CAP_EXCEEDED fatal (#380 semantics unchanged — still no fallback).
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

describe("resolve_ecs_memory", () => {
	it("defaults: growable 256 MiB cap, 1024 columns, full entity-index reservation", () => {
		const plan = resolveECSMemory();
		expect(plan.source).toBe("default");
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
		expect(plan.columnCapacity).toBe(DEFAULT_COLUMN_CAPACITY);
		expect(plan.entityIndexCapacity).toBe(ENTITY_INDEX_DEFAULT_CAPACITY);
		expect(plan.allocator.isInPlace).toBe(true);
		expect(plan.wasmMemory).toBeNull();
	});

	it("no-arm column_capacity pin is the minimal initial_capacity migration", () => {
		const plan = resolveECSMemory({ columnCapacity: 64 });
		expect(plan.source).toBe("default");
		expect(plan.columnCapacity).toBe(64);
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
	});

	it("budget: derives columns, entity index, and cap from declared entities", () => {
		const entities = 10_000;
		const plan = resolveECSMemory({ budget: { entities } });
		// pow2(10_000 / 8 archetypes) = pow2(1250) = 2048
		expect(plan.columnCapacity).toBe(2048);
		// pow2(2 × 10_000) = 32768
		expect(plan.entityIndexCapacity).toBe(32_768);
		// index + columns lands under the 4 MiB floor for this budget
		const raw =
			32_768 * ENTITY_INDEX_BYTES_PER_SLOT +
			entities * BUDGET_DEFAULT_BYTES_PER_ENTITY * BUDGET_GROWTH_HEADROOM;
		expect(raw).toBeLessThan(4 * MiB);
		expect(plan.capBytes).toBe(4 * MiB);
		expect(plan.budgetEntities).toBe(entities);
		expect(plan.intentLabel).toContain("10000 entities");
		expect(plan.derivation.length).toBeGreaterThan(0);
	});

	it("budget: large budgets size the cap above the floor", () => {
		const entities = 500_000;
		const plan = resolveECSMemory({ budget: { entities, bytesPerEntity: 64 } });
		const indexBytes = plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT;
		const columnBytes = entities * 64 * BUDGET_GROWTH_HEADROOM;
		expect(plan.capBytes).toBeGreaterThanOrEqual(indexBytes + columnBytes);
		// 64 KiB page-aligned
		expect((plan.capBytes as number) % (64 * 1024)).toBe(0);
	});

	it("budget: rejects entities beyond the EntityID index space", () => {
		expectInvalid(
			() => resolveECSMemory({ budget: { entities: (1 << 20) + 1 } }),
			"EntityID index space"
		);
	});

	it("max_bytes: caller-declared cap with default and pinned columns", () => {
		const plan = resolveECSMemory({ maxBytes: 8 * MiB });
		expect(plan.capBytes).toBe(8 * MiB);
		expect(plan.columnCapacity).toBe(DEFAULT_COLUMN_CAPACITY);
		const pinned = resolveECSMemory({ maxBytes: 8 * MiB, columnCapacity: 256 });
		expect(pinned.columnCapacity).toBe(256);
		// entity index reserves at most a quarter of the cap
		expect(plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT).toBeLessThanOrEqual(
			(8 * MiB) / 4
		);
	});

	it("wasm (engine-constructed): cap from maximum_pages, Memory exposed", () => {
		const plan = resolveECSMemory({ wasm: { maximumPages: 256 } });
		expect(plan.capBytes).toBe(256 * 64 * 1024);
		expect(plan.wasmMemory).toBeInstanceOf(WebAssembly.Memory);
		expect(plan.allocator.isInPlace).toBe(true);
	});

	it("wasm (bring-your-own): accepts a shared Memory, cap unknowable", () => {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
		const plan = resolveECSMemory({ wasm: { memory } });
		expect(plan.wasmMemory).toBe(memory);
		expect(plan.capBytes).toBeNull();
	});

	it("wasm (bring-your-own): rejects a non-shared Memory at construction", () => {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64 });
		expectInvalid(() => resolveECSMemory({ wasm: { memory } }), "shared: true");
	});

	it("wasm: rejects initial_pages above maximum_pages", () => {
		expectInvalid(
			() => resolveECSMemory({ wasm: { maximumPages: 4, initialPages: 8 } }),
			"exceeds maximum_pages"
		);
	});

	it("allocator: accepts an in-place allocator and honours the cap hint", () => {
		const plan = resolveECSMemory({
			allocator: growableSabAllocator(16 * MiB),
			capBytesHint: 16 * MiB
		});
		expect(plan.source).toBe("allocator");
		expect(plan.capBytes).toBe(16 * MiB);
	});

	it("allocator: runtime backstop rejects a non-in-place allocator (ADR-0008)", () => {
		// boundary: deliberately defeating the InPlaceBufferAllocator brand — the
		// whole point of this test is that the *runtime* backstop catches what
		// an untyped JS caller could pass despite the compile-time boundary.
		const defeated = DEFAULT_SAB_ALLOCATOR as InPlaceBufferAllocator;
		expectInvalid(() => resolveECSMemory({ allocator: defeated }), "ADR-0008");
	});

	it("heap: resolves a non-SAB ArrayBuffer backing with the default cap (ADR-0018 §1B)", () => {
		const plan = resolveECSMemory({ heap: {} });
		expect(plan.source).toBe("heap");
		expect(plan.capBytes).toBe(DEFAULT_ECS_CAP_BYTES);
		expect(plan.columnCapacity).toBe(DEFAULT_COLUMN_CAPACITY);
		expect(plan.allocator.isInPlace).toBe(true);
		expect(plan.wasmMemory).toBeNull();
		// The allocator hands back a plain ArrayBuffer, never a SharedArrayBuffer.
		const buf = plan.allocator(1024);
		expect(buf).toBeInstanceOf(ArrayBuffer);
		expect(buf instanceof SharedArrayBuffer).toBe(false);
	});

	it("heap: honours an explicit max_bytes and a column pin", () => {
		const plan = resolveECSMemory({ heap: { maxBytes: 8 * MiB }, columnCapacity: 128 });
		expect(plan.source).toBe("heap");
		expect(plan.capBytes).toBe(8 * MiB);
		expect(plan.columnCapacity).toBe(128);
		// #710: the entity-index reservation is clamped under the cap (same
		// quarter-of-cap rule as the maxBytes arm). Without this the heap arm
		// reserved the full ~12 MiB default, so an 8 MiB cap threw at Store
		// construction. It must be at most a quarter of the cap and strictly
		// smaller than the full default the `heap: {}` case keeps.
		expect(plan.entityIndexCapacity * ENTITY_INDEX_BYTES_PER_SLOT).toBeLessThanOrEqual(
			(8 * MiB) / 4
		);
		expect(plan.entityIndexCapacity).toBeLessThan(ENTITY_INDEX_DEFAULT_CAPACITY);
	});

	it("heap: rejects a non-positive max_bytes", () => {
		const malformed = JSON.parse('{ "heap": { "maxBytes": 0 } }');
		expectInvalid(() => resolveECSMemory(malformed), "heap.max_bytes");
	});

	it("rejects multiple sizing arms", () => {
		// boundary: two-arm literals are a compile error (never-fields); build
		// the malformed shape through the JSON-ingress style to test the
		// runtime guard untyped callers hit.
		const malformed = JSON.parse('{ "budget": { "entities": 10 }, "maxBytes": 1048576 }');
		expectInvalid(() => resolveECSMemory(malformed), "at most one of");
	});

	it("rejects the heap arm combined with another sizing arm", () => {
		const malformed = JSON.parse('{ "heap": {}, "maxBytes": 1048576 }');
		expectInvalid(() => resolveECSMemory(malformed), "at most one of");
	});
});

describe("ECS memory wiring (#682)", () => {
	it("exposes the resolved plan and the wasm Memory", () => {
		const world = new ECS({ memory: { wasm: { maximumPages: 64 } } });
		expect(world.memoryPlan.source).toBe("wasm");
		expect(world.wasmMemory).toBeInstanceOf(WebAssembly.Memory);
	});

	it("throws loudly on the removed pre-#682 knobs", () => {
		// boundary: the removed keys no longer typecheck; JSON-ingress shape
		// mimics an unmigrated untyped caller.
		const stale = JSON.parse('{ "initial_capacity": 64 }');
		expectInvalid(() => new ECS(stale), "replaced by ECSOptions.memory");
	});

	it("budget worlds enforce the entity-index reservation derived from the budget", () => {
		const world = new ECS({ memory: { budget: { entities: 100 } } });
		// pow2(2 × 100) = 256, floored at 4096 slots
		expect(world.memoryPlan.entityIndexCapacity).toBe(4096);
	});
});

describe("Store in-place backstop + intent-aware cap fatal", () => {
	it("Store rejects a non-in-place allocator at construction (ADR-0008)", () => {
		// boundary: brand deliberately defeated to exercise the runtime assert.
		const defeated = DEFAULT_SAB_ALLOCATOR as InPlaceBufferAllocator;
		expectInvalid(() => new Store({ bufferAllocator: defeated }), "ADR-0008");
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
			// column data; doublings march 4 → ... → 65536 rows (1 MiB) and the
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
		expect(err.message).toContain("#380");
	});

	// Spawn-path counterpart of the clean `addComponent` cap test above (#775).
	// `spawn`/`spawnMany` used to commit the entity slot before the column write
	// that can throw, so a cap hit mid-spawn left a phantom-alive slot: counts
	// over-counted by one, the id unreachable. The fix reserves column capacity
	// before committing the slot, so the throw lands with the world untouched.
	it("spawn cap hit leaves no phantom-alive slot (#775)", () => {
		const cap = 1 * MiB;
		const store = new Store({
			initialCapacity: 4,
			entityIndexCapacity: 1 << 16,
			bufferAllocator: growableSabAllocator(cap)
		});
		const Pos = store.registerComponent({ x: "f64", y: "f64" } as const);
		const tmpl = store.resolveTemplate([{ def: Pos }]);

		const ids: EntityID[] = [];
		let thrown: unknown;
		try {
			// 16 B/row; column doublings march to the 1 MiB cap, then the next
			// spawn's grow request overflows it — well before the index ceiling.
			for (let i = 0; i < 1 << 16; i++) ids.push(store.spawn(tmpl));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ECSError);
		expect((thrown as ECSError).category).toBe(ECS_ERROR.STORE_CAP_EXCEEDED);

		// We actually drove into the cap (not an empty / off-by-one loop).
		expect(ids.length).toBeGreaterThan(0);
		// No phantom-alive slot: the live count equals exactly the ids handed back
		// — the failed spawn committed nothing — and every returned id is alive.
		expect(store.entityCount).toBe(ids.length);
		for (const id of ids) expect(store.isAlive(id)).toBe(true);
	});

	it("spawn_many cap hit is atomic — no partial / phantom batch (#775)", () => {
		const cap = 1 * MiB;
		// Same index sizing as the clean-path test: 1<<16 slots reserve ~0.75 MiB,
		// which fits under the 1 MiB cap at construction and leaves the SAB *column*
		// grow — not the index ceiling or a construction-time reservation — as the
		// cap throw under test.
		const store = new Store({
			initialCapacity: 4,
			entityIndexCapacity: 1 << 16,
			bufferAllocator: growableSabAllocator(cap)
		});
		const Pos = store.registerComponent({ x: "f64", y: "f64" } as const);
		const tmpl = store.resolveTemplate([{ def: Pos }]);

		// One bulk spawn whose column reservation (1<<16 rows × 16 B = 1 MiB, atop
		// the index region) blows past the cap. The index pre-check passes (count
		// fits the index space), so `ensureRowCapacity` is the throw — and it
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
