import { bench, describe } from "vitest";
import { World } from "../world";
import { SCHEDULE } from "../schedule";
import type { EntityID } from "../entity";
import type { ComponentDef, ComponentFields } from "../component";

//=========================================================
// Helpers
//=========================================================

function make_fields(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f${i}`);
}

function make_values(n: number): Record<string, number> {
  const v: Record<string, number> = {};
  for (let i = 0; i < n; i++) v[`f${i}`] = 1;
  return v;
}

function xorshift32(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

//=========================================================
// Entity lifecycle
//=========================================================

describe("entity lifecycle", () => {
  bench("entity_create_1k", () => {
    const w = new World();
    for (let i = 0; i < 1_000; i++) w.create_entity();
  });

  bench("entity_create_10k", () => {
    const w = new World();
    for (let i = 0; i < 10_000; i++) w.create_entity();
  });

  bench("entity_destroy_10k", () => {
    const w = new World();
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());
    for (let i = 0; i < ids.length; i++) w.destroy_entity(ids[i]);
    w.update(0);
  });

  bench("entity_create_destroy_cycle", () => {
    const w = new World();
    for (let c = 0; c < 10; c++) {
      const ids: EntityID[] = [];
      for (let i = 0; i < 1_000; i++) ids.push(w.create_entity());
      for (let i = 0; i < ids.length; i++) w.destroy_entity(ids[i]);
      w.update(0);
    }
  });
});

//=========================================================
// Component operations (archetype transitions)
//=========================================================

describe("component operations", () => {
  const FIELDS: string[][] = [];
  for (let i = 0; i < 100; i++) {
    FIELDS.push(make_fields(1 + (i % 5)));
  }

  bench("register_100_components", () => {
    const w = new World();
    for (let i = 0; i < 100; i++) w.register_component(FIELDS[i]);
  });

  bench("add_1_component_10k", () => {
    const w = new World();
    const C = w.register_component(["f0"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      w.add_component(ids[i], C, { f0: i });
    }
  });

  bench("add_5_components_10k", () => {
    const w = new World();
    const defs = Array.from({ length: 5 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.add_component(ids[i], defs[d], vals);
      }
    }
  });

  bench("add_10_components_10k", () => {
    const w = new World();
    const defs = Array.from({ length: 10 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.add_component(ids[i], defs[d], vals);
      }
    }
  });

  bench("add_20_components_1k", () => {
    const w = new World();
    const defs = Array.from({ length: 20 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 1_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.add_component(ids[i], defs[d], vals);
      }
    }
  });

  bench("add_50_components_1k", () => {
    const w = new World();
    const defs = Array.from({ length: 50 }, () =>
      w.register_component(make_fields(1)),
    );
    const vals = make_values(1);
    const ids: EntityID[] = [];
    for (let i = 0; i < 1_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.add_component(ids[i], defs[d], vals);
      }
    }
  });

  bench("add_100_components_100", () => {
    const w = new World();
    const defs = Array.from({ length: 100 }, () =>
      w.register_component(make_fields(1)),
    );
    const vals = make_values(1);
    const ids: EntityID[] = [];
    for (let i = 0; i < 100; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.add_component(ids[i], defs[d], vals);
      }
    }
  });

  bench("remove_1_from_10_10k", () => {
    const w = new World();
    const defs = Array.from({ length: 10 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
      ids.push(id);
    }

    for (let i = 0; i < ids.length; i++) {
      w.remove_component(ids[i], defs[0]);
    }
  });

  bench("remove_5_from_10_5k", () => {
    const w = new World();
    const defs = Array.from({ length: 10 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 5_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
      ids.push(id);
    }

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < 5; d++) {
        w.remove_component(ids[i], defs[d]);
      }
    }
  });

  bench("remove_all_10_from_5k", () => {
    const w = new World();
    const defs = Array.from({ length: 10 }, () =>
      w.register_component(make_fields(2)),
    );
    const vals = make_values(2);
    const ids: EntityID[] = [];
    for (let i = 0; i < 5_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
      ids.push(id);
    }

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < defs.length; d++) {
        w.remove_component(ids[i], defs[d]);
      }
    }
  });

  bench("add_remove_churn_10k", () => {
    const w = new World();
    const C = w.register_component(["f0"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());

    for (let i = 0; i < ids.length; i++) {
      w.add_component(ids[i], C, { f0: 1 });
      w.remove_component(ids[i], C);
    }
  });

  bench("overwrite_component_10k", () => {
    const w = new World();
    const C = w.register_component(["f0", "f1"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      w.add_component(id, C, { f0: 0, f1: 0 });
      ids.push(id);
    }

    for (let i = 0; i < ids.length; i++) {
      w.add_component(ids[i], C, { f0: i, f1: i });
    }
  });

  bench("mixed_add_remove_10k", () => {
    const w = new World();
    const A = w.register_component(["f0"]);
    const B = w.register_component(["f0"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      if (i < 5_000) {
        w.add_component(id, A, { f0: 1 });
      } else {
        w.add_component(id, B, { f0: 1 });
      }
      ids.push(id);
    }

    for (let i = 0; i < 5_000; i++) {
      w.add_component(ids[i], B, { f0: 1 });
    }
    for (let i = 5_000; i < 10_000; i++) {
      w.remove_component(ids[i], B);
    }
  });
});

//=========================================================
// Archetype fan-out stress
//=========================================================

describe("archetype fan-out stress", () => {
  bench("create_100_unique_archetypes", () => {
    const w = new World();
    const defs: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 100; i++)
      defs.push(w.register_component(make_fields(1)));
    const vals = make_values(1);

    for (let i = 0; i < 100; i++) {
      const id = w.create_entity();
      w.add_component(id, defs[i], vals);
    }
  });

  bench("create_500_unique_archetypes", () => {
    const rng = xorshift32(42);
    const w = new World();
    const defs: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 100; i++)
      defs.push(w.register_component(make_fields(1)));
    const vals = make_values(1);

    for (let i = 0; i < 500; i++) {
      const id = w.create_entity();
      const chosen = new Set<number>();
      while (chosen.size < 5) chosen.add(Math.floor(rng() * 100));
      for (const c of chosen) w.add_component(id, defs[c], vals);
    }
  });

  bench("transition_across_100_archetypes", () => {
    const w = new World();
    const defs: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 101; i++)
      defs.push(w.register_component(make_fields(1)));
    const vals = make_values(1);

    const ids: EntityID[] = [];
    for (let i = 0; i < 100; i++) {
      const id = w.create_entity();
      w.add_component(id, defs[i], vals);
      ids.push(id);
    }

    for (let i = 0; i < ids.length; i++) {
      w.add_component(ids[i], defs[100], vals);
    }
  });
});

//=========================================================
// Deferred operations
//=========================================================

describe("deferred operations", () => {
  bench("deferred_add_flush_10k", () => {
    const w = new World();
    const C = w.register_component(["f0"]);

    const sys = w.register_system({
      fn(ctx) {
        for (let i = 0; i < 10_000; i++) {
          const id = ctx.create_entity();
          ctx.add_component(id, C, { f0: i });
        }
      },
    });
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("deferred_remove_flush_10k", () => {
    const w = new World();
    const C = w.register_component(["f0"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      w.add_component(id, C, { f0: i });
      ids.push(id);
    }

    const sys = w.register_system({
      fn(ctx) {
        for (let i = 0; i < ids.length; i++) {
          ctx.remove_component(ids[i], C);
        }
      },
    });
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("deferred_mixed_flush_10k", () => {
    const w = new World();
    const A = w.register_component(["f0"]);
    const B = w.register_component(["f0"]);
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      if (i < 5_000) w.add_component(id, A, { f0: 1 });
      else w.add_component(id, B, { f0: 1 });
      ids.push(id);
    }

    const sys = w.register_system({
      fn(ctx) {
        for (let i = 0; i < 5_000; i++) ctx.add_component(ids[i], B, { f0: 1 });
        for (let i = 5_000; i < 10_000; i++) ctx.remove_component(ids[i], B);
      },
    });
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("deferred_destroy_flush_10k", () => {
    const w = new World();
    const ids: EntityID[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(w.create_entity());

    const sys = w.register_system({
      fn(ctx) {
        for (let i = 0; i < ids.length; i++) ctx.destroy_entity(ids[i]);
      },
    });
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });
});

//=========================================================
// Query & iteration
//=========================================================

describe("query and iteration", () => {
  bench("query_cache_hit", () => {
    const w = new World();
    const Pos = w.register_component(["x", "y"]);
    const Vel = w.register_component(["vx", "vy"]);
    for (let i = 0; i < 1_000; i++) {
      const id = w.create_entity();
      w.add_component(id, Pos, { x: 0, y: 0 });
      w.add_component(id, Vel, { vx: 1, vy: 1 });
    }

    let result: unknown;
    for (let i = 0; i < 10_000; i++) result = w.query(Pos, Vel);
    void result;
  });

  bench("query_cold_miss", () => {
    const w = new World();
    const defs: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 10; i++)
      defs.push(w.register_component(make_fields(2)));
    const vals = make_values(2);

    for (let i = 0; i < 1_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
    }

    w.query(defs[0], defs[1]);
  });

  bench("query_2_components_across_100_archetypes", () => {
    const w = new World();
    const Shared1 = w.register_component(make_fields(1));
    const Shared2 = w.register_component(make_fields(1));
    const extras: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 100; i++)
      extras.push(w.register_component(make_fields(1)));
    const vals = make_values(1);

    for (let i = 0; i < 100; i++) {
      const id = w.create_entity();
      w.add_component(id, Shared1, vals);
      w.add_component(id, Shared2, vals);
      w.add_component(id, extras[i], vals);
    }

    w.query(Shared1, Shared2);
  });

  bench("query_5_components_across_50_archetypes", () => {
    const w = new World();
    const shared: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 5; i++)
      shared.push(w.register_component(make_fields(1)));
    const extras: ComponentDef<ComponentFields>[] = [];
    for (let i = 0; i < 50; i++)
      extras.push(w.register_component(make_fields(1)));
    const vals = make_values(1);

    for (let i = 0; i < 50; i++) {
      const id = w.create_entity();
      for (const s of shared) w.add_component(id, s, vals);
      w.add_component(id, extras[i], vals);
    }

    w.query(...shared);
  });

  bench("iterate_10k_2_components", () => {
    const w = new World();
    const Pos = w.register_component(["x", "y"] as const);
    const Vel = w.register_component(["vx", "vy"] as const);
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      w.add_component(id, Pos, { x: 0, y: 0 });
      w.add_component(id, Vel, { vx: 1, vy: 1 });
    }

    const pv = w.query(Pos, Vel);
    const sys = w.register_system(
      (q, _ctx, _dt) => {
        q.each((pos, vel, n) => {
          for (let i = 0; i < n; i++) {
            pos.x[i] += vel.vx[i];
            pos.y[i] += vel.vy[i];
          }
        });
      },
      () => pv,
    );
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("iterate_10k_5_components", () => {
    const w = new World();
    const defs = Array.from({ length: 5 }, () =>
      w.register_component(["a", "b"]),
    );
    const vals = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
    }

    const sys = w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const cols = defs.map((d) => arch.get_column(d, "a"));
          for (let i = 0; i < arch.entity_count; i++) {
            for (let c = 0; c < cols.length; c++) cols[c][i] += 1;
          }
        }
      },
      (qb) => qb.every(...defs),
    );
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("iterate_10k_10_components", () => {
    const w = new World();
    const defs = Array.from({ length: 10 }, () => w.register_component(["a"]));
    const vals = { a: 0 };
    for (let i = 0; i < 10_000; i++) {
      const id = w.create_entity();
      for (const d of defs) w.add_component(id, d, vals);
    }

    const sys = w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const cols = defs.map((d) => arch.get_column(d, "a"));
          for (let i = 0; i < arch.entity_count; i++) {
            for (let c = 0; c < cols.length; c++) cols[c][i] += 1;
          }
        }
      },
      (qb) => qb.every(...defs),
    );
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });

  bench("iterate_100k_2_components", () => {
    const w = new World();
    const Pos = w.register_component(["x", "y"] as const);
    const Vel = w.register_component(["vx", "vy"] as const);
    for (let i = 0; i < 100_000; i++) {
      const id = w.create_entity();
      w.add_component(id, Pos, { x: 0, y: 0 });
      w.add_component(id, Vel, { vx: 1, vy: 1 });
    }

    const pv = w.query(Pos, Vel);
    const sys = w.register_system(
      (q, _ctx, _dt) => {
        q.each((pos, vel, n) => {
          for (let i = 0; i < n; i++) {
            pos.x[i] += vel.vx[i];
            pos.y[i] += vel.vy[i];
          }
        });
      },
      () => pv,
    );
    w.add_systems(SCHEDULE.STARTUP, sys);
    w.startup();
  });
});

//=========================================================
// System execution (full frame)
//=========================================================

describe("frame_1_system_10k", () => {
  const w = new World();
  const Pos = w.register_component(["x", "y"] as const);
  const Vel = w.register_component(["vx", "vy"] as const);
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    w.add_component(id, Pos, { x: 0, y: 0 });
    w.add_component(id, Vel, { vx: 1, vy: 1 });
  }

  const pv = w.query(Pos, Vel);
  const sys = w.register_system(
    (q, _ctx, _dt) => {
      q.each((pos, vel, n) => {
        for (let i = 0; i < n; i++) {
          pos.x[i] += vel.vx[i];
        }
      });
    },
    () => pv,
  );
  w.add_systems(SCHEDULE.UPDATE, sys);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_3_systems_10k", () => {
  const w = new World();
  const Pos = w.register_component(["x", "y"]);
  const Vel = w.register_component(["vx", "vy"]);
  const Hp = w.register_component(["current", "max"]);
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    w.add_component(id, Pos, { x: 0, y: 0 });
    w.add_component(id, Vel, { vx: 1, vy: 1 });
    w.add_component(id, Hp, { current: 100, max: 100 });
  }

  const make_sys = (...q: ComponentDef<ComponentFields>[]) =>
    w.register_system(
      (query, _ctx, _dt) => {
        for (const arch of query) {
          const col = arch.get_column(q[0], "x" as never);
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(...q),
    );

  w.add_systems(
    SCHEDULE.UPDATE,
    make_sys(Pos, Vel),
    make_sys(Vel, Hp),
    make_sys(Pos, Hp),
  );
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_5_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 5 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_10_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 10 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_25_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 25 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_50_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 50 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_100_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 100 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_200_systems_10k", () => {
  const w = new World();
  const defs = Array.from({ length: 200 }, () => w.register_component(["a"]));
  const vals = { a: 0 };
  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    for (const d of defs) w.add_component(id, d, vals);
  }

  const systems = defs.map((_, si) =>
    w.register_system(
      (q, _ctx, _dt) => {
        for (const arch of q) {
          const col = arch.get_column(defs[si], "a");
          for (let i = 0; i < arch.entity_count; i++) {
            col[i] += 1;
          }
        }
      },
      (qb) => qb.every(defs[si], defs[(si + 1) % defs.length]),
    ),
  );
  w.add_systems(SCHEDULE.UPDATE, ...systems);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});

describe("frame_with_structural_churn", () => {
  const w = new World();
  const Pos = w.register_component(["x", "y"] as const);
  const Vel = w.register_component(["vx", "vy"] as const);
  w.register_component([]); // tag component (unused directly, creates archetype diversity)
  const Marker = w.register_component(["v"]);

  for (let i = 0; i < 10_000; i++) {
    const id = w.create_entity();
    w.add_component(id, Pos, { x: 0, y: 0 });
    w.add_component(id, Vel, { vx: 1, vy: 1 });
  }

  const pv = w.query(Pos, Vel);
  for (let s = 0; s < 100; s++) {
    const sys = w.register_system(
      (q, _ctx, _dt) => {
        q.each((pos, vel, n) => {
          for (let i = 0; i < n; i++) {
            pos.x[i] += vel.vx[i];
          }
        });
      },
      () => pv,
    );
    w.add_systems(SCHEDULE.UPDATE, sys);
  }

  let spawned_ids: EntityID[] = [];
  const churn_sys = w.register_system({
    fn(ctx) {
      for (const id of spawned_ids) ctx.destroy_entity(id);
      spawned_ids = [];

      for (let i = 0; i < 500; i++) {
        const id = ctx.create_entity();
        ctx.add_component(id, Marker, { v: i });
        spawned_ids.push(id);
      }
    },
  });
  w.add_systems(SCHEDULE.POST_UPDATE, churn_sys);
  w.startup();

  bench("frame", () => {
    w.update(0.016);
  });
});
