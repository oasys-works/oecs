import { describe, expect, it } from "vitest";
import { Schedule, SCHEDULE, systemSet } from "../../schedule";
import { SystemContext } from "../../query";
import { Store } from "../../store";
import {
	asSystemId,
	type SystemConfig,
	type SystemDescriptor,
	type SystemFn
} from "../../system";

const noop: SystemFn = () => {};

function makeCtx(): SystemContext {
	return new SystemContext(new Store());
}

let _scheduleUnitNextId = 0;
function makeSystem(overrides?: Partial<SystemConfig>): SystemDescriptor {
	return Object.freeze({
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		id: asSystemId(_scheduleUnitNextId++),
		fn: overrides?.fn ?? noop,
		onAdded: overrides?.onAdded,
		onRemoved: overrides?.onRemoved,
		dispose: overrides?.dispose
	});
}

describe("Schedule", () => {
	//=========================================================
	// Basic add/has/remove
	//=========================================================

	it("add_systems and has_system", () => {
		const schedule = new Schedule();
		const sys = makeSystem();

		expect(schedule.hasSystem(sys)).toBe(false);

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		expect(schedule.hasSystem(sys)).toBe(true);
	});

	it("remove_system removes from schedule", () => {
		const schedule = new Schedule();
		const sys = makeSystem();

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		schedule.removeSystem(sys);

		expect(schedule.hasSystem(sys)).toBe(false);
	});

	it("remove_system is a no-op for unscheduled system", () => {
		const schedule = new Schedule();
		const sys = makeSystem();

		expect(() => schedule.removeSystem(sys)).not.toThrow();
	});

	it("get_all_systems returns all scheduled systems", () => {
		const schedule = new Schedule();
		const a = makeSystem();
		const b = makeSystem();
		const c = makeSystem();

		schedule.addSystems(SCHEDULE.STARTUP, a);
		schedule.addSystems(SCHEDULE.UPDATE, b, c);

		const all = schedule.getAllSystems();
		expect(all).toContain(a);
		expect(all).toContain(b);
		expect(all).toContain(c);
		expect(all.length).toBe(3);
	});

	it("clear removes all systems", () => {
		const schedule = new Schedule();
		const a = makeSystem();
		const b = makeSystem();

		schedule.addSystems(SCHEDULE.UPDATE, a, b);
		schedule.clear();

		expect(schedule.hasSystem(a)).toBe(false);
		expect(schedule.hasSystem(b)).toBe(false);
		expect(schedule.getAllSystems().length).toBe(0);
	});

	//=========================================================
	// Duplicate detection
	//=========================================================

	it("throws on duplicate system", () => {
		const schedule = new Schedule();
		const sys = makeSystem();

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		expect(() => schedule.addSystems(SCHEDULE.UPDATE, sys)).toThrow();
	});

	//=========================================================
	// hasFixedSystems
	//=========================================================

	it("has_fixed_systems returns false when no systems registered", () => {
		const schedule = new Schedule();
		expect(schedule.hasFixedSystems()).toBe(false);
	});

	it("has_fixed_systems returns true after adding a system", () => {
		const schedule = new Schedule();
		const sys = makeSystem();
		schedule.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		expect(schedule.hasFixedSystems()).toBe(true);
	});

	it("has_fixed_systems returns false after removing the only system", () => {
		const schedule = new Schedule();
		const sys = makeSystem();
		schedule.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		schedule.removeSystem(sys);
		expect(schedule.hasFixedSystems()).toBe(false);
	});

	//=========================================================
	// Empty phases
	//=========================================================

	it("running empty phases does not throw", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		expect(() => schedule.runStartup(ctx, 0)).not.toThrow();
		expect(() => schedule.runUpdate(ctx, 0.016, 0)).not.toThrow();
	});

	//=========================================================
	// systemLastRun slot recycling
	//=========================================================

	it("does not recycle a lastRun slot into a system added mid-phase", () => {
		// `runLabel` hoists its plan's `slots` into a local, so a system removed
		// from inside the phase still runs (the snapshot holds it) and still writes
		// `systemLastRun[itsSlot] = tick` on the way out. If `removeSystem`'s freed
		// slot were handed straight to a system added in the same phase, that tail
		// write would land on the new system's last-run tick and silently shift its
		// `changed()` window — cross-talk the `Map` this array replaced could not
		// produce. Reachable from an observer or a teardown helper that removes and
		// re-adds systems mid-phase (e.g. `uninstallHostCommandSeam`).
		const schedule = new Schedule();
		const ctx = makeCtx();
		const seen: number[] = [];

		// `late` is added during the phase, so it first runs on the NEXT tick.
		const late = makeSystem({ fn: () => seen.push(ctx.lastRunTick) });
		// `victim` is removed during the phase but still runs from the snapshot,
		// after the remover — its tail write is the hazard.
		const victim = makeSystem();
		let swapped = false;
		const remover = makeSystem({
			fn: () => {
				if (swapped) return;
				swapped = true;
				schedule.removeSystem(victim);
				schedule.addSystems(SCHEDULE.UPDATE, late);
			}
		});

		// Insertion order is the tiebreak, so the phase runs remover then victim.
		schedule.addSystems(SCHEDULE.UPDATE, remover, victim);

		schedule.runUpdate(ctx, 0.016, 7);
		// `late` was not in the plan this phase captured.
		expect(seen).toEqual([]);
		expect(schedule.hasSystem(victim)).toBe(false);
		expect(schedule.hasSystem(late)).toBe(true);

		// First run of `late`: a freshly added system's window starts at tick 0, not
		// at 7 — which is what `victim`'s tail write left in the slot it freed.
		schedule.runUpdate(ctx, 0.016, 8);
		expect(seen).toEqual([0]);

		// And on the run after that it sees its own previous tick, so the fresh slot
		// is a real slot and not a hole that reads 0 forever.
		schedule.runUpdate(ctx, 0.016, 9);
		expect(seen).toEqual([0, 8]);
	});

	it("a slot reused outside a phase starts the new system at tick 0", () => {
		// The guard above is scoped to the running-phase window only; between phases
		// reuse proceeds, and a reused slot must be zeroed so the incoming system
		// does not inherit the outgoing one's last-run tick.
		const schedule = new Schedule();
		const ctx = makeCtx();
		const seen: number[] = [];
		const sys = makeSystem({ fn: () => seen.push(ctx.lastRunTick) });

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		schedule.runUpdate(ctx, 0.016, 3);
		schedule.runUpdate(ctx, 0.016, 4);
		expect(seen).toEqual([0, 3]);

		// Remove and re-add between phases: the slot comes back off the free list,
		// so the window restarts at 0 rather than resuming from 4.
		schedule.removeSystem(sys);
		schedule.addSystems(SCHEDULE.UPDATE, sys);
		schedule.runUpdate(ctx, 0.016, 5);
		expect(seen).toEqual([0, 3, 0]);
	});
});

