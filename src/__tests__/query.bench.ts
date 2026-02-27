import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";
import type { EntityID } from "../entity";
import type { ComponentDef } from "../component";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

const TIERS = [1_000, 10_000, 100_000] as const;

// ============================================================
// Helpers
// ============================================================

function make_world(N: number) {
  const world = new ECS();
  const Pos = world.register_component(Position);
  const Vel = world.register_component(Velocity);
  const entities: EntityID[] = [];
  for (let i = 0; i < N; i++) {
    const e = world.create_entity();
    world.add_components(e, [
      { def: Pos, values: { x: i, y: i } },
      { def: Vel, values: { vx: 1, vy: 1 } },
    ]);
    entities.push(e);
  }
  return { world, Pos, Vel, entities };
}

function make_fragmented_world(N: number) {
  const world = new ECS();
  const Pos = world.register_component(Position);
  const Vel = world.register_component(Velocity);

  const TAG_COUNT = 100;
  const tags: ComponentDef<Record<string, never>>[] = [];
  for (let t = 0; t < TAG_COUNT; t++) {
    tags.push(world.register_tag());
  }

  const entities: EntityID[] = [];
  for (let i = 0; i < N; i++) {
    const e = world.create_entity();
    world.add_components(e, [
      { def: Pos, values: { x: i, y: i } },
      { def: Vel, values: { vx: 1, vy: 1 } },
    ]);
    world.add_component(e, tags[i % TAG_COUNT]);
    entities.push(e);
  }

  return { world, Pos, Vel, entities };
}

function capture_ctx(world: ECS): SystemContext {
  let ctx!: SystemContext;
  const sys = world.register_system({ fn(_ctx) { ctx = _ctx; } });
  world.add_systems(SCHEDULE.UPDATE, sys);
  world.startup();
  world.update(0);
  return ctx;
}

// ============================================================
// 1. for..of batch iteration — single archetype (fast path)
// ============================================================

describe("for..of batch iteration", () => {
  for (const N of TIERS) {
    const { world, Pos, Vel } = make_world(N);
    capture_ctx(world);
    const q = world.query(Pos, Vel);

    bench(`${N.toLocaleString()} entities — single archetype`, () => {
      for (const arch of q) {
        const px = arch.get_column(Pos, "x");
        const py = arch.get_column(Pos, "y");
        const vx = arch.get_column(Vel, "vx");
        const vy = arch.get_column(Vel, "vy");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          px[i] += vx[i];
          py[i] += vy[i];
        }
      }
    });
  }
});

// ============================================================
// 2. Manual archetype iteration — for..of with get_column()
// ============================================================

describe("manual archetype iteration (for..of + get_column)", () => {
  for (const N of TIERS) {
    const { world, Pos, Vel } = make_world(N);
    capture_ctx(world);
    const q = world.query(Pos, Vel);

    bench(`${N.toLocaleString()} entities — single archetype`, () => {
      for (const arch of q) {
        const px = arch.get_column(Pos, "x");
        const py = arch.get_column(Pos, "y");
        const vx = arch.get_column(Vel, "vx");
        const vy = arch.get_column(Vel, "vy");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          px[i] += vx[i];
          py[i] += vy[i];
        }
      }
    });
  }
});

// ============================================================
// 3. Fragmented iteration — N entities across ~100 archetypes
// ============================================================

describe("fragmented iteration (~100 archetypes)", () => {
  for (const N of TIERS) {
    const { world, Pos, Vel } = make_fragmented_world(N);
    capture_ctx(world);
    const q = world.query(Pos, Vel);

    bench(`for..of + get_column — ${N.toLocaleString()} entities`, () => {
      for (const arch of q) {
        const px = arch.get_column(Pos, "x");
        const py = arch.get_column(Pos, "y");
        const vx = arch.get_column(Vel, "vx");
        const vy = arch.get_column(Vel, "vy");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          px[i] += vx[i];
          py[i] += vy[i];
        }
      }
    });
  }
});

// ============================================================
// 4. Single-entity access: get_field/set_field vs ref()
// ============================================================

describe("single-entity access: get_field/set_field vs ref()", () => {
  for (const N of TIERS) {
    const { world, Pos, Vel, entities } = make_world(N);
    const ctx = capture_ctx(world);

    bench(`get_field/set_field — ${N.toLocaleString()} entities`, () => {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        const vx = ctx.get_field(e, Vel, "vx");
        const vy = ctx.get_field(e, Vel, "vy");
        ctx.set_field(e, Pos, "x", ctx.get_field(e, Pos, "x") + vx);
        ctx.set_field(e, Pos, "y", ctx.get_field(e, Pos, "y") + vy);
      }
    });

    bench(`ref() — ${N.toLocaleString()} entities`, () => {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        const pos = ctx.ref(Pos, e);
        const vel = ctx.ref(Vel, e);
        pos.x += vel.vx;
        pos.y += vel.vy;
      }
    });
  }
});
