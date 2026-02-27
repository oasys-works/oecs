import { describe, expect, it } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

describe("ComponentRef (ctx.ref)", () => {
  //=========================================================
  // Reading fields
  //=========================================================

  it("reads current field values from the SoA columns", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 10, y: 20 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(20);
  });

  it("reads updated values after set_field", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    ctx.set_field(e, Pos, "x", 99);
    const pos = ctx.ref(Pos, e);
    expect(pos.x).toBe(99);
    expect(pos.y).toBe(2);
  });

  //=========================================================
  // Writing fields
  //=========================================================

  it("writes directly to the SoA columns", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    pos.x = 42;
    pos.y = 84;

    expect(ctx.get_field(e, Pos, "x")).toBe(42);
    expect(ctx.get_field(e, Pos, "y")).toBe(84);
  });

  it("supports compound assignment operators", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 10, y: 20 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    pos.x += 5;
    pos.y *= 2;

    expect(pos.x).toBe(15);
    expect(pos.y).toBe(40);
  });

  //=========================================================
  // Multiple refs
  //=========================================================

  it("refs to different components on the same entity are independent", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, Vel, { vx: 10, vy: 20 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    const vel = ctx.ref(Vel, e);

    pos.x += vel.vx;
    pos.y += vel.vy;

    expect(pos.x).toBe(11);
    expect(pos.y).toBe(22);
    expect(vel.vx).toBe(10);
    expect(vel.vy).toBe(20);
  });

  it("refs to the same component on different entities are independent", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e1 = world.create_entity();
    const e2 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e2, Pos, { x: 100, y: 200 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const p1 = ctx.ref(Pos, e1);
    const p2 = ctx.ref(Pos, e2);

    p1.x = 999;

    expect(p1.x).toBe(999);
    expect(p2.x).toBe(100);
  });

  //=========================================================
  // Prototype caching
  //=========================================================

  it("refs to the same component share a prototype", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e1 = world.create_entity();
    const e2 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });
    world.add_component(e2, Pos, { x: 0, y: 0 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const r1 = ctx.ref(Pos, e1);
    const r2 = ctx.ref(Pos, e2);

    expect(r1).not.toBe(r2);
    expect(Object.getPrototypeOf(r1)).toBe(Object.getPrototypeOf(r2));
  });

  //=========================================================
  // Live column binding
  //=========================================================

  it("ref reads live data — reflects external writes", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    expect(pos.x).toBe(0);

    // Write via set_field, read through existing ref
    ctx.set_field(e, Pos, "x", 77);
    expect(pos.x).toBe(77);
  });

  //=========================================================
  // Safety: refs are valid inside systems because structural
  // changes are deferred until flush.
  //
  // A ref captures _columns (the backing arrays from the
  // current archetype) and _row (the entity's position in
  // those arrays). An archetype transition (add/remove
  // component) would move the entity to a new archetype,
  // invalidating both. Deferred operations prevent this:
  // ctx.add_component / ctx.remove_component / ctx.destroy_entity
  // only buffer the intent — the entity stays in its current
  // archetype until ctx.flush() runs (automatically after each
  // schedule phase).
  //
  // These tests verify that refs created before a deferred
  // operation still read/write correct data.
  //=========================================================

  it("ref remains valid after deferred add_component (entity has not moved yet)", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 10, y: 20 });

    let ref_x_after_deferred_add = -1;
    let ref_y_after_deferred_add = -1;

    const sys = world.register_system({
      fn(ctx) {
        // Create ref while entity is in archetype [Pos]
        const pos = ctx.ref(Pos, e);
        expect(pos.x).toBe(10);
        expect(pos.y).toBe(20);

        // Defer adding Vel — entity should NOT move archetypes yet
        ctx.add_component(e, Vel, { vx: 1, vy: 2 });

        // Ref should still be valid: entity is still in [Pos]
        pos.x = 99;
        ref_x_after_deferred_add = pos.x;
        ref_y_after_deferred_add = pos.y;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(ref_x_after_deferred_add).toBe(99);
    expect(ref_y_after_deferred_add).toBe(20);

    // After flush (update completes), the entity moved to [Pos, Vel]
    // and the written value was carried over via copy_shared_from
    expect(world.get_field(e, Pos, "x")).toBe(99);
    expect(world.get_field(e, Vel, "vx")).toBe(1);
  });

  it("ref remains valid after deferred remove_component", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 5, y: 6 });
    world.add_component(e, Vel, { vx: 7, vy: 8 });

    let ref_vx_after_deferred_remove = -1;

    const sys = world.register_system({
      fn(ctx) {
        const vel = ctx.ref(Vel, e);
        expect(vel.vx).toBe(7);

        // Defer removing Vel — entity stays in [Pos, Vel] until flush
        ctx.remove_component(e, Vel);

        // Ref still reads correct data from the old archetype
        ref_vx_after_deferred_remove = vel.vx;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(ref_vx_after_deferred_remove).toBe(7);

    // After flush, entity is in [Pos] — Vel is gone
    expect(world.has_component(e, Vel)).toBe(false);
    expect(world.get_field(e, Pos, "x")).toBe(5);
  });

  it("ref remains valid after deferred destroy_entity", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 42, y: 84 });

    let ref_x_after_deferred_destroy = -1;

    const sys = world.register_system({
      fn(ctx) {
        const pos = ctx.ref(Pos, e);
        expect(pos.x).toBe(42);

        // Defer destruction — entity is still alive and in its archetype
        ctx.destroy_entity(e);

        // Ref still works: entity has not been removed yet
        ref_x_after_deferred_destroy = pos.x;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(ref_x_after_deferred_destroy).toBe(42);
    expect(world.is_alive(e)).toBe(false);
  });

  it("two refs to different components remain valid through deferred operations", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Health = world.register_component(["hp"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, Vel, { vx: 3, vy: 4 });

    let pos_x = -1;
    let vel_vx = -1;

    const sys = world.register_system({
      fn(ctx) {
        const pos = ctx.ref(Pos, e);
        const vel = ctx.ref(Vel, e);

        // Defer adding a third component
        ctx.add_component(e, Health, { hp: 100 });

        // Both refs still valid — use vel to update pos
        pos.x += vel.vx;
        pos.y += vel.vy;

        pos_x = pos.x;
        vel_vx = vel.vx;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(pos_x).toBe(4);  // 1 + 3
    expect(vel_vx).toBe(3);

    // After flush, values carried over to new archetype [Pos, Vel, Health]
    expect(world.get_field(e, Pos, "x")).toBe(4);
    expect(world.get_field(e, Pos, "y")).toBe(6);  // 2 + 4
    expect(world.get_field(e, Health, "hp")).toBe(100);
  });

  //=========================================================
  // Field enumeration
  //=========================================================

  it("component fields are enumerable on the prototype", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 5, y: 10 });

    let ctx!: SystemContext;
    const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    const pos = ctx.ref(Pos, e);
    const proto = Object.getPrototypeOf(pos);
    const keys = Object.keys(proto);

    expect(keys).toContain("x");
    expect(keys).toContain("y");
    expect(keys).toHaveLength(2);
  });
});
