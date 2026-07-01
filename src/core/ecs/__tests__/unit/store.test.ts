import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import {
	getEntityIndex,
	getEntityGeneration,
	createEntityId,
	MAX_ENTITY_ID,
	MAX_LIVE_GENERATION,
	RETIRED_GENERATION,
	type EntityID
} from "../../entity";

import type { ComponentDef, ComponentID } from "../../component";
import { BitSet } from "../../../../type_primitives";
import { ECSError, ECS_ERROR } from "../../utils/error";

function makeMask(...ids: (number | ComponentID)[]): BitSet {
	const mask = new BitSet();
	for (const id of ids) mask.set(id as number);
	return mask;
}

// Component schemas
const Position = { x: "f64", y: "f64", z: "f64" } as const;
const Velocity = { vx: "f64", vy: "f64", vz: "f64" } as const;
const Health = { current: "f64", max: "f64" } as const;
const Tag = {} as const; // empty (marker component)
// Two FLOAT (f32) fields — the only column types whose "undefined" coerces to
// NaN (Int* coerce to 0). Used to pin the omitted-field-is-0 contract (#716).
const Float2 = { fx: "f32", fy: "f32" } as const;

describe("Store", () => {
	//=========================================================
	// Entity lifecycle
	//=========================================================

	it("creates entities with incrementing indices", () => {
		const store = new Store();
		const a = store.createEntity();
		const b = store.createEntity();
		expect(getEntityIndex(a)).toBe(0);
		expect(getEntityIndex(b)).toBe(1);
	});

	it("is_alive returns true for living entities", () => {
		const store = new Store();
		const id = store.createEntity();
		expect(store.isAlive(id)).toBe(true);
	});

	it("is_alive returns false after destroy", () => {
		const store = new Store();
		const id = store.createEntity();
		store.destroyEntity(id);
		expect(store.isAlive(id)).toBe(false);
	});

	it("entity_count tracks create/destroy", () => {
		const store = new Store();
		expect(store.entityCount).toBe(0);

		const a = store.createEntity();
		const b = store.createEntity();
		expect(store.entityCount).toBe(2);

		store.destroyEntity(a);
		expect(store.entityCount).toBe(1);

		store.destroyEntity(b);
		expect(store.entityCount).toBe(0);
	});

	it("throws when destroying a dead entity", () => {
		const store = new Store();
		const id = store.createEntity();
		store.destroyEntity(id);
		expect(() => store.destroyEntity(id)).toThrow();
	});

	//=========================================================
	// Generation rollover / slot retirement (#376)
	//=========================================================

	// Drive slot 0 through every live generation (0..MAX_LIVE_GENERATION) so the
	// next destroy exhausts its counter. `destroy` cycles the slot one step;
	// returns the freshly recreated handle occupying slot 0 each time.
	function churnSlotToExhaustion(
		store: Store,
		destroy: (store: Store, id: ReturnType<Store["createEntity"]>) => void
	) {
		let id = store.createEntity();
		expect(getEntityIndex(id)).toBe(0);
		expect(getEntityGeneration(id)).toBe(0);
		const gen0Handle = id;

		for (let g = 0; g < MAX_LIVE_GENERATION; g++) {
			expect(getEntityIndex(id)).toBe(0);
			expect(getEntityGeneration(id)).toBe(g);
			destroy(store, id);
			id = store.createEntity();
		}

		// Slot 0 now holds the last live generation; the next destroy retires it.
		expect(getEntityIndex(id)).toBe(0);
		expect(getEntityGeneration(id)).toBe(MAX_LIVE_GENERATION);
		return { lastLive: id, gen0Handle };
	}

	it("retires a slot once its generation counter is exhausted (immediate destroy)", () => {
		const store = new Store();
		const { lastLive } = churnSlotToExhaustion(store, (s, id) => s.destroyEntity(id));

		store.destroyEntity(lastLive);

		// The exhausted index must NOT be recycled — the next entity takes a fresh slot.
		const next = store.createEntity();
		expect(getEntityIndex(next)).toBe(1);
	});

	it("retires a slot once its generation counter is exhausted (deferred destroy)", () => {
		const store = new Store();
		const { lastLive } = churnSlotToExhaustion(store, (s, id) => {
			s.destroyEntityDeferred(id);
			s.flushDestroyed();
		});

		store.destroyEntityDeferred(lastLive);
		store.flushDestroyed();

		const next = store.createEntity();
		expect(getEntityIndex(next)).toBe(1);
	});

	it("no stale handle to a retired slot ever reads as alive (ABA closed)", () => {
		const store = new Store();
		const { lastLive, gen0Handle } = churnSlotToExhaustion(store, (s, id) =>
			s.destroyEntity(id)
		);
		store.destroyEntity(lastLive);

		// The original generation-0 handle is the classic ABA aliasing risk: a
		// wrapping counter would resurrect it. With retirement it stays dead.
		expect(store.isAlive(gen0Handle)).toBe(false);
		// The just-retired handle is dead too.
		expect(store.isAlive(lastLive)).toBe(false);
		// Every handle the allocator could ever have issued for slot 0 carries a
		// generation in 0..MAX_LIVE_GENERATION; all must read dead.
		for (const gen of [0, 1, MAX_LIVE_GENERATION]) {
			expect(store.isAlive(createEntityId(0, gen))).toBe(false);
		}
		// A forged handle carrying the RETIRED_GENERATION tombstone — the value
		// parked in the retired slot — now reads DEAD (#778, fail-closed). It is
		// never issued to a live entity, so excluding it closes the ABA window from
		// the other side: even a handle aliasing the retired slot's own generation
		// can't read alive.
		expect(store.isAlive(createEntityId(0, RETIRED_GENERATION))).toBe(false);
	});

	it("isAlive is fail-closed for forged / out-of-bounds handles (#778)", () => {
		const store = new Store();
		const live = store.createEntity();
		expect(store.isAlive(live)).toBe(true); // sanity: a real handle still reads alive

		// Out of the 31-bit packed range: negative, and past MAX_ENTITY_ID. Without
		// the bound the 20-bit index mask would fold these onto a valid slot.
		expect(store.isAlive(-1 as EntityID)).toBe(false);
		expect(store.isAlive((MAX_ENTITY_ID + 1) as EntityID)).toBe(false);
		expect(store.isAlive(0xffffffff as EntityID)).toBe(false);
		// A garbage handle whose low 20 bits alias the live slot's index but whose
		// high bits are out of range must NOT inherit the live slot's liveness.
		const aliasedOob = ((MAX_ENTITY_ID + 1) | getEntityIndex(live)) as EntityID;
		expect(store.isAlive(aliasedOob)).toBe(false);
		// The tombstone generation on a never-allocated slot is dead too.
		expect(store.isAlive(createEntityId(0, RETIRED_GENERATION))).toBe(false);
	});

	//=========================================================
	// Component add & archetype transitions (single)
	//=========================================================

	it("add_component transitions entity to new archetype", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const id = store.createEntity();

		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });
		expect(store.hasComponent(id, Pos)).toBe(true);

		// Data is accessible via archetype columns
		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(1);
		expect(arch.readField(row, Pos.id, "y")).toBe(2);
		expect(arch.readField(row, Pos.id, "z")).toBe(3);
	});

	it("add_component overwrites data without transition when component already present", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const id = store.createEntity();

		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });
		const archCountBefore = store.archetypeCount;

		store.addComponent(id, Pos, { x: 10, y: 20, z: 30 });
		expect(store.archetypeCount).toBe(archCountBefore);

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(10);
		expect(arch.readField(row, Pos.id, "y")).toBe(20);
		expect(arch.readField(row, Pos.id, "z")).toBe(30);
	});

	//=========================================================
	// Component remove (single)
	//=========================================================

	it("remove_component transitions entity to smaller archetype", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const id = store.createEntity();

		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });
		store.addComponent(id, Vel, { vx: 4, vy: 5, vz: 6 });
		expect(store.hasComponent(id, Vel)).toBe(true);

		store.removeComponent(id, Vel);
		expect(store.hasComponent(id, Vel)).toBe(false);
		expect(store.hasComponent(id, Pos)).toBe(true);

		// Position data is preserved after transition
		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(1);
		expect(arch.readField(row, Pos.id, "y")).toBe(2);
		expect(arch.readField(row, Pos.id, "z")).toBe(3);
	});

	it("remove_component is a no-op when component not present", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const id = store.createEntity();

		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });

		// Should not throw
		store.removeComponent(id, Vel);
		expect(store.hasComponent(id, Pos)).toBe(true);
	});

	//=========================================================
	// Deferred destruction
	//=========================================================

	it("deferred destroy keeps entity alive until flush", () => {
		const store = new Store();
		const id = store.createEntity();

		store.destroyEntityDeferred(id);
		expect(store.isAlive(id)).toBe(true);
		expect(store.pendingDestroyCount).toBe(1);
	});

	it("flush_destroyed actually destroys entities", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 10, y: 20, z: 30 });

		const archetypes = store.getMatchingArchetypes(makeMask(Pos.id));
		expect(archetypes[0].entityCount).toBe(1);

		store.destroyEntityDeferred(id);
		store.flushDestroyed();

		expect(store.isAlive(id)).toBe(false);
		expect(archetypes[0].entityCount).toBe(0);
		expect(store.pendingDestroyCount).toBe(0);
	});

	it("double deferred destroy of same entity is safe", () => {
		const store = new Store();
		const id = store.createEntity();

		store.destroyEntityDeferred(id);
		store.destroyEntityDeferred(id);
		expect(store.pendingDestroyCount).toBe(2);

		// flush should not throw — second entry is skipped because entity is already dead
		expect(() => store.flushDestroyed()).not.toThrow();
		expect(store.isAlive(id)).toBe(false);
		expect(store.pendingDestroyCount).toBe(0);
	});

	it("immediate destroy_entity still works as before", () => {
		const store = new Store();
		const id = store.createEntity();

		store.destroyEntity(id);
		expect(store.isAlive(id)).toBe(false);
		expect(store.pendingDestroyCount).toBe(0);
	});

	it("pending_destroy_count reflects buffer state", () => {
		const store = new Store();
		const a = store.createEntity();
		const b = store.createEntity();

		expect(store.pendingDestroyCount).toBe(0);

		store.destroyEntityDeferred(a);
		expect(store.pendingDestroyCount).toBe(1);

		store.destroyEntityDeferred(b);
		expect(store.pendingDestroyCount).toBe(2);

		store.flushDestroyed();
		expect(store.pendingDestroyCount).toBe(0);
	});

	//=========================================================
	// Deferred structural changes
	//=========================================================

	it("add_component_deferred keeps entity in old archetype until flush", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });

		// Deferred add — entity should NOT have Velocity yet
		store.addComponentDeferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
		expect(store.hasComponent(id, Vel)).toBe(false);
		expect(store.hasComponent(id, Pos)).toBe(true);

		// After flush, entity transitions
		store.flushStructural();
		expect(store.hasComponent(id, Vel)).toBe(true);
		expect(store.hasComponent(id, Pos)).toBe(true);

		// Data is correct
		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Vel.id, "vx")).toBe(4);
		expect(arch.readField(row, Vel.id, "vy")).toBe(5);
		expect(arch.readField(row, Vel.id, "vz")).toBe(6);
	});

	it("remove_component_deferred keeps component present until flush", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });
		store.addComponent(id, Vel, { vx: 4, vy: 5, vz: 6 });

		// Deferred remove — entity should still have Velocity
		store.removeComponentDeferred(id, Vel);
		expect(store.hasComponent(id, Vel)).toBe(true);

		// After flush, component is removed
		store.flushStructural();
		expect(store.hasComponent(id, Vel)).toBe(false);
		expect(store.hasComponent(id, Pos)).toBe(true);
	});

	it("flush_structural applies adds before removes (same-component add+remove: remove wins)", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const Hp = store.registerComponent(Health);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });

		// Buffer a Vel that is BOTH added and removed in the same flush. This is
		// the only construction that distinguishes the ordering: under
		// adds-before-removes the add lands first and the later remove strips it
		// (Vel ends absent); under removes-first the remove would be a no-op on
		// a not-yet-present Vel and the add would survive (Vel ends present).
		// Final membership alone — as the old test asserted with only-added
		// Vel/Hp and only-removed Pos — cannot tell the two orderings apart.
		store.addComponentDeferred(id, Hp, { current: 100, max: 200 });
		store.addComponentDeferred(id, Vel, { vx: 1, vy: 2, vz: 3 });
		store.removeComponentDeferred(id, Vel);
		store.removeComponentDeferred(id, Pos);

		store.flushStructural();

		// Vel: added then removed → gone. This is the order-pinning assertion.
		expect(store.hasComponent(id, Vel)).toBe(false);
		// Hp: only added → present. Pos: only removed → gone.
		expect(store.hasComponent(id, Hp)).toBe(true);
		expect(store.hasComponent(id, Pos)).toBe(false);
	});

	it("deferred add to entity later deferred-destroyed: add applies then destroy", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });

		store.addComponentDeferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
		store.destroyEntityDeferred(id);

		// Flush structural first (adds apply), then destroy
		store.flushStructural();
		expect(store.isAlive(id)).toBe(true);
		expect(store.hasComponent(id, Vel)).toBe(true);

		store.flushDestroyed();
		expect(store.isAlive(id)).toBe(false);
	});

	it("double deferred add of same component: last values win", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const id = store.createEntity();

		store.addComponentDeferred(id, Pos, { x: 1, y: 2, z: 3 });
		store.addComponentDeferred(id, Pos, { x: 10, y: 20, z: 30 });

		store.flushStructural();

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(10);
		expect(arch.readField(row, Pos.id, "y")).toBe(20);
		expect(arch.readField(row, Pos.id, "z")).toBe(30);
	});

	it("pending_structural_count tracks buffer state", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 0, y: 0, z: 0 });

		expect(store.pendingStructuralCount).toBe(0);

		store.addComponentDeferred(id, Vel, { vx: 0, vy: 0, vz: 0 });
		expect(store.pendingStructuralCount).toBe(1);

		store.removeComponentDeferred(id, Pos);
		expect(store.pendingStructuralCount).toBe(2);

		store.flushStructural();
		expect(store.pendingStructuralCount).toBe(0);
	});

	it("throws on deferred add to dead entity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const id = store.createEntity();
		store.destroyEntity(id);

		expect(() => store.addComponentDeferred(id, Pos, { x: 0, y: 0, z: 0 })).toThrow();
	});

	it("throws on deferred remove from dead entity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const id = store.createEntity();
		store.destroyEntity(id);

		expect(() => store.removeComponentDeferred(id, Pos)).toThrow();
	});

	it("flush_structural skips dead entities", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const a = store.createEntity();
		const b = store.createEntity();
		store.addComponent(a, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(b, Pos, { x: 0, y: 0, z: 0 });

		store.addComponentDeferred(a, Vel, { vx: 1, vy: 2, vz: 3 });
		store.addComponentDeferred(b, Vel, { vx: 4, vy: 5, vz: 6 });

		// Kill entity a before flushing
		store.destroyEntity(a);

		// Should not throw — dead entity a is skipped
		expect(() => store.flushStructural()).not.toThrow();

		// b should still get its component
		expect(store.hasComponent(b, Vel)).toBe(true);
	});

	//=========================================================
	// Dev-mode errors
	//=========================================================

	it("throws on add_component to dead entity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const id = store.createEntity();
		store.destroyEntity(id);

		expect(() => store.addComponent(id, Pos, { x: 0, y: 0, z: 0 })).toThrow();
	});

	it("throws on remove_component from dead entity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 0, y: 0, z: 0 });
		store.destroyEntity(id);

		expect(() => store.removeComponent(id, Pos)).toThrow();
	});

	it("throws on has_component for dead entity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const id = store.createEntity();
		store.destroyEntity(id);

		expect(() => store.hasComponent(id, Pos)).toThrow();
	});

	//=========================================================
	// addComponents bulk
	//=========================================================

	it("add_components adds multiple components in single transition", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponents(id, [
			{ def: Pos, values: { x: 1, y: 2, z: 3 } },
			{ def: Vel, values: { vx: 4, vy: 5, vz: 6 } }
		]);

		expect(store.hasComponent(id, Pos)).toBe(true);
		expect(store.hasComponent(id, Vel)).toBe(true);

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(1);
		expect(arch.readField(row, Vel.id, "vx")).toBe(4);
	});

	//=========================================================
	// Float columns: an omitted field reads back 0, NOT NaN (#716)
	//=========================================================

	// Contract (mirrors the template zero-fill in `resolveTemplate`): a field
	// absent from the supplied `values` is written as 0. A Float32/64Array stores
	// `undefined` as NaN, so before the `?? 0` fix the omitted float field came
	// back NaN. The expected value below is DERIVED from the contract (omitted ⇒
	// 0), not loosened to match output.

	it("add_component with a partial values object zero-fills the omitted float field (write_fields)", () => {
		const store = new Store();
		const Float = store.registerComponent(Float2);
		const id = store.createEntity();

		// Supply fx, omit fy.
		store.addComponent(id, Float as ComponentDef, { fx: 5 });

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Float.id, "fx")).toBe(5);
		const fy = arch.readField(row, Float.id, "fy");
		expect(Number.isNaN(fy)).toBe(false); // the bug: NaN before the fix
		expect(fy).toBe(0);
	});

	it("add_component with an empty values object zero-fills BOTH float fields (write_fields)", () => {
		const store = new Store();
		const Float = store.registerComponent(Float2);
		const id = store.createEntity();

		store.addComponent(id, Float as ComponentDef, {});

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Float.id, "fx")).toBe(0);
		expect(arch.readField(row, Float.id, "fy")).toBe(0);
	});

	it("batch_add_component with a partial values object zero-fills the omitted float field (bulk_write_fields)", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Float = store.registerComponent(Float2);

		// Place three entities in a non-empty source archetype (Pos), then batch-add
		// the float component to ALL of them with fx supplied and fy omitted.
		const ids = [store.createEntity(), store.createEntity(), store.createEntity()];
		for (const e of ids) store.addComponent(e, Pos, { x: 0, y: 0, z: 0 });
		const srcArch = store.getEntityArchetype(ids[0]).id;

		store.batchAddComponent(srcArch, Float as ComponentDef, { fx: 7 });

		for (const e of ids) {
			const arch = store.getEntityArchetype(e);
			const row = store.getEntityRow(e);
			expect(arch.readField(row, Float.id, "fx")).toBe(7);
			const fy = arch.readField(row, Float.id, "fy");
			expect(Number.isNaN(fy)).toBe(false);
			expect(fy).toBe(0);
		}
	});

	//=========================================================
	// spawnMany — count guard precedes the allocation (#730)
	//=========================================================

	// `spawnMany` allocates `new Array(count)` before doing work. A negative
	// count makes that allocation throw `RangeError('Invalid array length')`, so
	// the intended `count <= 0 → []` guard was dead for negatives. The guard now
	// runs first: any non-positive count yields an empty array without throwing.

	it("spawn_many with a negative count returns [] and does not throw RangeError", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const p = store.resolveTemplate([{ def: Pos, values: { x: 1, y: 2, z: 3 } }]);

		let result: ReturnType<Store["spawnMany"]> | undefined;
		expect(() => {
			result = store.spawnMany(p, -1);
		}).not.toThrow();
		expect(result).toEqual([]);
		expect(store.entityCount).toBe(0); // nothing spawned
	});

	it("spawn_many with count 0 returns [] and spawns nothing", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const p = store.resolveTemplate([{ def: Pos, values: { x: 1, y: 2, z: 3 } }]);

		expect(store.spawnMany(p, 0)).toEqual([]);
		expect(store.entityCount).toBe(0);
	});

	it("spawn_many with a positive count still spawns that many entities", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const p = store.resolveTemplate([{ def: Pos, values: { x: 1, y: 2, z: 3 } }]);

		const ids = store.spawnMany(p, 3);
		expect(ids.length).toBe(3);
		expect(store.entityCount).toBe(3);
		for (const id of ids) {
			expect(store.isAlive(id)).toBe(true);
			expect(store.hasComponent(id, Pos)).toBe(true);
		}
	});

	//=========================================================
	// Tag components (empty schema)
	//=========================================================

	it("tag components work for archetype grouping", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Marker = store.registerComponent(Tag);

		const e1 = store.createEntity();
		const e2 = store.createEntity();

		store.addComponent(e1, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(e1, Marker, {});

		store.addComponent(e2, Pos, { x: 0, y: 0, z: 0 });

		expect(store.hasComponent(e1, Marker)).toBe(true);
		expect(store.hasComponent(e2, Marker)).toBe(false);

		const markerArchetypes = store.getMatchingArchetypes(makeMask(Marker.id));
		expect(markerArchetypes.length).toBe(1);
		expect(markerArchetypes[0].entityList).toContain(e1);
	});

	//=========================================================
	// Event channel dirty-list invariant
	//=========================================================

	// Regression for #728: `emitEvent` / `emitSignal` mark a channel dirty
	// (push its id to `dirtyEventChannels`) only AFTER a successful emit.
	// The old order sampled `reader.length === 0` and pushed the id BEFORE
	// `channel.emit(...)`; if that emit threw the `__DEV__` missing-field check,
	// `reader.length` stayed 0, so the NEXT (valid) emit saw an empty channel
	// and pushed the id a SECOND time — duplicating it in the dirty list. The
	// duplicate inflates `_devBufferedEventCount` and makes `clearEvents`
	// walk the channel twice, breaking the at-most-once-per-tick invariant.

	it("a thrown emit does not double-register the channel in the dirty list (#728)", () => {
		const store = new Store();
		const Pair = store.registerEvent<{ a: number; b: number }>(["a", "b"]);

		// Fresh channel: nothing buffered, dirty list empty.
		expect(store._devBufferedEventCount()).toBe(0);

		// `b` is missing — emit throws under __DEV__ without marking the channel.
		try {
			store.emitEvent(Pair, { a: 1 });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.FIELD_NOT_REGISTERED);
		}

		// Nothing was buffered and the channel was not marked dirty.
		expect(store._devBufferedEventCount()).toBe(0);

		// A subsequent VALID emit buffers exactly one event and marks the channel
		// dirty exactly once. With the bug the id is now in the dirty list twice,
		// so the buffered count is double-counted (2, not 1).
		store.emitEvent(Pair, { a: 2, b: 3 });
		expect(store._devBufferedEventCount()).toBe(1);

		// `clearEvents` clears the channel; a duplicate id is harmless to the
		// channel (clear is idempotent) but the count must drop to 0 in one pass.
		store.clearEvents();
		expect(store._devBufferedEventCount()).toBe(0);

		// And after clearing, the channel is reusable: the next emit re-registers
		// it once and the reader reads the fresh row back at index 0.
		store.emitEvent(Pair, { a: 4, b: 5 });
		expect(store._devBufferedEventCount()).toBe(1);
		const reader = store.getEventReader(Pair);
		expect(reader.length).toBe(1);
		expect(reader.a[0]).toBe(4);
		expect(reader.b[0]).toBe(5);
	});
});
