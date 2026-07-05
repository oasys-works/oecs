/**
 * Phase C of issue #213 — archetype pre-warming at world.startup().
 *
 * `ECS.startup()` walks every registered system's AND observer's `spawns` +
 * `transitions` (#768 — observers carry the same access shape) to compute the
 * archetype closure they can produce, then plants the whole set in a single
 * `extendColumnStore` call. The contract this file pins:
 *
 *   1. Every spawn becomes a live archetype by the time `startup()` returns
 *      (before any onAdded callback runs).
 *   2. Transitions are walked transitively from the spawn-seeded worklist;
 *      every reachable mask becomes a live archetype too.
 *   3. The whole closure goes through ONE `extendColumnStore` call —
 *      asserted via `columnStore.header.view_stamp`, which bumps once per
 *      extend.
 *   4. No archetype is created twice; duplicate masks across systems
 *      collapse.
 *   5. Empty closure (no spawns, no transitions) is a no-op — view_stamp
 *      doesn't move.
 *   6. Subsequent in-system `addComponent` calls hit the cached archetype
 *      path: no further view_stamp bumps.
 *
 * Closure-walk logic itself is exercised via the `_ecsInternals.computeArchetypeClosure`
 * test seam so we don't need a Store to test the BFS.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { _ecsInternals } from "../../ecs";
import { STORE_HEADER_OFFSETS } from "../../../store/header";
import { openAccess } from "../test_helpers";
import { BitSet } from "../../../../type_primitives";
import { asComponentId, makeComponentDef } from "../../component";
import type { ComponentDef, SystemDescriptor } from "../..";

function viewStamp(world: ECS): number {
	return world.columnStore.view.getUint32(STORE_HEADER_OFFSETS.view_stamp, true);
}

describe("archetype pre-warming (Phase C of issue #213)", () => {
	it("a single declared spawn becomes a live archetype before any on_added runs", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		let onAddedArchetypeCount = -1;
		world.registerSystem({
			...openAccess([Pos, Vel]),
			spawns: [[Pos, Vel]],
			onAdded: () => {
				// onAdded fires AFTER prewarm — the [Pos, Vel] archetype must
				// already exist (the empty archetype + [Pos, Vel] = 2).
				onAddedArchetypeCount = world.archetypeCount;
			},
			fn: () => {}
		});

		world.startup();

		// 1 empty + 1 prewarmed [Pos, Vel]
		expect(onAddedArchetypeCount).toBe(2);
		expect(world.archetypeCount).toBe(2);
	});

	it("the spawn-seeded worklist walks every reachable transition", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);

		world.registerSystem({
			...openAccess([A, B, C]),
			spawns: [[A]],
			transitions: [
				{ whenHas: [A], add: [B] }, // [A] → [A,B]
				{ whenHas: [B], add: [C] } // [A,B] → [A,B,C]
			],
			fn: () => {}
		});

		world.startup();

		// Expect 4 archetypes total: empty, [A], [A,B], [A,B,C].
		expect(world.archetypeCount).toBe(4);
	});

	it("transitions with `remove` shrink masks too", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		world.registerSystem({
			...openAccess([A, B]),
			spawns: [[A, B]],
			transitions: [{ whenHas: [A, B], remove: [B] }], // [A,B] → [A]
			fn: () => {}
		});

		world.startup();

		// empty + [A,B] + [A]
		expect(world.archetypeCount).toBe(3);
	});

	it("the entire closure goes through one extend_column_store (view_stamp bumps once)", () => {
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);
		const C = world.registerComponent(["v"] as const);
		const D = world.registerComponent(["v"] as const);

		// view_stamp is bumped once per extend. After the constructor (which
		// plants the empty archetype) it's already non-zero; baseline that
		// here, then assert the prewarm-driven extend bumps it by exactly 1
		// even though four distinct archetypes get planted.
		const baseline = viewStamp(world);

		world.registerSystem({
			...openAccess([A, B, C, D]),
			spawns: [
				[A, B],
				[A, C],
				[B, D]
			],
			transitions: [
				{ whenHas: [A, B], add: [D] } // [A,B] → [A,B,D]
			],
			fn: () => {}
		});

		world.startup();

		// Four new archetypes ([A,B], [A,C], [B,D], [A,B,D]) — one extend.
		expect(viewStamp(world) - baseline).toBe(1);
		// empty + 4 prewarmed
		expect(world.archetypeCount).toBe(5);
	});

	it("startup with no spawns / transitions is a no-op (view_stamp unchanged)", () => {
		const world = new ECS();
		const baseline = viewStamp(world);

		world.registerSystem({
			...openAccess([]),
			fn: () => {}
		});

		world.startup();

		expect(viewStamp(world)).toBe(baseline);
		expect(world.archetypeCount).toBe(1); // just the empty archetype
	});

	it("duplicate masks across systems collapse to a single archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		world.registerSystem({
			...openAccess([Pos, Vel]),
			spawns: [[Pos, Vel]],
			fn: () => {}
		});
		world.registerSystem({
			...openAccess([Pos, Vel]),
			spawns: [[Pos, Vel]], // same mask, declared again
			fn: () => {}
		});

		world.startup();

		// empty + [Pos, Vel] — not two copies of [Pos, Vel]
		expect(world.archetypeCount).toBe(2);
	});

	it("after startup, ctx.add_component for a prewarmed mask makes no further extends", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		world.registerSystem({
			...openAccess([Pos, Vel]),
			// Declare every archetype the entity walks through: [Pos] is
			// the intermediate after the first `addComponent`, [Pos, Vel]
			// is the final shape. ctx.commands.add is per-component, so
			// both materially exist mid-flush.
			spawns: [[Pos], [Pos, Vel]],
			fn(ctx) {
				const e = ctx.commands.spawn();
				ctx.commands.add(e, Pos, { x: 1, y: 2 });
				ctx.commands.add(e, Vel, { vx: 3, vy: 4 });
			}
		});

		world.startup();
		const afterStartup = viewStamp(world);

		// Run a few ticks — every iteration spawns an entity into one of
		// the prewarmed archetypes. No new archetypes should appear, so
		// view_stamp should be frozen.
		world.update(0);
		world.update(0);
		world.update(0);

		expect(viewStamp(world)).toBe(afterStartup);
	});

	it("a system with transitions but no spawns contributes nothing to the closure", () => {
		// The closure walk seeds from `spawns`; a transition with nothing
		// to fire on can't materialise an archetype on its own.
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		const baseline = viewStamp(world);
		world.registerSystem({
			reads: [A, B],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [{ whenHas: [A], add: [B] }],
			resourceReads: [],
			resourceWrites: [],
			fn: () => {}
		});

		world.startup();

		// No spawns ⇒ empty seed ⇒ no transitions fire ⇒ no extend.
		expect(viewStamp(world)).toBe(baseline);
		expect(world.archetypeCount).toBe(1);
	});

	it("an observer's declared spawn is prewarmed at startup, like a system's (#768)", () => {
		const world = new ECS();
		const Trigger = world.registerTag();
		const Mote = world.registerComponent(["v"] as const);

		// An observer that spawns a Mote when Trigger is added, declaring the spawn
		// in its access. Prewarm must fold the observer's `spawns` into the closure;
		// previously it walked systems only, so the [Mote] archetype first-touched
		// lazily on the first observer-spawn mid-tick. The observer need not fire —
		// prewarm acts on the declaration, exactly as it does for a system.
		world.observe(Trigger, {
			onAdd: (_e, ctx) => ctx.commands.spawn(Mote({ v: 0 })),
			access: { spawns: [[Mote]] }
		});

		world.startup();

		// empty + prewarmed [Mote]
		expect(world.archetypeCount).toBe(2);
	});

	it("an observer's transition is walked from a system's spawn seed (#768)", () => {
		// Cross-descriptor closure: a system seeds {A}, an observer transitions
		// {A} → {A,B}. The reachable {A,B} archetype must be prewarmed even though
		// no single descriptor declares it — the closure now mixes system seeds
		// with observer transitions.
		const world = new ECS();
		const A = world.registerComponent(["v"] as const);
		const B = world.registerComponent(["v"] as const);

		world.registerSystem({ ...openAccess([A]), spawns: [[A]], fn: () => {} });
		world.observe(A, {
			onAdd: (e, ctx) => ctx.commands.add(e, B, { v: 0 }),
			access: { writes: [B], transitions: [{ whenHas: [A], add: [B] }] }
		});

		world.startup();

		// empty + {A} + {A,B}
		expect(world.archetypeCount).toBe(3);
	});

	it("liberal `when_has` (subset of mask) admits the transition (design §6.6)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Owner = world.registerComponent(["owner"] as const);
		const CombatTarget = world.registerComponent(["target_id"] as const);

		world.registerSystem({
			...openAccess([Pos, Owner, CombatTarget]),
			spawns: [[Pos, Owner]],
			transitions: [
				// whenHas is a proper subset of the spawn mask. A liberal
				// over-approximation is acceptable: the closure walk just
				// over-plants, which is cheap (#213 §6.6).
				{ whenHas: [Pos], add: [CombatTarget] }
			],
			fn: () => {}
		});

		world.startup();

		// empty + [Pos, Owner] + [Pos, Owner, CombatTarget]
		expect(world.archetypeCount).toBe(3);
	});
});

describe("compute_archetype_closure (Phase C internals)", () => {
	const { computeArchetypeClosure } = _ecsInternals;

	function mkDef(id: number): ComponentDef {
		return makeComponentDef(asComponentId(id));
	}

	function maskOf(...ids: number[]): BitSet {
		const m = new BitSet();
		for (const id of ids) m.set(id);
		return m;
	}

	function asDescriptor(partial: Partial<SystemDescriptor>): SystemDescriptor {
		return {
			id: 0 as unknown as SystemDescriptor["id"],
			fn: () => {},
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			...partial
		} as SystemDescriptor;
	}

	it("returns nothing when no system declares anything", () => {
		expect(computeArchetypeClosure([])).toEqual([]);
		expect(computeArchetypeClosure([asDescriptor({})])).toEqual([]);
	});

	it("seeds from `spawns`", () => {
		const A = mkDef(0);
		const B = mkDef(1);
		const closure = computeArchetypeClosure([asDescriptor({ spawns: [[A, B]] })]);
		expect(closure).toHaveLength(1);
		expect(closure[0].equals(maskOf(0, 1))).toBe(true);
	});

	it("walks transitions to fixpoint", () => {
		const A = mkDef(0);
		const B = mkDef(1);
		const C = mkDef(2);
		const closure = computeArchetypeClosure([
			asDescriptor({
				spawns: [[A]],
				transitions: [
					{ whenHas: [A], add: [B] },
					{ whenHas: [B], add: [C] }
				]
			})
		]);
		// {A}, {A,B}, {A,B,C}
		expect(closure).toHaveLength(3);
		const got = new Set(closure.map((m) => m.hash()));
		expect(got.has(maskOf(0).hash())).toBe(true);
		expect(got.has(maskOf(0, 1).hash())).toBe(true);
		expect(got.has(maskOf(0, 1, 2).hash())).toBe(true);
	});

	it("dedups masks reached through multiple paths", () => {
		const A = mkDef(0);
		const B = mkDef(1);
		const C = mkDef(2);
		const closure = computeArchetypeClosure([
			asDescriptor({
				spawns: [[A, B]], // {A,B}
				transitions: [
					{ whenHas: [A], add: [C] }, // {A,B} -> {A,B,C}
					{ whenHas: [B], add: [C] } // also {A,B} -> {A,B,C}
				]
			})
		]);
		expect(closure).toHaveLength(2); // {A,B}, {A,B,C}
	});

	it("dedups identical spawns across systems", () => {
		const A = mkDef(0);
		const B = mkDef(1);
		const closure = computeArchetypeClosure([
			asDescriptor({ spawns: [[A, B]] }),
			asDescriptor({ spawns: [[A, B]] })
		]);
		expect(closure).toHaveLength(1);
	});

	it("a transition with `remove` shrinks the mask", () => {
		const A = mkDef(0);
		const B = mkDef(1);
		const closure = computeArchetypeClosure([
			asDescriptor({
				spawns: [[A, B]],
				transitions: [{ whenHas: [A, B], remove: [B] }]
			})
		]);
		expect(closure).toHaveLength(2); // {A,B} and {A}
	});
});
