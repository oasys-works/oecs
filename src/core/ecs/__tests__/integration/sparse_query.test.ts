/**
 * Sparse storage class — query integration (#469 / ADR-0011).
 *
 * The second query-match path: queries can `withSparse` / `withoutSparse`
 * a sparse component and iterate the matching entities via `forEachEntity`,
 * across every archetype. Covers the issue's acceptance criteria:
 *  - require a sparse component (members only, regardless of archetype);
 *  - exclude a sparse component;
 *  - mixed dense-bitmask + sparse-membership terms → correct intersection;
 *  - multi-sparse require (smallest-store drive) → intersection;
 *  - empty-result cases;
 *  - the dense `forEach` path stays untouched (no sparse consultation).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

// Collect the entities a sparse query yields, as a sorted plain-number array
// (iteration order over a sparse set is not canonical — determinism is #470).
function collect(q: { forEachEntity(cb: (e: EntityID) => void): void }): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
	return out.sort((a, b) => a - b);
}

const sorted = (ids: EntityID[]): number[] => ids.map((e) => e as number).sort((a, b) => a - b);

describe("ECS sparse query integration (#469)", () => {
	//=========================================================
	// withSparse — members only, across all archetypes
	//=========================================================

	it("require_sparse yields exactly the members, spanning archetypes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Marked = world.registerSparseTag();

		// Three different archetypes: {Pos}, {Pos,Vel}, {} (no dense comps).
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });
		const c = world.spawn(); // empty archetype

		// Non-members in the same archetypes.
		const d = world.spawn();
		world.addComponent(d, Pos, { x: 2, y: 2 });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 3, y: 3 });
		world.addComponent(e, Vel, { vx: 0, vy: 0 });

		world.addSparse(a, Marked);
		world.addSparse(b, Marked);
		world.addSparse(c, Marked);

		// query() with no dense terms → match-all dense; the sparse term filters.
		const q = world.query().withSparse(Marked);
		expect(collect(q)).toEqual(sorted([a, b, c]));
	});

	it("require_sparse reflects live add/remove of membership", () => {
		const world = new ECS();
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		const b = world.spawn();

		const q = world.query().withSparse(Marked);
		expect(collect(q)).toEqual([]);

		world.addSparse(a, Marked);
		expect(collect(q)).toEqual(sorted([a]));

		world.addSparse(b, Marked);
		expect(collect(q)).toEqual(sorted([a, b]));

		world.removeSparse(a, Marked);
		expect(collect(q)).toEqual(sorted([b]));
	});

	//=========================================================
	// withoutSparse
	//=========================================================

	it("exclude_sparse drops members, keeps the rest of the dense match", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Stunned = world.registerSparseTag();

		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		const c = world.spawn();
		world.addComponent(c, Pos, { x: 2, y: 2 });

		world.addSparse(b, Stunned);

		const q = world.query(Pos).withoutSparse(Stunned);
		expect(collect(q)).toEqual(sorted([a, c]));
	});

	//=========================================================
	// Mixed dense + sparse → intersection
	//=========================================================

	it("mixed dense bitmask + sparse require returns the intersection", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Marked = world.registerSparseTag();

		// Has Pos+Vel and Marked → match.
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addComponent(a, Vel, { vx: 0, vy: 0 });
		world.addSparse(a, Marked);

		// Has Pos+Vel but not Marked → dropped by sparse require.
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });

		// Marked but missing Vel → dropped by dense require.
		const c = world.spawn();
		world.addComponent(c, Pos, { x: 2, y: 2 });
		world.addSparse(c, Marked);

		const q = world.query(Pos, Vel).withSparse(Marked);
		expect(collect(q)).toEqual(sorted([a]));
	});

	it("sparse require composes with dense not()", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Marked = world.registerSparseTag();

		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addSparse(a, Marked);

		// Marked but has the excluded dense Vel → dropped.
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });
		world.addSparse(b, Marked);

		const q = world.query(Pos).without(Vel).withSparse(Marked);
		expect(collect(q)).toEqual(sorted([a]));
	});

	//=========================================================
	// Multi-sparse require (smallest-store drive) + exclude combo
	//=========================================================

	it("multiple sparse requires intersect; smallest store drives the scan", () => {
		const world = new ECS();
		const A = world.registerSparseTag();
		const B = world.registerSparseTag();

		const ents = [0, 1, 2, 3, 4].map(() => world.spawn());
		// A is the larger set; B is the rarer one (drives iteration).
		for (const e of ents) world.addSparse(e, A);
		world.addSparse(ents[1], B);
		world.addSparse(ents[3], B);

		const q = world.query().withSparse(A).withSparse(B);
		expect(collect(q)).toEqual(sorted([ents[1], ents[3]]));
	});

	it("require one sparse and exclude another", () => {
		const world = new ECS();
		const Alive = world.registerSparseTag();
		const Dead = world.registerSparseTag();

		const a = world.spawn();
		const b = world.spawn();
		const c = world.spawn();
		world.addSparse(a, Alive);
		world.addSparse(b, Alive);
		world.addSparse(c, Alive);
		world.addSparse(b, Dead);

		const q = world.query().withSparse(Alive).withoutSparse(Dead);
		expect(collect(q)).toEqual(sorted([a, c]));
	});

	//=========================================================
	// Sparse field data on yielded entities
	//=========================================================

	it("yielded entities expose their sparse field data", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent({ ready_at: "f64" });
		const a = world.spawn();
		const b = world.spawn();
		world.addSparse(a, Cooldown, { ready_at: 10 });
		world.addSparse(b, Cooldown, { ready_at: 20 });

		const seen = new Map<number, number>();
		world
			.query()
			.withSparse(Cooldown)
			.forEachEntity((e) => {
				seen.set(e as number, world.getSparseField(e, Cooldown, "ready_at"));
			});
		expect(seen.get(a as number)).toBe(10);
		expect(seen.get(b as number)).toBe(20);
	});

	//=========================================================
	// Empty-result cases
	//=========================================================

	it("empty result: no members, dense match exists", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		// Nobody holds Marked.
		expect(collect(world.query(Pos).withSparse(Marked))).toEqual([]);
	});

	it("empty result: members exist but fail the dense term", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Tagged = world.registerSparseTag();
		const a = world.spawn(); // no Pos
		world.addSparse(a, Tagged);
		expect(collect(world.query(Pos).withSparse(Tagged))).toEqual([]);
	});

	//=========================================================
	// Destruction purges membership from the match
	//=========================================================

	it("destroying a member drops it from the sparse match", () => {
		const world = new ECS();
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		const b = world.spawn();
		world.addSparse(a, Marked);
		world.addSparse(b, Marked);

		const q = world.query().withSparse(Marked);
		expect(collect(q)).toEqual(sorted([a, b]));

		world.despawn(a);
		world.flush(); // deferred destroy applies + purges sparse data
		expect(collect(q)).toEqual(sorted([b]));
	});

	//=========================================================
	// withSparse / withoutSparse are cached & stable
	//=========================================================

	it("require_sparse returns a stable cached query for the same term", () => {
		const world = new ECS();
		const Marked = world.registerSparseTag();
		const base = world.query();
		expect(base.withSparse(Marked)).toBe(base.withSparse(Marked));
	});

	it("multi-arg require_sparse returns a stable cached query (#497)", () => {
		const world = new ECS();
		const A = world.registerSparseTag();
		const B = world.registerSparseTag();
		const base = world.query();
		// The multi-arg form used to mint a fresh Query + id + term arrays on every
		// call; it now folds through the single-term cache, so repeated calls are
		// the identical instance.
		expect(base.withSparse(A, B)).toBe(base.withSparse(A, B));
	});

	it("multi-arg exclude_sparse returns a stable cached query (#497)", () => {
		const world = new ECS();
		const A = world.registerSparseTag();
		const B = world.registerSparseTag();
		const base = world.query();
		expect(base.withoutSparse(A, B)).toBe(base.withoutSparse(A, B));
	});

	it("multi-arg require_sparse(A, B) is the same instance as the chained form (#497)", () => {
		const world = new ECS();
		const A = world.registerSparseTag();
		const B = world.registerSparseTag();
		const base = world.query();
		// Folding through the single-term cache means the multi-arg call composes
		// out of the same cached prefixes the chained call builds.
		expect(base.withSparse(A, B)).toBe(base.withSparse(A).withSparse(B));
		expect(base.withoutSparse(A, B)).toBe(base.withoutSparse(A).withoutSparse(B));
	});

	it("multi-arg require_sparse still yields the correct intersection (#497)", () => {
		const world = new ECS();
		const A = world.registerSparseTag();
		const B = world.registerSparseTag();

		const ents = [0, 1, 2, 3, 4].map(() => world.spawn());
		for (const e of ents) world.addSparse(e, A);
		world.addSparse(ents[1], B);
		world.addSparse(ents[3], B);

		// Single-call multi-arg form — equivalent to the chained-require test above.
		const q = world.query().withSparse(A, B);
		expect(collect(q)).toEqual(sorted([ents[1], ents[3]]));
	});

	//=========================================================
	// Dense-only path unaffected: forEach still yields archetype views
	//=========================================================

	it("dense-only for_each is untouched by the sparse path", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 5, y: 6 });
		world.addSparse(a, Marked);

		// Dense query iterates archetype views regardless of sparse membership.
		let rows = 0;
		world.query(Pos).forEach((arch) => {
			rows += arch.entityCount;
		});
		expect(rows).toBe(1);
	});

	//=========================================================
	// forEachEntity on a dense-only query (no sparse terms) walks entities
	//=========================================================

	it("for_each_entity on a dense-only query yields all dense matches", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.spawn(); // no Pos — excluded by the dense term

		expect(collect(world.query(Pos))).toEqual(sorted([a, b]));
	});

	//=========================================================
	// Tag with a non-empty schema works the same
	//=========================================================

	it("works with a sparse component carrying fields, not just tags", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Burning = world.registerSparseComponent({ dps: "f64" });

		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addSparse(a, Burning, { dps: 3 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });

		expect(collect(world.query(Pos).withSparse(Burning))).toEqual(sorted([a]));
	});

	//=========================================================
	// Dense-path methods guard against sparse terms (#556)
	//=========================================================
	//
	// count() / forEach() / archetype_count walk only the dense archetype list
	// and never consult the sparse stores. On a sparse-derived query they would
	// fail open (return the unfiltered dense result), so they throw in __DEV__
	// steering the caller to forEachEntity. Tests run under vitest, where
	// __DEV__ is true, so the guard is live.

	it("count() throws on a query carrying a require_sparse term (#556)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addSparse(a, Marked);

		const q = world.query(Pos).withSparse(Marked);
		expect(() => q.entityCount).toThrow(/forEachEntity/);
	});

	it("count() throws on a query carrying an exclude_sparse term (#556)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Stunned = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });

		const q = world.query(Pos).withoutSparse(Stunned);
		expect(() => q.entityCount).toThrow(/forEachEntity/);
	});

	it("for_each() throws on a sparse-derived query (#556)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addSparse(a, Marked);

		const q = world.query(Pos).withSparse(Marked);
		expect(() => q.forEach(() => {})).toThrow(/forEachEntity/);
	});

	it("archetype_count throws on a sparse-derived query (#556)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Marked = world.registerSparseTag();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addSparse(a, Marked);

		const q = world.query(Pos).withSparse(Marked);
		expect(() => q.archetypeCount).toThrow(/forEachEntity/);
	});

	it("dense-only queries keep count() / for_each() / archetype_count working (#556)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });

		const q = world.query(Pos);
		expect(q.entityCount).toBe(2);
		expect(q.archetypeCount).toBeGreaterThanOrEqual(1);
		let rows = 0;
		q.forEach((arch) => {
			rows += arch.entityCount;
		});
		expect(rows).toBe(2);
	});
});
