import { describe, expect, it } from "vitest";
import { ECS } from "../ecs";
import { SCHEDULE } from "../schedule";
import type { SystemContext } from "../query";
import type { Store } from "../store";
import { unsafe_cast } from "type_primitives";

describe("Resource system", () => {
  it("registration returns unique ResourceDefs", () => {
    const world = new ECS();
    const A = world.register_resource(["x"] as const, { x: 0 });
    const B = world.register_resource(["y"] as const, { y: 0 });

    expect((A as unknown as number) !== (B as unknown as number)).toBe(true);
  });

  it("initial values are readable immediately after registration", () => {
    const world = new ECS();
    const Time = world.register_resource(["delta", "elapsed"] as const, {
      delta: 0.016,
      elapsed: 1.5,
    });

    const r = world.resource(Time);
    expect(r.delta).toBe(0.016);
    expect(r.elapsed).toBe(1.5);
  });

  it("ctx.resource returns typed reader with correct values", () => {
    const world = new ECS();
    const Config = world.register_resource(["speed", "gravity"] as const, {
      speed: 100,
      gravity: 9.8,
    });
    let read_speed = -1;
    let read_gravity = -1;

    const sys = world.register_system({
      fn(ctx: SystemContext) {
        const cfg = ctx.resource(Config);
        read_speed = cfg.speed;
        read_gravity = cfg.gravity;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(read_speed).toBe(100);
    expect(read_gravity).toBe(9.8);
  });

  it("ctx.set_resource updates values and reader reflects changes", () => {
    const world = new ECS();
    const Time = world.register_resource(["delta", "elapsed"] as const, {
      delta: 0,
      elapsed: 0,
    });
    let read_delta = -1;
    let read_elapsed = -1;

    const writer = world.register_system({
      fn(ctx: SystemContext) {
        ctx.set_resource(Time, { delta: 0.016, elapsed: 1.0 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const t = ctx.resource(Time);
        read_delta = t.delta;
        read_elapsed = t.elapsed;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, writer, {
      system: reader,
      ordering: { after: [writer] },
    });
    world.startup();
    world.update(0);

    expect(read_delta).toBe(0.016);
    expect(read_elapsed).toBe(1.0);
  });

  it("ctx.resource() reads individual fields via the reader", () => {
    const world = new ECS();
    const Camera = world.register_resource(["x", "y", "zoom"] as const, {
      x: 10,
      y: 20,
      zoom: 2,
    });
    let read_zoom = -1;

    const sys = world.register_system({
      fn(ctx: SystemContext) {
        read_zoom = ctx.resource(Camera).zoom;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(read_zoom).toBe(2);
  });

  it("ctx.set_resource() updates individual fields", () => {
    const world = new ECS();
    const Camera = world.register_resource(["x", "y", "zoom"] as const, {
      x: 10,
      y: 20,
      zoom: 2,
    });
    let read_x = -1;
    let read_y = -1;
    let read_zoom = -1;

    const writer = world.register_system({
      fn(ctx: SystemContext) {
        ctx.set_resource(Camera, { x: 10, y: 20, zoom: 4 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const cam = ctx.resource(Camera);
        read_x = cam.x;
        read_y = cam.y;
        read_zoom = cam.zoom;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, writer, {
      system: reader,
      ordering: { after: [writer] },
    });
    world.startup();
    world.update(0);

    expect(read_x).toBe(10);
    expect(read_y).toBe(20);
    expect(read_zoom).toBe(4);
  });

  it("multiple resources are independent", () => {
    const world = new ECS();
    const Time = world.register_resource(["delta"] as const, { delta: 0.016 });
    const Score = world.register_resource(["points"] as const, { points: 100 });

    world.set_resource(Score, { points: 200 });

    expect(world.resource(Time).delta).toBe(0.016);
    expect(world.resource(Score).points).toBe(200);
  });

  it("reader is a live view — reads always return current values", () => {
    const world = new ECS();
    const Counter = world.register_resource(["value"] as const, { value: 0 });

    const reader = world.resource(Counter);
    expect(reader.value).toBe(0);

    world.set_resource(Counter, { value: 42 });
    expect(reader.value).toBe(42);

    world.set_resource(Counter, { value: 99 });
    expect(reader.value).toBe(99);
  });

  it("set_resource applies immediately (not deferred)", () => {
    const world = new ECS();
    const State = world.register_resource(["phase"] as const, { phase: 0 });
    const phases: number[] = [];

    const sys = world.register_system({
      fn(ctx: SystemContext) {
        ctx.set_resource(State, { phase: 1 });
        phases.push(ctx.resource(State).phase);
        ctx.set_resource(State, { phase: 2 });
        phases.push(ctx.resource(State).phase);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(phases).toEqual([1, 2]);
  });

  it("partial set_resource only updates specified fields", () => {
    const world = new ECS();
    const Vec = world.register_resource(["x", "y", "z"] as const, {
      x: 1,
      y: 2,
      z: 3,
    });

    // Write only x — y and z should stay the same.
    // set_resource takes FieldValues<F> which requires all fields,
    // but internally ResourceChannel.write only overwrites fields present in the record.
    // So we use the channel directly for partial updates.
    const world_ecs = unsafe_cast<{ store: Store }>(world);
    const channel = world_ecs.store.get_resource_channel(Vec);
    channel.write({ x: 10 });

    const r = world.resource(Vec);
    expect(r.x).toBe(10);
    expect(r.y).toBe(2);
    expect(r.z).toBe(3);
  });

  it("resource values persist across frames", () => {
    const world = new ECS();
    const Counter = world.register_resource(["value"] as const, { value: 0 });
    let frame = 0;
    let read_value = -1;

    const sys = world.register_system({
      fn(ctx: SystemContext) {
        if (frame === 0) {
          ctx.set_resource(Counter, { value: 42 });
        }
        read_value = ctx.resource(Counter).value;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    frame = 0;
    world.update(0);
    expect(read_value).toBe(42);

    frame = 1;
    world.update(0);
    expect(read_value).toBe(42);
  });
});
