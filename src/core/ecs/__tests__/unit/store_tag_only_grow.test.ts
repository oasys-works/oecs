/**
 * Tag-only archetype growth regression (#210).
 *
 * Tag-only archetypes (mask is all tags, no data fields) have an empty
 * `Archetype._flatColumns` array. Their `addEntity` / `moveEntityFromTag`
 * paths bypass the SAB column bound check by design — there are no SAB
 * columns to overflow; the row count lives on the heap-backed
 * `_entityIds` instead. The SAB descriptor records `row_capacity =
 * initialCapacity` for them as metadata only.
 *
 * Before #210 was fixed, `extendColumnStore` / `_growHandler` reported
 * `row_count: a.length` for every archetype, and any tag-only archetype
 * past its initial row_capacity would trip the primitive's vacuous bound
 * check (`row_count > row_capacity`) on the next structural change.
 *
 * The fix in Store passes `row_count: 0` for archetypes with
 * `!hasColumns`, since their length is not stored in the SAB at all.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

describe("Tag-only archetype growth (#210)", () => {
	it("tag-only archetype length can exceed SAB row_capacity without throwing", () => {
		const world = new ECS({ memory: { columnCapacity: 4 } });
		const T1 = world.registerTag();
		const T2 = world.registerTag();

		// Overflow the [T1, T2] tag-only archetype past row_capacity=4.
		for (let i = 0; i < 10; i++) {
			const e = world.createEntity();
			world.addComponent(e, T1);
			world.addComponent(e, T2);
		}

		// Registering a NEW archetype calls `extendColumnStore` with every
		// existing archetype's row_count carried forward. Pre-fix this
		// threw `StoreExtendError: archetype N: row_count 10 > old
		// row_capacity 4`.
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);
		const e = world.createEntity();
		expect(() => world.addComponent(e, Pos, { x: 1, y: 2 })).not.toThrow();
	});

	it("tag-only overflow + sibling archetype grow doesn't trip _grow_handler", () => {
		const world = new ECS({ memory: { columnCapacity: 4 } });
		const T1 = world.registerTag();
		const Pos = world.registerComponent({ x: "f64", y: "f64" } as const);

		// Fill the tag-only [T1] archetype past row_capacity=4.
		for (let i = 0; i < 10; i++) {
			const e = world.createEntity();
			world.addComponent(e, T1);
		}

		// Fill the [Pos] data-bearing archetype past its row_capacity to
		// trigger `_growHandler`. Pre-fix this threw `StoreGrowError:
		// archetype <T1-id>: newRowCapacity 4 < row_count 10`.
		expect(() => {
			for (let i = 0; i < 10; i++) {
				const e = world.createEntity();
				world.addComponent(e, Pos, { x: i, y: i * 2 });
			}
		}).not.toThrow();
	});

	it("pathological fragmentation: mirrors proxy-ts_bench scenario", () => {
		// 10k iterations × 8 entities, 3-of-16 picks from {8 components + 8
		// tags}. Some masks collide many times (one mask accumulates >64
		// rows), and pure-tag masks bypass the bound check entirely.
		const world = new ECS({ memory: { columnCapacity: 64 } });
		const components: ReturnType<typeof world.registerComponent>[] = [];
		for (let i = 0; i < 8; i++) {
			components.push(world.registerComponent({ v: "f64" } as const));
		}
		const tags: ReturnType<typeof world.registerTag>[] = [];
		for (let i = 0; i < 8; i++) {
			tags.push(world.registerTag());
		}

		const ITERS = 10_000;
		const PER_ITER = 8;

		// Only the rowless empty archetype exists before the churn; registering
		// components/tags creates no archetypes. So the post-loop count minus
		// this baseline is exactly the number of distinct masks produced.
		const baselineArchetypes = world.archetypeCount;

		// Replay the deterministic pick formula into a set of canonical mask
		// keys (so we can assert the realised archetype count), and snapshot a
		// few entities (id + the `a` they were spawned with) so a lost row,
		// misrouted row, or torn column can't pass silently.
		const distinctMasks = new Set<string>();
		const sampleIters = new Set([0, 1, 137, 1234, 5000, 9999]);
		const samples: { id: EntityID; a: number; dataDefs: typeof components }[] = [];

		for (let a = 0; a < ITERS; a++) {
			const idx0 = a % 16;
			const idx1 = (a * 7 + 3) % 16;
			const idx2 = (a * 13 + 5) % 16;
			const picks = new Set([idx0, idx1, idx2]);
			if (picks.size < 2) picks.add((idx0 + 1) % 16);
			const pickList = [...picks];
			const defList = pickList.map((i) =>
				i < 8 ? { def: components[i], values: { v: a } } : { def: tags[i - 8] }
			);
			// addComponents is a single transition (empty → target), so each
			// distinct mask is exactly one archetype — no intermediates.
			distinctMasks.add(
				pickList
					.slice()
					.sort((x, y) => x - y)
					.join(",")
			);
			const dataDefs = pickList.filter((i) => i < 8).map((i) => components[i]);

			for (let e = 0; e < PER_ITER; e++) {
				const id = world.createEntity();
				world.addComponents(id, defList);
				// Snapshot the first entity of a few iterations that carry at
				// least one data field, giving the post-loop check a `v` to read.
				if (e === 0 && sampleIters.has(a) && dataDefs.length > 0) {
					samples.push({ id, a, dataDefs });
				}
			}
		}

		// No entity is ever destroyed — every spawned row must still be live.
		expect(world.entityCount).toBe(ITERS * PER_ITER);

		// One archetype per distinct mask, nothing lost or spuriously created.
		expect(world.archetypeCount - baselineArchetypes).toBe(distinctMasks.size);

		// Spot-check: each sampled entity's data fields still read the `a` they
		// were spawned with, despite ~80k transitions churning the columns.
		expect(samples.length).toBeGreaterThan(0);
		for (const { id, a, dataDefs } of samples) {
			expect(world.isAlive(id)).toBe(true);
			for (const def of dataDefs) {
				expect(world.getField(id, def, "v")).toBe(a);
			}
		}
	});
});
