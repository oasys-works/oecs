import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

describe("Structural changes mid-system are properly deferred", () => {
	it("system adds component to entity it is iterating — does not appear until next update", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const posVelQuery = world.query(Pos, Vel);
		let countDuringSystem = -1;

		const posQuery = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				// Iterate over Pos-only entities and add Vel to one
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						const eid = arch.entityIds[i] as EntityID;
						ctx.addComponent(eid, Vel, { vx: 10, vy: 20 });
					}
				});
				// Pos+Vel query should still be empty during this system
				countDuringSystem = posVelQuery.archetypeCount;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// During the system, entity was not yet in Pos+Vel query
		expect(countDuringSystem).toBe(0);

		// After flush (update completes), entity is now in Pos+Vel query
		expect(posVelQuery.archetypeCount).toBe(1);
		expect(world.getField(e, Vel, "vx")).toBe(10);
		expect(world.getField(e, Vel, "vy")).toBe(20);
	});

	it("system removes component during iteration — columns remain accessible for rest of loop", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Vel, { vx: 7, vy: 8 });

		const valuesRead: number[] = [];

		const posVelQuery = world.query(Pos, Vel);
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				posVelQuery.forEach((arch) => {
					const px = arch.getColumnRead(Pos, "x");
					const vx = arch.getColumnRead(Vel, "vx");
					for (let i = 0; i < arch.entityCount; i++) {
						// Remove Vel from first entity mid-iteration
						if (i === 0) {
							ctx.removeComponent(arch.entityIds[i] as EntityID, Vel);
						}
						// All columns should remain valid for the entire loop
						valuesRead.push(px[i], vx[i]);
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Deferred remove must not invalidate or shift columns mid-loop: both
		// entities read their exact spawn values — px=[1,5], vx=[3,7] interleaved.
		expect(valuesRead).toEqual([1, 3, 5, 7]);
	});

	it("system adds component to entity A while iterating entity B in same archetype — no corruption", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Tag = world.registerTag();

		const eA = world.spawn();
		world.addComponent(eA, Pos, { x: 100, y: 200 });

		const eB = world.spawn();
		world.addComponent(eB, Pos, { x: 300, y: 400 });

		const posQuery = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos, Tag]),
			fn(ctx) {
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						const eid = arch.entityIds[i];
						// When iterating eB, add Tag to eA
						if (eid === eB) {
							ctx.addComponent(eA, Tag);
						}
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// After flush, eA should have the Tag
		expect(world.hasComponent(eA, Tag)).toBe(true);
		// Both entities should still be alive and have Pos with correct values
		expect(world.isAlive(eA)).toBe(true);
		expect(world.isAlive(eB)).toBe(true);
		expect(world.getField(eA, Pos, "x")).toBe(100);
		expect(world.getField(eA, Pos, "y")).toBe(200);
		expect(world.getField(eB, Pos, "x")).toBe(300);
		expect(world.getField(eB, Pos, "y")).toBe(400);
	});

	it("system adds same component to 100 entities during one tick — all transition after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const entities: EntityID[] = [];
		for (let i = 0; i < 100; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 10 });
			entities.push(e);
		}

		const posVelQuery = world.query(Pos, Vel);
		const posQuery = world.query(Pos);

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						const eid = arch.entityIds[i] as EntityID;
						ctx.addComponent(eid, Vel, { vx: 1, vy: 2 });
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// After flush, all 100 entities should be in the Pos+Vel query
		let total = 0;
		posVelQuery.forEach((arch) => {
			total += arch.entityCount;
		});
		expect(total).toBe(100);

		// Verify field values survived the transition
		for (const e of entities) {
			expect(world.hasComponent(e, Vel)).toBe(true);
			expect(world.getField(e, Vel, "vx")).toBe(1);
			expect(world.getField(e, Vel, "vy")).toBe(2);
		}
	});

	it("chain of 3 systems: sys1 adds C, sys2+sys3 query C — should NOT find it until next update", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Marker = world.registerTag();

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		let sys2CountDuring = -1;
		let sys3CountDuring = -1;

		// sys1: adds Marker to entity
		const sys1 = world.registerSystem({
			...openAccess([Pos, Marker]),
			fn(ctx) {
				ctx.addComponent(e, Marker);
			}
		});

		// sys2: queries for Marker — should NOT find entity this frame
		const markerQuery = world.query(Marker);
		const sys2 = world.registerSystem({
			...openAccess([Marker]),
			fn() {
				sys2CountDuring = markerQuery.entityCount;
			}
		});

		// sys3: also queries Marker
		const sys3 = world.registerSystem({
			...openAccess([Marker]),
			fn() {
				sys3CountDuring = markerQuery.entityCount;
			}
		});

		// All in same UPDATE phase, so flush happens after all 3 run
		world.addSystems(SCHEDULE.UPDATE, sys1, sys2, sys3);
		world.startup();
		world.update(0);

		// During the update frame, sys2 and sys3 should not have seen the Marker entity
		expect(sys2CountDuring).toBe(0);
		expect(sys3CountDuring).toBe(0);

		// After flush, Marker is present
		expect(world.hasComponent(e, Marker)).toBe(true);

		// On the NEXT update, sys2 and sys3 should see it
		world.update(0);
		expect(sys2CountDuring).toBe(1);
		expect(sys3CountDuring).toBe(1);
	});

	it("system creates 100 new entities with components during execution — all correct after update", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const createdEntities: EntityID[] = [];
		const initialCount = world.entityCount;

		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				for (let i = 0; i < 100; i++) {
					const e = ctx.commands.spawn();
					ctx.addComponent(e, Pos, { x: i, y: i * 2 });
					createdEntities.push(e);
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// All 100 entities should exist
		expect(world.entityCount).toBe(initialCount + 100);

		// All should be alive and have correct Pos values
		for (let i = 0; i < 100; i++) {
			const e = createdEntities[i];
			expect(world.isAlive(e)).toBe(true);
			expect(world.hasComponent(e, Pos)).toBe(true);
			expect(world.getField(e, Pos, "x")).toBe(i);
			expect(world.getField(e, Pos, "y")).toBe(i * 2);
		}
	});

	it("system adds then removes same component (both deferred) — component absent after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Marker = world.registerTag();

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			...openAccess([Pos, Marker]),
			fn(ctx) {
				// Both deferred: add then remove in same system
				ctx.addComponent(e, Marker);
				ctx.removeComponent(e, Marker);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// ECS flushes adds first, then removes — so add Marker, then remove Marker.
		// Result: entity does NOT have Marker.
		expect(world.hasComponent(e, Marker)).toBe(false);
		// Entity should still be alive and retain Pos
		expect(world.isAlive(e)).toBe(true);
		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.getField(e, Pos, "x")).toBe(1);
	});
});
