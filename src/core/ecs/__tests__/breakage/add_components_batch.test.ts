/**
 * Dynamic batching contract for `addComponents` / `removeComponents` —
 * issue #211 follow-up to Phase C of #213.
 *
 * Before this PR, `Store.addComponents(eid, [A, B, C, D])` walked the
 * archetype graph one component at a time. Each step that crossed into an
 * archetype the SAB had never carried triggered a fresh `extendColumnStore`
 * call — three of those intermediate archetypes ([+A], [+A,+B], [+A,+B,+C])
 * never held an entity, but they still cost a full SAB realloc + copy each.
 * With the final-mask refactor, only the destination archetype is created.
 *
 * The contract pinned here:
 *   1. `addComponents` from a fresh archetype to an N-new-component target
 *      bumps `view_stamp` exactly once (the destination), not N times.
 *   2. Same for `removeComponents` when N components are dropped.
 *   3. No-op calls (entries that don't change the mask) don't bump
 *      `view_stamp` at all.
 *   4. Functional behavior — final archetype, field values, swap-and-pop
 *      bookkeeping — matches the per-step graph walk it replaces.
 *   5. Intermediate archetypes are NOT materialised: a fresh world that
 *      goes 0 → [A,B,C] via a single `addComponents` ends up with exactly
 *      two archetypes (empty + [A,B,C]), not four.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { STORE_HEADER_OFFSETS } from "../../../store/header";

function viewStamp(world: ECS): number {
	return world.columnStore.view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
}

describe("add_components batching (issue #211 follow-up)", () => {
	it("a single add_components with 4 new components bumps view_stamp exactly once", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);
		const D = world.registerComponent(["v"] as const);

		const baseline = viewStamp(world);
		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }), C({ v: 3 }), D({ v: 4 }));

		// One target archetype created ⇒ one extend.
		expect(viewStamp(world) - baseline).toBe(1);
	});

	it("doesn't materialise intermediate archetypes", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		expect(world.archetypeCount).toBe(1); // empty archetype only

		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }), C({ v: 3 }));

		// Pre-PR: empty + [A] + [A,B] + [A,B,C] = 4. Now: empty + [A,B,C] = 2.
		expect(world.archetypeCount).toBe(2);
	});

	it("functional equivalence: entity lands in the final archetype with correct values", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		const e = world.spawn();
		world.addComponents(e, A({ v: 10 }), B({ v: 20 }), C({ v: 30 }));

		expect(world.hasComponent(e, A)).toBe(true);
		expect(world.hasComponent(e, B)).toBe(true);
		expect(world.hasComponent(e, C)).toBe(true);
		expect(world.getField(e, A, "v")).toBe(10);
		expect(world.getField(e, B, "v")).toBe(20);
		expect(world.getField(e, C, "v")).toBe(30);
	});

	it("re-adding components already on the entity overwrites in-place without a transition", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }));
		const afterFirst = viewStamp(world);

		// Add the same defs again with new values — entity stays in [A, B].
		world.addComponents(e, A({ v: 100 }), B({ v: 200 }));

		expect(viewStamp(world)).toBe(afterFirst); // no new archetype
		expect(world.getField(e, A, "v")).toBe(100);
		expect(world.getField(e, B, "v")).toBe(200);
	});

	it("mixed (some present, some new) only materialises the union archetype", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		const e = world.spawn();
		world.addComponent(e, A, { v: 1 });
		// world is now: empty + [A] = 2 archetypes
		expect(world.archetypeCount).toBe(2);

		const before = viewStamp(world);
		world.addComponents(e,
			A({ v: 11 }), // already present — overwrite
			B({ v: 22 }), // new
			C({ v: 33 }) // new
		);

		// One new archetype [A, B, C] (no [A, B] intermediate).
		expect(world.archetypeCount).toBe(3);
		expect(viewStamp(world) - before).toBe(1);
		expect(world.getField(e, A, "v")).toBe(11);
		expect(world.getField(e, B, "v")).toBe(22);
		expect(world.getField(e, C, "v")).toBe(33);
	});
});

describe("remove_components batching (issue #211 follow-up)", () => {
	it("a single remove_components dropping 3 components bumps view_stamp at most once", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);
		const D = world.registerComponent(["v"] as const);

		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }), C({ v: 3 }), D({ v: 4 }));

		const afterAdd = viewStamp(world);
		// Remove three components — target [D] has not been planted yet, so
		// one extend. The two intermediates ([B,C,D] and [C,D]) that the
		// old graph walk would have created are skipped.
		world.removeComponents(e, A, B, C);

		expect(viewStamp(world) - afterAdd).toBe(1);
		expect(world.hasComponent(e, A)).toBe(false);
		expect(world.hasComponent(e, B)).toBe(false);
		expect(world.hasComponent(e, C)).toBe(false);
		expect(world.hasComponent(e, D)).toBe(true);
		expect(world.getField(e, D, "v")).toBe(4);
	});

	it("removing components the entity doesn't have is a no-op", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		const e = world.spawn();
		world.addComponent(e, A, { v: 1 });
		const before = viewStamp(world);

		// B and C are not on the entity.
		world.removeComponents(e, B, C);

		expect(viewStamp(world)).toBe(before); // no transition, no extend
		expect(world.hasComponent(e, A)).toBe(true);
		expect(world.getField(e, A, "v")).toBe(1);
	});

	it("if the target archetype already exists, no extend at all", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		// Plant [A] explicitly via a separate entity.
		const eAnchor = world.spawn();
		world.addComponent(eAnchor, A, { v: 99 });

		// Now create an entity in [A, B] and remove B — target is [A], which
		// already exists, so no SAB extend should fire.
		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }));
		const before = viewStamp(world);

		world.removeComponents(e, B);

		expect(viewStamp(world)).toBe(before);
		expect(world.hasComponent(e, A)).toBe(true);
		expect(world.hasComponent(e, B)).toBe(false);
	});
});

/**
 * Composite-add edge cache (#659). The second+ add of the same (source
 * archetype, added-set) must resolve through `currentArch`'s cached composite
 * edge — one packed-key `Map.get` yielding target + transition map — yet land
 * the entity in exactly the same archetype, with the same field values, as the
 * first (cold) call's final-mask resolve. These pin that the cache is a pure
 * accelerator: identical observable state, no extra archetypes planted.
 */
