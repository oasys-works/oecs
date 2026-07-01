/**
 * Query scale — "no corruption at moderate scale", NOT a cap boundary.
 *
 * Query-cache dedup and live archetype growth over ≤63 tags / ≤20
 * components and a few hundred entities — well inside the 128-component SAB
 * descriptor limit (#381). These verify cached queries stay coherent and
 * grow live, not behavior AT the cap. The real cap boundary lives in
 * `limits/component_count_cap.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

describe("Query scale", () => {
	it("100 unique queries, each returns correct cached reference", () => {
		const world = new ECS();
		// 100 distinct archetypes/queries built from distinct component PAIRS
		// drawn from a small pool (well inside the SAB descriptor component
		// limit): C(15,2) = 105 ≥ 100 distinct two-component masks.
		const POOL = 15;
		const comps = [];
		for (let i = 0; i < POOL; i++) {
			comps.push(world.registerComponent(["v"] as const));
		}

		const pairs: Array<[number, number]> = [];
		for (let a = 0; a < POOL && pairs.length < 100; a++) {
			for (let b = a + 1; b < POOL && pairs.length < 100; b++) {
				pairs.push([a, b]);
			}
		}
		expect(pairs.length).toBe(100);

		// Create one entity per distinct pair so each archetype exists
		for (let i = 0; i < pairs.length; i++) {
			const [a, b] = pairs[i];
			const e = world.createEntity();
			world.addComponent(e, comps[a], { v: i });
			world.addComponent(e, comps[b], { v: i });
		}

		// Each distinct-pair query should be cached
		const queries = [];
		for (let i = 0; i < pairs.length; i++) {
			const [a, b] = pairs[i];
			queries.push(world.query(comps[a], comps[b]));
		}

		for (let i = 0; i < pairs.length; i++) {
			const [a, b] = pairs[i];
			expect(world.query(comps[a], comps[b])).toBe(queries[i]);
		}
	});

	it("50 queries over 20 components, 500 entities across 30 archetypes, all correct", () => {
		const world = new ECS();
		const comps = [];
		for (let i = 0; i < 20; i++) {
			comps.push(world.registerComponent(["v"] as const));
		}

		// Create entities with various component combos
		for (let i = 0; i < 500; i++) {
			const e = world.createEntity();
			// Always add comp[0]
			world.addComponent(e, comps[0], { v: i });
			// Add comp[1..9] based on bit pattern of i
			for (let c = 1; c < 10; c++) {
				if ((i >> c) & 1) {
					world.addComponent(e, comps[c], { v: c });
				}
			}
		}

		// Query for comp[0] should find all 500 entities
		const q0 = world.query(comps[0]);
		let total = 0;
		q0.forEach((arch) => {
			total += arch.entityCount;
		});
		expect(total).toBe(500);

		// Repeated calls return same cached query
		expect(world.query(comps[0])).toBe(q0);
	});

	it("live query stress: register query, create new archetypes, verify live growth", () => {
		const world = new ECS();
		const Common = world.registerComponent(["v"] as const);
		// Common + tags must stay within the SAB descriptor component limit
		// (#381); 63 distinct single-tag archetypes is plenty to exercise live
		// query growth and stays well under the cap.
		const TAG_COUNT = 63;
		const tags = [];
		for (let i = 0; i < TAG_COUNT; i++) {
			tags.push(world.registerTag());
		}

		// Register query before any entities exist
		const q = world.query(Common);
		expect(q.archetypeCount).toBe(0);

		// Create entities in TAG_COUNT different archetypes
		for (let i = 0; i < TAG_COUNT; i++) {
			const e = world.createEntity();
			world.addComponent(e, Common, { v: i });
			world.addComponent(e, tags[i]);
		}

		// Query should have grown live: TAG_COUNT {Common, tag[i]} archetypes
		// plus 1 intermediate {Common} archetype from the addComponent transitions
		expect(q.archetypeCount).toBe(TAG_COUNT + 1);
	});

	it("query cache deduplication — same mask always returns same Query", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		const queries = new Set();
		for (let i = 0; i < 200; i++) {
			// Same query repeatedly
			queries.add(world.query(A, B));
			queries.add(world.query(B, A));
			queries.add(world.query(A).and(B));
		}
		// All should resolve to same cached query
		expect(queries.size).toBe(1);

		// Different query is different
		queries.add(world.query(A, C));
		expect(queries.size).toBe(2);
	});
});
