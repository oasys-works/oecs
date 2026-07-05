import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { ECS_ERROR, ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

describe("ComponentRef (ctx.ref)", () => {
	//=========================================================
	// Reading fields
	//=========================================================

	it("reads current field values from the SoA columns", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 10, y: 20 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.refRead(Pos, e);
		expect(pos.x).toBe(10);
		expect(pos.y).toBe(20);
	});

	it("reads updated values after set_field", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		ctx.setField(e, Pos, "x", 99);
		const pos = ctx.refRead(Pos, e);
		expect(pos.x).toBe(99);
		expect(pos.y).toBe(2);
	});

	//=========================================================
	// Writing fields
	//=========================================================

	it("writes directly to the SoA columns", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.ref(Pos, e);
		pos.x = 42;
		pos.y = 84;

		expect(ctx.getField(e, Pos, "x")).toBe(42);
		expect(ctx.getField(e, Pos, "y")).toBe(84);
	});

	it("supports compound assignment operators", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 10, y: 20 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.ref(Pos, e);
		pos.x += 5;
		pos.y *= 2;

		expect(pos.x).toBe(15);
		expect(pos.y).toBe(40);
	});

	//=========================================================
	// Multiple refs
	//=========================================================

	it("refs to different components on the same entity are independent", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, Vel, { vx: 10, vy: 20 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.ref(Pos, e);
		const vel = ctx.refRead(Vel, e);

		pos.x += vel.vx;
		pos.y += vel.vy;

		expect(pos.x).toBe(11);
		expect(pos.y).toBe(22);
		expect(vel.vx).toBe(10);
		expect(vel.vy).toBe(20);
	});

	it("refs to the same component on different entities are independent", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e1 = world.spawn();
		const e2 = world.spawn();
		world.addComponent(e1, Pos, { x: 1, y: 2 });
		world.addComponent(e2, Pos, { x: 100, y: 200 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const p1 = ctx.ref(Pos, e1);
		const p2 = ctx.refRead(Pos, e2);

		p1.x = 999;

		expect(p1.x).toBe(999);
		expect(p2.x).toBe(100);
	});

	//=========================================================
	// Prototype caching
	//=========================================================

	it("refs to the same component share a prototype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e1 = world.spawn();
		const e2 = world.spawn();
		world.addComponent(e1, Pos, { x: 0, y: 0 });
		world.addComponent(e2, Pos, { x: 0, y: 0 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const r1 = ctx.refRead(Pos, e1);
		const r2 = ctx.refRead(Pos, e2);

		expect(r1).not.toBe(r2);
		expect(Object.getPrototypeOf(r1)).toBe(Object.getPrototypeOf(r2));
	});

	//=========================================================
	// Live column binding
	//=========================================================

	it("ref reads live data — reflects external writes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.refRead(Pos, e);
		expect(pos.x).toBe(0);

		// Write via setField, read through existing ref
		ctx.setField(e, Pos, "x", 77);
		expect(pos.x).toBe(77);
	});

	it("ref reads/writes through the live column buffer after a grow", () => {
		// A held ref reads `col.buf` live (not a buffer snapshot taken at creation),
		// so it stays correct when the column grows and refreshes its view in place.
		// A tiny columnCapacity forces the grow within a handful of appends.
		const world = new ECS({ memory: { columnCapacity: 4 } });
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 7, y: 8 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		// Hold a ref to e, THEN append enough same-archetype entities to force the
		// Pos column to grow (reallocating + refreshing the backing view).
		const pos = ctx.ref(Pos, e);
		for (let i = 0; i < 64; i++) {
			const f = world.spawn();
			world.addComponent(f, Pos, { x: i, y: i });
		}

		// The held ref still resolves e's row against the grown buffer.
		expect(pos.x).toBe(7);
		expect(pos.y).toBe(8);
		pos.x = 123;
		expect(ctx.refRead(Pos, e).x).toBe(123);
	});

	//=========================================================
	// Safety: refs are valid inside systems because structural
	// changes are deferred until flush.
	//=========================================================

	it("ref remains valid after deferred add_component (entity has not moved yet)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 10, y: 20 });

		let refXAfterDeferredAdd = -1;
		let refYAfterDeferredAdd = -1;

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				// Create ref while entity is in archetype [Pos]
				const pos = ctx.ref(Pos, e);
				expect(pos.x).toBe(10);
				expect(pos.y).toBe(20);

				// Defer adding Vel — entity should NOT move archetypes yet
				ctx.addComponent(e, Vel, { vx: 1, vy: 2 });

				// Ref should still be valid: entity is still in [Pos]
				pos.x = 99;
				refXAfterDeferredAdd = pos.x;
				refYAfterDeferredAdd = pos.y;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(refXAfterDeferredAdd).toBe(99);
		expect(refYAfterDeferredAdd).toBe(20);

		// After flush (update completes), the entity moved to [Pos, Vel]
		// and the written value was carried over via copySharedFrom
		expect(world.getField(e, Pos, "x")).toBe(99);
		expect(world.getField(e, Vel, "vx")).toBe(1);
	});

	it("ref remains valid after deferred remove_component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 5, y: 6 });
		world.addComponent(e, Vel, { vx: 7, vy: 8 });

		let refVxAfterDeferredRemove = -1;

		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				const vel = ctx.refRead(Vel, e);
				expect(vel.vx).toBe(7);

				// Defer removing Vel — entity stays in [Pos, Vel] until flush
				ctx.removeComponent(e, Vel);

				// Ref still reads correct data from the old archetype
				refVxAfterDeferredRemove = vel.vx;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(refVxAfterDeferredRemove).toBe(7);

		// After flush, entity is in [Pos] — Vel is gone
		expect(world.hasComponent(e, Vel)).toBe(false);
		expect(world.getField(e, Pos, "x")).toBe(5);
	});

	it("ref remains valid after deferred destroy_entity", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 42, y: 84 });

		let refXAfterDeferredDestroy = -1;

		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				const pos = ctx.refRead(Pos, e);
				expect(pos.x).toBe(42);

				// Defer destruction — entity is still alive and in its archetype
				ctx.commands.despawn(e);

				// Ref still works: entity has not been removed yet
				refXAfterDeferredDestroy = pos.x;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(refXAfterDeferredDestroy).toBe(42);
		expect(world.isAlive(e)).toBe(false);
	});

	it("two refs to different components remain valid through deferred operations", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Health = world.registerComponent(["hp"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, Vel, { vx: 3, vy: 4 });

		let posX = -1;
		let velVx = -1;

		const sys = world.registerSystem({
			...openAccess([Pos, Vel, Health]),
			fn(ctx) {
				const pos = ctx.ref(Pos, e);
				const vel = ctx.refRead(Vel, e);

				// Defer adding a third component
				ctx.addComponent(e, Health, { hp: 100 });

				// Both refs still valid — use vel to update pos
				pos.x += vel.vx;
				pos.y += vel.vy;

				posX = pos.x;
				velVx = vel.vx;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(posX).toBe(4); // 1 + 3
		expect(velVx).toBe(3);

		// After flush, values carried over to new archetype [Pos, Vel, Health]
		expect(world.getField(e, Pos, "x")).toBe(4);
		expect(world.getField(e, Pos, "y")).toBe(6); // 2 + 4
		expect(world.getField(e, Health, "hp")).toBe(100);
	});

	//=========================================================
	// Field enumeration
	//=========================================================

	it("component fields are enumerable on the prototype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 5, y: 10 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		const pos = ctx.refRead(Pos, e);
		const proto = Object.getPrototypeOf(pos);
		const keys = Object.keys(proto);

		expect(keys).toContain("x");
		expect(keys).toContain("y");
		expect(keys).toHaveLength(2);
	});

	//=========================================================
	// DEV guards: ref on a missing component / tag throws an
	// ECSError instead of a raw TypeError from createRef.
	//=========================================================

	it("ecs.refRead on an alive entity missing the component throws COMPONENT_NOT_REGISTERED", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		try {
			world.refRead(Vel, e);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}
	});

	it("ecs.refRead with a tag def throws COMPONENT_NOT_REGISTERED (tags have no columns)", () => {
		const world = new ECS();
		const Tag = world.registerTag();
		const e = world.spawn();
		world.addComponent(e, Tag);

		try {
			world.refRead(Tag, e);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}
	});

	it("ctx.ref / ctx.refRead on an alive entity missing the component throw COMPONENT_NOT_REGISTERED", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		try {
			ctx.ref(Vel, e);
			expect.fail("ctx.ref should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}

		try {
			ctx.refRead(Vel, e);
			expect.fail("ctx.refRead should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}
	});

	it("ctx.ref / ctx.refRead with a tag def throw COMPONENT_NOT_REGISTERED (tags have no columns)", () => {
		const world = new ECS();
		const Tag = world.registerTag();
		const e = world.spawn();
		world.addComponent(e, Tag);

		let ctx!: SystemContext;
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn(_ctx) {
				ctx = _ctx;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		try {
			ctx.ref(Tag, e);
			expect.fail("ctx.ref should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}

		try {
			ctx.refRead(Tag, e);
			expect.fail("ctx.refRead should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ECSError);
			expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		}
	});
});
