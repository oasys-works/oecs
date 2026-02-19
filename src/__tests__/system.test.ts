import { describe, expect, it, vi } from "vitest";
import { World } from "../world";
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
