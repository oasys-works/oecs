import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { resourceKey } from "../../resource";
import { ECS_ERROR, ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";

describe("Resource system", () => {
	// ==== Resource key system ====

	it("insert and read a resource by key", () => {
		const world = new ECS();
		const TimeRes = resourceKey<{ delta: number; elapsed: number }>("Time");
		world.registerResource(TimeRes, { delta: 0.016, elapsed: 1.5 });
		const time = world.resource(TimeRes);
		expect(time.delta).toBe(0.016);
		expect(time.elapsed).toBe(1.5);
	});

	it("resource returns mutable reference — direct mutation works", () => {
		const world = new ECS();
		const Counter = resourceKey<{ value: number }>("Counter");
		world.registerResource(Counter, { value: 0 });
		const counter = world.resource(Counter);
		counter.value = 42;
		expect(world.resource(Counter).value).toBe(42);
	});

	it("set_resource replaces the value entirely", () => {
		const world = new ECS();
		const Config = resourceKey<{ speed: number }>("Config");
		world.registerResource(Config, { speed: 10 });
		world.setResource(Config, { speed: 99 });
		expect(world.resource(Config).speed).toBe(99);
	});

	it("has_resource returns false before insert, true after", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		expect(world.hasResource(Res)).toBe(false);
		world.registerResource(Res, { x: 1 });
		expect(world.hasResource(Res)).toBe(true);
	});

	it("duplicate insert throws RESOURCE_ALREADY_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		try {
			world.registerResource(Res, { x: 2 });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_ALREADY_REGISTERED);
		}
	});

	it("resource() on missing key throws RESOURCE_NOT_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Missing");
		try {
			world.resource(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("set_resource on missing key throws RESOURCE_NOT_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Missing");
		try {
			world.setResource(Res, { x: 1 });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("multiple key resources are independent", () => {
		const world = new ECS();
		const A = resourceKey<{ val: number }>("A");
		const B = resourceKey<{ val: number }>("B");
		world.registerResource(A, { val: 10 });
		world.registerResource(B, { val: 20 });
		world.resource(A).val = 99;
		expect(world.resource(B).val).toBe(20);
	});

	it("stores non-numeric values (objects, class instances)", () => {
		const world = new ECS();
		class Renderer {
			public count = 0;
			update() {
				this.count++;
			}
		}
		const RendererRes = resourceKey<Renderer>("Renderer");
		const instance = new Renderer();
		world.registerResource(RendererRes, instance);
		const r = world.resource(RendererRes);
		r.update();
		r.update();
		expect(r.count).toBe(2);
		expect(r).toBe(instance);
	});

	it("ctx.resource reads key-based resources within systems", () => {
		const world = new ECS();
		const Config = resourceKey<{ speed: number }>("Config");
		world.registerResource(Config, { speed: 42 });
		let readSpeed = -1;
		const sys = world.registerSystem({
			...openAccess([], [Config]),
			fn(ctx: SystemContext) {
				readSpeed = ctx.resource(Config).speed;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(readSpeed).toBe(42);
	});

	it("ctx.set_resource replaces key-based resources within systems", () => {
		const world = new ECS();
		const State = resourceKey<{ phase: number }>("State");
		world.registerResource(State, { phase: 0 });
		const sys = world.registerSystem({
			...openAccess([], [State]),
			fn(ctx: SystemContext) {
				ctx.setResource(State, { phase: 3 });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(world.resource(State).phase).toBe(3);
	});

	it("direct mutation within system persists across frames", () => {
		const world = new ECS();
		const Counter = resourceKey<{ value: number }>("Counter");
		world.registerResource(Counter, { value: 0 });
		const sys = world.registerSystem({
			...openAccess([], [Counter]),
			fn(ctx: SystemContext) {
				ctx.resource(Counter).value++;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		world.update(0);
		world.update(0);
		expect(world.resource(Counter).value).toBe(3);
	});

	it("ctx.has_resource returns correct values within systems", () => {
		const world = new ECS();
		const Inserted = resourceKey<{ x: number }>("Inserted");
		const NotInserted = resourceKey<{ x: number }>("NotInserted");
		world.registerResource(Inserted, { x: 1 });
		let hasInserted = false;
		let hasNotInserted = true;
		const sys = world.registerSystem({
			...openAccess([], [Inserted, NotInserted]),
			fn(ctx: SystemContext) {
				hasInserted = ctx.hasResource(Inserted);
				hasNotInserted = ctx.hasResource(NotInserted);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(hasInserted).toBe(true);
		expect(hasNotInserted).toBe(false);
	});
});

describe("Resource lifecycle — remove / re-insert (#798)", () => {
	it("removeResource drops the resource — hasResource is false afterwards", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		expect(world.hasResource(Res)).toBe(true);
		world.removeResource(Res);
		expect(world.hasResource(Res)).toBe(false);
	});

	it("resource() throws RESOURCE_NOT_REGISTERED after remove (value is gone)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		world.removeResource(Res);
		try {
			world.resource(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("registerResource works again after remove — present → absent → present", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		world.removeResource(Res);
		// Re-registering must NOT throw RESOURCE_ALREADY_REGISTERED now that the
		// key is free again, and the fresh value (not the old one) is read back.
		world.registerResource(Res, { x: 99 });
		expect(world.hasResource(Res)).toBe(true);
		expect(world.resource(Res).x).toBe(99);
	});

	it("removeResource on a missing key throws RESOURCE_NOT_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Missing");
		try {
			world.removeResource(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("removeResource on an already-removed key throws (idempotent removal is NOT allowed)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		world.removeResource(Res);
		try {
			world.removeResource(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("ctx.removeResource drops a resource mid-tick when declared in resourceWrites", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		const sys = world.registerSystem({
			...openAccess([], [Res]),
			fn(ctx: SystemContext) {
				if (ctx.hasResource(Res)) ctx.removeResource(Res);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(world.hasResource(Res)).toBe(false);
	});

	it("ctx.removeResource without a resourceWrites declaration throws (access check)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.registerResource(Res, { x: 1 });
		// openAccess([]) declares NO resources — removing one is an undeclared write.
		const sys = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.removeResource(Res);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).toThrow(ECSError);
		// The resource survives — the undeclared write was rejected before the store mutated.
		expect(world.hasResource(Res)).toBe(true);
	});

	it("remove then re-register across frames — a per-mode singleton lifecycle", () => {
		const world = new ECS();
		const Mode = resourceKey<{ phase: number }>("Mode");
		const seen: (number | null)[] = [];
		const sys = world.registerSystem({
			...openAccess([], [Mode]),
			fn(ctx: SystemContext) {
				seen.push(ctx.hasResource(Mode) ? ctx.resource(Mode).phase : null);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		world.registerResource(Mode, { phase: 1 });
		world.update(0); // sees phase 1
		world.removeResource(Mode);
		world.update(0); // absent
		world.registerResource(Mode, { phase: 2 });
		world.update(0); // sees phase 2

		expect(seen).toEqual([1, null, 2]);
	});
});
