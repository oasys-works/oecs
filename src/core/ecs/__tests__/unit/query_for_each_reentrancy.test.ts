/**
 * `Query.forEach` re-entrancy must not corrupt the non-empty buffer (#431).
 *
 * `forEach`/`count`/`ChangedQuery.forEach` bind the array returned by
 * `Query._nonEmpty()` once and walk it. Before the fix, `_nonEmpty()`
 * rebuilt that array *in place* (`dst.length = 0; …push`) whenever the query
 * dirty epoch advanced — so a nested `forEach`/`count` on the *same* Query,
 * after an immediate-mode mutation that crosses a 0↔non-zero entity boundary
 * (which bumps the epoch), truncated the array the outer loop was mid-walking.
 * Result: a still-non-empty archetype gets skipped, or an archetype that was
 * empty at iteration start gets spuriously visited.
 *
 * The fix makes the rebuild allocate a fresh array and swap it in, so the
 * outer iterator keeps walking the snapshot it started with. In-system
 * iteration was never affected — deferred mutations settle the epoch during
 * `flushStructural`, between systems, never mid-loop. The trigger is host /
 * immediate-mode code that iterates and mutates on the same Query.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import type { EntityID } from "../../entity";
import type { ArchetypeView } from "../../archetype";

const Position = ["x", "y"] as const;
const Tag = ["v"] as const;

function getStore(world: ECS): Store {
	return (world as unknown as { store: Store }).store;
}

describe("Query.for_each re-entrancy (#431)", () => {
	it("nested count() after a 1→0 crossing does not skip a still-non-empty archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const A = world.registerComponent(Tag);
		const B = world.registerComponent(Tag);
		const store = getStore(world);

		// Three distinct archetypes, all matching query(Pos), each with exactly
		// one entity → three non-empty matching archetypes. One entity per arch
		// means any immediate destroy crosses the 1→0 boundary and bumps the
		// query dirty epoch.
		const e0 = world.spawn();
		world.addComponent(e0, Pos, { x: 0, y: 0 }); // arch [Pos]
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, A, { v: 0 }); // arch [Pos, A]
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 2, y: 2 });
		world.addComponent(e2, B, { v: 0 }); // arch [Pos, B]

		const q = world.query(Pos);
		const startNonEmpty = q.archetypes.filter((a) => a.entityCount > 0);
		expect(startNonEmpty.length).toBe(3);

		const visited = new Set<ArchetypeView>();
		const order: ArchetypeView[] = [];
		let mutated = false;

		q.forEach((arch) => {
			visited.add(arch);
			order.push(arch);
			if (!mutated) {
				mutated = true;
				// Immediate-mode mutation: empty one matching archetype (1→0,
				// bumps the epoch), then re-enter `_nonEmpty()` via a nested
				// count() on the SAME query. Pre-fix this rebuilt the shared
				// array in place under the outer loop.
				store.destroyEntity(e1);
				q.entityCount;
			}
		});

		// Snapshot semantics: every archetype that was non-empty when iteration
		// began is visited exactly once, even the one emptied mid-loop. Pre-fix,
		// the in-place rebuild shrank the array under the cursor → only two
		// callbacks fired and a still-non-empty archetype was skipped.
		expect(order.length).toBe(3);
		expect(visited.size).toBe(3);
		for (const a of startNonEmpty) expect(visited.has(a)).toBe(true);
	});

	it("nested for_each after a 0→non-zero crossing does not spuriously visit a freshly-filled archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const A = world.registerComponent(Tag);
		const B = world.registerComponent(Tag);
		const store = getStore(world);

		// Two non-empty matching archetypes plus one matching archetype that
		// exists but is empty (created, then emptied) so a later add crosses
		// 0→non-zero.
		const e0 = world.spawn();
		world.addComponent(e0, Pos, { x: 0, y: 0 }); // arch [Pos]
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		world.addComponent(e1, A, { v: 0 }); // arch [Pos, A]

		// Materialise an empty matching archetype [Pos, B]: fill then empty it.
		const filler = world.spawn();
		world.addComponent(filler, Pos, { x: 9, y: 9 });
		world.addComponent(filler, B, { v: 0 });
		store.destroyEntity(filler); // [Pos, B] now exists but is empty

		const q = world.query(Pos);
		const startNonEmpty = q.archetypes.filter((a) => a.entityCount > 0);
		expect(startNonEmpty.length).toBe(2);

		const visited = new Set<ArchetypeView>();
		const order: ArchetypeView[] = [];
		let mutated = false;

		q.forEach((arch) => {
			visited.add(arch);
			order.push(arch);
			if (!mutated) {
				mutated = true;
				// Fill the empty matching archetype (0→non-zero, bumps the
				// epoch), then re-enter via a nested forEach on the SAME query.
				const e2 = world.spawn();
				world.addComponent(e2, Pos, { x: 2, y: 2 });
				world.addComponent(e2, B, { v: 0 });
				q.forEach(() => {});
			}
		});

		// The freshly-filled [Pos, B] was empty at iteration start, so the outer
		// walk must NOT visit it. Pre-fix, the in-place rebuild grew the array
		// under the cursor and the outer loop ran off the end into the new entry.
		expect(order.length).toBe(2);
		expect(visited.size).toBe(2);
		for (const a of startNonEmpty) expect(visited.has(a)).toBe(true);
	});

	it("non-crossing mutations (no epoch bump) keep iteration stable", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);

		// Two entities in the same [Pos] archetype; a 2→1 destroy is a
		// same-side move (no 0-crossing, no epoch bump, no rebuild).
		const e0 = world.spawn();
		world.addComponent(e0, Pos, { x: 0, y: 0 });
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 1 });

		const q = world.query(Pos);
		let visits = 0;
		q.forEach((arch) => {
			visits++;
			void arch.entityCount;
			store.destroyEntity(e1 as EntityID); // 2→1, same side
			q.entityCount;
		});

		expect(visits).toBe(1); // one archetype, visited once
		expect(q.entityCount).toBe(1);
	});
});
