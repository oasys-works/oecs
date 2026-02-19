import { describe, expect, it } from "vitest";
import { World } from "../world";
import { SCHEDULE } from "../schedule";

// Field arrays
const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;
const Health = ["hp"] as const;
const Static = [] as const; // tag component

describe("World query", () => {
  //=========================================================
  // Basic query
  //=========================================================

  it("query returns matching archetypes", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });

    // Query [Pos, Vel] should match only e1's archetype
    const matches = world.query(Pos, Vel);
    expect(matches.length).toBe(1);
    expect(matches.archetypes[0].entity_list).toContain(e1);
  });

  it("query with single component returns all archetypes containing it", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });
    world.add_component(e1, Vel, { vx: 0, vy: 0 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 0, y: 0 });

    // Query [Pos] should match both archetypes
    const matches = world.query(Pos);
    const all_entities = [...matches].flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);
  });

  //=========================================================
  // Cache behavior
  //=========================================================

  it("cached query returns same reference on repeated calls", () => {
    const world = new World();
    const Pos = world.register_component(Position);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const first = world.query(Pos);
    const second = world.query(Pos);

    // Same reference - live Query
    expect(first).toBe(second);
  });

  it("live query result grows when new matching archetype is created", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const result = world.query(Pos);
    const length_before = result.length;
    expect(length_before).toBeGreaterThan(0);

    // Adding a new component combo creates a new archetype containing Pos
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 0, y: 0 });
    world.add_component(e2, Vel, { vx: 0, vy: 0 });

    // Same reference — live array was updated in-place by the registry
    const after = world.query(Pos);
    expect(after).toBe(result);
    expect(after.length).toBeGreaterThan(length_before);
  });

  it("cache is stable when no new archetypes are created", () => {
    const world = new World();
    const Pos = world.register_component(Position);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });

    const first = world.query(Pos);

    // Adding another entity to the same archetype does NOT create a new archetype
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 1, y: 1 });

    const second = world.query(Pos);

    // Same reference, same length
    expect(second).toBe(first);
    expect(second.length).toBe(first.length);
  });

  it("unrelated archetype does not grow the query result", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Hp = world.register_component(Health);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const result = world.query(Pos);
    const length_before = result.length;

    // Create an entity with only Health — unrelated to Pos query
    const e2 = world.create_entity();
    world.add_component(e2, Hp, { hp: 100 });

    const after = world.query(Pos);

    // Same reference, same length
    expect(after).toBe(result);
    expect(after.length).toBe(length_before);
  });

  //=========================================================
  // Component order independence
  //=========================================================

  it("query result is the same regardless of component order", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });
    world.add_component(e1, Vel, { vx: 0, vy: 0 });

    const result_a = world.query(Pos, Vel);
    const result_b = world.query(Vel, Pos);

    expect(result_a).toBe(result_b);
  });

  //=========================================================
  // Deferred destruction via world
  //=========================================================

  it("destroy_entity defers — entity stays alive after call", () => {
    const world = new World();

    const id = world.create_entity();
    world.destroy_entity(id);

    expect(world.is_alive(id)).toBe(true);
  });

  it("flush processes the deferred buffer", () => {
    const world = new World();

    const id = world.create_entity();
    world.destroy_entity(id);
    world.flush();

    expect(world.is_alive(id)).toBe(false);
  });

  //=========================================================
  // Column access integration
  //=========================================================

  it("allows column access through archetype dense columns", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 10, y: 20 });
    world.add_component(e1, Vel, { vx: 1, vy: 2 });

    for (const arch of world.query(Pos, Vel)) {
      const px = arch.get_column(Pos, "x");
      const vy = arch.get_column(Vel, "vy");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(px[i]).toBe(10);
        expect(vy[i]).toBe(2);
      }
    }
  });

  //=========================================================
  // Deferred structural changes + query consistency
  //=========================================================

  it("deferred add_component does not change query result length until flush", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    // Cache a query for [Pos, Vel] — currently empty
    const before = world.query(Pos, Vel);
    expect(before.length).toBe(0);

    // System defers an add_component
    let len_during_system = -1;
    const sys = world.register_system(
      (q, ctx) => {
        ctx.add_component(e1, Vel, { vx: 3, vy: 4 });
        len_during_system = q.length;
      },
      (qb) => qb.every(Pos, Vel),
    );
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // During the system, the query was still empty
    expect(len_during_system).toBe(0);

    // After update (which flushes), the live array has grown
    const after = world.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after.archetypes[0].entity_list).toContain(e1);
  });

  it("deferred remove_component does not change query result until flush", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    // Cache a query for [Pos, Vel] — entity e1 is in it
    const before = world.query(Pos, Vel);
    expect(before.length).toBe(1);
    expect(before.archetypes[0].entity_count).toBe(1);

    // System defers a remove_component
    let count_during_system = -1;
    const sys = world.register_system(
      (q, ctx) => {
        ctx.remove_component(e1, Vel);
        count_during_system = q.archetypes[0].entity_count;
      },
      (qb) => qb.every(Pos, Vel),
    );
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // During the system, entity was still in its archetype
    expect(count_during_system).toBe(1);

    // After update (which flushes), entity has moved out
    expect(before.archetypes[0].entity_count).toBe(0);
  });

  it("two systems in sequence see consistent state until flush", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const pos_query = world.query(Pos);
    const pos_vel_query = world.query(Pos, Vel);

    let sys1_saw_pos = false;
    let sys2_vel_len = -1;

    // System 1 observes Pos query and defers adding Vel
    const s1 = world.register_system({
      fn(ctx) {
        const entities = [...pos_query].flatMap((a) => [...a.entity_list]);
        if (entities.includes(e1)) sys1_saw_pos = true;
        ctx.add_component(e1, Vel, { vx: 0, vy: 0 });
      },
    });

    // System 2 observes Pos+Vel query — should still see old state
    const s2 = world.register_system({
      fn() {
        sys2_vel_len = pos_vel_query.length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, s1, s2);
    world.startup();
    world.update(0);

    expect(sys1_saw_pos).toBe(true);
    expect(sys2_vel_len).toBe(0);

    // After update flush, re-query sees the change
    const after = world.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after.archetypes[0].entity_list).toContain(e1);
  });

  it("flush processes structural changes before destructions", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    // System defers both add and destroy
    const sys = world.register_system(
      (_q, ctx) => {
        ctx.add_component(e1, Vel, { vx: 0, vy: 0 });
        ctx.destroy_entity(e1);
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // After flush: structural applies (add Vel), then destroy runs
    expect(world.is_alive(e1)).toBe(false);
  });

  //=========================================================
  // Query.each() — typed column iteration
  //=========================================================

  it("each() calls fn once per non-empty archetype with correct columns and count", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 10, y: 20 });
    world.add_component(e1, Vel, { vx: 1, vy: 2 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 30, y: 40 });
    world.add_component(e2, Vel, { vx: 3, vy: 4 });

    let call_count = 0;
    let total_entities = 0;

    world.query(Pos, Vel).each((pos, vel, n) => {
      call_count++;
      total_entities += n;
      // Verify typed columns are accessible
      for (let i = 0; i < n; i++) {
        expect(typeof pos.x[i]).toBe("number");
        expect(typeof vel.vx[i]).toBe("number");
      }
    });

    expect(call_count).toBe(1); // one archetype
    expect(total_entities).toBe(2);
  });

  it("each() skips archetypes with zero entities", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 0, vy: 0 });

    const q = world.query(Pos, Vel);

    // Deferred destroy + flush to empty the archetype
    world.destroy_entity(e1);
    world.flush();

    let call_count = 0;
    q.each((_pos, _vel, _n) => {
      call_count++;
    });
    expect(call_count).toBe(0);
  });

  it("each() reflects correct typed array values", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 5, y: 7 });
    world.add_component(e1, Vel, { vx: 2, vy: 3 });

    world.query(Pos, Vel).each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i]; // 5 + 2 = 7
        pos.y[i] += vel.vy[i]; // 7 + 3 = 10
      }
    });

    // Verify mutation via get_column
    for (const arch of world.query(Pos, Vel)) {
      const x = arch.get_column(Pos, "x");
      const y = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(x[i]).toBe(7);
        expect(y[i]).toBe(10);
      }
    }
  });

  //=========================================================
  // Query.not() — exclusion filtering
  //=========================================================

  it("not() excludes archetypes that have the given component", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Stat = world.register_component(Static);

    // e1: Pos + Vel (not static)
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Vel + Static (excluded)
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Vel, { vx: 7, vy: 8 });
    world.add_component(e2, Stat, {});

    const q = world.query(Pos, Vel).not(Stat);

    // Only e1's archetype should match
    expect(q.length).toBe(1);

    // e2 should not appear in any archetype
    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).not.toContain(e2);
  });

  it("not() live — newly created excluded archetype does not appear", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Stat = world.register_component(Static);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = world.query(Pos, Vel).not(Stat);
    const before_len = q.length;

    // Create a new entity with the excluded component
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Vel, { vx: 7, vy: 8 });
    world.add_component(e2, Stat, {});

    // Live array should NOT have grown — excluded archetype rejected
    expect(q.length).toBe(before_len);
  });

  it("not() cache hit — same Query reference returned on repeated calls", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Stat = world.register_component(Static);

    const q1 = world.query(Pos, Vel).not(Stat);
    const q2 = world.query(Pos, Vel).not(Stat);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.and() — extend required set
  //=========================================================

  it("and() returns same cached Query as query() with both components", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q_chained = world.query(Pos).and(Vel);
    const q_direct = world.query(Pos, Vel);

    expect(q_chained).toBe(q_direct);
  });

  it("and() chaining is order-independent — same mask → same result", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const q1 = world.query(Pos).and(Vel);
    const q2 = world.query(Vel).and(Pos);

    expect(q1).toBe(q2);
  });

  it("and() cache hit — same Query reference on repeated chains", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const q1 = world.query(Pos).and(Vel);
    const q2 = world.query(Pos).and(Vel);

    expect(q1).toBe(q2);
  });

  it("and() skips duplicate components already in include mask", () => {
    const world = new World();
    const Pos = world.register_component(Position);

    const q1 = world.query(Pos).and(Pos);
    const q2 = world.query(Pos);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.or() — any-of filtering
  //=========================================================

  it("or() passes archetypes with at least one of the or-components", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    // e1: Pos + Vel
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Hp
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Hp, { hp: 100 });

    // e3: Pos only — no Vel or Hp
    const e3 = world.create_entity();
    world.add_component(e3, Pos, { x: 7, y: 8 });

    const q = world.query(Pos).or(Vel, Hp);

    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).toContain(e2);
    expect(entity_ids).not.toContain(e3);
  });

  it("or() live — new matching archetype gets added to live array", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = world.query(Pos).or(Vel, Hp);
    const before_len = q.length;

    // New archetype with Pos + Hp should be picked up
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Hp, { hp: 50 });

    expect(q.length).toBeGreaterThan(before_len);
    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e2);
  });

  it("or() live — archetype with none of the or-components is not added", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = world.query(Pos).or(Vel);
    const before_len = q.length;

    // New archetype with Pos + Hp — Hp is NOT in the or-mask
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Hp, { hp: 50 });

    expect(q.length).toBe(before_len);
  });

  it("or() cache hit — same Query reference on repeated calls", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    const q1 = world.query(Pos).or(Vel, Hp);
    const q2 = world.query(Pos).or(Vel, Hp);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // register_system with QueryBuilder
  //=========================================================

  it("register_system with query builder resolves query at registration time", () => {
    const world = new World();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    let captured_q: any = null;
    const sys = world.register_system(
      (q, _ctx, _dt) => {
        captured_q = q;
      },
      (qb) => qb.every(Pos, Vel),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0.016);

    expect(captured_q).not.toBeNull();
    expect(captured_q.length).toBe(1);
  });

  it("register_system with config object still works", () => {
    const world = new World();
    let ran = false;
    const sys = world.register_system({
      fn: (_ctx, _dt) => {
        ran = true;
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0.016);
    expect(ran).toBe(true);
  });
});
