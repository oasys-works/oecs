import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import type { EntityID } from "../entity";

const TIERS = [1_000, 10_000, 100_000] as const;

// ============================================================
// 1. Single component add
// ============================================================

describe("single component add (Pos)", () => {
  for (const N of TIERS) {
    bench(`${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      const Pos = world.register_component(["x", "y"] as const);

      const entities: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        entities.push(world.create_entity());
      }

      for (let i = 0; i < N; i++) {
        world.add_component(entities[i], Pos, { x: i, y: i });
      }
    });
  }
});

// ============================================================
// 2. Sequential component add x2
// ============================================================

describe("sequential component add x2 (Pos + Vel)", () => {
  for (const N of TIERS) {
    bench(`${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      const Pos = world.register_component(["x", "y"] as const);
      const Vel = world.register_component(["vx", "vy"] as const);

      const entities: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        entities.push(world.create_entity());
      }

      for (let i = 0; i < N; i++) {
        world.add_component(entities[i], Pos, { x: i, y: i });
        world.add_component(entities[i], Vel, { vx: 1, vy: 2 });
      }
    });
  }
});

// ============================================================
// 3. Batch component add x2
// ============================================================

describe("batch component add x2 (Pos + Vel)", () => {
  for (const N of TIERS) {
    bench(`${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      const Pos = world.register_component(["x", "y"] as const);
      const Vel = world.register_component(["vx", "vy"] as const);

      const entities: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        entities.push(world.create_entity());
      }

      for (let i = 0; i < N; i++) {
        world.add_components(entities[i], [
          { def: Pos, values: { x: i, y: i } },
          { def: Vel, values: { vx: 1, vy: 2 } },
        ]);
      }
    });
  }
});

// ============================================================
// 4. Component remove
// ============================================================

describe("component remove (Vel from Pos+Vel entities)", () => {
  for (const N of TIERS) {
    bench(`${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      const Pos = world.register_component(["x", "y"] as const);
      const Vel = world.register_component(["vx", "vy"] as const);

      const entities: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        const e = world.create_entity();
        world.add_component(e, Pos, { x: i, y: i });
        world.add_component(e, Vel, { vx: 1, vy: 2 });
        entities.push(e);
      }

      for (let i = 0; i < N; i++) {
        world.remove_component(entities[i], Vel);
      }
    });
  }
});

// ============================================================
// 5. Tag add + remove
// ============================================================

describe("tag add + remove (no column operations)", () => {
  for (const N of TIERS) {
    bench(`${N.toLocaleString()} entities`, () => {
      const world = new ECS();
      const Tag = world.register_tag();

      const entities: EntityID[] = [];
      for (let i = 0; i < N; i++) {
        entities.push(world.create_entity());
      }

      for (let i = 0; i < N; i++) {
        world.add_component(entities[i], Tag);
      }

      for (let i = 0; i < N; i++) {
        world.remove_component(entities[i], Tag);
      }
    });
  }
});
