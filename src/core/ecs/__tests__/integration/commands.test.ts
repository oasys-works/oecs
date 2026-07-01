import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { bundle } from "../../component";
import type { EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

describe("ctx.commands (deferred structural facade)", () => {
	it("spawn / add / despawn apply at the phase flush", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Mark = world.registerTag();
		const victim = world.spawnBundle(bundle(Pos, { x: 9, y: 9 }));

		let spawned: EntityID | null = null;
		let aliveMid: boolean | null = null;
		const sys = world.registerSystem({
			...openAccess([Pos, Mark]),
			spawns: [[Pos], [Pos, Mark]],
			fn: (ctx) => {
				spawned = ctx.commands.spawn(bundle(Pos, { x: 5, y: 6 }));
				ctx.commands.add(spawned, Mark);
				aliveMid = world.isAlive(victim); // despawn is deferred → still alive
				ctx.commands.despawn(victim);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(spawned).not.toBeNull();
		expect(world.isAlive(spawned!)).toBe(true);
		expect(world.getField(spawned!, Pos, "x")).toBe(5);
		expect(world.getField(spawned!, Pos, "y")).toBe(6);
		expect(world.hasComponent(spawned!, Mark)).toBe(true);
		expect(aliveMid).toBe(true);
		expect(world.isAlive(victim)).toBe(false);
	});

	it("remove is deferred to the flush", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const Extra = world.registerComponent({ v: "f64" });
		const e = world.spawnBundle(bundle(Pos, { x: 1, y: 1 }), bundle(Extra, { v: 7 }));

		let hadMid: boolean | null = null;
		const sys = world.registerSystem({
			...openAccess([Pos, Extra]),
			transitions: [{ whenHas: [Pos, Extra], remove: [Extra] }],
			fn: (ctx) => {
				ctx.commands.remove(e, Extra);
				hadMid = world.hasComponent(e, Extra); // deferred → still present
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(hadMid).toBe(true);
		expect(world.hasComponent(e, Extra)).toBe(false);
		expect(world.hasComponent(e, Pos)).toBe(true);
	});

	it("disable / enable are deferred to the flush", () => {
		const world = new ECS({ memory: { columnCapacity: 16 } });
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const e = world.spawnBundle(bundle(Pos, { x: 1, y: 1 }));

		const disableSys = world.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				ctx.commands.disable(e);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, disableSys);
		world.startup();
		world.update(0);

		// default query excludes disabled rows
		let visible = 0;
		world.query(Pos).forEach((arch) => {
			visible += arch.entityCount;
		});
		expect(visible).toBe(0);
		expect(world.isAlive(e)).toBe(true);
	});
});