describe("Schedule — system sets", () => {
	// Build a system that records `label` into `order` when it runs.
	function recorder(order: string[], label: string): SystemDescriptor {
		return makeSystem({ fn: () => order.push(label) });
	}

	//=========================================================
	// Set ordering expands to per-member edges
	//=========================================================

	it("configure_set before: every member of A runs before every member of B", () => {
		const schedule = new Schedule();
		const order: string[] = [];
		const A = systemSet("A");
		const B = systemSet("B");
		const a1 = recorder(order, "a1");
		const a2 = recorder(order, "a2");
		const b1 = recorder(order, "b1");
		const b2 = recorder(order, "b2");

		// Interleave insertion so the result is driven by set ordering, not the
		// insertion-order tiebreak (which alone would give b1, a1, b2, a2).
		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: b1, set: B },
			{ system: a1, set: A },
			{ system: b2, set: B },
			{ system: a2, set: A }
		);
		schedule.configureSet(A, { before: [B] });

		schedule.runUpdate(makeCtx(), 0.016, 0);

		const idx = (l: string) => order.indexOf(l);
		expect(order.length).toBe(4);
		expect(Math.max(idx("a1"), idx("a2"))).toBeLessThan(Math.min(idx("b1"), idx("b2")));
	});

	it("configure_set after: B-after-A is equivalent to A-before-B", () => {
		const schedule = new Schedule();
		const order: string[] = [];
		const A = systemSet("A");
		const B = systemSet("B");
		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: recorder(order, "b1"), set: B },
			{ system: recorder(order, "a1"), set: A },
			{ system: recorder(order, "b2"), set: B },
			{ system: recorder(order, "a2"), set: A }
		);
		schedule.configureSet(B, { after: [A] });

		schedule.runUpdate(makeCtx(), 0.016, 0);

		const idx = (l: string) => order.indexOf(l);
		expect(Math.max(idx("a1"), idx("a2"))).toBeLessThan(Math.min(idx("b1"), idx("b2")));
	});

	it("a set can be ordered relative to a concrete system", () => {
		const schedule = new Schedule();
		const order: string[] = [];
		const Group = systemSet("Group");
		const anchor = recorder(order, "anchor");
		const g1 = recorder(order, "g1");
		const g2 = recorder(order, "g2");

		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: g1, set: Group },
			{ system: g2, set: Group },
			anchor
		);
		schedule.configureSet(Group, { after: [anchor] });

		schedule.runUpdate(makeCtx(), 0.016, 0);
		const idx = (l: string) => order.indexOf(l);
		expect(idx("anchor")).toBeLessThan(idx("g1"));
		expect(idx("anchor")).toBeLessThan(idx("g2"));
	});

	it("a self-referential single-member set is a no-op, not a cycle", () => {
		const schedule = new Schedule();
		const order: string[] = [];
		const Solo = systemSet("Solo");
		schedule.addSystems(SCHEDULE.UPDATE, { system: recorder(order, "solo"), set: Solo });
		// "every member before every member" — self-edges are skipped, so with one
		// member this introduces no edge and must not be flagged as a cycle.
		schedule.configureSet(Solo, { before: [Solo] });

		expect(() => schedule.runUpdate(makeCtx(), 0.016, 0)).not.toThrow();
		expect(order).toEqual(["solo"]);
	});

	it("configure_set after add_systems invalidates the sort cache", () => {
		const schedule = new Schedule();
		const A = systemSet("A");
		const B = systemSet("B");
		const order1: string[] = [];
		const first = makeSystem({ fn: () => order1.push("a") });
		const second = makeSystem({ fn: () => order1.push("b") });
		schedule.addSystems(SCHEDULE.UPDATE, { system: second, set: B }, { system: first, set: A });

		// First run builds + caches the sort (insertion tiebreak → b, a).
		schedule.runUpdate(makeCtx(), 0.016, 0);
		expect(order1).toEqual(["b", "a"]);

		// Configuring ordering must invalidate the cache so the next run re-sorts.
		schedule.configureSet(A, { before: [B] });
		order1.length = 0;
		schedule.runUpdate(makeCtx(), 0.016, 0);
		expect(order1).toEqual(["a", "b"]);
	});

	it("set membership without a configured condition still runs every member", () => {
		const schedule = new Schedule();
		const order: string[] = [];
		const Group = systemSet("Group");
		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: recorder(order, "x"), set: Group },
			{ system: recorder(order, "y"), set: Group }
		);
		schedule.runUpdate(makeCtx(), 0.016, 0);
		expect(order.sort()).toEqual(["x", "y"]);
	});
});
