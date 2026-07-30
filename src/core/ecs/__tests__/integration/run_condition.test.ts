/**
 * Run conditions / system sets.
 *
 * ECS-level behaviour: the determinism acceptance (a false gate is byte-for-byte
 * the system being absent that tick), the three shipped built-ins, set-level
 * gating + AND semantics, the skipped-system last-run invariant, the custom
 * predicate path, and the dev-mode access check on a condition's reads. Pure
 * scheduling mechanics (set-ordering edge expansion, the no-gate fast path) live
 * in `unit/schedule.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE, systemSet } from "../../schedule";
import {
	runIfResourceEq,
	runEveryNTicks,
	runIfAnyMatch,
	type RunCondition
} from "../../run_condition";
import { resourceKey } from "../../resource";
import { openAccess } from "../test_helpers";

describe("Run conditions", () => {
	//=========================================================
	// Acceptance 1 — a false gate == the system being absent that tick
	//=========================================================

	it("a false run-condition skips the body: state_hash identical to removing the system", () => {
		const Flag = resourceKey<boolean>("Flag");

		// World A: system gated OFF (resource is false → condition never fires).
		const a = new ECS({ deterministic: true });
		const PosA = a.registerComponent(["x"] as const, "i32");
		a.resources.register(Flag, false);
		const ea = a.spawn();
		a.addComponent(ea, PosA, { x: 0 });
		const sysA = a.registerSystem({
			...openAccess([PosA]),
			fn(ctx) {
				ctx.setField(ea, PosA, "x", ctx.ecsTick + 1);
			}
		});
		a.addSystems(SCHEDULE.UPDATE, { system: sysA, runIf: runIfResourceEq(Flag, true) });
		a.startup();
		a.update(1 / 60);

		// World B: the SAME system is simply never scheduled (genuinely absent).
		const b = new ECS({ deterministic: true });
		const PosB = b.registerComponent(["x"] as const, "i32");
		b.resources.register(Flag, false);
		const eb = b.spawn();
		b.addComponent(eb, PosB, { x: 0 });
		b.registerSystem({
			...openAccess([PosB]),
			fn(ctx) {
				ctx.setField(eb, PosB, "x", ctx.ecsTick + 1);
			}
		});
		b.startup();
		b.update(1 / 60);

		// Skipped == absent.
		expect(a.snapshots.stateHash()).toBe(b.snapshots.stateHash());

		// And flipping the gate ON makes the system run — state diverges from the
		// skipped case, confirming the gate isn't a no-op in both directions.
		a.resources.set(Flag, true);
		a.update(1 / 60);
		expect(a.snapshots.stateHash()).not.toBe(b.snapshots.stateHash());
	});

	it("a skipped system enqueues nothing — a gated-off spawn never materialises", () => {
		const Flag = resourceKey<boolean>("Flag");
		const world = new ECS({ deterministic: true });
		const Tag = world.registerComponent([] as const);
		world.resources.register(Flag, false);

		const spawner = world.registerSystem({
			...openAccess([Tag]),
			spawns: [[Tag]],
			fn(ctx) {
				const e = ctx.commands.spawn();
				ctx.commands.add(e, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, { system: spawner, runIf: runIfResourceEq(Flag, true) });
		world.startup();

		const before = world.snapshots.stateHash();
		world.update(1 / 60); // gated off → no spawn, no deferred flush contribution
		expect(world.query(Tag).entityCount).toBe(0);
		expect(world.snapshots.stateHash()).toBe(before);

		world.resources.set(Flag, true);
		world.update(1 / 60); // gated on → one entity spawns
		expect(world.query(Tag).entityCount).toBe(1);
	});

	//=========================================================
	// Built-ins
	//=========================================================

	it("run_if_resource_eq gates on a resource value", () => {
		const Paused = resourceKey<boolean>("Paused");
		const world = new ECS({ deterministic: true });
		world.resources.register(Paused, true);

		let runs = 0;
		const sys = world.registerSystem((/* ctx */) => {
			runs++;
		});
		world.addSystems(SCHEDULE.UPDATE, {
			system: sys,
			runIf: runIfResourceEq(Paused, false)
		});
		world.startup();

		world.update(1 / 60); // paused → skip
		expect(runs).toBe(0);

		world.resources.set(Paused, false);
		world.update(1 / 60); // unpaused → run
		world.update(1 / 60);
		expect(runs).toBe(2);
	});

	it("run_every_n_ticks fires on tick % n === 0 (deterministic, tick-keyed)", () => {
		const world = new ECS({ deterministic: true });
		const ranOn: number[] = [];
		const sys = world.registerSystem((ctx) => {
			ranOn.push(ctx.ecsTick);
		});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: runEveryNTicks(3) });
		world.startup();

		for (let i = 0; i < 7; i++) world.update(1 / 60); // ticks 0..6
		expect(ranOn).toEqual([0, 3, 6]);
	});

	it("run_every_n_ticks honours an offset phase-shift", () => {
		const world = new ECS({ deterministic: true });
		const ranOn: number[] = [];
		const sys = world.registerSystem((ctx) => {
			ranOn.push(ctx.ecsTick);
		});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: runEveryNTicks(3, 1) });
		world.startup();

		for (let i = 0; i < 7; i++) world.update(1 / 60); // ticks 0..6
		expect(ranOn).toEqual([1, 4]);
	});

	it("run_every_n_ticks folds an out-of-range / negative offset into [0, n)", () => {
		const runWith = (n: number, offset: number): number[] => {
			const world = new ECS({ deterministic: true });
			const ranOn: number[] = [];
			const sys = world.registerSystem((ctx) => {
				ranOn.push(ctx.ecsTick);
			});
			world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: runEveryNTicks(n, offset) });
			world.startup();
			for (let i = 0; i < 8; i++) world.update(1 / 60); // ticks 0..7
			return ranOn;
		};

		// offset is a phase mod n: 7 ≡ 1, 6 ≡ 0, −1 ≡ 2 (mod 3). No spurious early
		// fire from signed-zero modulo — each equals its in-range phase.
		expect(runWith(3, 7)).toEqual(runWith(3, 1)); // [1, 4, 7]
		expect(runWith(3, 7)).toEqual([1, 4, 7]);
		expect(runWith(3, 6)).toEqual([0, 3, 6]); // ≡ offset 0
		expect(runWith(3, -1)).toEqual([2, 5]); // ≡ offset 2
	});

	it("run_every_n_ticks rejects a non-integer offset in __DEV__", () => {
		expect(() => runEveryNTicks(3, 1.5)).toThrow(/offset must be an integer/);
	});

	it("run_if_any_match gates on whether a query matches an entity", () => {
		const world = new ECS({ deterministic: true });
		const Marker = world.registerComponent([] as const);
		const q = world.query(Marker);

		let runs = 0;
		const sys = world.registerSystem((/* ctx */) => {
			runs++;
		});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: runIfAnyMatch(q) });
		world.startup();

		world.update(1 / 60); // no Marker entity → skip
		expect(runs).toBe(0);

		const e = world.spawn();
		world.addComponent(e, Marker, {}); // host-side immediate
		world.update(1 / 60); // now matches → run
		expect(runs).toBe(1);
	});

	//=========================================================
	// Skipped systems do not advance last_run
	//=========================================================

	it("a skipped tick does not advance the system's last-run tick", () => {
		const world = new ECS({ deterministic: true });
		const observed: number[] = [];
		// Custom predicate: skip exactly tick 1 (also exercises the custom path).
		const skipTick1: RunCondition = {
			name: "skip_tick_1",
			evaluate: (ctx) => ctx.ecsTick !== 1
		};
		const sys = world.registerSystem((ctx) => {
			observed.push(ctx.lastRunTick);
		});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: skipTick1 });
		world.startup();

		for (let i = 0; i < 4; i++) world.update(1 / 60); // ticks 0,1(skip),2,3

		// Ran at 0 (last_run seed 0), skipped 1, ran at 2 seeing last_run STILL 0
		// (the skip left it unadvanced), ran at 3 seeing last_run 2.
		expect(observed).toEqual([0, 0, 2]);
	});

	//=========================================================
	// accessCheck covers a condition's reads (dev only)
	//=========================================================

	it("a condition reading an undeclared resource throws in __DEV__", () => {
		const Flag = resourceKey<boolean>("Flag");
		const world = new ECS({ deterministic: true });
		world.resources.register(Flag, true);

		// Hand-rolled condition that reads Flag but forgets to declare it.
		const undeclared: RunCondition = {
			name: "reads_undeclared",
			evaluate: (ctx) => ctx.getResource(Flag) === true
		};
		const sys = world.registerSystem((/* ctx */) => {});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: undeclared });
		world.startup();

		expect(() => world.update(1 / 60)).toThrow(/didn't declare it/);
	});

	it("the built-in run_if_resource_eq declares its read, so it does not throw", () => {
		const Flag = resourceKey<boolean>("Flag");
		const world = new ECS({ deterministic: true });
		world.resources.register(Flag, true);
		const sys = world.registerSystem((/* ctx */) => {});
		world.addSystems(SCHEDULE.UPDATE, { system: sys, runIf: runIfResourceEq(Flag, true) });
		world.startup();
		expect(() => world.update(1 / 60)).not.toThrow();
	});
});

