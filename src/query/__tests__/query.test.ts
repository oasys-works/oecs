import { describe, expect, it } from "vitest";
import { SystemContext } from "../query";
import { Store } from "../../store/store";

// Schemas
const Position = { x: "f32", y: "f32" } as const;
const Velocity = { vx: "f32", vy: "f32" } as const;
const Health = { hp: "f32" } as const;

describe("SystemContext", () => {
  //=========================================================
  // Basic query
  //=========================================================

  it("query returns matching archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });

    // Query [Pos, Vel] should match only e1's archetype
    const matches = ctx.query(Pos, Vel);
    expect(matches.length).toBe(1);
    expect(matches[0].entity_list).toContain(e1);
  });

  it("query with single component returns all archetypes containing it", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0 });

    // Query [Pos] should match both archetypes
    const matches = ctx.query(Pos);
    const all_entities = matches.flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);
  });

  //=========================================================
  // Cache behavior
  //=========================================================

  it("cached query returns same reference on repeated calls", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const first = ctx.query(Pos);
    const second = ctx.query(Pos);

    // Same reference - live array
    expect(first).toBe(second);
  });

  it("live query result grows when new matching archetype is created", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const result = ctx.query(Pos);
    const length_before = result.length;
    expect(length_before).toBeGreaterThan(0);

    // Adding a new component combo creates a new archetype containing Pos
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0 });
    store.add_component(e2, Vel, { vx: 0, vy: 0 });

    // Same reference — live array was updated in-place by the registry
    const after = ctx.query(Pos);
    expect(after).toBe(result);
    expect(after.length).toBeGreaterThan(length_before);
  });

  it("cache is stable when no new archetypes are created", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });

    const first = ctx.query(Pos);

    // Adding another entity to the same archetype does NOT create a new archetype
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 1, y: 1 });

    const second = ctx.query(Pos);

    // Same reference, same length
    expect(second).toBe(first);
    expect(second.length).toBe(first.length);
  });

  it("unrelated archetype does not grow the query result", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Hp = store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const result = ctx.query(Pos);
    const length_before = result.length;

    // Create an entity with only Health — unrelated to Pos query
    const e2 = store.create_entity();
    store.add_component(e2, Hp, { hp: 100 });

    const after = ctx.query(Pos);

    // Same reference, same length
    expect(after).toBe(result);
    expect(after.length).toBe(length_before);
  });

  //=========================================================
  // Component order independence
  //=========================================================

  it("query result is the same regardless of component order", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0 });

    const result_a = ctx.query(Pos, Vel);
    const result_b = ctx.query(Vel, Pos);

    expect(result_a).toBe(result_b);
  });

  //=========================================================
  // Deferred destruction via SystemContext
  //=========================================================

  it("destroy_entity defers — entity stays alive after call", () => {
    const store = new Store();
    const ctx = new SystemContext(store);

    const id = store.create_entity();
    ctx.destroy_entity(id);

    expect(store.is_alive(id)).toBe(true);
  });

  it("flush_destroyed processes the deferred buffer", () => {
    const store = new Store();
    const ctx = new SystemContext(store);

    const id = store.create_entity();
    ctx.destroy_entity(id);
    ctx.flush_destroyed();

    expect(store.is_alive(id)).toBe(false);
  });

  //=========================================================
  // Column access integration
  //=========================================================

  it("allows column access through store's component registry", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 10, y: 20 });
    store.add_component(e1, Vel, { vx: 1, vy: 2 });

    const reg = ctx.components;
    const px = reg.get_column(Pos, "x");
    const vy = reg.get_column(Vel, "vy");

    for (const arch of ctx.query(Pos, Vel)) {
      for (const eid of arch.entity_list) {
        const i = eid & 0xfffff; // get_entity_index
        expect(px[i]).toBe(10);
        expect(vy[i]).toBe(2);
      }
    }
  });

  //=========================================================
  // Deferred structural changes + query consistency
  //=========================================================

  it("deferred add_component does not change query result length until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // Cache a query for [Pos, Vel] — currently empty
    const before = ctx.query(Pos, Vel);
    expect(before.length).toBe(0);

    // Deferred add — should NOT change cached query
    ctx.add_component(e1, Vel, { vx: 3, vy: 4 });
    const still_before = ctx.query(Pos, Vel);
    expect(still_before.length).toBe(0);

    // After flush, the live array has grown
    ctx.flush();
    const after = ctx.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after[0].entity_list).toContain(e1);
  });

  it("deferred remove_component does not change query result until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    // Cache a query for [Pos, Vel] — entity e1 is in it
    const before = ctx.query(Pos, Vel);
    expect(before.length).toBe(1);
    expect(before[0].entity_count).toBe(1);

    // Deferred remove — entity still appears in its archetype
    ctx.remove_component(e1, Vel);
    expect(before[0].entity_count).toBe(1);

    // After flush, entity has moved out
    ctx.flush();
    expect(before[0].entity_count).toBe(0);
  });

  it("two systems in sequence see consistent state until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // "System 1" queries and defers a structural change
    const system1_result = ctx.query(Pos);
    expect(system1_result.flatMap((a) => [...a.entity_list])).toContain(e1);
    ctx.add_component(e1, Vel, { vx: 0, vy: 0 });

    // "System 2" queries — still sees old archetypes only
    const system2_result_pos_vel = ctx.query(Pos, Vel);
    expect(system2_result_pos_vel.length).toBe(0);

    // Flush between phases
    ctx.flush();

    // Now re-query sees updated state (live array grew)
    const after = ctx.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after[0].entity_list).toContain(e1);
  });

  it("flush processes structural changes before destructions", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // Defer add then destroy
    ctx.add_component(e1, Vel, { vx: 0, vy: 0 });
    ctx.destroy_entity(e1);

    // After flush: structural applies (add Vel), then destroy runs
    ctx.flush();
    expect(store.is_alive(e1)).toBe(false);
  });
});
