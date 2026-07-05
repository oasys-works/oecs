/**
 * Column scale — "no corruption at moderate scale", NOT a cap boundary.
 *
 * SoA column growth, swap-and-pop, and batch ops over up to 10k entities —
 * well under the 256 MiB SAB cap (#380) and the 1M `EntityID` index. The
 * point is that column data stays intact through growth and dense
 * swap-removes, not that anything is tested AT a documented limit. The real
 * cap boundaries live in `limits/component_count_cap.test.ts` (SAB
 * descriptor mask width) and `unit/store.test.ts` (#376 slot retirement).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

const Position = ["x", "y"] as const;

describe("Column scale", () => {
	it("10,000 entities with Position, write unique values, verify all via column access", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		for (let i = 0; i < 10_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 3 });
		}

		world.query(Pos).forEach((arch) => {
			const cx = arch.getColumnRead(Pos, "x");
			const cy = arch.getColumnRead(Pos, "y");
			for (let i = 0; i < arch.entityCount; i++) {
				expect(cy[i]).toBe(cx[i] * 3);
			}
		});
	});

	it("5,000 entities with 3-field component, delete 2,500, verify remaining columns", () => {
		const world = new ECS();
		const Data = world.registerComponent(["a", "b", "c"] as const);

		const entities = [];
		for (let i = 0; i < 5_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Data, { a: i, b: i + 1, c: i + 2 });
			entities.push(e);
		}

		// Delete even-indexed entities
		for (let i = 0; i < 5_000; i += 2) {
			world.despawn(entities[i]);
		}
		world.flush();

		// Verify remaining entities have correct data
		for (let i = 1; i < 5_000; i += 2) {
			expect(world.isAlive(entities[i])).toBe(true);
			expect(world.getField(entities[i], Data, "a")).toBe(i);
			expect(world.getField(entities[i], Data, "b")).toBe(i + 1);
			expect(world.getField(entities[i], Data, "c")).toBe(i + 2);
		}
	});

	it("column growth: push 10,000 entities, verify no corruption", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const entities = [];
		for (let i = 0; i < 10_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: -i });
			entities.push(e);
		}

		// Verify all data
		for (let i = 0; i < 10_000; i++) {
			expect(world.getField(entities[i], Pos, "x")).toBe(i);
			expect(world.getField(entities[i], Pos, "y")).toBe(-i);
		}
	});

	it("swap-and-pop: 1,000 entities, destroy from front 500×, verify remaining data", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const entities = [];
		for (let i = 0; i < 1_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 10 });
			entities.push(e);
		}

		// Destroy first 500
		for (let i = 0; i < 500; i++) {
			world.despawn(entities[i]);
		}
		world.flush();

		// Remaining 500 should have correct data
		for (let i = 500; i < 1_000; i++) {
			expect(world.isAlive(entities[i])).toBe(true);
			expect(world.getField(entities[i], Pos, "x")).toBe(i);
			expect(world.getField(entities[i], Pos, "y")).toBe(i * 10);
		}
	});

	it("batch ops at scale: batch_add to archetype with 1,000 entities", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		// Create 1,000 entities with just Position
		const entities = [];
		for (let i = 0; i < 1_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 2 });
			entities.push(e);
		}

		// Get the archetype containing [Pos] only (not Vel)
		const posOnlyQuery = world.query(Pos).without(Vel);
		expect(posOnlyQuery.archetypeCount).toBe(1);
		const srcArch = posOnlyQuery.archetypes[0];
		expect(srcArch.entityCount).toBe(1_000);

		// Batch add Velocity to all entities in that archetype
		world.batchAddComponent(srcArch.id, Vel, { vx: 1, vy: 2 });

		// Verify all entities now have both components with correct data
		for (const e of entities) {
			expect(world.hasComponent(e, Pos)).toBe(true);
			expect(world.hasComponent(e, Vel)).toBe(true);
			expect(world.getField(e, Vel, "vx")).toBe(1);
			expect(world.getField(e, Vel, "vy")).toBe(2);
		}

		// Verify original Position data is preserved
		for (let i = 0; i < entities.length; i++) {
			expect(world.getField(entities[i], Pos, "x")).toBe(i);
			expect(world.getField(entities[i], Pos, "y")).toBe(i * 2);
		}
	});
});
