import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { bundle } from "../../component";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

describe("callable bundles", () => {
	it("bundle() pairs a def with values", () => {
		const world = new ECS({ memory: { columnCapacity: 4 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const b = bundle(Pos, { x: 1, y: 2 });
		expect(b.def).toBe(Pos);
		expect(b.values).toEqual({ x: 1, y: 2 });
	});

	it("spawnBundle writes fields, attaches bare tags, zero-fills omitted fields", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" });
		const Tag = world.registerTag();

		const e = world.spawnBundle(bundle(Pos, { x: 1, y: 2 }), bundle(Vel, { vx: 3, vy: 4 }), Tag);
		expect(world.getField(e, Pos, "x")).toBe(1);
		expect(world.getField(e, Pos, "y")).toBe(2);
		expect(world.getField(e, Vel, "vx")).toBe(3);
		expect(world.getField(e, Vel, "vy")).toBe(4);
		expect(world.hasComponent(e, Tag)).toBe(true);

		// omitted field zero-fills (matches the template / writeFields contract)
		const e2 = world.spawnBundle(bundle(Pos, { x: 7 }));
		expect(world.getField(e2, Pos, "x")).toBe(7);
		expect(world.getField(e2, Pos, "y")).toBe(0);
	});

	it("ctx.commands.spawn accepts the same bundle varargs", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" });

		let spawned: EntityID | null = null;
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			spawns: [[Pos, Vel]],
			fn: (ctx) => {
				spawned = ctx.commands.spawn(bundle(Pos, { x: 8, y: 9 }), bundle(Vel, { vx: 1, vy: 1 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(spawned).not.toBeNull();
		expect(world.getField(spawned!, Pos, "x")).toBe(8);
		expect(world.getField(spawned!, Vel, "vy")).toBe(1);
	});
});

describe("callable component defs", () => {
	it("a def carries its numeric id on `.id`, distinct per component", () => {
		const world = new ECS();
		const A = world.registerComponent({ a: "f64" });
		const B = world.registerComponent({ b: "f64" });
		expect(typeof A).toBe("function");
		expect(typeof A.id).toBe("number");
		expect(A.id).not.toBe(B.id);
		// `.id` is non-enumerable — a spread/JSON of the def doesn't leak it.
		expect(Object.keys(A)).not.toContain("id");
	});

	it("calling a def produces a Bundle equivalent to bundle(def, values)", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const called = Pos({ x: 1, y: 2 });
		const built = bundle(Pos, { x: 1, y: 2 });
		expect(called.def).toBe(Pos);
		expect(called.values).toEqual(built.values);
		// no-arg call is the zero-fill bundle (same as a bare def)
		expect(Pos().values).toEqual({});
	});

	it("spawnBundle accepts the callable form mixed with bare tags", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" });
		const Tag = world.registerTag();

		// Pos({x,y}) / Vel({vx}) callable form; Tag bare; Vel omits vy → zero-fill.
		const e = world.spawnBundle(Pos({ x: 5, y: 6 }), Vel({ vx: 7 }), Tag);
		expect(world.getField(e, Pos, "x")).toBe(5);
		expect(world.getField(e, Pos, "y")).toBe(6);
		expect(world.getField(e, Vel, "vx")).toBe(7);
		expect(world.getField(e, Vel, "vy")).toBe(0);
		expect(world.hasComponent(e, Tag)).toBe(true);
	});

	it("ctx.commands.add accepts the callable form", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" });
		const e = world.spawnBundle(Pos({ x: 1, y: 1 }));

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			transitions: [{ whenHas: [Pos], add: [Vel] }],
			fn: (ctx) => {
				ctx.commands.add(e, Vel({ vx: 2, vy: 3 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(world.getField(e, Vel, "vx")).toBe(2);
		expect(world.getField(e, Vel, "vy")).toBe(3);
	});
});
