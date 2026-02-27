import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";

const TIERS = [1_000, 10_000, 100_000] as const;

// ============================================================
// Helpers
// ============================================================

function make_world() {
  const world = new ECS();
  let ctx: SystemContext;
  const sys = world.register_system({
    fn(_ctx) { ctx = _ctx; },
  });
  world.add_systems(SCHEDULE.UPDATE, sys);
  world.startup();
  world.update(0);
  return { world, ctx: ctx! };
}

// ============================================================
// 1. Event emit (data) — SoA column push throughput
// ============================================================

describe("event emit (data)", () => {
  for (const N of TIERS) {
    const { world } = make_world();
    const Damage = world.register_event(["target", "amount"] as const);

    bench(`emit ${N.toLocaleString()} data events`, () => {
      for (let i = 0; i < N; i++) {
        world.emit(Damage, { target: i, amount: i * 10 });
      }
      world.update(0);
    });
  }
});

// ============================================================
// 2. Signal emit — counter increment throughput
// ============================================================

describe("signal emit", () => {
  for (const N of TIERS) {
    const { world } = make_world();
    const Tick = world.register_signal();

    bench(`emit ${N.toLocaleString()} signals`, () => {
      for (let i = 0; i < N; i++) {
        world.emit(Tick);
      }
      world.update(0);
    });
  }
});

// ============================================================
// 3. Event emit + read cycle — full round-trip
// ============================================================

describe("event emit + read cycle", () => {
  for (const N of TIERS) {
    const { world, ctx } = make_world();
    const Hit = world.register_event(["target", "amount"] as const);

    bench(`emit + read ${N.toLocaleString()} events`, () => {
      for (let i = 0; i < N; i++) {
        ctx.emit(Hit, { target: i, amount: i * 5 });
      }

      const reader = ctx.read(Hit);
      let sum = 0;
      for (let i = 0; i < reader.length; i++) {
        sum += reader.target[i] + reader.amount[i];
      }

      if (sum < 0) throw sum;

      world.update(0);
    });
  }
});

// ============================================================
// 4. Resource read — getter overhead (1M reads)
// ============================================================

describe("resource read", () => {
  const { world } = make_world();
  const Time = world.register_resource(["delta", "elapsed"] as const, {
    delta: 0.016,
    elapsed: 42.0,
  });

  const reader = world.resource(Time);

  bench("read resource fields 1M times", () => {
    let sum = 0;
    for (let i = 0; i < 1_000_000; i++) {
      sum += reader.delta + reader.elapsed;
    }
    if (sum < 0) throw sum;
  });
});

// ============================================================
// 5. Resource write — set_resource throughput (100K writes)
// ============================================================

describe("resource write", () => {
  const { world } = make_world();
  const Config = world.register_resource(["speed", "gravity"] as const, {
    speed: 0,
    gravity: 9.8,
  });

  bench("set_resource 100K times", () => {
    for (let i = 0; i < 100_000; i++) {
      world.set_resource(Config, { speed: i, gravity: 9.8 + i });
    }
  });
});
