/**
 * Pure-TS heap backing (`memory: { heap: {} }`) — ADR-0018 §1B / the oecs
 * profile. The engine's core/ecs runs over a plain resizable `ArrayBuffer`
 * instead of a `SharedArrayBuffer`: no cross-origin isolation, no worker/WASM
 * transfer. These tests prove the heap world is functionally a peer of the SAB
 * world — construct, grow, tick, query, structural change, determinism,
 * snapshot/restore — and that it needs no `SharedArrayBuffer` global at all.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { ComponentDef } from "../../component";
import type { EntityID } from "../../entity";
import {
	heapArraybufferAllocator,
	growableSabAllocator,
	snapshotColumnStore,
	restoreColumnStore,
	columnStoreStateHash,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	SabUnavailableError
} from "../../../store";

const MiB = 1024 * 1024;

const isSab = (b: unknown): boolean =>
	typeof SharedArrayBuffer !== "undefined" && b instanceof SharedArrayBuffer;

/** A world with a Pos/Vel move system; spawns `n` movers (n > default column
 * capacity forces an in-place grow) and ticks `steps` times. Returns the world
 * plus probes so callers can assert integrated state. */
function worldWithMovers(
	memory: ConstructorParameters<typeof ECS>[0],
	n: number,
	steps: number
): { world: ECS; Pos: ComponentDef; Vel: ComponentDef; ids: EntityID[]; dt: number } {
	const world = new ECS(memory);
	// A `{ deterministic: true }` world rejects f32/f64 columns (#777), so size the
	// mover columns as integers there; non-deterministic worlds keep f64 for the
	// fractional-dt precision assertions (`toBeCloseTo`) the grow tests rely on.
	const colType = world.deterministic ? "i32" : "f64";
	const Pos = world.registerComponent(["x", "y"] as const, colType);
	const Vel = world.registerComponent(["vx", "vy"] as const, colType);
	const movers = world.query(Pos, Vel);
	const move = world.registerSystem({
		// exclusive grant keeps the dev-only access-declaration check out of the
		// way; this test is about storage, not access policy.
		exclusive: true,
		reads: [],
		writes: [],
		fn: (ctx, dt) => {
			movers.forEach((arch) => {
				const vx = arch.getColumnRead(Vel, "vx");
				const vy = arch.getColumnRead(Vel, "vy");
				const ids = arch.entityIds;
				for (let i = 0; i < arch.entityCount; i++) {
					const pos = ctx.ref(Pos, ids[i]);
					pos.x += vx[i] * dt;
					pos.y += vy[i] * dt;
				}
			});
		}
	});
	world.addSystems(SCHEDULE.UPDATE, move);
	world.startup();

	const ids: EntityID[] = [];
	for (let i = 0; i < n; i++) {
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: i, y: 0 });
		world.addComponent(e, Vel, { vx: 1, vy: 2 });
		ids.push(e);
	}
	world.flush();

	const dt = 0.5;
	for (let s = 0; s < steps; s++) world.update(dt);
	return { world, Pos, Vel, ids, dt };
}

describe("heap backing: construct + grow + tick", () => {
	it("runs over a plain ArrayBuffer (never a SharedArrayBuffer)", () => {
		const { world } = worldWithMovers({ memory: { heap: {} } }, 10, 1);
		expect(world.memoryPlan.source).toBe("heap");
		expect(world.columnStore.buffer).toBeInstanceOf(ArrayBuffer);
		expect(isSab(world.columnStore.buffer)).toBe(false);
	});

	it("constructs + ticks + grows under a small heap.max_bytes cap (#710)", () => {
		// Regression: the heap arm used to hardcode the full entity-index
		// reservation (~12 MiB), so any `heap.maxBytes` below that threw
		// StoreCapExceededError at `new ECS(...)` — before the world even existed.
		// A small-cap heap world must construct, tick, and grow like the
		// equivalent maxBytes SAB world (whose arm always clamped the index).
		const N = 2000; // > default column cap (1024) → forces an in-place grow under the cap
		const steps = 5;
		const { world, Pos, ids, dt } = worldWithMovers(
			{ memory: { heap: { maxBytes: 8 * MiB } } },
			N,
			steps
		);
		expect(world.memoryPlan.source).toBe("heap");
		expect(world.columnStore.buffer).toBeInstanceOf(ArrayBuffer);
		// the entity index was sized under the cap, not at the full default
		expect(world.memoryPlan.entityIndexCapacity).toBeLessThan(ENTITY_INDEX_DEFAULT_CAPACITY);
		expect(world.getField(ids[N - 1], Pos, "x")).toBeCloseTo(N - 1 + dt * steps, 9);
	});

	it("integrates correctly across an in-place grow (5000 > default column cap)", () => {
		const N = 5000;
		const steps = 10;
		const { world, Pos, ids, dt } = worldWithMovers({ memory: { heap: {} } }, N, steps);
		// values survive the buffer resize(s) triggered by spawning past capacity
		for (const p of [0, 1, 1023, 1024, 2500, N - 1]) {
			expect(world.getField(ids[p], Pos, "x")).toBeCloseTo(p + dt * steps, 9);
			expect(world.getField(ids[p], Pos, "y")).toBeCloseTo(2 * dt * steps, 9);
		}
		expect(isSab(world.columnStore.buffer)).toBe(false);
	});

	it("supports structural changes (remove component, destroy entity)", () => {
		const { world, Pos, Vel, ids } = worldWithMovers({ memory: { heap: {} } }, 100, 1);
		expect(world.query(Pos, Vel).count()).toBe(100);

		world.removeComponent(ids[0], Vel);
		world.destroyEntity(ids[1]);
		world.flush();

		expect(world.query(Pos, Vel).count()).toBe(98); // -1 removed Vel, -1 destroyed
		expect(world.hasComponent(ids[0], Vel)).toBe(false);
		expect(world.hasComponent(ids[0], Pos)).toBe(true);
		expect(world.isAlive(ids[1])).toBe(false);
	});
});

