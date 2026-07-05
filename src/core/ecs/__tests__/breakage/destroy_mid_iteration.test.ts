import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

describe("Destruction during system execution", () => {
	it("system destroys current entity — archetype columns valid for remaining entities", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 10, y: 20 });
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 30, y: 40 });
		const e3 = world.spawn();
		world.addComponent(e3, Pos, { x: 50, y: 60 });

		const valuesRead: number[] = [];
		let destroyedEntity: EntityID | null = null;

		const posQuery = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				posQuery.forEach((arch) => {
					const px = arch.getColumnRead(Pos, "x");
					const py = arch.getColumnRead(Pos, "y");
					for (let i = 0; i < arch.entityCount; i++) {
						// Destroy the first entity we encounter
						if (destroyedEntity === null) {
							destroyedEntity = arch.entityIds[i] as EntityID;
							ctx.commands.despawn(arch.entityIds[i] as EntityID);
						}
						// All reads should succeed, including after the deferred destroy call
						valuesRead.push(px[i], py[i]);
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Deferred destroy must not shift columns mid-loop: every entity reads
		// its exact spawn values, in spawn order (e1={10,20} e2={30,40} e3={50,60}).
		expect(valuesRead).toEqual([10, 20, 30, 40, 50, 60]);

		// The destroyed entity is now dead after flush
		expect(world.isAlive(destroyedEntity!)).toBe(false);
		// Remaining entities are still alive
		expect(world.entityCount).toBe(2);
	});

	it("system marks ALL entities for deferred destruction — iteration completes, entities dead after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const entities: EntityID[] = [];
		for (let i = 0; i < 10; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 10 });
			entities.push(e);
		}

		let iterationCount = 0;

		const posQuery = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						ctx.commands.despawn(arch.entityIds[i] as EntityID);
						iterationCount++;
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Should have iterated all 10 entities
		expect(iterationCount).toBe(10);

		// All entities are dead after flush
		for (const e of entities) {
			expect(world.isAlive(e)).toBe(false);
		}
		expect(world.entityCount).toBe(0);
	});

	it("interleaved create + destroy in single system — entity_count correct after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		// Create 5 initial entities
		const initial: EntityID[] = [];
		for (let i = 0; i < 5; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: 0 });
			initial.push(e);
		}

		const created: EntityID[] = [];

		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				// Destroy 3 of the initial entities
				for (let i = 0; i < 3; i++) {
					ctx.commands.despawn(initial[i]);
				}
				// Create 4 new entities
				for (let i = 0; i < 4; i++) {
					const e = ctx.commands.spawn();
					ctx.addComponent(e, Pos, { x: 100 + i, y: 0 });
					created.push(e);
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Started with 5, destroyed 3, created 4 = 6 alive
		expect(world.entityCount).toBe(6);

		// Destroyed entities are dead
		for (let i = 0; i < 3; i++) {
			expect(world.isAlive(initial[i])).toBe(false);
		}

		// Surviving initial entities are alive
		for (let i = 3; i < 5; i++) {
			expect(world.isAlive(initial[i])).toBe(true);
		}

		// Newly created entities are alive with correct data
		for (let i = 0; i < 4; i++) {
			expect(world.isAlive(created[i])).toBe(true);
			expect(world.getField(created[i], Pos, "x")).toBe(100 + i);
		}
	});

	it("destroy in sys1, sys2 still sees entity (deferred) — dead after update completes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 42, y: 84 });

		let sys2SawEntity = false;
		let sys2CouldReadField = false;

		// sys1 defers destruction
		const sys1 = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				ctx.commands.despawn(e);
			}
		});

		// sys2 checks if entity is still visible during same phase
		const posQuery = world.query(Pos);
		const sys2 = world.registerSystem({
			...openAccess([Pos]),
			fn() {
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						if (arch.entityIds[i] === e) {
							sys2SawEntity = true;
							const px = arch.getColumnRead(Pos, "x");
							sys2CouldReadField = px[i] === 42;
						}
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys1, sys2);
		world.startup();
		world.update(0);

		// sys2 should have seen the entity (destroy was deferred within the same phase)
		expect(sys2SawEntity).toBe(true);
		expect(sys2CouldReadField).toBe(true);

		// After update completes (flush), entity is dead
		expect(world.isAlive(e)).toBe(false);
	});

	it("mass deferred destruction: 1,000 entities queued, flush, verify all dead", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const entities: EntityID[] = [];
		for (let i = 0; i < 1_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: 0 });
			entities.push(e);
		}

		expect(world.entityCount).toBe(1_000);

		const posQuery = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				posQuery.forEach((arch) => {
					for (let i = 0; i < arch.entityCount; i++) {
						ctx.commands.despawn(arch.entityIds[i] as EntityID);
					}
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// All 1,000 entities should be dead
		expect(world.entityCount).toBe(0);
		for (const e of entities) {
			expect(world.isAlive(e)).toBe(false);
		}
	});
});
