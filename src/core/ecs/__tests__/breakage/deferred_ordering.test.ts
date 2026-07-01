import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

describe("Deferred operation ordering", () => {
	it("deferred add A then add B — entity has both after flush", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const A = world.registerTag();
		const B = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			...openAccess([Pos, A, B]),
			fn(ctx) {
				ctx.addComponent(e, A);
				ctx.addComponent(e, B);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(world.hasComponent(e, A)).toBe(true);
		expect(world.hasComponent(e, B)).toBe(true);
		// Pos data should survive the transitions
		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.getField(e, Pos, "x")).toBe(1);
		expect(world.getField(e, Pos, "y")).toBe(2);
	});

	it("deferred add A then remove A — entity does NOT have A (add first, then remove)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const A = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 5, y: 10 });

		const sys = world.registerSystem({
			...openAccess([Pos, A]),
			fn(ctx) {
				ctx.addComponent(e, A);
				ctx.removeComponent(e, A);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Flush processes all adds first, then all removes.
		// So: add A (entity transitions to [Pos, A]), then remove A (transitions back to [Pos]).
		// Result: entity does NOT have A.
		expect(world.hasComponent(e, A)).toBe(false);
		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.getField(e, Pos, "x")).toBe(5);
	});

	it("multiple deferred adds of same component — last values win", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				// Queue three adds of the same component with different values
				ctx.addComponent(e, Vel, { vx: 10, vy: 20 });
				ctx.addComponent(e, Vel, { vx: 30, vy: 40 });
				ctx.addComponent(e, Vel, { vx: 50, vy: 60 });
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Entity should have Vel. The first add transitions the entity to [Pos,Vel],
		// subsequent adds overwrite values in-place since the component is already present.
		expect(world.hasComponent(e, Vel)).toBe(true);
		expect(world.getField(e, Vel, "vx")).toBe(50);
		expect(world.getField(e, Vel, "vy")).toBe(60);
	});

	it("deferred add + deferred destroy — structural flush applies, then destroy", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				ctx.addComponent(e, Vel, { vx: 99, vy: 99 });
				ctx.destroyEntity(e);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Flush processes structural changes (adds/removes) first, then destructions.
		// So: entity gets Vel added, then entity is destroyed.
		// Entity should be dead after the update.
		expect(world.isAlive(e)).toBe(false);
		expect(world.entityCount).toBe(0);
	});

	it("3 systems defer different ops on same entity — operations apply in correct order", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const A = world.registerTag();
		const B = world.registerTag();
		const C = world.registerTag();

		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		// Give entity tag A initially
		world.addComponent(e, A);

		// sys1: add B
		const sys1 = world.registerSystem({
			...openAccess([Pos, A, B, C]),
			fn(ctx) {
				ctx.addComponent(e, B);
			}
		});

		// sys2: add C
		const sys2 = world.registerSystem({
			...openAccess([Pos, A, B, C]),
			fn(ctx) {
				ctx.addComponent(e, C);
			}
		});

		// sys3: remove A
		const sys3 = world.registerSystem({
			...openAccess([Pos, A, B, C]),
			fn(ctx) {
				ctx.removeComponent(e, A);
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys1, sys2, sys3);
		world.startup();
		world.update(0);

		// After flush: adds are processed first (add B, add C), then removes (remove A).
		// Entity should have: Pos, B, C but NOT A.
		expect(world.hasComponent(e, Pos)).toBe(true);
		expect(world.hasComponent(e, A)).toBe(false);
		expect(world.hasComponent(e, B)).toBe(true);
		expect(world.hasComponent(e, C)).toBe(true);
		expect(world.getField(e, Pos, "x")).toBe(1);
		expect(world.getField(e, Pos, "y")).toBe(2);
	});

	it("stress: 500 entities each getting random deferred add or remove — all final states match expected", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Tag = world.registerTag();

		// Create 500 entities, half with Tag initially
		const entities: EntityID[] = [];
		const initialHasTag: boolean[] = [];
		for (let i = 0; i < 500; i++) {
			const e = world.createEntity();
			world.addComponent(e, Pos, { x: i, y: 0 });
			const hasTag = i % 2 === 0;
			if (hasTag) {
				world.addComponent(e, Tag);
			}
			entities.push(e);
			initialHasTag.push(hasTag);
		}

		// Use a deterministic "random" pattern: toggle Tag on every 3rd entity
		const expectedHasTag = [...initialHasTag];
		const ops: Array<{ entity: EntityID; action: "add" | "remove" }> = [];

		for (let i = 0; i < 500; i++) {
			if (i % 3 === 0) {
				if (expectedHasTag[i]) {
					// Remove Tag
					ops.push({ entity: entities[i], action: "remove" });
					expectedHasTag[i] = false;
				} else {
					// Add Tag
					ops.push({ entity: entities[i], action: "add" });
					expectedHasTag[i] = true;
				}
			}
		}

		const sys = world.registerSystem({
			...openAccess([Pos, Tag]),
			fn(ctx) {
				for (const op of ops) {
					if (op.action === "add") {
						ctx.addComponent(op.entity, Tag);
					} else {
						ctx.removeComponent(op.entity, Tag);
					}
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Verify all entities match expected state
		for (let i = 0; i < 500; i++) {
			expect(world.isAlive(entities[i])).toBe(true);
			expect(world.hasComponent(entities[i], Tag)).toBe(expectedHasTag[i]);
			// Pos data should be intact
			expect(world.getField(entities[i], Pos, "x")).toBe(i);
		}
	});
});
