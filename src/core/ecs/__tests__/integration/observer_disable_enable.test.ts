/**
 * onDisable / onEnable observers (#677 / ADR-0023) — the entity enable/disable
 * (#577) transition surfaced as a structural-style observer signal so a consumer
 * (the reactive bridge) can drain it.
 *
 * Discipline mirrors onAdd/onRemove (ADR-0013): fires at the DEFERRED toggle
 * drain in `flushStructural`, in canonical order, for EVERY component the entity
 * carries (a disable is a soft remove of the whole mask from default queries), and
 * collapses to one event per NET transition across a drain. An IMMEDIATE
 * `world.disable()` does not fire (like immediate `addComponent`). The signal is
 * a scheduling artifact — OUT of `stateHash`. `yieldExisting` seeds enabled
 * members only.
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { getEntityIndex, type EntityID } from "../../entity";
import { openAccess } from "../test_helpers";

const Pos = { x: "i32", y: "i32" } as const;
const Vel = { vx: "i32", vy: "i32" } as const;

/** Register a system that runs the next queued command each tick — one toggle
 * script step per `world.update()`. Returns the command queue to push closures. */
function commandQueue(world: ECS, access: ReturnType<typeof openAccess>) {
	const cmds: Array<(ctx: Parameters<NonNullable<Parameters<ECS["registerSystem"]>[0]["fn"]>>[0]) => void> = [];
	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
			...access,
			name: "toggle_script",
			fn: (ctx) => {
				const c = cmds.shift();
				if (c !== undefined) c(ctx);
			}
		})
	);
	return cmds;
}

