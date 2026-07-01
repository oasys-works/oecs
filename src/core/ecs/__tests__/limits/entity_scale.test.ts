/**
 * Entity scale — "no corruption at moderate scale", NOT a cap boundary.
 *
 * These exercise create / destroy / recycle correctness at 10k entities —
 * comfortably under every documented hard cap (1M `EntityID` index, 2046
 * live generations before slot retirement #376, 256 MiB SAB #380). They
 * verify nothing aliases or corrupts at scale; they do NOT probe behavior
 * AT vs OVER a cap. The real cap boundaries live in `unit/entity.test.ts`
 * (index / generation overflow throws) and `unit/store.test.ts`
 * (generation-exhaustion slot retirement, #376).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

const Position = ["x", "y"] as const;

describe("Entity scale", () => {
	it("creates 10,000 entities, all alive and entity_count correct", () => {
		const world = new ECS();
		const entities = [];
		for (let i = 0; i < 10_000; i++) {
			entities.push(world.createEntity());
		}
		expect(world.entityCount).toBe(10_000);
		for (const e of entities) {
			expect(world.isAlive(e)).toBe(true);
		}
	});

	it("creates 10,000 then destroys 5,000 — survivors alive, dead are dead", () => {
		const world = new ECS();
		const entities = [];
		for (let i = 0; i < 10_000; i++) {
			entities.push(world.createEntity());
		}

		for (let i = 0; i < 5_000; i++) {
			world.destroyEntity(entities[i]);
		}
		world.flush();

		expect(world.entityCount).toBe(5_000);
		for (let i = 0; i < 5_000; i++) {
			expect(world.isAlive(entities[i])).toBe(false);
		}
		for (let i = 5_000; i < 10_000; i++) {
			expect(world.isAlive(entities[i])).toBe(true);
		}
	});

	it("creates 10,000 with Position, destroy odd-indexed, verify even-indexed data intact", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const entities = [];
		for (let i = 0; i < 10_000; i++) {
			const e = world.createEntity();
			world.addComponent(e, Pos, { x: i, y: i * 2 });
			entities.push(e);
		}

		// Destroy odd-indexed
		for (let i = 1; i < 10_000; i += 2) {
			world.destroyEntity(entities[i]);
		}
		world.flush();

		// Verify even-indexed still have correct data
		for (let i = 0; i < 10_000; i += 2) {
			expect(world.isAlive(entities[i])).toBe(true);
			expect(world.getField(entities[i], Pos, "x")).toBe(i);
			expect(world.getField(entities[i], Pos, "y")).toBe(i * 2);
		}
	});

	it("entity ID recycling: create 1,000 → destroy all → create 1,000 more, old IDs dead", () => {
		const world = new ECS();
		const oldEntities = [];
		for (let i = 0; i < 1_000; i++) {
			oldEntities.push(world.createEntity());
		}
		for (const e of oldEntities) {
			world.destroyEntity(e);
		}
		world.flush();

		const newEntities = [];
		for (let i = 0; i < 1_000; i++) {
			newEntities.push(world.createEntity());
		}

		for (const e of oldEntities) {
			expect(world.isAlive(e)).toBe(false);
		}
		for (const e of newEntities) {
			expect(world.isAlive(e)).toBe(true);
		}
		expect(world.entityCount).toBe(1_000);
	});

	it("interleaved create/destroy (create 100, destroy 50, repeat 20×), final state correct", () => {
		const world = new ECS();
		const alive: Set<EntityID> = new Set();
		let allEntities: EntityID[] = [];

		for (let round = 0; round < 20; round++) {
			const batch = [];
			for (let i = 0; i < 100; i++) {
				const e = world.createEntity();
				batch.push(e);
				alive.add(e);
			}
			allEntities = allEntities.concat(batch);

			// Destroy 50 from the alive set
			const aliveArr = [...alive];
			for (let i = 0; i < 50 && i < aliveArr.length; i++) {
				world.destroyEntity(aliveArr[i]);
				alive.delete(aliveArr[i]);
			}
			world.flush();
		}

		expect(world.entityCount).toBe(alive.size);
		for (const e of alive) {
			expect(world.isAlive(e)).toBe(true);
		}
	});
});
