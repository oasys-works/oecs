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
		world.resources.register(TimeRes, { delta: 0.016, elapsed: 1.5 });
		const time = world.resources.get(TimeRes);
		expect(time.delta).toBe(0.016);
		expect(time.elapsed).toBe(1.5);
	});

	it("resource returns mutable reference — direct mutation works", () => {
		const world = new ECS();
		const Counter = resourceKey<{ value: number }>("Counter");
		world.resources.register(Counter, { value: 0 });
		const counter = world.resources.get(Counter);
		counter.value = 42;
		expect(world.resources.get(Counter).value).toBe(42);
	});

	it("set_resource replaces the value entirely", () => {
		const world = new ECS();
		const Config = resourceKey<{ speed: number }>("Config");
		world.resources.register(Config, { speed: 10 });
		world.resources.set(Config, { speed: 99 });
		expect(world.resources.get(Config).speed).toBe(99);
	});

	it("has_resource returns false before insert, true after", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		expect(world.resources.has(Res)).toBe(false);
		world.resources.register(Res, { x: 1 });
		expect(world.resources.has(Res)).toBe(true);
	});

	it("duplicate insert throws RESOURCE_ALREADY_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		try {
			world.resources.register(Res, { x: 2 });
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
			world.resources.get(Res);
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
			world.resources.set(Res, { x: 1 });
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
		world.resources.register(A, { val: 10 });
		world.resources.register(B, { val: 20 });
		world.resources.get(A).val = 99;
		expect(world.resources.get(B).val).toBe(20);
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
		world.resources.register(RendererRes, instance);
		const r = world.resources.get(RendererRes);
		r.update();
		r.update();
		expect(r.count).toBe(2);
		expect(r).toBe(instance);
	});

	it("ctx.resource reads key-based resources within systems", () => {
		const world = new ECS();
		const Config = resourceKey<{ speed: number }>("Config");
		world.resources.register(Config, { speed: 42 });
		let readSpeed = -1;
		const sys = world.registerSystem({
			...openAccess([], [Config]),
			fn(ctx: SystemContext) {
				readSpeed = ctx.getResource(Config).speed;
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
		world.resources.register(State, { phase: 0 });
		const sys = world.registerSystem({
			...openAccess([], [State]),
			fn(ctx: SystemContext) {
				ctx.setResource(State, { phase: 3 });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(world.resources.get(State).phase).toBe(3);
	});

	it("direct mutation within system persists across frames", () => {
		const world = new ECS();
		const Counter = resourceKey<{ value: number }>("Counter");
		world.resources.register(Counter, { value: 0 });
		const sys = world.registerSystem({
			...openAccess([], [Counter]),
			fn(ctx: SystemContext) {
				ctx.getResource(Counter).value++;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		world.update(0);
		world.update(0);
		expect(world.resources.get(Counter).value).toBe(3);
	});

	it("ctx.has_resource returns correct values within systems", () => {
		const world = new ECS();
		const Inserted = resourceKey<{ x: number }>("Inserted");
		const NotInserted = resourceKey<{ x: number }>("NotInserted");
		world.resources.register(Inserted, { x: 1 });
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

describe("Resource lifecycle — remove / re-insert", () => {
	it("removeResource drops the resource — hasResource is false afterwards", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		expect(world.resources.has(Res)).toBe(true);
		world.resources.remove(Res);
		expect(world.resources.has(Res)).toBe(false);
	});

	it("resource() throws RESOURCE_NOT_REGISTERED after remove (value is gone)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		world.resources.remove(Res);
		try {
			world.resources.get(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("registerResource works again after remove — present → absent → present", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		world.resources.remove(Res);
		// Re-registering must NOT throw RESOURCE_ALREADY_REGISTERED now that the
		// key is free again, and the fresh value (not the old one) is read back.
		world.resources.register(Res, { x: 99 });
		expect(world.resources.has(Res)).toBe(true);
		expect(world.resources.get(Res).x).toBe(99);
	});

	it("removeResource on a missing key throws RESOURCE_NOT_REGISTERED", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Missing");
		try {
			world.resources.remove(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("removeResource on an already-removed key throws (idempotent removal is NOT allowed)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		world.resources.remove(Res);
		try {
			world.resources.remove(Res);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
		}
	});

	it("ctx.removeResource drops a resource mid-tick when declared in resourceWrites", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
		const sys = world.registerSystem({
			...openAccess([], [Res]),
			fn(ctx: SystemContext) {
				if (ctx.hasResource(Res)) ctx.removeResource(Res);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(world.resources.has(Res)).toBe(false);
	});

	it("ctx.removeResource without a resourceWrites declaration throws (access check)", () => {
		const world = new ECS();
		const Res = resourceKey<{ x: number }>("Res");
		world.resources.register(Res, { x: 1 });
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
		expect(world.resources.has(Res)).toBe(true);
	});

	it("remove then re-register across frames — a per-mode singleton lifecycle", () => {
		const world = new ECS();
		const Mode = resourceKey<{ phase: number }>("Mode");
		const seen: (number | null)[] = [];
		const sys = world.registerSystem({
			...openAccess([], [Mode]),
			fn(ctx: SystemContext) {
				seen.push(ctx.hasResource(Mode) ? ctx.getResource(Mode).phase : null);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		world.resources.register(Mode, { phase: 1 });
		world.update(0); // sees phase 1
		world.resources.remove(Mode);
		world.update(0); // absent
		world.resources.register(Mode, { phase: 2 });
		world.update(0); // sees phase 2

		expect(seen).toEqual([1, null, 2]);
	});
});