describe("Observers — onDisable / onEnable (#677)", () => {
	it("a deferred disable fires onDisable at the flush boundary; re-enable fires onEnable", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const disabled: number[] = [];
		const enabled: number[] = [];
		world.observe(P, {
			onDisable: (eid) => disabled.push(eid as number),
			onEnable: (eid) => enabled.push(eid as number),
			access: openAccess([P])
		});
		const e = world.spawn();
		world.addComponent(e, P, { x: 1, y: 2 });
		const cmds = commandQueue(world, openAccess([P]));
		world.startup();

		expect(disabled).toEqual([]);
		cmds.push((ctx) => ctx.disable(e));
		world.update(1 / 60);
		expect(disabled).toEqual([e as number]);
		expect(enabled).toEqual([]);

		cmds.push((ctx) => ctx.enable(e));
		world.update(1 / 60);
		expect(enabled).toEqual([e as number]);
		expect(disabled).toEqual([e as number]); // unchanged
	});

	it("an immediate (host-side) disable does NOT fire onDisable", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		let fires = 0;
		world.observe(P, { onDisable: () => fires++, access: openAccess([P]) });
		const e = world.spawn();
		world.addComponent(e, P, { x: 0, y: 0 });
		world.startup();
		world.disable(e); // immediate path — not an observed point (ADR-0013/0023)
		expect(world.isDisabled(e)).toBe(true);
		expect(fires).toBe(0);
	});

	it("onDisable fires once per carried component the entity has an observer on", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const V = world.registerComponent(Vel);
		const onP: number[] = [];
		const onV: number[] = [];
		world.observe(P, { onDisable: (eid) => onP.push(eid as number), access: openAccess([P]) });
		world.observe(V, { onDisable: (eid) => onV.push(eid as number), access: openAccess([V]) });
		const e = world.spawn();
		world.addComponent(e, P, { x: 1, y: 1 });
		world.addComponent(e, V, { vx: 2, vy: 2 });
		const cmds = commandQueue(world, openAccess([P, V]));
		world.startup();

		cmds.push((ctx) => ctx.disable(e));
		world.update(1 / 60);
		// A disable is a soft remove of the WHOLE mask — both observers fire.
		expect(onP).toEqual([e as number]);
		expect(onV).toEqual([e as number]);
	});

	it("net-effect: disable+enable in one tick fires nothing; disable+enable+disable fires one onDisable", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const disabled: number[] = [];
		const enabled: number[] = [];
		world.observe(P, {
			onDisable: (eid) => disabled.push(eid as number),
			onEnable: (eid) => enabled.push(eid as number),
			access: openAccess([P])
		});
		const a = world.spawn();
		const b = world.spawn();
		world.addComponent(a, P, { x: 0, y: 0 });
		world.addComponent(b, P, { x: 0, y: 0 });
		const cmds = commandQueue(world, openAccess([P]));
		world.startup();

		// a: disable then enable → no net transition (was enabled, ends enabled).
		// b: disable, enable, disable → one net onDisable.
		cmds.push((ctx) => {
			ctx.disable(a);
			ctx.enable(a);
			ctx.disable(b);
			ctx.enable(b);
			ctx.disable(b);
		});
		world.update(1 / 60);
		expect(enabled).toEqual([]); // a's enable nets out; b ends disabled
		expect(disabled).toEqual([b as number]); // single event for b
		expect(world.isDisabled(a)).toBe(false);
		expect(world.isDisabled(b)).toBe(true);
	});

	it("fires in canonical entity-id order within an observer (radix, not queue order)", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const order: number[] = [];
		world.observe(P, {
			onDisable: (eid) => order.push(getEntityIndex(eid)),
			access: openAccess([P])
		});
		const ids: EntityID[] = [];
		for (let i = 0; i < 5; i++) {
			const e = world.spawn();
			world.addComponent(e, P, { x: i, y: i });
			ids.push(e);
		}
		const cmds = commandQueue(world, openAccess([P]));
		world.startup();

		// Disable in DESCENDING queue order; events must come out ascending by index.
		cmds.push((ctx) => {
			for (let i = ids.length - 1; i >= 0; i--) ctx.disable(ids[i]);
		});
		world.update(1 / 60);
		const sorted = order.slice().sort((x, y) => x - y);
		expect(order).toEqual(sorted);
	});

	it("an onDisable that enqueues structural work settles in the same tick (cascade)", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const Marker = world.registerTag();
		const survivor = world.spawn();
		world.addComponent(survivor, P, { x: 9, y: 9 });
		const victim = world.spawn();
		world.addComponent(victim, P, { x: 1, y: 1 });
		world.observe(P, {
			onDisable: (eid, ctx) => {
				if ((eid as number) === (victim as number)) ctx.addComponent(survivor, Marker);
			},
			access: openAccess([P, Marker])
		});
		const cmds = commandQueue(world, openAccess([P, Marker]));
		world.startup();

		expect(world.hasComponent(survivor, Marker)).toBe(false);
		cmds.push((ctx) => ctx.disable(victim));
		world.update(1 / 60);
		// The add the onDisable queued settled this tick (joint fixed point).
		expect(world.hasComponent(survivor, Marker)).toBe(true);
	});

	it("registering toggle observers does not change state_hash (signal is out of the hash)", () => {
		const build = (observe: boolean) => {
			const world = new ECS({ deterministic: true });
			const P = world.registerComponent(Pos);
			if (observe) {
				world.observe(P, {
					onDisable: () => {},
					onEnable: () => {},
					access: openAccess([P])
				});
			}
			const ids: EntityID[] = [];
			for (let i = 0; i < 4; i++) {
				const e = world.spawn();
				world.addComponent(e, P, { x: i, y: i * 2 });
				ids.push(e);
			}
			const cmds = commandQueue(world, openAccess([P]));
			world.startup();
			cmds.push((ctx) => {
				ctx.disable(ids[1]);
				ctx.disable(ids[2]);
			});
			world.update(1 / 60);
			return world.snapshots.stateHash();
		};
		// Same disabled set ⇒ same hash, regardless of whether an observer drained it.
		expect(build(true)).toBe(build(false));
	});

	it("yield_existing seeds enabled members only — a disabled entity is absent", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const enabledEntity = world.spawn();
		const disabledEntity = world.spawn();
		world.addComponent(enabledEntity, P, { x: 1, y: 1 });
		world.addComponent(disabledEntity, P, { x: 2, y: 2 });
		world.disable(disabledEntity); // immediate host-side disable before observe
		expect(world.isDisabled(disabledEntity)).toBe(true);

		const seeded: number[] = [];
		world.observe(P, {
			onAdd: (eid) => seeded.push(eid as number),
			access: openAccess([P]),
			yieldExisting: true
		});
		expect(seeded).toEqual([enabledEntity as number]);
	});

	it("per-entity onSet does not fire for a disabled entity (matches the default-query exclusion)", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const sets: number[] = [];
		world.observe(P, {
			granularity: "entity",
			onSet: (eid) => sets.push(eid as number),
			access: openAccess([P])
		});
		const e = world.spawn();
		world.addComponent(e, P, { x: 0, y: 0 });
		world.disable(e); // immediate disable before any tick

		// A system writes the (disabled) entity's field by explicit eid every tick.
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				...openAccess([P]),
				name: "write_disabled",
				fn: (ctx) => ctx.setField(e, P, "x", 1)
			})
		);
		world.startup();
		world.update(1 / 60);
		// The write marked the row dirty, but onSet skips it — the entity is disabled.
		expect(sets).toEqual([]);

		// Re-enable, then write again: now onSet fires.
		world.enable(e);
		world.update(1 / 60);
		expect(sets).toEqual([e as number]);
	});

	it("a destroyed entity does not fire onDisable even if a disable was queued for it", () => {
		const world = new ECS({ deterministic: true });
		const P = world.registerComponent(Pos);
		const disabled: number[] = [];
		world.observe(P, {
			onDisable: (eid) => disabled.push(eid as number),
			access: openAccess([P])
		});
		const e = world.spawn();
		world.addComponent(e, P, { x: 1, y: 1 });
		const cmds = commandQueue(world, openAccess([P]));
		world.startup();

		// Destroy drains before the toggle (structural quiescent → toggle); the dead
		// handle is skipped, so onDisable never fires for it.
		cmds.push((ctx) => {
			ctx.disable(e);
			ctx.commands.despawn(e);
		});
		world.update(1 / 60);
		expect(disabled).toEqual([]);
		expect(world.isAlive(e)).toBe(false);
	});
});