describe("heap backing: determinism is backing-agnostic", () => {
	const build = (memory: ConstructorParameters<typeof ECS>[0]): number => {
		const { world } = worldWithMovers(memory, 200, 4);
		return world.stateHash();
	};

	it("two heap worlds with identical history agree on state_hash", () => {
		expect(build({ memory: { heap: {} }, deterministic: true })).toBe(
			build({ memory: { heap: {} }, deterministic: true })
		);
	});

	it("a heap world and a shared (SharedArrayBuffer) world agree on state_hash", () => {
		// The digest folds column bytes, not the buffer kind — so swapping the
		// backing must not perturb it.
		expect(build({ memory: { heap: {} }, deterministic: true })).toBe(
			build({ memory: { shared: {} }, deterministic: true })
		);
	});
});

describe("shared backing: opt-in SharedArrayBuffer profile", () => {
	it("`memory: { shared: {} }` is backed by a SharedArrayBuffer and ticks", () => {
		const { world, Pos, ids, dt } = worldWithMovers({ memory: { shared: {} } }, 100, 3);
		expect(world.memoryPlan.source).toBe("shared");
		expect(world.columnStore.buffer).toBeInstanceOf(SharedArrayBuffer);
		expect(isSab(world.columnStore.buffer)).toBe(true);
		expect(world.getField(ids[99], Pos, "x")).toBeCloseTo(99 + dt * 3, 9);
	});
});

describe("heap backing: snapshot / restore", () => {
	it("round-trips a heap snapshot into another heap buffer, digest-identical", () => {
		const { world } = worldWithMovers({ memory: { heap: {} } }, 1500, 3);
		const hash = columnStoreStateHash(world.columnStore);

		const snap = new Uint8Array(snapshotColumnStore(world.columnStore)); // stable copy
		const restored = restoreColumnStore(snap, heapArraybufferAllocator());

		expect(isSab(restored.buffer)).toBe(false);
		expect(columnStoreStateHash(restored)).toBe(hash);
	});
});

describe("heap backing: no SharedArrayBuffer in the runtime", () => {
	// Simulate a browser without cross-origin isolation, where the
	// `SharedArrayBuffer` global is absent. `typeof SharedArrayBuffer` then
	// reports "undefined" — the condition the SAB allocators guard on.
	afterEach(() => vi.unstubAllGlobals());

	it("a heap world constructs + ticks with no SharedArrayBuffer global", () => {
		vi.stubGlobal("SharedArrayBuffer", undefined);
		expect(typeof SharedArrayBuffer).toBe("undefined");

		const { world, Pos, ids, dt } = worldWithMovers({ memory: { heap: {} } }, 2000, 5);
		// `isSab` short-circuits to false when the SharedArrayBuffer global is
		// stubbed away, so it can't fail here — assert the buffer is a real
		// ArrayBuffer instead (a check that survives the stub and can fail).
		expect(world.columnStore.buffer).toBeInstanceOf(ArrayBuffer);
		expect(world.getField(ids[1999], Pos, "x")).toBeCloseTo(1999 + dt * 5, 9);
	});

	it("opting into the SAB allocator throws SabUnavailableError when SAB is missing", () => {
		vi.stubGlobal("SharedArrayBuffer", undefined);
		// oecs's default profile is heap (proven above), so `new ECS()` does NOT
		// throw without the global. Only explicitly choosing the SharedArrayBuffer
		// allocator — the `@oasys/oecs/shared` profile — requires it.
		expect(() => new ECS({ memory: { allocator: growableSabAllocator() } })).toThrow(
			SabUnavailableError
		);
	});
});
