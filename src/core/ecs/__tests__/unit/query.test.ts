import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

// Field arrays
const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;
const Health = ["hp"] as const;
const Static = [] as const; // tag component

describe("ECS query", () => {
	//=========================================================
	// Basic query
	//=========================================================

	it("query returns matching archetypes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });

		// Query [Pos, Vel] should match only e1's archetype
		const matches = world.query(Pos, Vel);
		expect(matches.archetypeCount).toBe(1);
		expect(matches._nonEmpty()[0].entityList).toContain(e1);
	});

	it("query with single component returns all archetypes containing it", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 0, y: 0 });
		world.addComponent(e1, Vel, { vx: 0, vy: 0 });

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 0, y: 0 });

		// Query [Pos] should match both archetypes
		const matches = world.query(Pos);
		const allEntities: number[] = [];
		matches.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) allEntities.push(a.entityIds[i]);
		});
		expect(allEntities).toContain(e1);
		expect(allEntities).toContain(e2);
	});

	//=========================================================
	// Cache behavior
	//=========================================================

	it("cached query returns same reference on repeated calls", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const first = world.query(Pos);
		const second = world.query(Pos);

		// Same reference - live Query
		expect(first).toBe(second);
	});

	it("cache is stable when no new archetypes are created", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 0, y: 0 });

		const first = world.query(Pos);

		// Adding another entity to the same archetype does NOT create a new archetype
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 1, y: 1 });

		const second = world.query(Pos);

		// Same reference, same length
		expect(second).toBe(first);
		expect(second.archetypeCount).toBe(first.archetypeCount);
	});

	it("unrelated archetype does not grow the query result", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Hp = world.registerComponent(Health);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });

		const result = world.query(Pos);
		const lengthBefore = result.archetypeCount;

		// Create an entity with only Health — unrelated to Pos query
		const e2 = world.spawn();
		world.addComponent(e2, Hp, { hp: 100 });

		const after = world.query(Pos);

		// Same reference, same archetype_count
		expect(after).toBe(result);
		expect(after.archetypeCount).toBe(lengthBefore);
	});

	//=========================================================
	// Component order independence
	//=========================================================

	it("query result is the same regardless of component order", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 0, y: 0 });
		world.addComponent(e1, Vel, { vx: 0, vy: 0 });

		const resultA = world.query(Pos, Vel);
		const resultB = world.query(Vel, Pos);

		expect(resultA).toBe(resultB);
	});

	//=========================================================
	// Query.not() — exclusion filtering
	//=========================================================

	it("not() excludes archetypes that have the given component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Stat = world.registerComponent(Static);

		// e1: Pos + Vel (not static)
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		// e2: Pos + Vel + Static (excluded)
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Vel, { vx: 7, vy: 8 });
		world.addComponent(e2, Stat, {});

		const q = world.query(Pos, Vel).without(Stat);

		// Only e1's archetype should match
		expect(q.archetypeCount).toBe(1);

		// e2 should not appear in any archetype
		const entityIds: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entityIds.push(a.entityIds[i]);
		});
		expect(entityIds).toContain(e1);
		expect(entityIds).not.toContain(e2);
	});

	it("not() cache hit — same Query reference returned on repeated calls", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Stat = world.registerComponent(Static);

		const q1 = world.query(Pos, Vel).without(Stat);
		const q2 = world.query(Pos, Vel).without(Stat);

		expect(q1).toBe(q2);
	});

	//=========================================================
	// Query.and() — extend required set
	//=========================================================

	it("and() returns same cached Query as query() with both components", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		const qChained = world.query(Pos).and(Vel);
		const qDirect = world.query(Pos, Vel);

		expect(qChained).toBe(qDirect);
	});

	it("and() chaining is order-independent — same mask → same result", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const q1 = world.query(Pos).and(Vel);
		const q2 = world.query(Vel).and(Pos);

		expect(q1).toBe(q2);
	});

	it("and() cache hit — same Query reference on repeated chains", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const q1 = world.query(Pos).and(Vel);
		const q2 = world.query(Pos).and(Vel);

		expect(q1).toBe(q2);
	});

	it("and() skips duplicate components already in include mask", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const q1 = world.query(Pos).and(Pos);
		const q2 = world.query(Pos);

		expect(q1).toBe(q2);
	});

	//=========================================================
	// Query.anyOf() — any-of filtering
	//=========================================================

	it("any_of() passes archetypes with at least one of the any_of-components", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Hp = world.registerComponent(Health);

		// e1: Pos + Vel
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e1, Vel, { vx: 3, vy: 4 });

		// e2: Pos + Hp
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 5, y: 6 });
		world.addComponent(e2, Hp, { hp: 100 });

		// e3: Pos only — no Vel or Hp
		const e3 = world.spawn();
		world.addComponent(e3, Pos, { x: 7, y: 8 });

		const q = world.query(Pos).anyOf(Vel, Hp);

		const entityIds: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) entityIds.push(a.entityIds[i]);
		});
		expect(entityIds).toContain(e1);
		expect(entityIds).toContain(e2);
		expect(entityIds).not.toContain(e3);
	});

	it("any_of() cache hit — same Query reference on repeated calls", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Hp = world.registerComponent(Health);

		const q1 = world.query(Pos).anyOf(Vel, Hp);
		const q2 = world.query(Pos).anyOf(Vel, Hp);

		expect(q1).toBe(q2);
	});

	// Regression: the `componentIndex` inverted index is a push-only
	// `ArchetypeID[][]` (not a `Map<Set>`) on the premise that a
	// (component, archetype) pair is registered AT MOST ONCE — so a shared
	// component must never make a single-component query visit one of its
	// archetypes twice, nor over-count its entities.
	it("shared component across many archetypes is visited once per archetype, no duplicates", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Hp = world.registerComponent(Health);
		const Static = world.registerComponent([] as const);

		// 4 distinct archetypes, all containing Pos: {Pos}, {Pos,Vel},
		// {Pos,Hp}, {Pos,Vel,Hp,Static}. Pos's componentIndex bucket gets one
		// entry per archetype — a duplicate would double-visit here.
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 1 });
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 2, y: 2 });
		world.addComponent(e2, Vel, { vx: 0, vy: 0 });
		const e3 = world.spawn();
		world.addComponent(e3, Pos, { x: 3, y: 3 });
		world.addComponent(e3, Hp, { hp: 10 });
		const e4 = world.spawn();
		world.addComponent(e4, Pos, { x: 4, y: 4 });
		world.addComponent(e4, Vel, { vx: 0, vy: 0 });
		world.addComponent(e4, Hp, { hp: 10 });
		world.addComponent(e4, Static);

		const q = world.query(Pos);
		// Each matching archetype appears exactly once.
		const seen = new Set<number>();
		let visits = 0;
		q.forEach((a) => {
			visits++;
			seen.add(a.id);
		});
		expect(visits).toBe(4);
		expect(seen.size).toBe(4);

		// Every entity is counted exactly once (no double-visit inflation).
		expect(q.entityCount).toBe(4);
		const ids: number[] = [];
		q.forEach((a) => {
			for (let i = 0; i < a.entityCount; i++) ids.push(a.entityIds[i]);
		});
		expect(ids.length).toBe(4);
		expect(new Set(ids).size).toBe(4);
		for (const e of [e1, e2, e3, e4]) expect(ids).toContain(e);
	});
});
