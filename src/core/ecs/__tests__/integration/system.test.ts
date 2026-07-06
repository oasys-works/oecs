import { describe, expect, it, vi } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { ECS_ERROR, type ECSError } from "../../utils/error";
import type { Query, SystemContext } from "../../query";
import type { SystemConfig, SystemFn } from "../../system";

function makeConfig(overrides?: Partial<SystemConfig>): SystemConfig {
	return {
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		fn: (_ctx: SystemContext, _dt: number) => {},
		...overrides
	};
}

describe("ECS system registration", () => {
	//=========================================================
	// Registration
	//=========================================================

	it("register_system assigns unique SystemIDs", () => {
		const world = new ECS();
		const a = world.registerSystem(makeConfig());
		const b = world.registerSystem(makeConfig());

		expect(a.id).not.toBe(b.id);
		expect(a.id as number).toBe(0);
		expect(b.id as number).toBe(1);
	});

	it("register_system returns a frozen descriptor", () => {
		const world = new ECS();
		const descriptor = world.registerSystem(makeConfig());

		expect(Object.isFrozen(descriptor)).toBe(true);
	});

	it("system_count tracks registrations", () => {
		const world = new ECS();
		expect(world.systemCount).toBe(0);

		world.registerSystem(makeConfig());
		expect(world.systemCount).toBe(1);

		world.registerSystem(makeConfig());
		expect(world.systemCount).toBe(2);
	});

	//=========================================================
	// Removal
	//=========================================================

	it("remove_system calls on_removed and removes from registry", () => {
		const onRemoved = vi.fn();
		const world = new ECS();
		const descriptor = world.registerSystem(makeConfig({ onRemoved }));

		world.removeSystem(descriptor);

		expect(onRemoved).toHaveBeenCalledOnce();
		expect(world.systemCount).toBe(0);
	});

	//=========================================================
	// Lifecycle: startup calls onAdded
	//=========================================================

	it("startup calls on_added on all systems", () => {
		const onAddedA = vi.fn();
		const onAddedB = vi.fn();

		const world = new ECS();
		world.registerSystem(makeConfig({ onAdded: onAddedA }));
		world.registerSystem(makeConfig({ onAdded: onAddedB }));

		world.startup();

		expect(onAddedA).toHaveBeenCalledOnce();
		expect(onAddedB).toHaveBeenCalledOnce();
	});

	it("startup skips systems without on_added", () => {
		const world = new ECS();
		world.registerSystem(makeConfig()); // no onAdded

		expect(() => world.startup()).not.toThrow();
	});

	//=========================================================
	// Lifecycle: dispose
	//=========================================================

	it("dispose calls dispose then on_removed, then clears", () => {
		const callOrder: string[] = [];
		const world = new ECS();

		world.registerSystem(
			makeConfig({
				dispose: () => callOrder.push("dispose"),
				onRemoved: () => callOrder.push("on_removed")
			})
		);

		world.dispose();

		expect(callOrder).toEqual(["dispose", "on_removed"]);
		expect(world.systemCount).toBe(0);
	});

	it("dispose handles systems without lifecycle hooks", () => {
		const world = new ECS();
		world.registerSystem(makeConfig());

		expect(() => world.dispose()).not.toThrow();
		expect(world.systemCount).toBe(0);
	});

	//=========================================================
	// Descriptor preserves fn
	//=========================================================

	it("descriptor preserves the system function", () => {
		const fn = vi.fn();
		const world = new ECS();
		const descriptor = world.registerSystem(makeConfig({ fn }));

		expect(descriptor.fn).toBe(fn);
	});

	it("ctx exposes is_alive and has_component as shims for Store", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const AliveTag = world.registerTag();
		const tagged = world.spawn();
		const untagged = world.spawn();
		world.addComponent(tagged, Pos, { x: 1, y: 2 });
		world.addComponent(tagged, AliveTag);

		let taggedAlive = false;
		let untaggedAlive = false;
		let taggedHasPos = false;
		let untaggedHasPos = true;
		let taggedHasTag = false;
		let untaggedHasTag = true;
		const sys = world.registerSystem(
			makeConfig({
				fn: (ctx) => {
					taggedAlive = ctx.isAlive(tagged);
					untaggedAlive = ctx.isAlive(untagged);
					taggedHasPos = ctx.hasComponent(tagged, Pos);
					untaggedHasPos = ctx.hasComponent(untagged, Pos);
					taggedHasTag = ctx.hasComponent(tagged, AliveTag);
					untaggedHasTag = ctx.hasComponent(untagged, AliveTag);
				}
			})
		);

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(taggedAlive).toBe(true);
		expect(untaggedAlive).toBe(true);
		expect(taggedHasPos).toBe(true);
		expect(untaggedHasPos).toBe(false);
		expect(taggedHasTag).toBe(true);
		expect(untaggedHasTag).toBe(false);
	});

	// #213 H4: the bare-fn overload is `(ctx, dt)`. Forgetting the query builder
	// on the `(q, ctx, dt)` form would silently misbind args (q := ctx, dt := undefined);
	// the __DEV__ arity guard fails fast instead. Strict TS already rejects the
	// literal 3-param-arrow-with-no-builder form, so this 3-arity function reaches
	// the bare overload via a cast standing in for an untyped JS consumer.
	it("throws SYSTEM_FN_ARITY when a 3-param fn is registered without a query builder", () => {
		const world = new ECS();
		const threeArity = (_q: SystemContext, _ctx: SystemContext, _dt: number) => {};
		try {
			// stands in for an untyped JS caller — the only path a 3-arity fn reaches the bare overload
			world.registerSystem(threeArity as unknown as SystemFn);
			expect.unreachable("registration should have thrown");
		} catch (e) {
			const err = e as ECSError;
			expect(err.category).toBe(ECS_ERROR.SYSTEM_FN_ARITY);
			expect(err.message).toContain("query builder");
		}
	});

	it("does not throw for a legitimate bare (ctx, dt) system function", () => {
		const world = new ECS();
		expect(() => world.registerSystem((_ctx: SystemContext, _dt: number) => {})).not.toThrow();
	});

	it("does not throw for the (q, ctx, dt) form when the query builder is supplied", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		expect(() =>
			world.registerSystem(
				(_q: Query<readonly [typeof Pos]>, _ctx: SystemContext, _dt: number) => {},
				(qb) => qb.with(Pos)
			)
		).not.toThrow();
	});
});

