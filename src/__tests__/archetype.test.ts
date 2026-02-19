import { describe, expect, it } from "vitest";
import {
  Archetype,
  as_archetype_id,
  type ArchetypeColumnLayout,
} from "../archetype";
import { as_component_id } from "../component";
import { create_entity_id } from "../entity";
import { BitSet } from "type_primitives";

// Helpers
const arch_id = (n: number) => as_archetype_id(n);
const comp_id = (n: number) => as_component_id(n);
const entity = (index: number, gen: number = 0) => create_entity_id(index, gen);

function make_mask(...ids: number[]): BitSet {
  const mask = new BitSet();
  for (const id of ids) mask.set(id);
  return mask;
}

function make_layout(
  component_id: number,
  fields: string[],
): ArchetypeColumnLayout {
  const field_index: Record<string, number> = Object.create(null);
  for (let i = 0; i < fields.length; i++) {
    field_index[fields[i]] = i;
  }
  return {
    component_id: comp_id(component_id),
    field_names: fields,
    field_index,
  };
}

describe("Archetype", () => {
  //=========================================================
  // Construction
  //=========================================================

  it("preserves component mask on construction", () => {
    const mask = make_mask(1, 2, 3);
    const a = new Archetype(arch_id(0), mask);
    expect(a.mask.has(1)).toBe(true);
    expect(a.mask.has(2)).toBe(true);
    expect(a.mask.has(3)).toBe(true);
    expect(a.mask.has(4)).toBe(false);
  });

  it("stores ArchetypeID", () => {
    const id = arch_id(42);
    const a = new Archetype(id, make_mask());
    expect(a.id).toBe(id);
  });

  it("handles empty mask", () => {
    const a = new Archetype(arch_id(0), make_mask());
    expect(a.mask.has(0)).toBe(false);
  });

  //=========================================================
  // Membership
  //=========================================================

  it("add_entity increases entity_count", () => {
    const a = new Archetype(arch_id(0), make_mask(1));
    expect(a.entity_count).toBe(0);

    a.add_entity(entity(0));
    expect(a.entity_count).toBe(1);

    a.add_entity(entity(1));
    expect(a.entity_count).toBe(2);
  });

  it("add_entity returns sequential rows", () => {
    const a = new Archetype(arch_id(0), make_mask());
    expect(a.add_entity(entity(0))).toBe(0);
    expect(a.add_entity(entity(1))).toBe(1);
    expect(a.add_entity(entity(2))).toBe(2);
  });

  it("entity_list returns added entities", () => {
    const a = new Archetype(arch_id(0), make_mask());
    const e0 = entity(0);
    const e1 = entity(1);
    a.add_entity(e0);
    a.add_entity(e1);

    expect(a.entity_list).toContain(e0);
    expect(a.entity_list).toContain(e1);
  });

  it("entity_list reflects presence of entities", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(5));
    expect(a.entity_list.includes(entity(5))).toBe(true);
    expect(a.entity_list.includes(entity(6))).toBe(false);
  });

  //=========================================================
  // Removal (swap-and-pop)
  //=========================================================

  it("remove_entity decreases count", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(0));
    a.add_entity(entity(1));
    a.remove_entity(0);
    expect(a.entity_count).toBe(1);
  });

  it("remove_entity returns swapped entity_index", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(10)); // row 0
    a.add_entity(entity(20)); // row 1
    a.add_entity(entity(30)); // row 2

    // Remove row 0 — entity(30) (row 2) swaps in
    const swapped = a.remove_entity(0);
    expect(swapped).toBe(30);
    expect(a.entity_count).toBe(2);
    expect(a.entity_list.includes(entity(10))).toBe(false);
    expect(a.entity_list.includes(entity(20))).toBe(true);
    expect(a.entity_list.includes(entity(30))).toBe(true);
  });

  it("remove_entity returns -1 when removing last element", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(0));

    const swapped = a.remove_entity(0);
    expect(swapped).toBe(-1);
    expect(a.entity_count).toBe(0);
  });

  it("remove_entity returns -1 when removing the tail element", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(0)); // row 0
    a.add_entity(entity(1)); // row 1

    // Remove last row — no swap needed
    const swapped = a.remove_entity(1);
    expect(swapped).toBe(-1);
    expect(a.entity_count).toBe(1);
    expect(a.entity_list.includes(entity(0))).toBe(true);
  });

  it("can add after remove", () => {
    const a = new Archetype(arch_id(0), make_mask());
    a.add_entity(entity(0));
    a.remove_entity(0);
    expect(a.entity_count).toBe(0);

    a.add_entity(entity(1));
    expect(a.entity_count).toBe(1);
    expect(a.entity_list.includes(entity(1))).toBe(true);
  });

  //=========================================================
  // has_component
  //=========================================================

  it("has_component returns true for components in mask", () => {
    const a = new Archetype(arch_id(0), make_mask(2, 5, 8));
    expect(a.has_component(comp_id(2))).toBe(true);
    expect(a.has_component(comp_id(5))).toBe(true);
    expect(a.has_component(comp_id(8))).toBe(true);
  });

  it("has_component returns false for absent components", () => {
    const a = new Archetype(arch_id(0), make_mask(2, 5));
    expect(a.has_component(comp_id(0))).toBe(false);
    expect(a.has_component(comp_id(3))).toBe(false);
    expect(a.has_component(comp_id(99))).toBe(false);
  });

  it("has_component returns false on empty mask", () => {
    const a = new Archetype(arch_id(0), make_mask());
    expect(a.has_component(comp_id(0))).toBe(false);
  });

  //=========================================================
  // matches
  //=========================================================

  it("matches returns true for subset of mask", () => {
    const a = new Archetype(arch_id(0), make_mask(1, 2, 3));
    expect(a.matches(make_mask(1, 3))).toBe(true);
  });

  it("matches returns true for exact mask", () => {
    const a = new Archetype(arch_id(0), make_mask(1, 2));
    expect(a.matches(make_mask(1, 2))).toBe(true);
  });

  it("matches returns false when missing a required component", () => {
    const a = new Archetype(arch_id(0), make_mask(1));
    expect(a.matches(make_mask(1, 2))).toBe(false);
  });

  it("empty required matches everything", () => {
    const a = new Archetype(arch_id(0), make_mask(1, 2));
    expect(a.matches(make_mask())).toBe(true);
  });

  it("empty mask only matches empty required", () => {
    const a = new Archetype(arch_id(0), make_mask());
    expect(a.matches(make_mask())).toBe(true);
    expect(a.matches(make_mask(1))).toBe(false);
  });

  //=========================================================
  // Graph edges
  //=========================================================

  it("get_edge returns undefined for uncached component", () => {
    const a = new Archetype(arch_id(0), make_mask());
    expect(a.get_edge(comp_id(1))).toBeUndefined();
  });

  it("set_edge / get_edge round-trips", () => {
    const a = new Archetype(arch_id(0), make_mask());
    const edge = { add: arch_id(1), remove: null };
    a.set_edge(comp_id(5), edge);

    const retrieved = a.get_edge(comp_id(5));
    expect(retrieved).toBe(edge);
    expect(retrieved!.add).toBe(arch_id(1));
    expect(retrieved!.remove).toBeNull();
  });

  //=========================================================
  // Column data
  //=========================================================

  it("write_fields and read_field round-trip", () => {
    const layout = make_layout(1, ["x", "y"]);
    const a = new Archetype(arch_id(0), make_mask(1), [layout]);

    const row = a.add_entity(entity(0));
    a.write_fields(row, comp_id(1), { x: 10, y: 20 });

    expect(a.read_field(row, comp_id(1), "x")).toBe(10);
    expect(a.read_field(row, comp_id(1), "y")).toBe(20);
  });

  it("get_column returns dense array for iteration", () => {
    const layout = make_layout(1, ["x"]);
    const a = new Archetype(arch_id(0), make_mask(1), [layout]);

    a.add_entity(entity(0));
    a.add_entity(entity(1));
    a.add_entity(entity(2));

    a.write_fields(0, comp_id(1), { x: 100 });
    a.write_fields(1, comp_id(1), { x: 200 });
    a.write_fields(2, comp_id(1), { x: 300 });

    const col = a.get_column(comp_id(1) as any, "x" as any);
    expect(col[0]).toBe(100);
    expect(col[1]).toBe(200);
    expect(col[2]).toBe(300);
  });

  it("swap-and-pop preserves column data integrity", () => {
    const layout = make_layout(1, ["x", "y"]);
    const a = new Archetype(arch_id(0), make_mask(1), [layout]);

    // Add 3 entities with distinct data
    a.add_entity(entity(0)); // row 0
    a.write_fields(0, comp_id(1), { x: 10, y: 11 });

    a.add_entity(entity(1)); // row 1
    a.write_fields(1, comp_id(1), { x: 20, y: 21 });

    a.add_entity(entity(2)); // row 2
    a.write_fields(2, comp_id(1), { x: 30, y: 31 });

    // Remove row 0 — entity(2) (row 2) swaps into row 0
    a.remove_entity(0);

    expect(a.entity_count).toBe(2);

    // entity(2) is now at row 0, entity(1) stays at row 1
    expect(a.read_field(0, comp_id(1), "x")).toBe(30);
    expect(a.read_field(0, comp_id(1), "y")).toBe(31);

    expect(a.read_field(1, comp_id(1), "x")).toBe(20);
    expect(a.read_field(1, comp_id(1), "y")).toBe(21);
  });

  it("multiple component columns swap together", () => {
    const layout_a = make_layout(1, ["a"]);
    const layout_b = make_layout(2, ["b"]);
    const a = new Archetype(arch_id(0), make_mask(1, 2), [layout_a, layout_b]);

    a.add_entity(entity(0)); // row 0
    a.write_fields(0, comp_id(1), { a: 100 });
    a.write_fields(0, comp_id(2), { b: -1 });

    a.add_entity(entity(1)); // row 1
    a.write_fields(1, comp_id(1), { a: 200 });
    a.write_fields(1, comp_id(2), { b: -2 });

    // Remove row 0 — entity(1) swaps into row 0
    a.remove_entity(0);

    expect(a.read_field(0, comp_id(1), "a")).toBe(200);
    expect(a.read_field(0, comp_id(2), "b")).toBe(-2);
  });

  it("copy_shared_from copies matching component data", () => {
    const layout = make_layout(1, ["x"]);
    const src = new Archetype(arch_id(0), make_mask(1), [layout]);
    const dst = new Archetype(arch_id(1), make_mask(1), [layout]);

    src.add_entity(entity(0));
    src.write_fields(0, comp_id(1), { x: 42 });

    const dst_row = dst.add_entity(entity(0));
    dst.copy_shared_from(src, 0, dst_row);

    expect(dst.read_field(dst_row, comp_id(1), "x")).toBe(42);
  });

  it("columns grow when capacity is exceeded", () => {
    const layout = make_layout(1, ["v"]);
    const a = new Archetype(arch_id(0), make_mask(1), [layout]);

    // Add more entities than initial capacity
    for (let i = 0; i < 50; i++) {
      const row = a.add_entity(entity(i));
      a.write_fields(row, comp_id(1), { v: i * 10 });
    }

    expect(a.entity_count).toBe(50);

    // Verify all data is preserved (no removes, so row === insertion index)
    for (let i = 0; i < 50; i++) {
      expect(a.read_field(i, comp_id(1), "v")).toBe(i * 10);
    }
  });
});
