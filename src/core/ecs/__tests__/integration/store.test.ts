import { describe, expect, it } from "vitest";
import { Store } from "../../store";

import type { ComponentID } from "../../component";
import { BitSet } from "../../../../type_primitives";

function makeMask(...ids: (number | ComponentID)[]): BitSet {
	const mask = new BitSet();
	for (const id of ids) mask.set(id as number);
	return mask;
}

// Component schemas
const Position = { x: "f64", y: "f64", z: "f64" } as const;
const Velocity = { vx: "f64", vy: "f64", vz: "f64" } as const;
const Health = { current: "f64", max: "f64" } as const;

describe("Store (integration)", () => {
	//=========================================================
	// Multiple component transitions
	//=========================================================

	it("adding multiple components transitions through archetypes", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const id = store.createEntity();

		store.addComponent(id, Pos, { x: 1, y: 2, z: 3 });
		expect(store.hasComponent(id, Pos)).toBe(true);
		expect(store.hasComponent(id, Vel)).toBe(false);

		store.addComponent(id, Vel, { vx: 4, vy: 5, vz: 6 });
		expect(store.hasComponent(id, Pos)).toBe(true);
		expect(store.hasComponent(id, Vel)).toBe(true);

		// Verify data survived the transition
		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);
		expect(arch.readField(row, Pos.id, "x")).toBe(1);
		expect(arch.readField(row, Vel.id, "vx")).toBe(4);
	});

	//=========================================================
	// Independent entities
	//=========================================================

	it("different entities can have different component sets", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const Hp = store.registerComponent(Health);

		const e1 = store.createEntity();
		const e2 = store.createEntity();

		store.addComponent(e1, Pos, { x: 1, y: 0, z: 0 });
		store.addComponent(e1, Vel, { vx: 1, vy: 0, vz: 0 });

		store.addComponent(e2, Pos, { x: 2, y: 0, z: 0 });
		store.addComponent(e2, Hp, { current: 100, max: 100 });

		expect(store.hasComponent(e1, Pos)).toBe(true);
		expect(store.hasComponent(e1, Vel)).toBe(true);
		expect(store.hasComponent(e1, Hp)).toBe(false);

		expect(store.hasComponent(e2, Pos)).toBe(true);
		expect(store.hasComponent(e2, Vel)).toBe(false);
		expect(store.hasComponent(e2, Hp)).toBe(true);
	});

	//=========================================================
	// Data preservation across transitions
	//=========================================================

	it("data is preserved when transitioning between archetypes", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const id = store.createEntity();
		store.addComponent(id, Pos, { x: 10, y: 20, z: 30 });

		// Transition: [Pos] → [Pos, Vel]
		store.addComponent(id, Vel, { vx: 1, vy: 2, vz: 3 });

		const arch = store.getEntityArchetype(id);
		const row = store.getEntityRow(id);

		// Pos data survived the transition
		expect(arch.readField(row, Pos.id, "x")).toBe(10);
		expect(arch.readField(row, Pos.id, "y")).toBe(20);
		expect(arch.readField(row, Pos.id, "z")).toBe(30);

		// Vel data is correct
		expect(arch.readField(row, Vel.id, "vx")).toBe(1);
		expect(arch.readField(row, Vel.id, "vy")).toBe(2);
		expect(arch.readField(row, Vel.id, "vz")).toBe(3);
	});

	//=========================================================
	// Dense column iteration
	//=========================================================

	it("dense column iteration after multiple entities added", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const ids = [];
		for (let i = 0; i < 10; i++) {
			const id = store.createEntity();
			store.addComponent(id, Pos, { x: i, y: i * 2, z: i * 3 });
			ids.push(id);
		}

		// All entities should be in the same archetype
		const archetypes = store.getMatchingArchetypes(makeMask(Pos.id));
		expect(archetypes.length).toBe(1);
		const arch = archetypes[0];
		expect(arch.entityCount).toBe(10);

		// Dense iteration should work
		const colX = arch.getColumnRead(Pos, "x");
		const colY = arch.getColumnRead(Pos, "y");
		for (let row = 0; row < arch.entityCount; row++) {
			// Rows are assigned in order, so row i has entity i
			expect(colX[row]).toBe(row);
			expect(colY[row]).toBe(row * 2);
		}
	});

	//=========================================================
	// Archetype deduplication
	//=========================================================

	it("same component set reuses the same archetype", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const e1 = store.createEntity();
		const e2 = store.createEntity();

		store.addComponent(e1, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(e1, Vel, { vx: 0, vy: 0, vz: 0 });

		const archCountAfterE1 = store.archetypeCount;

		store.addComponent(e2, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(e2, Vel, { vx: 0, vy: 0, vz: 0 });

		// No new archetypes should have been created
		expect(store.archetypeCount).toBe(archCountAfterE1);
	});

	//=========================================================
	// Graph edge caching
	//=========================================================

	it("second transition reuses cached edge (no new archetype)", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const e1 = store.createEntity();
		store.addComponent(e1, Pos, { x: 0, y: 0, z: 0 });
		const countAfterFirst = store.archetypeCount;

		const e2 = store.createEntity();
		store.addComponent(e2, Pos, { x: 0, y: 0, z: 0 });
		expect(store.archetypeCount).toBe(countAfterFirst);
	});

	//=========================================================
	// Query matching
	//=========================================================

	it("get_matching_archetypes returns archetypes with required components", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const Hp = store.registerComponent(Health);

		const e1 = store.createEntity();
		store.addComponent(e1, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(e1, Vel, { vx: 0, vy: 0, vz: 0 });

		const e2 = store.createEntity();
		store.addComponent(e2, Pos, { x: 0, y: 0, z: 0 });
		store.addComponent(e2, Hp, { current: 100, max: 100 });

		// Query for [Pos] - 3 archetypes match: [Pos] (intermediate, created during
		// e1's first addComponent), [Pos, Vel], and [Pos, Hp].
		const posMatches = store.getMatchingArchetypes(makeMask(Pos.id));
		expect(posMatches.length).toBe(3);

		// Both entities are found across matching archetypes
		const allEntities = posMatches.flatMap((a) => [...a.entityList]);
		expect(allEntities).toContain(e1);
		expect(allEntities).toContain(e2);

		// Query for [Pos, Vel] - only e1's archetype matches
		const posVelMatches = store.getMatchingArchetypes(
			makeMask(Pos.id, Vel.id)
		);
		expect(posVelMatches.length).toBe(1);
		expect(posVelMatches[0].entityList).toContain(e1);

		// Query for [Hp] - only e2's archetype matches
		const hpMatches = store.getMatchingArchetypes(makeMask(Hp.id));
		expect(hpMatches.length).toBe(1);
		expect(hpMatches[0].entityList).toContain(e2);
	});

	it("get_matching_archetypes returns empty for unregistered component combo", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);
		const Hp = store.registerComponent(Health);

		const e1 = store.createEntity();
		store.addComponent(e1, Pos, { x: 0, y: 0, z: 0 });

		// No entity has Vel + Hp
		const matches = store.getMatchingArchetypes(makeMask(Vel.id, Hp.id));
		expect(matches.length).toBe(0);
	});

	it("get_matching_archetypes with empty required returns all archetypes", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		store.createEntity(); // alive but has no archetype row yet
		const e2 = store.createEntity();
		store.addComponent(e2, Pos, { x: 0, y: 0, z: 0 });

		const matches = store.getMatchingArchetypes(makeMask());
		expect(matches.length).toBe(store.archetypeCount);
	});

	//=========================================================
	// Destroy cleanup
	//=========================================================

	it("destroyed entity is removed from its archetype membership", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const e1 = store.createEntity();
		const e2 = store.createEntity();
		store.addComponent(e1, Pos, { x: 1, y: 0, z: 0 });
		store.addComponent(e2, Pos, { x: 2, y: 0, z: 0 });

		const archetypes = store.getMatchingArchetypes(makeMask(Pos.id));
		expect(archetypes.length).toBe(1);
		expect(archetypes[0].entityCount).toBe(2);

		store.destroyEntity(e1);
		expect(archetypes[0].entityCount).toBe(1);
		expect(archetypes[0].entityList).toContain(e2);
	});

	it("destroy_entity handles swap-and-pop for remaining entity data", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const e1 = store.createEntity();
		const e2 = store.createEntity();
		store.addComponent(e1, Pos, { x: 10, y: 20, z: 30 });
		store.addComponent(e2, Pos, { x: 100, y: 200, z: 300 });

		// Destroy e1 — e2 should swap into row 0
		store.destroyEntity(e1);

		const arch = store.getEntityArchetype(e2);
		const row = store.getEntityRow(e2);
		expect(arch.readField(row, Pos.id, "x")).toBe(100);
		expect(arch.readField(row, Pos.id, "y")).toBe(200);
		expect(arch.readField(row, Pos.id, "z")).toBe(300);
	});

	//=========================================================
	// Swap-and-pop with multiple entities
	//=========================================================

	it("destroying one entity preserves other entities' data in same archetype", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const e1 = store.createEntity();
		const e2 = store.createEntity();
		const e3 = store.createEntity();

		store.addComponent(e1, Pos, { x: 1, y: 1, z: 1 });
		store.addComponent(e2, Pos, { x: 2, y: 2, z: 2 });
		store.addComponent(e3, Pos, { x: 3, y: 3, z: 3 });

		// Destroy middle entity
		store.destroyEntity(e2);

		// Remaining entities should still have correct data
		const arch1 = store.getEntityArchetype(e1);
		const row1 = store.getEntityRow(e1);
		expect(arch1.readField(row1, Pos.id, "x")).toBe(1);

		const arch3 = store.getEntityArchetype(e3);
		const row3 = store.getEntityRow(e3);
		expect(arch3.readField(row3, Pos.id, "x")).toBe(3);
	});

	//=========================================================
	// Capacity growth
	//=========================================================

	it("handles many entities beyond initial capacity", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const ids = [];
		for (let i = 0; i < 200; i++) {
			const id = store.createEntity();
			store.addComponent(id, Pos, { x: i, y: 0, z: 0 });
			ids.push(id);
		}

		expect(store.entityCount).toBe(200);

		for (const id of ids) {
			expect(store.isAlive(id)).toBe(true);
			expect(store.hasComponent(id, Pos)).toBe(true);
		}
	});
});
