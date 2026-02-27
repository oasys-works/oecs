import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import type { EntityID } from "../entity";

const TIERS = [1_000, 10_000, 100_000] as const;

const Position = ["x", "y", "z"] as const;
const Velocity = ["vx", "vy", "vz"] as const;

// ============================================================
// Entity creation (fresh) — high water mark path
// ============================================================

describe("entity creation (fresh)", () => {
  for (const N of TIERS) {
    bench(`create ${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      for (let i = 0; i < N; i++) {
        world.create_entity();
      }
    });
  }
});

// ============================================================
// Entity creation (recycled) — free stack path
// ============================================================

describe("entity creation (recycled)", () => {
  for (const N of TIERS) {
    bench(
      `create ${N.toLocaleString()} recycled entities`,
      () => {
        for (let i = 0; i < N; i++) {
          world.create_entity();
        }
      },
      {
        setup: () => {
          world = new ECS();
          const ids: EntityID[] = [];
          for (let i = 0; i < N; i++) {
            ids.push(world.create_entity());
          }
          for (let i = 0; i < N; i++) {
            world.destroy_entity_deferred(ids[i]);
          }
          world.flush();
        },
      },
    );
  }

  let world: ECS;
});

// ============================================================
// Entity destruction (bare) — no components
// ============================================================

describe("entity destruction (bare)", () => {
  for (const N of TIERS) {
    bench(
      `destroy ${N.toLocaleString()} bare entities`,
      () => {
        for (let i = 0; i < N; i++) {
          world.destroy_entity_deferred(ids[i]);
        }
        world.flush();
      },
      {
        setup: () => {
          world = new ECS();
          ids = [];
          for (let i = 0; i < N; i++) {
            ids.push(world.create_entity());
          }
        },
      },
    );
  }

  let world: ECS;
  let ids: EntityID[];
});

// ============================================================
// Entity destruction (with components) — archetype removal cost
// ============================================================

describe("entity destruction (with components)", () => {
  for (const N of TIERS) {
    bench(
      `destroy ${N.toLocaleString()} entities with Pos+Vel`,
      () => {
        for (let i = 0; i < N; i++) {
          world.destroy_entity_deferred(ids[i]);
        }
        world.flush();
      },
      {
        setup: () => {
          world = new ECS();
          ids = [];
          const Pos = world.register_component(Position);
          const Vel = world.register_component(Velocity);
          for (let i = 0; i < N; i++) {
            const e = world.create_entity();
            world.add_component(e, Pos, { x: i, y: i * 2, z: i * 3 });
            world.add_component(e, Vel, { vx: 1, vy: 2, vz: 3 });
            ids.push(e);
          }
        },
      },
    );
  }

  let world: ECS;
  let ids: EntityID[];
});
