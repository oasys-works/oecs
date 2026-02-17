import { describe, expect, it } from "vitest";
import { ArchetypeRegistry } from "../archetype_registry";
import { ComponentRegistry } from "../../component/component_registry";
import { as_component_id, type ComponentID } from "../../component/component";
import { BitSet } from "type_primitives";

// Helpers
const comp_id = (n: number) => as_component_id(n) as ComponentID;

function make_mask(...ids: number[]): BitSet {
  const mask = new BitSet();
  for (const id of ids) mask.set(id);
  return mask;
}

function make_registry_with_components(count: number): {
  comp_reg: ComponentRegistry;
  arch_reg: ArchetypeRegistry;
} {
  const comp_reg = new ComponentRegistry();
  for (let i = 0; i < count; i++) {
    comp_reg.register({ [`f${i}`]: "f32" });
  }
  const arch_reg = new ArchetypeRegistry(comp_reg);
  return { comp_reg, arch_reg };
}

describe("ArchetypeRegistry", () => {
  //=========================================================
  // Construction
  //=========================================================

  it("creates empty archetype on construction", () => {
    const { arch_reg } = make_registry_with_components(0);
    expect(arch_reg.count).toBe(1);

    const empty = arch_reg.get(arch_reg.empty_archetype_id);
    expect(empty.mask.has(0)).toBe(false);
  });

  it("get_component_archetype_count returns 0 for unknown component", () => {
    const { arch_reg } = make_registry_with_components(0);
    expect(arch_reg.get_component_archetype_count(comp_id(99))).toBe(0);
  });

  //=========================================================
  // get_or_create
  //=========================================================

  it("creates a new archetype for a new signature", () => {
    const { arch_reg } = make_registry_with_components(3);
    const id = arch_reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(arch_reg.count).toBe(2); // empty + new
    const arch = arch_reg.get(id);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(true);
    expect(arch.mask.has(3)).toBe(false);
  });

  it("deduplicates archetypes with same signature", () => {
    const { arch_reg } = make_registry_with_components(3);
    const a = arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    const b = arch_reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(a).toBe(b);
    expect(arch_reg.count).toBe(2); // empty + one
  });

  it("deduplicates regardless of input order", () => {
    const { arch_reg } = make_registry_with_components(3);
    const a = arch_reg.get_or_create([comp_id(2), comp_id(1)]);
    const b = arch_reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(a).toBe(b);
  });

  it("get_component_archetype_count tracks per-component counts", () => {
    const { arch_reg } = make_registry_with_components(3);

    arch_reg.get_or_create([comp_id(1)]);
    expect(arch_reg.get_component_archetype_count(comp_id(1))).toBe(1);

    // Duplicate does not bump
    arch_reg.get_or_create([comp_id(1)]);
    expect(arch_reg.get_component_archetype_count(comp_id(1))).toBe(1);

    arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    expect(arch_reg.get_component_archetype_count(comp_id(1))).toBe(2);
    expect(arch_reg.get_component_archetype_count(comp_id(2))).toBe(1);
  });

  //=========================================================
  // resolve_add
  //=========================================================

  it("resolve_add creates target archetype with added component", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1)]);
    const target = arch_reg.resolve_add(src, comp_id(2));

    const arch = arch_reg.get(target);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(true);
  });

  it("resolve_add caches the edge for repeated calls", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1)]);

    const first = arch_reg.resolve_add(src, comp_id(2));
    const count_after = arch_reg.count;

    const second = arch_reg.resolve_add(src, comp_id(2));
    expect(second).toBe(first);
    expect(arch_reg.count).toBe(count_after); // no new archetype
  });

  it("resolve_add caches reverse remove edge", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1)]);
    const target = arch_reg.resolve_add(src, comp_id(2));

    // Removing comp_id(2) from target should return src
    const back = arch_reg.resolve_remove(target, comp_id(2));
    expect(back).toBe(src);
  });

  //=========================================================
  // resolve_remove
  //=========================================================

  it("resolve_remove creates target archetype without component", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    const target = arch_reg.resolve_remove(src, comp_id(2));

    const arch = arch_reg.get(target);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(false);
  });

  it("resolve_remove caches the edge for repeated calls", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1), comp_id(2)]);

    const first = arch_reg.resolve_remove(src, comp_id(2));
    const count_after = arch_reg.count;

    const second = arch_reg.resolve_remove(src, comp_id(2));
    expect(second).toBe(first);
    expect(arch_reg.count).toBe(count_after);
  });

  it("resolve_remove caches reverse add edge", () => {
    const { arch_reg } = make_registry_with_components(3);
    const src = arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    const target = arch_reg.resolve_remove(src, comp_id(1));

    // Adding comp_id(1) back to target should return src
    const back = arch_reg.resolve_add(target, comp_id(1));
    expect(back).toBe(src);
  });

  //=========================================================
  // get_matching
  //=========================================================

  it("empty required returns all archetypes", () => {
    const { arch_reg } = make_registry_with_components(3);
    arch_reg.get_or_create([comp_id(1)]);
    arch_reg.get_or_create([comp_id(2)]);

    const matches = arch_reg.get_matching(make_mask());
    expect(matches.length).toBe(arch_reg.count);
  });

  it("returns archetypes containing required components", () => {
    const { arch_reg } = make_registry_with_components(4);
    arch_reg.get_or_create([comp_id(1)]);
    arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    arch_reg.get_or_create([comp_id(2), comp_id(3)]);

    const matches = arch_reg.get_matching(make_mask(1));
    expect(matches.length).toBe(2); // [1] and [1,2]
  });

  it("returns empty for unmatched components", () => {
    const { arch_reg } = make_registry_with_components(100);
    arch_reg.get_or_create([comp_id(1)]);

    const matches = arch_reg.get_matching(make_mask(99));
    expect(matches.length).toBe(0);
  });

  it("multi-component query intersects correctly", () => {
    const { arch_reg } = make_registry_with_components(4);
    arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    arch_reg.get_or_create([comp_id(1), comp_id(3)]);
    arch_reg.get_or_create([comp_id(1), comp_id(2), comp_id(3)]);

    const matches = arch_reg.get_matching(make_mask(1, 2));
    expect(matches.length).toBe(2); // [1,2] and [1,2,3]
  });

  //=========================================================
  // Component index
  //=========================================================

  it("component index tracks new archetypes", () => {
    const { arch_reg } = make_registry_with_components(3);
    arch_reg.get_or_create([comp_id(1)]);
    arch_reg.get_or_create([comp_id(1), comp_id(2)]);

    // Both archetypes with comp_id(1) should be found
    const matches = arch_reg.get_matching(make_mask(1));
    expect(matches.length).toBe(2);

    // Only one archetype has comp_id(2)
    const matches2 = arch_reg.get_matching(make_mask(2));
    expect(matches2.length).toBe(1);
  });

  //=========================================================
  // Transition round-trips
  //=========================================================

  it("add then remove returns to original archetype", () => {
    const { arch_reg } = make_registry_with_components(3);
    const original = arch_reg.get_or_create([comp_id(1)]);
    const with_two = arch_reg.resolve_add(original, comp_id(2));
    const back = arch_reg.resolve_remove(with_two, comp_id(2));

    expect(back).toBe(original);
  });

  it("remove then add returns to original archetype", () => {
    const { arch_reg } = make_registry_with_components(3);
    const original = arch_reg.get_or_create([comp_id(1), comp_id(2)]);
    const without_two = arch_reg.resolve_remove(original, comp_id(2));
    const back = arch_reg.resolve_add(without_two, comp_id(2));

    expect(back).toBe(original);
  });

  //=========================================================
  // Archetype columns are created from component registry
  //=========================================================

  it("new archetypes have columns matching component schemas", () => {
    const comp_reg = new ComponentRegistry();
    const Pos = comp_reg.register({ x: "f32", y: "f32" });
    const arch_reg = new ArchetypeRegistry(comp_reg);

    const id = arch_reg.get_or_create([Pos as ComponentID]);
    const arch = arch_reg.get(id);

    // Should be able to get columns
    const col_x = arch.get_column(Pos, "x");
    const col_y = arch.get_column(Pos, "y");
    expect(col_x).toBeInstanceOf(Float32Array);
    expect(col_y).toBeInstanceOf(Float32Array);
  });
});
