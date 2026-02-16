import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { get_entity_index } from "../../entity/entity";
import type { ComponentID } from "../../component/component";
import { BitSet } from "../../collections/bitset";

function make_mask(...ids: (number | ComponentID)[]): BitSet {
  const mask = new BitSet();
  for (const id of ids) mask.set(id as number);
  return mask;
}

// Schemas
const Position = { x: "f32", y: "f32", z: "f32" } as const;
const Velocity = { vx: "f32", vy: "f32", vz: "f32" } as const;
const Health = { current: "i32", max: "i32" } as const;
const Tag = {} as const; // empty schema (marker component)

describe("Store", () => {
  //=========================================================
  // Entity lifecycle
  //=========================================================

  it("creates entities with incrementing indices", () => {
    const store = new Store();
    const a = store.create_entity();
    const b = store.create_entity();
    expect(get_entity_index(a)).toBe(0);
    expect(get_entity_index(b)).toBe(1);
  });

  it("is_alive returns true for living entities", () => {
    const store = new Store();
    const id = store.create_entity();
    expect(store.is_alive(id)).toBe(true);
  });

  it("is_alive returns false after destroy", () => {
    const store = new Store();
    const id = store.create_entity();
    store.destroy_entity(id);
    expect(store.is_alive(id)).toBe(false);
  });

  it("entity_count tracks create/destroy", () => {
    const store = new Store();
    expect(store.entity_count).toBe(0);

    const a = store.create_entity();
    const b = store.create_entity();
    expect(store.entity_count).toBe(2);

    store.destroy_entity(a);
    expect(store.entity_count).toBe(1);

    store.destroy_entity(b);
    expect(store.entity_count).toBe(0);
  });

  it("throws when destroying a dead entity", () => {
    const store = new Store();
    const id = store.create_entity();
    store.destroy_entity(id);
    expect(() => store.destroy_entity(id)).toThrow();
  });

  //=========================================================
  // Component add & archetype transitions
  //=========================================================

  it("add_component transitions entity to new archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    expect(store.has_component(id, Pos)).toBe(true);

    // Data is accessible via ComponentRegistry
    const reg = store.get_component_registry();
    expect(reg.get_field(Pos, id, "x")).toBe(1);
    expect(reg.get_field(Pos, id, "y")).toBe(2);
    expect(reg.get_field(Pos, id, "z")).toBe(3);
  });

  it("add_component overwrites data without transition when component already present", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    const arch_count_before = store.archetype_count;

    store.add_component(id, Pos, { x: 10, y: 20, z: 30 });
    expect(store.archetype_count).toBe(arch_count_before);

    const reg = store.get_component_registry();
    expect(reg.get_field(Pos, id, "x")).toBe(10);
    expect(reg.get_field(Pos, id, "y")).toBe(20);
    expect(reg.get_field(Pos, id, "z")).toBe(30);
  });

  it("adding multiple components transitions through archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    expect(store.has_component(id, Pos)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(false);

    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Pos)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(true);
  });

  //=========================================================
  // Component remove
  //=========================================================

  it("remove_component transitions entity to smaller archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Vel)).toBe(true);

    store.remove_component(id, Vel);
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);
  });

  it("remove_component is a no-op when component not present", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Should not throw
    store.remove_component(id, Vel);
    expect(store.has_component(id, Pos)).toBe(true);
  });

  //=========================================================
  // Independent entities
  //=========================================================

  it("different entities can have different component sets", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 1, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 1, vy: 0, vz: 0 });

    store.add_component(e2, Pos, { x: 2, y: 0, z: 0 });
    store.add_component(e2, Hp, { current: 100, max: 100 });

    expect(store.has_component(e1, Pos)).toBe(true);
    expect(store.has_component(e1, Vel)).toBe(true);
    expect(store.has_component(e1, Hp)).toBe(false);

    expect(store.has_component(e2, Pos)).toBe(true);
    expect(store.has_component(e2, Vel)).toBe(false);
    expect(store.has_component(e2, Hp)).toBe(true);
  });

  //=========================================================
  // Archetype deduplication
  //=========================================================

  it("same component set reuses the same archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0, vz: 0 });

    const arch_count_after_e1 = store.archetype_count;

    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e2, Vel, { vx: 0, vy: 0, vz: 0 });

    // No new archetypes should have been created
    expect(store.archetype_count).toBe(arch_count_after_e1);
  });

  //=========================================================
  // Graph edge caching
  //=========================================================

  it("second transition reuses cached edge (no new archetype)", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    const count_after_first = store.archetype_count;

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    expect(store.archetype_count).toBe(count_after_first);
  });

  //=========================================================
  // Query matching
  //=========================================================

  it("get_matching_archetypes returns archetypes with required components", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0, vz: 0 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e2, Hp, { current: 100, max: 100 });

    // Query for [Pos] - 3 archetypes match: [Pos] (empty intermediate),
    // [Pos, Vel], and [Pos, Hp]. Both entities' final archetypes are included.
    const pos_matches = store.get_matching_archetypes(make_mask(Pos as ComponentID));
    expect(pos_matches.length).toBe(3);

    // Both entities are found across matching archetypes
    const all_entities = pos_matches.flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);

    // Query for [Pos, Vel] - only e1's archetype matches
    const pos_vel_matches = store.get_matching_archetypes(make_mask(Pos as ComponentID, Vel as ComponentID));
    expect(pos_vel_matches.length).toBe(1);
    expect(pos_vel_matches[0].entity_list).toContain(e1);

    // Query for [Hp] - only e2's archetype matches
    const hp_matches = store.get_matching_archetypes(make_mask(Hp as ComponentID));
    expect(hp_matches.length).toBe(1);
    expect(hp_matches[0].entity_list).toContain(e2);
  });

  it("get_matching_archetypes returns empty for unregistered component combo", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });

    // No entity has Vel + Hp
    const matches = store.get_matching_archetypes(make_mask(Vel as ComponentID, Hp as ComponentID));
    expect(matches.length).toBe(0);
  });

  it("get_matching_archetypes with empty required returns all archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    store.create_entity(); // in empty archetype
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });

    const matches = store.get_matching_archetypes(make_mask());
    expect(matches.length).toBe(store.archetype_count);
  });

  //=========================================================
  // Destroy cleanup
  //=========================================================

  it("destroyed entity is removed from its archetype membership", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    const e2 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 0, z: 0 });
    store.add_component(e2, Pos, { x: 2, y: 0, z: 0 });

    const archetypes = store.get_matching_archetypes(make_mask(Pos as ComponentID));
    expect(archetypes.length).toBe(1);
    expect(archetypes[0].entity_count).toBe(2);

    store.destroy_entity(e1);
    expect(archetypes[0].entity_count).toBe(1);
    expect(archetypes[0].entity_list).toContain(e2);
  });

  it("destroy_entity poisons component data", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const reg = store.get_component_registry();

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 10, y: 20, z: 30 });

    // Grab the raw column to inspect after destroy
    const col_x = reg.get_column(Pos, "x");
    const col_y = reg.get_column(Pos, "y");
    const col_z = reg.get_column(Pos, "z");
    expect(col_x[0]).toBe(10);

    store.destroy_entity(e1);
    expect(col_x[0]).toBeNaN();
    expect(col_y[0]).toBeNaN();
    expect(col_z[0]).toBeNaN();
  });

  it("destroy_entity poisons integer component data", () => {
    const store = new Store();
    const Hp = store.register_component(Health);
    const reg = store.get_component_registry();

    const e1 = store.create_entity();
    store.add_component(e1, Hp, { current: 100, max: 200 });

    const col_current = reg.get_column(Hp, "current");
    const col_max = reg.get_column(Hp, "max");

    store.destroy_entity(e1);
    expect(col_current[0]).toBe(-1);
    expect(col_max[0]).toBe(-1);
  });

  it("remove_component poisons component data", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const reg = store.get_component_registry();

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });

    const col_vx = reg.get_column(Vel, "vx");
    const col_vy = reg.get_column(Vel, "vy");
    const col_vz = reg.get_column(Vel, "vz");
    expect(col_vx[0]).toBe(4);

    store.remove_component(id, Vel);

    // Velocity data is poisoned
    expect(col_vx[0]).toBeNaN();
    expect(col_vy[0]).toBeNaN();
    expect(col_vz[0]).toBeNaN();

    // Position data is untouched
    expect(reg.get_field(Pos, id, "x")).toBe(1);
    expect(reg.get_field(Pos, id, "y")).toBe(2);
    expect(reg.get_field(Pos, id, "z")).toBe(3);
  });

  //=========================================================
  // Dev-mode errors
  //=========================================================

  it("throws on add_component to dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.add_component(id, Pos, { x: 0, y: 0, z: 0 })).toThrow();
  });

  it("throws on remove_component from dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.add_component(id, Pos, { x: 0, y: 0, z: 0 });
    store.destroy_entity(id);

    expect(() => store.remove_component(id, Pos)).toThrow();
  });

  it("throws on has_component for dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.has_component(id, Pos)).toThrow();
  });

  //=========================================================
  // Tag components (empty schema)
  //=========================================================

  it("tag components work for archetype grouping", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Marker = store.register_component(Tag);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Marker, {} as Record<string, number>);

    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });

    expect(store.has_component(e1, Marker)).toBe(true);
    expect(store.has_component(e2, Marker)).toBe(false);

    const marker_archetypes = store.get_matching_archetypes(make_mask(Marker as ComponentID));
    expect(marker_archetypes.length).toBe(1);
    expect(marker_archetypes[0].entity_list).toContain(e1);
  });

  //=========================================================
  // Capacity growth
  //=========================================================

  it("handles many entities beyond initial capacity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const ids = [];
    for (let i = 0; i < 200; i++) {
      const id = store.create_entity();
      store.add_component(id, Pos, { x: i, y: 0, z: 0 });
      ids.push(id);
    }

    expect(store.entity_count).toBe(200);

    for (const id of ids) {
      expect(store.is_alive(id)).toBe(true);
      expect(store.has_component(id, Pos)).toBe(true);
    }
  });

  //=========================================================
  // Deferred destruction
  //=========================================================

  it("deferred destroy keeps entity alive until flush", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity_deferred(id);
    expect(store.is_alive(id)).toBe(true);
    expect(store.pending_destroy_count).toBe(1);
  });

  it("flush_destroyed actually destroys entities", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const reg = store.get_component_registry();

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 10, y: 20, z: 30 });

    const archetypes = store.get_matching_archetypes(make_mask(Pos as ComponentID));
    expect(archetypes[0].entity_count).toBe(1);

    store.destroy_entity_deferred(id);
    store.flush_destroyed();

    expect(store.is_alive(id)).toBe(false);
    expect(archetypes[0].entity_count).toBe(0);
    expect(store.pending_destroy_count).toBe(0);

    // Data is poisoned
    const col_x = reg.get_column(Pos, "x");
    expect(col_x[0]).toBeNaN();
  });

  it("double deferred destroy of same entity is safe", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity_deferred(id);
    store.destroy_entity_deferred(id);
    expect(store.pending_destroy_count).toBe(2);

    // flush should not throw — second entry is skipped because entity is already dead
    expect(() => store.flush_destroyed()).not.toThrow();
    expect(store.is_alive(id)).toBe(false);
    expect(store.pending_destroy_count).toBe(0);
  });

  it("immediate destroy_entity still works as before", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity(id);
    expect(store.is_alive(id)).toBe(false);
    expect(store.pending_destroy_count).toBe(0);
  });

  it("pending_destroy_count reflects buffer state", () => {
    const store = new Store();
    const a = store.create_entity();
    const b = store.create_entity();

    expect(store.pending_destroy_count).toBe(0);

    store.destroy_entity_deferred(a);
    expect(store.pending_destroy_count).toBe(1);

    store.destroy_entity_deferred(b);
    expect(store.pending_destroy_count).toBe(2);

    store.flush_destroyed();
    expect(store.pending_destroy_count).toBe(0);
  });

  //=========================================================
  // Deferred structural changes
  //=========================================================

  it("add_component_deferred keeps entity in old archetype until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Deferred add — entity should NOT have Velocity yet
    store.add_component_deferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);

    // After flush, entity transitions
    store.flush_structural();
    expect(store.has_component(id, Vel)).toBe(true);
    expect(store.has_component(id, Pos)).toBe(true);

    // Data is correct
    const reg = store.get_component_registry();
    expect(reg.get_field(Vel, id, "vx")).toBe(4);
    expect(reg.get_field(Vel, id, "vy")).toBe(5);
    expect(reg.get_field(Vel, id, "vz")).toBe(6);
  });

  it("remove_component_deferred keeps component present until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });

    // Deferred remove — entity should still have Velocity
    store.remove_component_deferred(id, Vel);
    expect(store.has_component(id, Vel)).toBe(true);

    // After flush, component is removed
    store.flush_structural();
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);
  });

  it("flush_structural applies adds then removes in order", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Buffer: add Vel, add Hp, remove Pos
    store.add_component_deferred(id, Vel, { vx: 1, vy: 2, vz: 3 });
    store.add_component_deferred(id, Hp, { current: 100, max: 200 });
    store.remove_component_deferred(id, Pos);

    store.flush_structural();

    // Adds applied first, then removes
    expect(store.has_component(id, Vel)).toBe(true);
    expect(store.has_component(id, Hp)).toBe(true);
    expect(store.has_component(id, Pos)).toBe(false);
  });

  it("deferred add to entity later deferred-destroyed: add applies then destroy", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    store.add_component_deferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
    store.destroy_entity_deferred(id);

    // Flush structural first (adds apply), then destroy
    store.flush_structural();
    expect(store.is_alive(id)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(true);

    store.flush_destroyed();
    expect(store.is_alive(id)).toBe(false);
  });

  it("double deferred add of same component: last values win", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();

    store.add_component_deferred(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component_deferred(id, Pos, { x: 10, y: 20, z: 30 });

    store.flush_structural();

    const reg = store.get_component_registry();
    expect(reg.get_field(Pos, id, "x")).toBe(10);
    expect(reg.get_field(Pos, id, "y")).toBe(20);
    expect(reg.get_field(Pos, id, "z")).toBe(30);
  });

  it("pending_structural_count tracks buffer state", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 0, y: 0, z: 0 });

    expect(store.pending_structural_count).toBe(0);

    store.add_component_deferred(id, Vel, { vx: 0, vy: 0, vz: 0 });
    expect(store.pending_structural_count).toBe(1);

    store.remove_component_deferred(id, Pos);
    expect(store.pending_structural_count).toBe(2);

    store.flush_structural();
    expect(store.pending_structural_count).toBe(0);
  });

  it("throws on deferred add to dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() =>
      store.add_component_deferred(id, Pos, { x: 0, y: 0, z: 0 }),
    ).toThrow();
  });

  it("throws on deferred remove from dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.remove_component_deferred(id, Pos)).toThrow();
  });

  it("flush_structural skips dead entities", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const a = store.create_entity();
    const b = store.create_entity();
    store.add_component(a, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(b, Pos, { x: 0, y: 0, z: 0 });

    store.add_component_deferred(a, Vel, { vx: 1, vy: 2, vz: 3 });
    store.add_component_deferred(b, Vel, { vx: 4, vy: 5, vz: 6 });

    // Kill entity a before flushing
    store.destroy_entity(a);

    // Should not throw — dead entity a is skipped
    expect(() => store.flush_structural()).not.toThrow();

    // b should still get its component
    expect(store.has_component(b, Vel)).toBe(true);
  });
});
