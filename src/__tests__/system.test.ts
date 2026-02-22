import { describe, expect, it, vi } from "vitest";
import { World } from "../world";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";
import type { SystemConfig } from "../system";

function make_config(overrides?: Partial<SystemConfig>): SystemConfig {
  return {
    fn: overrides?.fn ?? ((_ctx: SystemContext, _dt: number) => {}),
    on_added: overrides?.on_added,
    on_removed: overrides?.on_removed,
    dispose: overrides?.dispose,
  };
}

describe("World system registration", () => {
  //=========================================================
  // Registration
  //=========================================================

  it("register_system assigns unique SystemIDs", () => {
    const world = new World();
    const a = world.register_system(make_config());
    const b = world.register_system(make_config());

    expect(a.id).not.toBe(b.id);
    expect(a.id as number).toBe(0);
    expect(b.id as number).toBe(1);
  });

  it("register_system returns a frozen descriptor", () => {
    const world = new World();
    const descriptor = world.register_system(make_config());

    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("system_count tracks registrations", () => {
    const world = new World();
    expect(world.system_count).toBe(0);

    world.register_system(make_config());
    expect(world.system_count).toBe(1);

    world.register_system(make_config());
    expect(world.system_count).toBe(2);
  });

  //=========================================================
  // Removal
  //=========================================================

  it("remove_system calls on_removed and removes from registry", () => {
    const on_removed = vi.fn();
    const world = new World();
    const descriptor = world.register_system(make_config({ on_removed }));

    world.remove_system(descriptor);

    expect(on_removed).toHaveBeenCalledOnce();
    expect(world.system_count).toBe(0);
  });

  //=========================================================
  // Lifecycle: startup calls on_added
  //=========================================================

  it("startup calls on_added on all systems", () => {
    const on_added_a = vi.fn();
    const on_added_b = vi.fn();

    const world = new World();
    world.register_system(make_config({ on_added: on_added_a }));
    world.register_system(make_config({ on_added: on_added_b }));

    world.startup();

    expect(on_added_a).toHaveBeenCalledOnce();
    expect(on_added_b).toHaveBeenCalledOnce();
  });

  it("startup skips systems without on_added", () => {
    const world = new World();
    world.register_system(make_config()); // no on_added

    expect(() => world.startup()).not.toThrow();
  });

  //=========================================================
  // Lifecycle: dispose
  //=========================================================

  it("dispose calls dispose then on_removed, then clears", () => {
    const call_order: string[] = [];
    const world = new World();

    world.register_system(
      make_config({
        dispose: () => call_order.push("dispose"),
        on_removed: () => call_order.push("on_removed"),
      }),
    );

    world.dispose();

    expect(call_order).toEqual(["dispose", "on_removed"]);
    expect(world.system_count).toBe(0);
  });

  it("dispose handles systems without lifecycle hooks", () => {
    const world = new World();
    world.register_system(make_config());

    expect(() => world.dispose()).not.toThrow();
    expect(world.system_count).toBe(0);
  });

  //=========================================================
  // Descriptor preserves fn
  //=========================================================

  it("descriptor preserves the system function", () => {
    const fn = vi.fn();
    const world = new World();
    const descriptor = world.register_system(make_config({ fn }));

    expect(descriptor.fn).toBe(fn);
  });
});

describe("World fixed timestep", () => {
  it("runs FIXED_UPDATE the correct number of times per frame", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    let tick_count = 0;
    const sys = world.register_system(
      make_config({ fn: () => { tick_count++; } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    // One frame of ~2 fixed steps worth
    world.update(2 / 60);
    expect(tick_count).toBe(2);
  });

  it("accumulates partial frames across updates", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    let tick_count = 0;
    const sys = world.register_system(
      make_config({ fn: () => { tick_count++; } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    // Half a step — not enough to tick
    world.update(0.5 / 60);
    expect(tick_count).toBe(0);

    // Another half — now accumulated one full step
    world.update(0.5 / 60);
    expect(tick_count).toBe(1);
  });

  it("passes fixed_timestep as dt to FIXED_UPDATE systems", () => {
    const fixed_dt = 1 / 50;
    const world = new World({ fixed_timestep: fixed_dt });
    let received_dt = 0;
    const sys = world.register_system(
      make_config({ fn: (_ctx, dt) => { received_dt = dt; } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    world.update(fixed_dt);
    expect(received_dt).toBeCloseTo(fixed_dt);
  });

  it("clamps accumulator to prevent spiral of death", () => {
    const world = new World({ fixed_timestep: 1 / 60, max_fixed_steps: 4 });
    let tick_count = 0;
    const sys = world.register_system(
      make_config({ fn: () => { tick_count++; } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    // Huge dt that would require 100 steps without clamping
    world.update(100 / 60);
    expect(tick_count).toBe(4);
  });

  it("skips accumulator loop when no FIXED_UPDATE systems exist", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    const order: string[] = [];
    const sys = world.register_system(
      make_config({ fn: () => { order.push("update"); } }),
    );
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    // Should just run UPDATE, no fixed loop
    world.update(1 / 60);
    expect(order).toEqual(["update"]);
  });

  it("FIXED_UPDATE runs before variable UPDATE phases", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    const order: string[] = [];

    const fixed = world.register_system(
      make_config({ fn: () => { order.push("fixed"); } }),
    );
    const update = world.register_system(
      make_config({ fn: () => { order.push("update"); } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, fixed);
    world.add_systems(SCHEDULE.UPDATE, update);
    world.startup();

    world.update(1 / 60);
    expect(order).toEqual(["fixed", "update"]);
  });

  it("fixed_alpha exposes interpolation factor", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    const sys = world.register_system(make_config());
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    // 1.5 steps: 1 tick consumed, 0.5 step remainder
    world.update(1.5 / 60);
    expect(world.fixed_alpha).toBeCloseTo(0.5);
  });

  it("fixed_timestep getter/setter works", () => {
    const world = new World({ fixed_timestep: 1 / 60 });
    expect(world.fixed_timestep).toBeCloseTo(1 / 60);

    world.fixed_timestep = 1 / 30;
    expect(world.fixed_timestep).toBeCloseTo(1 / 30);
  });

  it("defaults to 1/60 timestep and 4 max steps", () => {
    const world = new World();
    expect(world.fixed_timestep).toBeCloseTo(1 / 60);

    // Verify max_fixed_steps defaults to 4 by testing clamping
    let tick_count = 0;
    const sys = world.register_system(
      make_config({ fn: () => { tick_count++; } }),
    );
    world.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    world.startup();

    world.update(10 / 60);
    expect(tick_count).toBe(4);
  });
});
