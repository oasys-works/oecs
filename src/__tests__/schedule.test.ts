import { describe, expect, it } from "vitest";
import { Schedule, SCHEDULE } from "../schedule";
import { SystemContext } from "../query";
import { Store } from "../store";
import {
  as_system_id,
  type SystemConfig,
  type SystemDescriptor,
  type SystemFn,
} from "../system";

let next_id = 0;

const noop: SystemFn = () => {};

function make_ctx(): SystemContext {
  return new SystemContext(new Store());
}

function make_system(overrides?: Partial<SystemConfig>): SystemDescriptor {
  return Object.freeze({
    id: as_system_id(next_id++),
    fn: overrides?.fn ?? noop,
    on_added: overrides?.on_added,
    on_removed: overrides?.on_removed,
    dispose: overrides?.dispose,
  });
}

describe("Schedule", () => {
  //=========================================================
  // Basic add/has/remove
  //=========================================================

  it("add_systems and has_system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    expect(schedule.has_system(sys)).toBe(false);

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    expect(schedule.has_system(sys)).toBe(true);
  });

  it("remove_system removes from schedule", () => {
    const schedule = new Schedule();
    const sys = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    schedule.remove_system(sys);

    expect(schedule.has_system(sys)).toBe(false);
  });

  it("remove_system is a no-op for unscheduled system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    expect(() => schedule.remove_system(sys)).not.toThrow();
  });

  it("get_all_systems returns all scheduled systems", () => {
    const schedule = new Schedule();
    const a = make_system();
    const b = make_system();
    const c = make_system();

    schedule.add_systems(SCHEDULE.STARTUP, a);
    schedule.add_systems(SCHEDULE.UPDATE, b, c);

    const all = schedule.get_all_systems();
    expect(all).toContain(a);
    expect(all).toContain(b);
    expect(all).toContain(c);
    expect(all.length).toBe(3);
  });

  it("clear removes all systems", () => {
    const schedule = new Schedule();
    const a = make_system();
    const b = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, a, b);
    schedule.clear();

    expect(schedule.has_system(a)).toBe(false);
    expect(schedule.has_system(b)).toBe(false);
    expect(schedule.get_all_systems().length).toBe(0);
  });

  //=========================================================
  // Duplicate detection
  //=========================================================

  it("throws on duplicate system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    expect(() => schedule.add_systems(SCHEDULE.UPDATE, sys)).toThrow();
  });

  //=========================================================
  // Execution order
  //=========================================================

  it("run_startup executes PRE_STARTUP -> STARTUP -> POST_STARTUP", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const pre = make_system({ fn: () => order.push("pre") });
    const main = make_system({ fn: () => order.push("main") });
    const post = make_system({ fn: () => order.push("post") });

    schedule.add_systems(SCHEDULE.PRE_STARTUP, pre);
    schedule.add_systems(SCHEDULE.STARTUP, main);
    schedule.add_systems(SCHEDULE.POST_STARTUP, post);

    schedule.run_startup(ctx);

    expect(order).toEqual(["pre", "main", "post"]);
  });

  it("run_update executes PRE_UPDATE -> UPDATE -> POST_UPDATE", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const pre = make_system({ fn: () => order.push("pre") });
    const main = make_system({ fn: () => order.push("main") });
    const post = make_system({ fn: () => order.push("post") });

    schedule.add_systems(SCHEDULE.PRE_UPDATE, pre);
    schedule.add_systems(SCHEDULE.UPDATE, main);
    schedule.add_systems(SCHEDULE.POST_UPDATE, post);

    schedule.run_update(ctx, 0.016);

    expect(order).toEqual(["pre", "main", "post"]);
  });

  it("run_update passes delta_time to system fn", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    let received_dt = 0;
    const sys = make_system({
      fn: (_ctx, dt) => {
        received_dt = dt;
      },
    });

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    schedule.run_update(ctx, 0.016);

    expect(received_dt).toBeCloseTo(0.016);
  });

  //=========================================================
  // Ordering constraints
  //=========================================================

  it("before constraint orders systems correctly", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });

    // a runs before b
    schedule.add_systems(
      SCHEDULE.UPDATE,
      { system: a, ordering: { before: [b] } },
      b,
    );

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b"]);
  });

  it("after constraint orders systems correctly", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });

    // b runs after a
    schedule.add_systems(SCHEDULE.UPDATE, a, {
      system: b,
      ordering: { after: [a] },
    });

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b"]);
  });

  it("insertion order is used as tiebreaker when no constraints", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });
    const c = make_system({ fn: () => order.push("c") });

    schedule.add_systems(SCHEDULE.UPDATE, a, b, c);

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("complex ordering chain: a -> b -> c", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });
    const c = make_system({ fn: () => order.push("c") });

    // c registered first but must run last
    schedule.add_systems(
      SCHEDULE.UPDATE,
      { system: c, ordering: { after: [b] } },
      { system: b, ordering: { after: [a] } },
      a,
    );

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("constraints referencing systems in different labels are ignored", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });

    // b is in a different label, so "after b" constraint is ignored
    schedule.add_systems(SCHEDULE.PRE_UPDATE, b);
    schedule.add_systems(SCHEDULE.UPDATE, {
      system: a,
      ordering: { after: [b] },
    });

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["b", "a"]);
  });

  //=========================================================
  // Circular dependency detection
  //=========================================================

  it("throws on circular dependency", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    const a = make_system();
    const b = make_system();

    schedule.add_systems(
      SCHEDULE.UPDATE,
      { system: a, ordering: { before: [b] } },
      { system: b, ordering: { before: [a] } },
    );

    expect(() => schedule.run_update(ctx, 0)).toThrow(/Circular/);
  });

  it("throws on 3-way circular dependency", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    const a = make_system();
    const b = make_system();
    const c = make_system();

    schedule.add_systems(
      SCHEDULE.UPDATE,
      { system: a, ordering: { before: [b] } },
      { system: b, ordering: { before: [c] } },
      { system: c, ordering: { before: [a] } },
    );

    expect(() => schedule.run_update(ctx, 0)).toThrow(/Circular/);
  });

  //=========================================================
  // Cache invalidation
  //=========================================================

  it("sort cache invalidates on add", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    schedule.add_systems(SCHEDULE.UPDATE, a);

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a"]);

    order.length = 0;

    const b = make_system({ fn: () => order.push("b") });
    schedule.add_systems(SCHEDULE.UPDATE, b);

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b"]);
  });

  it("sort cache invalidates on remove", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });
    schedule.add_systems(SCHEDULE.UPDATE, a, b);

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["a", "b"]);

    order.length = 0;
    schedule.remove_system(a);

    schedule.run_update(ctx, 0);
    expect(order).toEqual(["b"]);
  });

  //=========================================================
  // SystemContext integration
  //=========================================================

  it("systems receive SystemContext with working store access", () => {
    const schedule = new Schedule();
    const store = new Store();
    const ctx = new SystemContext(store);

    let created_entity = false;
    const sys = make_system({
      fn: (ctx_arg) => {
        const id = ctx_arg.create_entity();
        created_entity = store.is_alive(id);
      },
    });

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    schedule.run_update(ctx, 0);

    expect(created_entity).toBe(true);
  });

  //=========================================================
  // Deferred destruction flush
  //=========================================================

  it("entities destroyed in a system are flushed before the next phase runs", () => {
    const schedule = new Schedule();
    const store = new Store();
    const ctx = new SystemContext(store);

    const entity = store.create_entity();
    let alive_in_update: boolean | null = null;

    // PRE_UPDATE system defers destruction
    const destroyer = make_system({
      fn: (c) => {
        c.destroy_entity(entity);
      },
    });

    // UPDATE system checks if entity is still alive
    const checker = make_system({
      fn: () => {
        alive_in_update = store.is_alive(entity);
      },
    });

    schedule.add_systems(SCHEDULE.PRE_UPDATE, destroyer);
    schedule.add_systems(SCHEDULE.UPDATE, checker);
    schedule.run_update(ctx, 0);

    expect(alive_in_update).toBe(false);
  });

  //=========================================================
  // Empty phases
  //=========================================================

  it("running empty phases does not throw", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    expect(() => schedule.run_startup(ctx)).not.toThrow();
    expect(() => schedule.run_update(ctx, 0.016)).not.toThrow();
  });

  //=========================================================
  // Fixed update
  //=========================================================

  it("has_fixed_systems returns false when no systems registered", () => {
    const schedule = new Schedule();
    expect(schedule.has_fixed_systems()).toBe(false);
  });

  it("has_fixed_systems returns true after adding a system", () => {
    const schedule = new Schedule();
    const sys = make_system();
    schedule.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    expect(schedule.has_fixed_systems()).toBe(true);
  });

  it("has_fixed_systems returns false after removing the only system", () => {
    const schedule = new Schedule();
    const sys = make_system();
    schedule.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    schedule.remove_system(sys);
    expect(schedule.has_fixed_systems()).toBe(false);
  });

  it("run_fixed_update executes FIXED_UPDATE systems with fixed_dt", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    let received_dt = 0;
    const sys = make_system({
      fn: (_ctx, dt) => {
        received_dt = dt;
      },
    });

    schedule.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    schedule.run_fixed_update(ctx, 1 / 50);

    expect(received_dt).toBeCloseTo(1 / 50);
  });

  it("run_fixed_update respects ordering constraints", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();
    const order: string[] = [];

    const a = make_system({ fn: () => order.push("a") });
    const b = make_system({ fn: () => order.push("b") });

    schedule.add_systems(
      SCHEDULE.FIXED_UPDATE,
      { system: b, ordering: { after: [a] } },
      a,
    );

    schedule.run_fixed_update(ctx, 1 / 60);
    expect(order).toEqual(["a", "b"]);
  });
});
