import { describe, expect, it, vi } from "vitest";
import { SystemRegistry } from "../system_registry";
import { Store } from "../../store";
import type { SystemContext } from "../../query";
import type { SystemConfig } from "../system";

function make_config(overrides?: Partial<SystemConfig>): SystemConfig {
  return {
    fn: overrides?.fn ?? ((_ctx: SystemContext, _dt: number) => {}),
    on_added: overrides?.on_added,
    on_removed: overrides?.on_removed,
    dispose: overrides?.dispose,
  };
}

describe("SystemRegistry", () => {
  //=========================================================
  // Registration
  //=========================================================

  it("register assigns unique SystemIDs", () => {
    const registry = new SystemRegistry();
    const a = registry.register(make_config());
    const b = registry.register(make_config());

    expect(a.id).not.toBe(b.id);
    expect((a.id as number)).toBe(0);
    expect((b.id as number)).toBe(1);
  });

  it("register returns a frozen descriptor", () => {
    const registry = new SystemRegistry();
    const descriptor = registry.register(make_config());

    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("count tracks registrations", () => {
    const registry = new SystemRegistry();
    expect(registry.count).toBe(0);

    registry.register(make_config());
    expect(registry.count).toBe(1);

    registry.register(make_config());
    expect(registry.count).toBe(2);
  });

  //=========================================================
  // Lookup
  //=========================================================

  it("get retrieves a registered system", () => {
    const registry = new SystemRegistry();
    const descriptor = registry.register(make_config());

    const retrieved = registry.get(descriptor.id);
    expect(retrieved).toBe(descriptor);
  });

  it("get_all returns all registered systems", () => {
    const registry = new SystemRegistry();
    const a = registry.register(make_config());
    const b = registry.register(make_config());

    const all = registry.get_all();
    expect(all).toContain(a);
    expect(all).toContain(b);
    expect(all.length).toBe(2);
  });

  //=========================================================
  // Removal
  //=========================================================

  it("remove calls on_removed and removes from registry", () => {
    const on_removed = vi.fn();
    const registry = new SystemRegistry();
    const descriptor = registry.register(make_config({ on_removed }));

    registry.remove(descriptor.id);

    expect(on_removed).toHaveBeenCalledOnce();
    expect(registry.count).toBe(0);
  });

  it("remove is a no-op for unknown ID", () => {
    const registry = new SystemRegistry();
    const descriptor = registry.register(make_config());

    registry.remove(descriptor.id);
    // Second remove should be a no-op
    expect(() => registry.remove(descriptor.id)).not.toThrow();
  });

  //=========================================================
  // Lifecycle: init_all
  //=========================================================

  it("init_all calls on_added with store on all systems", () => {
    const on_added_a = vi.fn();
    const on_added_b = vi.fn();

    const registry = new SystemRegistry();
    registry.register(make_config({ on_added: on_added_a }));
    registry.register(make_config({ on_added: on_added_b }));

    const store = new Store();
    registry.init_all(store);

    expect(on_added_a).toHaveBeenCalledOnce();
    expect(on_added_a).toHaveBeenCalledWith(store);
    expect(on_added_b).toHaveBeenCalledOnce();
    expect(on_added_b).toHaveBeenCalledWith(store);
  });

  it("init_all skips systems without on_added", () => {
    const registry = new SystemRegistry();
    registry.register(make_config()); // no on_added

    const store = new Store();
    expect(() => registry.init_all(store)).not.toThrow();
  });

  //=========================================================
  // Lifecycle: dispose_all
  //=========================================================

  it("dispose_all calls dispose then on_removed, then clears", () => {
    const call_order: string[] = [];
    const registry = new SystemRegistry();

    registry.register(
      make_config({
        dispose: () => call_order.push("dispose"),
        on_removed: () => call_order.push("on_removed"),
      }),
    );

    registry.dispose_all();

    expect(call_order).toEqual(["dispose", "on_removed"]);
    expect(registry.count).toBe(0);
  });

  it("dispose_all handles systems without lifecycle hooks", () => {
    const registry = new SystemRegistry();
    registry.register(make_config());

    expect(() => registry.dispose_all()).not.toThrow();
    expect(registry.count).toBe(0);
  });

  //=========================================================
  // Descriptor preserves fn
  //=========================================================

  it("descriptor preserves the system function", () => {
    const fn = vi.fn();
    const registry = new SystemRegistry();
    const descriptor = registry.register(make_config({ fn }));

    expect(descriptor.fn).toBe(fn);
  });
});
