import { describe, expect, it } from "vitest";
import { World } from "../world";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";

describe("Event system", () => {
  it("emit in one system, read in a later system within the same update", () => {
    const world = new World();
    const Damage = world.register_event(["target", "amount"] as const);
    const received: { target: number; amount: number }[] = [];

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Damage, { target: 42, amount: 10 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const dmg = ctx.read(Damage);
        for (let i = 0; i < dmg.length; i++) {
          received.push({ target: dmg.target[i], amount: dmg.amount[i] });
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(received).toEqual([{ target: 42, amount: 10 }]);
  });

  it("events are cleared between frames", () => {
    const world = new World();
    const Hit = world.register_event(["damage"] as const);

    let readLength = -1;
    let frame = 0;
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        if (frame === 0) {
          ctx.emit(Hit, { damage: 99 });
        }
        readLength = ctx.read(Hit).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    frame = 0;
    world.update(0);
    expect(readLength).toBe(1);

    frame = 1;
    world.update(0);
    expect(readLength).toBe(0);
  });

  it("signal (zero-field) events work", () => {
    const world = new World();
    const GameOver = world.register_signal();
    let fired = false;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(GameOver);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        if (ctx.read(GameOver).length > 0) {
          fired = true;
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(fired).toBe(true);
  });

  it("multiple emits accumulate within a frame", () => {
    const world = new World();
    const Score = world.register_event(["points"] as const);
    const totals: number[] = [];

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Score, { points: 10 });
        ctx.emit(Score, { points: 20 });
        ctx.emit(Score, { points: 30 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const s = ctx.read(Score);
        for (let i = 0; i < s.length; i++) {
          totals.push(s.points[i]);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(totals).toEqual([10, 20, 30]);
  });

  it("startup events are readable in POST_STARTUP", () => {
    const world = new World();
    const Ready = world.register_signal();
    let readCount = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Ready);
        ctx.emit(Ready);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        readCount = ctx.read(Ready).length;
      },
    });

    world.add_systems(SCHEDULE.STARTUP, emitter);
    world.add_systems(SCHEDULE.POST_STARTUP, reader);
    world.startup();

    expect(readCount).toBe(2);
  });

  it("reading an event with no emits returns length 0", () => {
    const world = new World();
    const Nothing = world.register_event(["value"] as const);
    let readLength = -1;

    const reader = world.register_system({
      fn(ctx: SystemContext) {
        readLength = ctx.read(Nothing).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, reader);
    world.startup();
    world.update(0);

    expect(readLength).toBe(0);
  });

  it("multiple signal emits accumulate", () => {
    const world = new World();
    const Tick = world.register_signal();
    let count = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Tick);
        ctx.emit(Tick);
        ctx.emit(Tick);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        count = ctx.read(Tick).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(count).toBe(3);
  });

  it("events emitted in PRE_UPDATE are readable in UPDATE and POST_UPDATE", () => {
    const world = new World();
    const Input = world.register_event(["key"] as const);
    let updateLen = 0;
    let postUpdateLen = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Input, { key: 65 });
      },
    });
    const updateReader = world.register_system({
      fn(ctx: SystemContext) {
        updateLen = ctx.read(Input).length;
      },
    });
    const postUpdateReader = world.register_system({
      fn(ctx: SystemContext) {
        postUpdateLen = ctx.read(Input).length;
      },
    });

    world.add_systems(SCHEDULE.PRE_UPDATE, emitter);
    world.add_systems(SCHEDULE.UPDATE, updateReader);
    world.add_systems(SCHEDULE.POST_UPDATE, postUpdateReader);
    world.startup();
    world.update(0);

    expect(updateLen).toBe(1);
    expect(postUpdateLen).toBe(1);
  });
});