describe("System sets", () => {
	//=========================================================
	// Acceptance 2 — a shared condition gates every member together
	//=========================================================

	it("a set condition gates all members as a group", () => {
		const Active = resourceKey<boolean>("Active");
		const world = new ECS({ deterministic: true });
		world.resources.register(Active, false);

		const Combat = systemSet("Combat");
		let aRuns = 0;
		let bRuns = 0;
		const s1 = world.registerSystem(() => {
			aRuns++;
		});
		const s2 = world.registerSystem(() => {
			bRuns++;
		});
		world.addSystems(SCHEDULE.UPDATE, { system: s1, set: Combat }, { system: s2, set: Combat });
		world.configureSet(Combat, { runIf: runIfResourceEq(Active, true) });
		world.startup();

		world.update(1 / 60); // set inactive → both skip
		expect([aRuns, bRuns]).toEqual([0, 0]);

		world.resources.set(Active, true);
		world.update(1 / 60); // set active → both run
		expect([aRuns, bRuns]).toEqual([1, 1]);
	});

	it("member effective gate is the AND of its own condition and the set's", () => {
		const SetOn = resourceKey<boolean>("SetOn");
		const OwnOn = resourceKey<boolean>("OwnOn");
		const world = new ECS({ deterministic: true });
		world.resources.register(SetOn, true);
		world.resources.register(OwnOn, true);

		const Group = systemSet("Group");
		let runs = 0;
		const sys = world.registerSystem(() => {
			runs++;
		});
		world.addSystems(SCHEDULE.UPDATE, {
			system: sys,
			set: Group,
			runIf: runIfResourceEq(OwnOn, true)
		});
		world.configureSet(Group, { runIf: runIfResourceEq(SetOn, true) });
		world.startup();

		const runOnce = (setOn: boolean, ownOn: boolean): number => {
			world.resources.set(SetOn, setOn);
			world.resources.set(OwnOn, ownOn);
			const before = runs;
			world.update(1 / 60);
			return runs - before;
		};

		expect(runOnce(true, true)).toBe(1); // both true → runs
		expect(runOnce(true, false)).toBe(0); // own false → skip
		expect(runOnce(false, true)).toBe(0); // set false → skip
		expect(runOnce(false, false)).toBe(0); // both false → skip
	});

	it("configure_set works regardless of order relative to add_systems", () => {
		const On = resourceKey<boolean>("On");
		const world = new ECS({ deterministic: true });
		world.resources.register(On, false);
		const Set = systemSet("LateConfigured");
		let runs = 0;
		const sys = world.registerSystem(() => {
			runs++;
		});
		// configure BEFORE the member is added — picked up at run time.
		world.configureSet(Set, { runIf: runIfResourceEq(On, true) });
		world.addSystems(SCHEDULE.UPDATE, { system: sys, set: Set });
		world.startup();

		world.update(1 / 60);
		expect(runs).toBe(0);
		world.resources.set(On, true);
		world.update(1 / 60);
		expect(runs).toBe(1);
	});
});
