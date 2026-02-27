/**
 * Micro-benchmarks to isolate performance bottlenecks.
 *
 * Groups:
 *   A. Entity lifecycle (create, destroy, is_alive)
 *   B. Archetype transitions (add_component, remove_component, copy_shared_from)
 *   C. Column operations (push, swap_remove, write_fields)
 *   D. Iteration overhead (get_column, query iteration, inner loops)
 *   E. Infrastructure (BitSet, field_index lookup, sparse array access)
 */

import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import type { EntityID } from "../entity";

// ═══════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════

const N = 10_000;

// ═══════════════════════════════════════════════════════════════
//  A. Entity lifecycle
// ═══════════════════════════════════════════════════════════════

describe("A. entity lifecycle", () => {
  // A1: Pure entity creation (no components, fresh indices)
  {
    bench("create_entity — fresh slots", () => {
      const w = new ECS({ initial_capacity: N });
      for (let i = 0; i < N; i++) w.create_entity();
    });
  }

  // A2: Entity creation from free-list (recycled indices)
  {
    const w = new ECS({ initial_capacity: N });
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) ids.push(w.create_entity());
    // destroy them all so indices go into free_indices
    for (let i = 0; i < N; i++) w.destroy_entity_deferred(ids[i]);

    bench("create_entity — recycled slots", () => {
      const fresh: EntityID[] = [];
      for (let i = 0; i < N; i++) fresh.push(w.create_entity());
      // put them back for next iteration
      for (let i = 0; i < N; i++) w.destroy_entity_deferred(fresh[i]);
    });
  }

  // A3: destroy_entity on entities in empty archetype (no columns to swap)
  {
    bench("destroy_entity — empty archetype (no components)", () => {
      const w = new ECS({ initial_capacity: N });
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) ids.push(w.create_entity());
      for (let i = 0; i < N; i++) w.destroy_entity_deferred(ids[i]);
    });
  }

  // A4: destroy_entity on entities with 1 component (1 column swap)
  {
    bench("destroy_entity — 1 component (1 field)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_component(e, A, { v: i });
        ids.push(e);
      }
      for (let i = 0; i < N; i++) w.destroy_entity_deferred(ids[i]);
    });
  }

  // A5: destroy_entity on entities with 3 components (6 column swaps)
  {
    bench("destroy_entity — 3 components (6 fields)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["x", "y"] as const);
      const B = w.register_component(["vx", "vy"] as const);
      const C = w.register_component(["hp", "mp"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_components(e, [
          { def: A, values: { x: i, y: i } },
          { def: B, values: { vx: 1, vy: 1 } },
          { def: C, values: { hp: 100, mp: 50 } },
        ]);
        ids.push(e);
      }
      for (let i = 0; i < N; i++) w.destroy_entity_deferred(ids[i]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  B. Archetype transitions (add/remove component)
// ═══════════════════════════════════════════════════════════════

describe("B. archetype transitions", () => {
  // B1: add_component — entity in empty archetype → archetype with 1 component
  //     No copy_shared_from needed (src has no data)
  {
    bench("add 1 component (0→1, no copy)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) ids.push(w.create_entity());
      for (let i = 0; i < N; i++) w.add_component(ids[i], A, { v: 0 });
    });
  }

  // B2: add_component — entity with 1 component → 2 components (copy 1 field)
  {
    bench("add 1 component (1→2, copy 1 field)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["v"] as const);
      const B = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_component(e, A, { v: i });
        ids.push(e);
      }
      for (let i = 0; i < N; i++) w.add_component(ids[i], B, { v: 0 });
    });
  }

  // B3: add_component — entity with 2 components → 3 (copy 2x2 fields)
  {
    bench("add 1 component (2→3, copy 4 fields)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["x", "y"] as const);
      const B = w.register_component(["vx", "vy"] as const);
      const C = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_components(e, [
          { def: A, values: { x: i, y: i } },
          { def: B, values: { vx: 1, vy: 1 } },
        ]);
        ids.push(e);
      }
      for (let i = 0; i < N; i++) w.add_component(ids[i], C, { v: 0 });
    });
  }

  // B4: remove_component — entity with 2 components → 1 (copy 1 field)
  {
    bench("remove 1 component (2→1, copy 1 field)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["v"] as const);
      const B = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_component(e, A, { v: i });
        w.add_component(e, B, { v: 0 });
        ids.push(e);
      }
      for (let i = 0; i < N; i++) w.remove_component(ids[i], B);
    });
  }

  // B5: Full round-trip: add + remove back (steady-state transition perf)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["v"] as const);
    const B = w.register_component(["v"] as const);
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { v: i });
      ids.push(e);
    }
    // Warm up edge cache
    w.add_component(ids[0], B, { v: 0 });
    w.remove_component(ids[0], B);

    let has_b = false;
    bench("add+remove round-trip (1→2→1, edges cached)", () => {
      if (!has_b) {
        for (let i = 0; i < N; i++) w.add_component(ids[i], B, { v: 0 });
      } else {
        for (let i = 0; i < N; i++) w.remove_component(ids[i], B);
      }
      has_b = !has_b;
    });
  }

  // B6: add_components batch (3 at once) vs sequential
  {
    bench("add_components batch (0→3, 6 fields)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["x", "y"] as const);
      const B = w.register_component(["vx", "vy"] as const);
      const C = w.register_component(["hp", "mp"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) ids.push(w.create_entity());
      for (let i = 0; i < N; i++) {
        w.add_components(ids[i], [
          { def: A, values: { x: 0, y: 0 } },
          { def: B, values: { vx: 1, vy: 1 } },
          { def: C, values: { hp: 100, mp: 50 } },
        ]);
      }
    });
  }

  {
    bench("add_component sequential 3x (0→1→2→3, 6 fields)", () => {
      const w = new ECS({ initial_capacity: N });
      const A = w.register_component(["x", "y"] as const);
      const B = w.register_component(["vx", "vy"] as const);
      const C = w.register_component(["hp", "mp"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) ids.push(w.create_entity());
      for (let i = 0; i < N; i++) {
        w.add_component(ids[i], A, { x: 0, y: 0 });
        w.add_component(ids[i], B, { vx: 1, vy: 1 });
        w.add_component(ids[i], C, { hp: 100, mp: 50 });
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  C. Column operations (isolated)
// ═══════════════════════════════════════════════════════════════

describe("C. column operations", () => {
  // C1: write_fields overhead — Record<string, number> lookup
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["x", "y", "z", "w"] as const);
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { x: 0, y: 0, z: 0, w: 0 });
      ids.push(e);
    }
    const q = w.query(A);

    bench("write_fields via add_component overwrite (4 fields)", () => {
      for (let i = 0; i < ids.length; i++) {
        w.add_component(ids[i], A, { x: i, y: i, z: i, w: i });
      }
    });
  }

  // C2: Direct column write vs write_fields — baseline comparison
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["x", "y", "z", "w"] as const);
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { x: 0, y: 0, z: 0, w: 0 });
    }
    const q = w.query(A);

    bench("direct column write (4 fields, no record lookup)", () => {
      for (const arch of q) {
        const ax = arch.get_column(A, "x");
        const ay = arch.get_column(A, "y");
        const az = arch.get_column(A, "z");
        const aw = arch.get_column(A, "w");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          ax[i] = i;
          ay[i] = i;
          az[i] = i;
          aw[i] = i;
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  D. Iteration overhead
// ═══════════════════════════════════════════════════════════════

describe("D. iteration overhead", () => {
  // D1: get_column lookup cost (sparse array + field_index hash)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["x", "y"] as const);
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { x: i, y: i });
    }
    const q = w.query(A);

    bench("get_column × 2 per arch, iterate (single archetype)", () => {
      for (const arch of q) {
        const ax = arch.get_column(A, "x");
        const ay = arch.get_column(A, "y");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          ax[i] += ay[i];
        }
      }
    });
  }

  // D2: same but with pre-cached column references (no get_column in loop)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["x", "y"] as const);
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { x: i, y: i });
    }
    const q = w.query(A);
    const arch = q.archetypes[0];
    const cached_x = arch.get_column(A, "x");
    const cached_y = arch.get_column(A, "y");

    bench("pre-cached columns, iterate (single archetype)", () => {
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        cached_x[i] += cached_y[i];
      }
    });
  }

  // D3: for..of query (generator) vs archetypes array access
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["v"] as const);
    // Create 32 archetypes
    const tags: ReturnType<typeof w.register_tag>[] = [];
    for (let t = 0; t < 32; t++) tags.push(w.register_tag());
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { v: 0 });
      w.add_component(e, tags[i % 32]);
    }
    const q = w.query(A);

    bench("for..of query iteration (32 archetypes)", () => {
      let sum = 0;
      for (const arch of q) {
        const a = arch.get_column(A, "v");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) sum += a[i];
      }
      return sum;
    });

    bench("direct .archetypes[] iteration (32 archetypes)", () => {
      let sum = 0;
      const archs = q.archetypes;
      for (let k = 0; k < archs.length; k++) {
        const arch = archs[k];
        if (arch.entity_count === 0) continue;
        const a = arch.get_column(A, "v");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) sum += a[i];
      }
      return sum;
    });
  }

  // D4: 2-component query vs 5-component query (column lookup fanout)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["v"] as const);
    const B = w.register_component(["v"] as const);
    const C = w.register_component(["v"] as const);
    const D = w.register_component(["v"] as const);
    const E = w.register_component(["v"] as const);
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { v: 0 });
      w.add_component(e, B, { v: 1 });
      w.add_component(e, C, { v: 2 });
      w.add_component(e, D, { v: 3 });
      w.add_component(e, E, { v: 4 });
    }
    const q2 = w.query(A, B);
    const q5 = w.query(A, B, C, D, E);

    bench("iterate 2-component query (2 get_column calls)", () => {
      for (const arch of q2) {
        const a = arch.get_column(A, "v");
        const b = arch.get_column(B, "v");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) a[i] += b[i];
      }
    });

    bench("iterate 5-component query (5 get_column calls)", () => {
      for (const arch of q5) {
        const a = arch.get_column(A, "v");
        const b = arch.get_column(B, "v");
        const c = arch.get_column(C, "v");
        const d = arch.get_column(D, "v");
        const e = arch.get_column(E, "v");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) a[i] += b[i] + c[i] + d[i] + e[i];
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  E. Infrastructure costs
// ═══════════════════════════════════════════════════════════════

describe("E. infrastructure costs", () => {
  // E1: is_alive check overhead
  {
    const w = new ECS({ initial_capacity: N });
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) ids.push(w.create_entity());

    bench("is_alive × N", () => {
      for (let i = 0; i < ids.length; i++) w.is_alive(ids[i]);
    });
  }

  // E2: Record<string, number> object creation (values passed to add_component)
  {
    bench("object literal creation ×N ({x:0, y:0})", () => {
      const arr: Record<string, number>[] = [];
      for (let i = 0; i < N; i++) arr.push({ x: 0, y: 0 });
      return arr;
    });
  }

  // E3: get_entity_index (bitwise AND) — verifying it's not the bottleneck
  {
    const w = new ECS({ initial_capacity: N });
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) ids.push(w.create_entity());

    bench("is_alive + has_component × N", () => {
      const A = w.register_component(["v"] as const);
      for (let i = 0; i < ids.length; i++) w.has_component(ids[i], A);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  F. Entity cycle breakdown
// ═══════════════════════════════════════════════════════════════

describe("F. entity_cycle breakdown", () => {
  // F1: create + add_component (the "spawn B" half)
  {
    bench("create_entity + add_component(B) × N", () => {
      const w = new ECS({ initial_capacity: N });
      const B = w.register_component(["v"] as const);
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_component(e, B, { v: i });
      }
    });
  }

  // F2: destroy_entity × N on single-component entities
  {
    bench("destroy_entity × N (1 component)", () => {
      const w = new ECS({ initial_capacity: N });
      const B = w.register_component(["v"] as const);
      const ids: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = w.create_entity();
        w.add_component(e, B, { v: i });
        ids.push(e);
      }
      for (let i = ids.length - 1; i >= 0; i--) w.destroy_entity_deferred(ids[i]);
    });
  }

  // F3: Full entity_cycle (create + add + iterate + destroy) — the benchmark itself
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["v"] as const);
    const B = w.register_component(["v"] as const);
    const seed_ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { v: i });
      seed_ids.push(e);
    }
    const qa = w.query(A);
    const qb = w.query(B);

    bench("full entity_cycle (create+add B, destroy B) × N", () => {
      // Spawn B entities
      const archs_a = qa.archetypes;
      for (let i = 0; i < archs_a.length; i++) {
        const arch = archs_a[i];
        if (arch.entity_count === 0) continue;
        const a = arch.get_column(A, "v");
        for (let j = 0; j < arch.entity_count; j++) {
          const e = w.create_entity();
          w.add_component(e, B, { v: a[j] });
        }
      }
      // Destroy B entities
      const archs_b = qb.archetypes;
      for (let i = 0; i < archs_b.length; i++) {
        const arch = archs_b[i];
        const ids = arch.entity_ids;
        for (let j = arch.entity_count - 1; j >= 0; j--) {
          w.destroy_entity_deferred(ids[j]);
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  G. Add/remove breakdown
// ═══════════════════════════════════════════════════════════════

describe("G. add_remove breakdown", () => {
  // G1: add B to N entities (A→AB transition)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["v"] as const);
    const B = w.register_component(["v"] as const);
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A, { v: 0 });
      ids.push(e);
    }
    // warm edge cache
    w.add_component(ids[0], B, { v: 0 });
    w.remove_component(ids[0], B);

    let has_b = false;
    bench("toggle B on N entities (add half)", () => {
      if (!has_b) {
        for (let i = 0; i < ids.length; i++) {
          w.add_component(ids[i], B, { v: 0 });
        }
        has_b = true;
      } else {
        for (let i = 0; i < ids.length; i++) {
          w.remove_component(ids[i], B);
        }
        has_b = false;
      }
    });
  }

  // G2: tag-only transitions (no column data to copy)
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_tag();
    const B = w.register_tag();
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_component(e, A);
      ids.push(e);
    }
    // warm edge cache
    w.add_component(ids[0], B);
    w.remove_component(ids[0], B);

    let has_b = false;
    bench("toggle tag B (no column data) × N", () => {
      if (!has_b) {
        for (let i = 0; i < ids.length; i++) w.add_component(ids[i], B);
        has_b = true;
      } else {
        for (let i = 0; i < ids.length; i++) w.remove_component(ids[i], B);
        has_b = false;
      }
    });
  }

  // G3: Heavy transitions — entity has 5 components, add/remove 1
  {
    const w = new ECS({ initial_capacity: N });
    const A = w.register_component(["x", "y"] as const);
    const B = w.register_component(["vx", "vy"] as const);
    const C = w.register_component(["hp", "mp"] as const);
    const D = w.register_component(["str", "dex"] as const);
    const E = w.register_component(["v"] as const);
    const ids: EntityID[] = [];
    for (let i = 0; i < N; i++) {
      const e = w.create_entity();
      w.add_components(e, [
        { def: A, values: { x: 0, y: 0 } },
        { def: B, values: { vx: 1, vy: 1 } },
        { def: C, values: { hp: 100, mp: 50 } },
        { def: D, values: { str: 10, dex: 10 } },
      ]);
      ids.push(e);
    }
    // warm edge cache
    w.add_component(ids[0], E, { v: 0 });
    w.remove_component(ids[0], E);

    let has_e = false;
    bench("toggle E with 4 existing components (copy 8 fields) × N", () => {
      if (!has_e) {
        for (let i = 0; i < ids.length; i++) w.add_component(ids[i], E, { v: 0 });
        has_e = true;
      } else {
        for (let i = 0; i < ids.length; i++) w.remove_component(ids[i], E);
        has_e = false;
      }
    });
  }
});
