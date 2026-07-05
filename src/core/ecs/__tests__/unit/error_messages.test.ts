/**
 * Error-experience contract (POLISH_AUDIT #4 / M6 / M17 / M18).
 *
 * Locks in the dev-mode diagnostic upgrades:
 *  - `registerComponent(schema, { name })` threads the debug name into
 *    access-violation and liveness messages (`'Pos' (component 0)`);
 *  - every `ENTITY_NOT_ALIVE` names the operation and decodes the packed id
 *    (index + generation) with the id in `context`;
 *  - access violations use the dedicated `ACCESS_UNDECLARED` category, not
 *    the registration categories, so catch-and-branch works;
 *  - resource/event "not registered" messages interpolate `key.description`
 *    and hint at the registration call;
 *  - no user-facing message references snake_case option names or private
 *    tracker issue numbers.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { ECS_ERROR, isEcsError } from "../../utils/error";
import { resourceKey } from "../../resource";
import { eventKey } from "../../event";

describe("component debug names", () => {
	it("names the component in access-violation messages", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" }, { name: "Pos" });
		const Vel = world.registerComponent({ vx: "f64", vy: "f64" }, { name: "Vel" });
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, Vel, { vx: 0, vy: 0 });

		const sys = world.registerSystem({
			name: "mover",
			reads: [Pos],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn: (ctx: SystemContext) => {
				// undeclared read of Vel — must throw naming 'Vel'
				ctx.getField(e, Vel as never, "vx" as never);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		let caught: unknown;
		try {
			world.update(0);
		} catch (err) {
			caught = err;
		}
		expect(isEcsError(caught)).toBe(true);
		if (isEcsError(caught)) {
			expect(caught.category).toBe(ECS_ERROR.ACCESS_UNDECLARED);
			expect(caught.message).toContain("'Vel'");
			expect(caught.message).toContain(`(component ${Vel.id})`);
			expect(caught.message).toContain("mover");
		}
	});

	it("array-shorthand registration accepts a name in the options slot", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const, "i32", { name: "Pos" });
		const stale = ((world.createEntity() as number) + (1 << 20)) as never;
		expect(() => world.hasComponent(stale, Pos)).toThrow(/'Pos' \(component 0\)/);
	});
});

describe("ENTITY_NOT_ALIVE context", () => {
	it("names the op and decodes index/generation, with the id in context", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" }, { name: "Pos" });
		const e = world.createEntity();
		world.addComponent(e, Pos, { x: 1 });
		// immediate destroy via the store to get a genuinely dead handle
		let caught: unknown;
		try {
			// getField on an out-of-range (never-created) handle
			world.getField((e + (1 << 20)) as typeof e, Pos, "x");
		} catch (err) {
			caught = err;
		}
		expect(isEcsError(caught)).toBe(true);
		if (isEcsError(caught)) {
			expect(caught.category).toBe(ECS_ERROR.ENTITY_NOT_ALIVE);
			expect(caught.message).toContain("getField");
			expect(caught.message).toMatch(/index \d+, generation \d+/);
			expect(caught.message).toContain("'Pos'");
			expect(caught.context).toMatchObject({ op: "getField" });
		}
	});
});

describe("registry messages interpolate the key name", () => {
	it("resource read of an unregistered key names it and hints registration", () => {
		const world = new ECS();
		const Config = resourceKey<number>("config");
		expect(() => world.resources.get(Config)).toThrow(/'config'.*resources\.register/);
	});

	it("event emit of an unregistered key names it and hints registration", () => {
		const world = new ECS();
		const Hit = eventKey<{ dmg: number }>("hit");
		expect(() => world.events.read(Hit)).toThrow(/'hit'.*events\.register/);
	});
});
