import { bench, describe } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";

const TIERS = [1_000, 10_000, 100_000] as const;

function make_world(n: number) {
  const world = new ECS();

  const Pos = world.register_component(["x", "y"] as const);
  const Vel = world.register_component(["vx", "vy"] as const);
  const Health = world.register_component(["current", "max"] as const);
  const Damage = world.register_event(["target", "amount"] as const);

  const moveSys = world.register_system(
    (q, _ctx, dt) => {
      for (const arch of q) {
        const px = arch.get_column(Pos, "x");
        const py = arch.get_column(Pos, "y");
        const vx = arch.get_column(Vel, "vx");
        const vy = arch.get_column(Vel, "vy");
        const n = arch.entity_count;
        for (let i = 0; i < n; i++) {
          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
        }
      }
    },
    (qb) => qb.every(Pos, Vel),
  );

  const healthSys = world.register_system({
    fn(ctx) {
      const dmg = ctx.read(Damage);
      for (let i = 0; i < dmg.length; i++) {
        const _target = dmg.target[i];
        const _amount = dmg.amount[i];
      }
    },
  });

  world.add_systems(SCHEDULE.UPDATE, moveSys, healthSys);

  for (let i = 0; i < n; i++) {
    const e = world.create_entity();
    world.add_components(e, [
      { def: Pos, values: { x: i, y: i * 2 } },
      { def: Vel, values: { vx: 1, vy: 0.5 } },
      { def: Health, values: { current: 100, max: 100 } },
    ]);
  }

  world.startup();

  return { world };
}

describe("full frame simulation", () => {
  for (const n of TIERS) {
    const { world } = make_world(n);

    bench(`world.update(1/60) — ${n.toLocaleString()} entities`, () => {
      world.update(1 / 60);
    });
  }
});
