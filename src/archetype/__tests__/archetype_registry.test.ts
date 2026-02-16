import { describe, expect, it } from "vitest";
import { ArchetypeRegistry } from "../archetype_registry";
import { as_component_id, type ComponentID } from "../../component/component";
import { BitSet } from "../../collections/bitset";

// Helpers
const comp_id = (n: number) => as_component_id(n) as ComponentID;

function make_mask(...ids: number[]): BitSet {
  const mask = new BitSet();
  for (const id of ids) mask.set(id);
  return mask;
}

describe("ArchetypeRegistry", () => {
  //=========================================================
  // Construction
  //=========================================================

  it("creates empty archetype on construction", () => {
    const reg = new ArchetypeRegistry();
    expect(reg.count).toBe(1);

    const empty = reg.get(reg.empty_archetype_id);
    expect(empty.mask.has(0)).toBe(false);
  });

  it("get_component_archetype_count returns 0 for unknown component", () => {
    const reg = new ArchetypeRegistry();
    expect(reg.get_component_archetype_count(comp_id(99))).toBe(0);
  });

  //=========================================================
  // get_or_create
  //=========================================================

  it("creates a new archetype for a new signature", () => {
    const reg = new ArchetypeRegistry();
    const id = reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(reg.count).toBe(2); // empty + new
    const arch = reg.get(id);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(true);
    expect(arch.mask.has(3)).toBe(false);
  });

  it("deduplicates archetypes with same signature", () => {
    const reg = new ArchetypeRegistry();
    const a = reg.get_or_create([comp_id(1), comp_id(2)]);
    const b = reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(a).toBe(b);
    expect(reg.count).toBe(2); // empty + one
  });

  it("deduplicates regardless of input order", () => {
    const reg = new ArchetypeRegistry();
    const a = reg.get_or_create([comp_id(2), comp_id(1)]);
    const b = reg.get_or_create([comp_id(1), comp_id(2)]);

    expect(a).toBe(b);
  });

  it("get_component_archetype_count tracks per-component counts", () => {
    const reg = new ArchetypeRegistry();

    reg.get_or_create([comp_id(1)]);
    expect(reg.get_component_archetype_count(comp_id(1))).toBe(1);

    // Duplicate does not bump
    reg.get_or_create([comp_id(1)]);
    expect(reg.get_component_archetype_count(comp_id(1))).toBe(1);

    reg.get_or_create([comp_id(1), comp_id(2)]);
    expect(reg.get_component_archetype_count(comp_id(1))).toBe(2);
    expect(reg.get_component_archetype_count(comp_id(2))).toBe(1);
  });

  //=========================================================
  // resolve_add
  //=========================================================

  it("resolve_add creates target archetype with added component", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1)]);
    const target = reg.resolve_add(src, comp_id(2));

    const arch = reg.get(target);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(true);
  });

  it("resolve_add caches the edge for repeated calls", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1)]);

    const first = reg.resolve_add(src, comp_id(2));
    const count_after = reg.count;

    const second = reg.resolve_add(src, comp_id(2));
    expect(second).toBe(first);
    expect(reg.count).toBe(count_after); // no new archetype
  });

  it("resolve_add caches reverse remove edge", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1)]);
    const target = reg.resolve_add(src, comp_id(2));

    // Removing comp_id(2) from target should return src
    const back = reg.resolve_remove(target, comp_id(2));
    expect(back).toBe(src);
  });

  //=========================================================
  // resolve_remove
  //=========================================================

  it("resolve_remove creates target archetype without component", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1), comp_id(2)]);
    const target = reg.resolve_remove(src, comp_id(2));

    const arch = reg.get(target);
    expect(arch.mask.has(1)).toBe(true);
    expect(arch.mask.has(2)).toBe(false);
  });

  it("resolve_remove caches the edge for repeated calls", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1), comp_id(2)]);

    const first = reg.resolve_remove(src, comp_id(2));
    const count_after = reg.count;

    const second = reg.resolve_remove(src, comp_id(2));
    expect(second).toBe(first);
    expect(reg.count).toBe(count_after);
  });

  it("resolve_remove caches reverse add edge", () => {
    const reg = new ArchetypeRegistry();
    const src = reg.get_or_create([comp_id(1), comp_id(2)]);
    const target = reg.resolve_remove(src, comp_id(1));

    // Adding comp_id(1) back to target should return src
    const back = reg.resolve_add(target, comp_id(1));
    expect(back).toBe(src);
  });

  //=========================================================
  // get_matching
  //=========================================================

  it("empty required returns all archetypes", () => {
    const reg = new ArchetypeRegistry();
    reg.get_or_create([comp_id(1)]);
    reg.get_or_create([comp_id(2)]);

    const matches = reg.get_matching(make_mask());
    expect(matches.length).toBe(reg.count);
  });

  it("returns archetypes containing required components", () => {
    const reg = new ArchetypeRegistry();
    reg.get_or_create([comp_id(1)]);
    reg.get_or_create([comp_id(1), comp_id(2)]);
    reg.get_or_create([comp_id(2), comp_id(3)]);

    const matches = reg.get_matching(make_mask(1));
    expect(matches.length).toBe(2); // [1] and [1,2]
  });

  it("returns empty for unmatched components", () => {
    const reg = new ArchetypeRegistry();
    reg.get_or_create([comp_id(1)]);

    const matches = reg.get_matching(make_mask(99));
    expect(matches.length).toBe(0);
  });

  it("multi-component query intersects correctly", () => {
    const reg = new ArchetypeRegistry();
    reg.get_or_create([comp_id(1), comp_id(2)]);
    reg.get_or_create([comp_id(1), comp_id(3)]);
    reg.get_or_create([comp_id(1), comp_id(2), comp_id(3)]);

    const matches = reg.get_matching(make_mask(1, 2));
    expect(matches.length).toBe(2); // [1,2] and [1,2,3]
  });

  //=========================================================
  // Component index
  //=========================================================

  it("component index tracks new archetypes", () => {
    const reg = new ArchetypeRegistry();
    reg.get_or_create([comp_id(1)]);
    reg.get_or_create([comp_id(1), comp_id(2)]);

    // Both archetypes with comp_id(1) should be found
    const matches = reg.get_matching(make_mask(1));
    expect(matches.length).toBe(2);

    // Only one archetype has comp_id(2)
    const matches2 = reg.get_matching(make_mask(2));
    expect(matches2.length).toBe(1);
  });

  //=========================================================
  // Transition round-trips
  //=========================================================

  it("add then remove returns to original archetype", () => {
    const reg = new ArchetypeRegistry();
    const original = reg.get_or_create([comp_id(1)]);
    const with_two = reg.resolve_add(original, comp_id(2));
    const back = reg.resolve_remove(with_two, comp_id(2));

    expect(back).toBe(original);
  });

  it("remove then add returns to original archetype", () => {
    const reg = new ArchetypeRegistry();
    const original = reg.get_or_create([comp_id(1), comp_id(2)]);
    const without_two = reg.resolve_remove(original, comp_id(2));
    const back = reg.resolve_add(without_two, comp_id(2));

    expect(back).toBe(original);
  });
});
