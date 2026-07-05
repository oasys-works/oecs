/**
 * Archetype scale — "no corruption at moderate scale", NOT a cap boundary.
 *
 * Distinct-archetype creation, per-step transition data preservation, and
 * the archetype edge cache over ≤63 components / ~50 archetypes — all
 * comfortably inside the 128-component SAB descriptor limit (#381). These
 * verify archetype identity + transitions stay correct at scale, not
 * behavior AT the component cap. The real cap boundary lives in
 * `limits/component_count_cap.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

describe("Archetype scale", () => {
	it("32 components, entities with unique subsets create distinct archetypes", () => {
		const world = new ECS();
		const comps = [];
		for (let i = 0; i < 32; i++) {
			comps.push(world.registerComponent(["v"] as const));
		}

		// Create entities with component combos: {0}, {0,1}, {0,1,2}, ...
		world.query(comps[0]); // register query before entities exist
		for (let i = 0; i < 32; i++) {
			const e = world.spawn();
			for (let j = 0; j <= i; j++) {
				world.addComponent(e, comps[j], { v: j });
			}
		}

		// Each entity created a unique archetype containing comp[0]
		expect(world.query(comps[0]).archetypeCount).toBeGreaterThanOrEqual(32);
	});

	it("add 1 component at a time through 20 transitions, data preserved at every step", () => {
		const world = new ECS();
		const comps = [];
		for (let i = 0; i < 20; i++) {
			comps.push(world.registerComponent(["v"] as const));
		}

		const e = world.spawn();
		for (let i = 0; i < 20; i++) {
			world.addComponent(e, comps[i], { v: i * 10 });

			// Verify all previously added components still have correct data
			for (let j = 0; j <= i; j++) {
				expect(world.getField(e, comps[j], "v")).toBe(j * 10);
			}
		}
	});

	it("1,000 entities across ~50 archetypes, query over common component finds all", () => {
		const world = new ECS();
		const Common = world.registerComponent(["v"] as const);
		const extras = [];
		for (let i = 0; i < 50; i++) {
			extras.push(world.registerTag());
		}

		const allEntities = [];
		for (let i = 0; i < 1_000; i++) {
			const e = world.spawn();
			world.addComponent(e, Common, { v: i });
			// Add a tag based on i % 50 to spread across archetypes
			world.addComponent(e, extras[i % 50]);
			allEntities.push(e);
		}

		const q = world.query(Common);
		let total = 0;
		q.forEach((arch) => {
			total += arch.entityCount;
		});
		expect(total).toBe(1_000);
	});

	it("edge cache: 500 entities with same component sequence, archetype_count stays constant", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		// First entity establishes the archetypes
		const e0 = world.spawn();
		world.addComponent(e0, A, { v: 0 });
		world.addComponent(e0, B, { v: 0 });
		const countAfterFirst = world.query(A).archetypeCount;

		// 499 more entities with same sequence
		for (let i = 1; i < 500; i++) {
			const e = world.spawn();
			world.addComponent(e, A, { v: i });
			world.addComponent(e, B, { v: i });
		}

		expect(world.query(A).archetypeCount).toBe(countAfterFirst);
	});

	it("tag-only scaling: 1,000 entities with various tag combos, correctness verified", () => {
		const world = new ECS();
		const tags = [];
		for (let i = 0; i < 10; i++) {
			tags.push(world.registerTag());
		}

		const entities = [];
		for (let i = 0; i < 1_000; i++) {
			const e = world.spawn();
			// Add tags based on bit pattern of i % 1024
			for (let t = 0; t < 10; t++) {
				if ((i >> t) & 1) {
					world.addComponent(e, tags[t]);
				}
			}
			entities.push(e);
		}

		// Verify tag 0 query finds all entities with bit 0 set
		const q0 = world.query(tags[0]);
		let foundCount = 0;
		const foundSet = new Set<EntityID>();
		q0.forEach((arch) => {
			foundCount += arch.entityCount;
			for (let i = 0; i < arch.entityCount; i++) {
				foundSet.add(arch.entityIds[i] as EntityID);
			}
		});

		// Count how many entities should have tag 0 (odd indices)
		let expected = 0;
		for (let i = 0; i < 1_000; i++) {
			if (i & 1) expected++;
		}
		expect(foundCount).toBe(expected);

		for (let i = 0; i < 1_000; i++) {
			if (i & 1) {
				expect(foundSet.has(entities[i])).toBe(true);
			}
		}
	});
});