describe("add_components composite-add edge cache (#659)", () => {
	it("repeated plural adds from the empty archetype are byte-identical to the cold call", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		const ids = Array.from({ length: 5 }, () => world.spawn());
		// First call resolves cold (mask hash + archLookup) and plants the edge;
		// calls 2..5 hit the composite cache. All must agree.
		for (let i = 0; i < ids.length; i++) {
			world.addComponents(ids[i], A({ v: 10 + i }), B({ v: 20 + i }));
		}

		// empty + [A,B] only — the cache plants no archetypes of its own.
		expect(world.archetypeCount).toBe(2);
		for (let i = 0; i < ids.length; i++) {
			expect(world.hasComponent(ids[i], A)).toBe(true);
			expect(world.hasComponent(ids[i], B)).toBe(true);
			expect(world.getField(ids[i], A, "v")).toBe(10 + i);
			expect(world.getField(ids[i], B, "v")).toBe(20 + i);
		}
	});

	it("cache hit drives the with-row move path (live entity already holding a component)", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		// Two live entities sitting in [A] (a real row, not the rowless empty
		// archetype) — this is the issue's target case: plural add on an entity
		// that already exists. e1's add resolves cold; e2's hits the cache and
		// must travel the cached src→target transition map via moveEntityFrom.
		const e1 = world.spawn();
		const e2 = world.spawn();
		world.addComponent(e1, A, { v: 1 });
		world.addComponent(e2, A, { v: 2 });

		world.addComponents(e1, B({ v: 11 }), C({ v: 12 }));
		const archetypesAfterCold = world.archetypeCount;
		world.addComponents(e2, B({ v: 21 }), C({ v: 22 }));

		// The cached hit reuses the [A,B,C] archetype — no new one.
		expect(world.archetypeCount).toBe(archetypesAfterCold);
		for (const [e, a, b, c] of [
			[e1, 1, 11, 12],
			[e2, 2, 21, 22]
		] as const) {
			expect(world.getField(e, A, "v")).toBe(a);
			expect(world.getField(e, B, "v")).toBe(b);
			expect(world.getField(e, C, "v")).toBe(c);
		}
	});

	it("entry order is part of the key but resolves to the same target archetype", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		const e1 = world.spawn();
		const e2 = world.spawn();
		world.addComponents(e1, A({ v: 1 }), B({ v: 2 }));
		// Reversed order — a distinct cache key, but the union {A,B} is the same
		// archetype, so no second archetype is planted.
		world.addComponents(e2, B({ v: 4 }), A({ v: 3 }));

		expect(world.archetypeCount).toBe(2);
		expect(world.getField(e1, A, "v")).toBe(1);
		expect(world.getField(e1, B, "v")).toBe(2);
		expect(world.getField(e2, A, "v")).toBe(3);
		expect(world.getField(e2, B, "v")).toBe(4);
	});

	it("re-adding all-present components stays in-place and is never served from the cache", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		const e = world.spawn();
		world.addComponents(e, A({ v: 1 }), B({ v: 2 }));
		const stamp = viewStamp(world);

		// Same set from the SAME (now [A,B]) source: every def is already present,
		// so this is an in-place overwrite, not a transition — the cache must not
		// short-circuit it into a spurious move.
		world.addComponents(e, A({ v: 100 }), B({ v: 200 }));

		expect(viewStamp(world)).toBe(stamp);
		expect(world.getField(e, A, "v")).toBe(100);
		expect(world.getField(e, B, "v")).toBe(200);
	});
});
