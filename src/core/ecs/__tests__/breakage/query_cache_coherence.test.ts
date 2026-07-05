import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";

describe("Query cache coherence edge cases", () => {
	it("query cached before entities exist — live array picks them up when matching entities are created", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		// Cache the query before any entities exist
		const q = world.query(Pos);
		expect(q.archetypeCount).toBe(0);
		expect(q.entityCount).toBe(0);

		// Now create matching entities
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 3, y: 4 });

		// Same query reference should now see the entities via live update
		expect(q.archetypeCount).toBeGreaterThan(0);
		expect(q.entityCount).toBe(2);

		// Verify we can iterate and read data
		let total = 0;
		q.forEach((arch) => {
			total += arch.entityCount;
			const px = arch.getColumnRead(Pos, "x");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(typeof px[i]).toBe("number");
			}
		});
		expect(total).toBe(2);
	});

	it("query -> add entities -> destroy all -> add new to same archetype — for..of correct", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const q = world.query(Pos);

		// Phase 1: create and populate
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 3, y: 4 });

		expect(q.entityCount).toBe(2);

		// Phase 2: destroy all via deferred + flush
		world.despawn(e1);
		world.despawn(e2);
		world.flush();

		// forEach should skip empty archetypes
		let countAfterDestroy = 0;
		q.forEach((arch) => {
			countAfterDestroy += arch.entityCount;
		});
		expect(countAfterDestroy).toBe(0);

		// Phase 3: add new entities to the same archetype shape
		const e3 = world.spawn();
		world.addComponent(e3, Pos, { x: 10, y: 20 });

		// forEach should now yield exactly the new entity
		let countAfterReadd = 0;
		const readValues: number[] = [];
		q.forEach((arch) => {
			countAfterReadd += arch.entityCount;
			const px = arch.getColumnRead(Pos, "x");
			const py = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				readValues.push(px[i], py[i]);
			}
		});
		expect(countAfterReadd).toBe(1);
		expect(readValues).toEqual([10, 20]);
	});

	it("query with .not(Tag) + add Tag during system — entity gone from query after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Tag = world.registerTag();

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 5, y: 10 });

		const qNoTag = world.query(Pos).without(Tag);
		expect(qNoTag.entityCount).toBe(1);

		let countDuringSystem = -1;

		const sys = world.registerSystem({
			...openAccess([Pos, Tag]),
			fn(ctx) {
				// During system, add Tag to entity
				ctx.commands.add(e, Tag);
				// Query should still show the entity (deferred)
				countDuringSystem = qNoTag.entityCount;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// During the system, entity was still visible (deferred add)
		expect(countDuringSystem).toBe(1);

		// After flush, entity has Tag so it should no longer match .not(Tag)
		expect(qNoTag.entityCount).toBe(0);
		// Entity should still be alive
		expect(world.isAlive(e)).toBe(true);
		expect(world.hasComponent(e, Tag)).toBe(true);
	});

	it("two queries Q1=[Pos], Q2=[Pos,Vel]; remove Vel during system — entity in Q1 not Q2 after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, Vel, { vx: 3, vy: 4 });

		const q1 = world.query(Pos); // matches [Pos] and [Pos,Vel]
		const q2 = world.query(Pos, Vel); // matches only [Pos,Vel]

		// Before: entity is in both queries
		expect(q1.entityCount).toBe(1);
		expect(q2.entityCount).toBe(1);

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				ctx.commands.remove(e, Vel);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// After flush: entity moved from [Pos,Vel] archetype to [Pos] archetype
		// q1 should still see it (entity still has Pos)
		expect(q1.entityCount).toBe(1);
		// q2 should NOT see it (entity no longer has Vel)
		expect(q2.entityCount).toBe(0);
	});

	it("archetype empty -> re-populated — query yields exactly 1 archetype with 1 entity", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		// Create entity, populate archetype
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const q = world.query(Pos);
		expect(q.entityCount).toBe(1);

		// Empty it via deferred destroy + flush
		world.despawn(e1);
		world.flush();
		expect(q.entityCount).toBe(0);

		// Repopulate with a single entity
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 99, y: 88 });

		// Query should yield exactly 1 non-empty archetype with 1 entity
		let archCount = 0;
		let totalEntities = 0;
		q.forEach((arch) => {
			archCount++;
			totalEntities += arch.entityCount;
		});
		expect(archCount).toBe(1);
		expect(totalEntities).toBe(1);
		expect(world.getField(e2, Pos, "x")).toBe(99);
	});

	it("200 distinct queries in tight loop — cache size correct, no duplicates", () => {
		const world = new ECS();

		// 200 distinct query masks built from distinct component PAIRS drawn
		// from a small pool (well inside the SAB descriptor component limit):
		// C(21,2) = 210 ≥ 200 distinct two-component masks.
		const POOL = 21;
		const defs = [];
		for (let i = 0; i < POOL; i++) {
			defs.push(world.registerComponent(["v"] as const));
		}

		const pairs: Array<[number, number]> = [];
		for (let a = 0; a < POOL && pairs.length < 200; a++) {
			for (let b = a + 1; b < POOL && pairs.length < 200; b++) {
				pairs.push([a, b]);
			}
		}
		expect(pairs.length).toBe(200);

		// Create 200 distinct two-component queries
		const queries = [];
		for (let i = 0; i < pairs.length; i++) {
			const [a, b] = pairs[i];
			queries.push(world.query(defs[a], defs[b]));
		}

		// Each query should be a unique object
		const uniqueQueries = new Set(queries);
		expect(uniqueQueries.size).toBe(200);

		// Re-requesting the same query should return the cached instance
		for (let i = 0; i < pairs.length; i++) {
			const [a, b] = pairs[i];
			const again = world.query(defs[a], defs[b]);
			expect(again).toBe(queries[i]);
		}
	});
});