describe("ECS fixed timestep", () => {
	it("runs FIXED_UPDATE the correct number of times per frame", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		let tickCount = 0;
		const sys = world.registerSystem(
			makeConfig({
				fn: () => {
					tickCount++;
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		// One frame of ~2 fixed steps worth
		world.update(2 / 60);
		expect(tickCount).toBe(2);
	});

	it("accumulates partial frames across updates", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		let tickCount = 0;
		const sys = world.registerSystem(
			makeConfig({
				fn: () => {
					tickCount++;
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		// Half a step — not enough to tick
		world.update(0.5 / 60);
		expect(tickCount).toBe(0);

		// Another half — now accumulated one full step
		world.update(0.5 / 60);
		expect(tickCount).toBe(1);
	});

	it("passes fixed_timestep as dt to FIXED_UPDATE systems", () => {
		const fixedDt = 1 / 50;
		const world = new ECS({ fixedTimestep: fixedDt });
		let receivedDt = 0;
		const sys = world.registerSystem(
			makeConfig({
				fn: (_ctx, dt) => {
					receivedDt = dt;
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		world.update(fixedDt);
		expect(receivedDt).toBeCloseTo(fixedDt);
	});

	it("clamps accumulator to prevent spiral of death", () => {
		const world = new ECS({ fixedTimestep: 1 / 60, maxFixedSteps: 4 });
		let tickCount = 0;
		const sys = world.registerSystem(
			makeConfig({
				fn: () => {
					tickCount++;
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		// Huge dt that would require 100 steps without clamping
		world.update(100 / 60);
		expect(tickCount).toBe(4);
	});

	it("skips accumulator loop when no FIXED_UPDATE systems exist", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		const order: string[] = [];
		const sys = world.registerSystem(
			makeConfig({
				fn: () => {
					order.push("update");
				}
			})
		);
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		// Should just run UPDATE, no fixed loop
		world.update(1 / 60);
		expect(order).toEqual(["update"]);
	});

	it("FIXED_UPDATE runs before variable UPDATE phases", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		const order: string[] = [];

		const fixed = world.registerSystem(
			makeConfig({
				fn: () => {
					order.push("fixed");
				}
			})
		);
		const update = world.registerSystem(
			makeConfig({
				fn: () => {
					order.push("update");
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, fixed);
		world.addSystems(SCHEDULE.UPDATE, update);
		world.startup();

		world.update(1 / 60);
		expect(order).toEqual(["fixed", "update"]);
	});

	it("fixed_alpha exposes interpolation factor", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		const sys = world.registerSystem(makeConfig());
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		// 1.5 steps: 1 tick consumed, 0.5 step remainder
		world.update(1.5 / 60);
		expect(world.fixedAlpha).toBeCloseTo(0.5);
	});

	it("fixed_timestep getter/setter works", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		expect(world.fixedTimestep).toBeCloseTo(1 / 60);

		world.fixedTimestep = 1 / 30;
		expect(world.fixedTimestep).toBeCloseTo(1 / 30);
	});

	it("defaults to 1/60 timestep and 4 max steps", () => {
		const world = new ECS();
		expect(world.fixedTimestep).toBeCloseTo(1 / 60);

		// Verify maxFixedSteps defaults to 4 by testing clamping
		let tickCount = 0;
		const sys = world.registerSystem(
			makeConfig({
				fn: () => {
					tickCount++;
				}
			})
		);
		world.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		world.startup();

		world.update(10 / 60);
		expect(tickCount).toBe(4);
	});
});

// ============================================================================
// Phase A+B of issue #213 — mandatory system access declarations + runtime
// validation. Phase A landed the type-level surface; Phase B replaced the
// PHASE_A_PLACEHOLDER_ACCESS sentinel with real per-system declarations and
// wired SystemContext + Archetype + World methods to throw under __DEV__
// when a system performs access it didn't declare.
// ============================================================================
describe("SystemConfig access declarations (issue #213 Phase A)", () => {
	it("descriptor preserves declared reads/writes/spawns/despawns/transitions/resources", () => {
		const world = new ECS();
		const A = world.registerComponent(["x"] as const);
		const B = world.registerComponent(["y"] as const);
		const C = world.registerTag();
		const SomeRes = Symbol("res") as unknown as import("../../resource").ResourceKey<number>;

		const descriptor = world.registerSystem({
			reads: [A],
			writes: [B],
			spawns: [[A, B]],
			despawns: [C],
			transitions: [{ whenHas: [A], add: [B], remove: [C] }],
			resourceReads: [SomeRes],
			resourceWrites: [],
			fn: () => {}
		});

		expect(descriptor.reads).toEqual([A]);
		expect(descriptor.writes).toEqual([B]);
		expect(descriptor.spawns).toEqual([[A, B]]);
		expect(descriptor.despawns).toEqual([C]);
		expect(descriptor.transitions).toEqual([{ whenHas: [A], add: [B], remove: [C] }]);
		expect(descriptor.resourceReads).toEqual([SomeRes]);
		expect(descriptor.resourceWrites).toEqual([]);
	});

	it("bare-fn registration fills empty access arrays", () => {
		const world = new ECS();
		const descriptor = world.registerSystem((_ctx, _dt) => {});

		expect(descriptor.reads).toEqual([]);
		expect(descriptor.writes).toEqual([]);
		expect(descriptor.spawns).toEqual([]);
		expect(descriptor.despawns).toEqual([]);
		expect(descriptor.transitions).toEqual([]);
		expect(descriptor.resourceReads).toEqual([]);
		expect(descriptor.resourceWrites).toEqual([]);
	});
});

// ============================================================================
// Phase B of issue #213 — runtime validation of declared access surface.
// accessCheck.enter(desc) is called by Schedule before fn() runs; every
// component read / write / structural change / resource access is checked
// against the descriptor's declarations and throws ECSError on a violation.
// ============================================================================
describe("Runtime access validation (issue #213 Phase B)", () => {
	it("throws when system reads an undeclared component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "reader",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.getField(e, Pos, "x");
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'reader'.*didn't declare/);
	});

	it("throws when system writes an undeclared component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "writer",
			reads: [Pos],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.setField(e, Pos, "x", 99);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'writer'.*write/);
	});

	it("throws when system adds an undeclared component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "adder",
			reads: [Pos],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.commands.add(e, Vel, { vx: 0, vy: 0 });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'adder'.*addComponent/);
	});

	it("throws when system removes an undeclared component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });
		world.addComponent(e, Vel, { vx: 0, vy: 0 });

		const sys = world.registerSystem({
			name: "remover",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.commands.remove(e, Vel);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'remover'.*removeComponent/);
	});

	it("throws when system destroys an entity without declaring any despawns", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "killer",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.commands.despawn(e);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'killer'.*despawn/);
	});

	it("throws when system reads an undeclared resource", () => {
		const world = new ECS();
		const Res = Symbol("R") as unknown as import("../../resource").ResourceKey<{ v: number }>;
		world.resources.register(Res, { v: 1 });

		const sys = world.registerSystem({
			name: "res_reader",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.getResource(Res);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'res_reader'.*resource read/);
	});

	it("throws when system writes an undeclared resource", () => {
		const world = new ECS();
		const Res = Symbol("RW") as unknown as import("../../resource").ResourceKey<{ v: number }>;
		world.resources.register(Res, { v: 1 });

		const sys = world.registerSystem({
			name: "res_writer",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [Res],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			fn(ctx: SystemContext) {
				ctx.setResource(Res, { v: 2 });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		expect(() => world.update(0)).toThrow(/system 'res_writer'.*resource write/);
	});

	it("validation does not fire for accesses outside any system (setup / teardown)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Res = Symbol("Outside") as unknown as import("../../resource").ResourceKey<{ v: number }>;
		world.resources.register(Res, { v: 1 });

		const e = world.spawn();
		expect(() => {
			// All of these run with no active system → access_check is a no-op.
			world.addComponent(e, Pos, { x: 1, y: 2 });
			world.setField(e, Pos, "x", 99);
			expect(world.getField(e, Pos, "x")).toBe(99);
			world.resources.get(Res);
			world.resources.set(Res, { v: 2 });
			world.removeComponent(e, Pos);
			world.despawn(e);
			world.flush();
		}).not.toThrow();
	});

	it("declared writes implicitly cover reads of the same component", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 5, y: 6 });

		let observed = -1;
		const sys = world.registerSystem({
			name: "rmw",
			reads: [],
			// Only declares writes — must still be allowed to read Pos because
			// every write implies a read (design §3).
			writes: [Pos],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn(ctx) {
				observed = ctx.getField(e, Pos, "x");
				ctx.setField(e, Pos, "x", observed + 1);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).not.toThrow();
		expect(observed).toBe(5);
		expect(world.getField(e, Pos, "x")).toBe(6);
	});

	it("declared spawns let the system add_component for the spawned-archetype members", () => {
		const world = new ECS();
		const A = world.registerComponent(["x"] as const);
		const B = world.registerComponent(["y"] as const);

		const sys = world.registerSystem({
			name: "spawner",
			reads: [],
			writes: [],
			spawns: [[A, B]],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn(ctx) {
				const e = ctx.commands.spawn();
				ctx.commands.add(e, A, { x: 1 });
				ctx.commands.add(e, B, { y: 2 });
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).not.toThrow();
	});

	it("transitions declare add/remove component allowances", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Tag = world.registerTag();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "tag_toggler",
			reads: [Pos],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [{ whenHas: [Pos], add: [Tag], remove: [Tag] }],
			resourceReads: [],
			resourceWrites: [],
			fn(ctx) {
				ctx.commands.add(e, Tag);
				ctx.commands.remove(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).not.toThrow();
	});

	it("on_added callbacks are also wrapped in access_check", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		const sys = world.registerSystem({
			name: "startup_reader",
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			// ctx annotated permissive (§typestate escape hatch): this system
			// DELIBERATELY violates its declaration to assert the runtime throw.
			onAdded(ctx: SystemContext) {
				ctx.getField(e, Pos, "x");
			},
			fn() {}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		expect(() => world.startup()).toThrow(/system 'startup_reader'.*didn't declare/);
	});
});
