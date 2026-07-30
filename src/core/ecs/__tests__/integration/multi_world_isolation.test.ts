/**
 * Multi-world isolation.
 *
 * Simulation state is per-`Store`, so most multi-world concern is already
 * isolated. The untested seam is the *process-global* mutable singletons that
 * every `new ECS()` shares:
 *
 *   - the dev-only `accessCheck` span (a single overwritable slot);
 *   - the dev-only `dispatchTrace` aggregator.
 *
 * These tests run N worlds with interleaved ticks and assert zero state bleed,
 * and exercise the `accessCheck` re-entrancy case (a system that ticks a
 * *second* world inside its own open access span) — the guard `ECS.update()`
 * restores at the tick boundary.
 *
 * NOTE — the two upstream cases that pinned the parallel-kernel `REGISTRY`
 * cross-world collision contract (a process-global `Map<string, fn>`
 * registered via `register_parallel_kernel`) are N/A here: oecs has no
 * `parallel/` module — the parallel kernel registry was replaced by the
 * `ComputeBackend` seam — so there is no shared kernel registry to isolate.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";

const Counter = { n: "i32" } as const;

/**
 * A deterministic world seeded so each `seed` evolves on a distinct trajectory:
 * `seed + 1` entities starting at distinct values, and an UPDATE system that
 * increments every counter once per tick. Distinct seeds ⇒ distinct
 * `stateHash` after any fixed number of ticks.
 */
function buildWorld(seed: number): { world: ECS; tick: () => void } {
	const world = new ECS({ deterministic: true });
	const C = world.registerComponent(Counter);
	for (let i = 0; i <= seed; i++) {
		const e = world.spawn();
		world.addComponent(e, C, { n: seed * 100 + i });
	}
	const sys = world.registerSystem({
		...openAccess([C]),
		name: `bump_${seed}`,
		fn(ctx) {
			const q = world.query(C);
			for (const arch of q._nonEmpty()) {
				const col = arch.getColumn(C, "n", ctx.ecsTick);
				for (let r = 0; r < arch.length; r++) col[r] = col[r] + 1;
			}
		}
	});
	world.addSystems(SCHEDULE.UPDATE, sys);
	world.startup();
	return { world, tick: () => world.update(1 / 60) };
}

describe("multi-world isolation", () => {
	// ────────────────────────────────────────────────────────────────────────
	// AC1: N interleaved worlds, zero state bleed via shared globals.
	// ────────────────────────────────────────────────────────────────────────
	describe("stateHash isolation across interleaved worlds", () => {
		const N = 4;
		const TICKS = 8;

		it("interleaved ticks match each world's solo stateHash", () => {
			// Solo baseline: build + tick each world in isolation.
			const solo: number[] = [];
			for (let w = 0; w < N; w++) {
				const { world, tick } = buildWorld(w);
				for (let t = 0; t < TICKS; t++) tick();
				solo.push(world.snapshots.stateHash());
			}
			// Distinct seeds must produce distinct trajectories, else the
			// isolation assertion below would be vacuously satisfiable.
			expect(new Set(solo).size).toBe(N);

			// Forward round-robin interleave: every world still gets exactly
			// TICKS ticks, but the calls are interleaved. A bleed through any
			// process-global would shift at least one world's hash off its solo
			// value.
			const fwd = Array.from({ length: N }, (_, w) => buildWorld(w));
			for (let t = 0; t < TICKS; t++) {
				for (let w = 0; w < N; w++) fwd[w].tick();
			}
			for (let w = 0; w < N; w++) expect(fwd[w].world.snapshots.stateHash()).toBe(solo[w]);

			// Reverse round-robin: same per-world tick count, opposite interleave
			// order. Order-independence is the isolation property under test.
			const rev = Array.from({ length: N }, (_, w) => buildWorld(w));
			for (let t = 0; t < TICKS; t++) {
				for (let w = N - 1; w >= 0; w--) rev[w].tick();
			}
			for (let w = 0; w < N; w++) expect(rev[w].world.snapshots.stateHash()).toBe(solo[w]);
		});

		it("a world ticked alongside others is unaffected by the others' churn", () => {
			// One probe world ticked once; the same world ticked once but
			// sandwiched between N-1 other worlds' ticks must land on the same
			// hash — the neighbours' activity does not leak in.
			const probeSolo = buildWorld(0);
			probeSolo.tick();
			const expected = probeSolo.world.snapshots.stateHash();

			const probe = buildWorld(0);
			const neighbours = Array.from({ length: N - 1 }, (_, w) => buildWorld(w + 1));
			for (const nb of neighbours) nb.tick();
			probe.tick();
			for (const nb of neighbours) nb.tick();

			expect(probe.world.snapshots.stateHash()).toBe(expected);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// AC3: accessCheck span survives a cross-world re-entrant tick.
	//
	// `accessCheck` keeps a SINGLE process-global span (the running system's
	// descriptor + its allowed-id sets). When world A's system — mid-span —
	// drives world B's tick, B's schedule opens and closes its own spans,
	// ending with the global slot nulled. Without a save/restore at the tick
	// boundary, A's enforcement would be silently disabled for the rest of its
	// body. `ECS.update` snapshots + restores the caller's span, the same
	// way the observer dispatch already does for nested spans, so A's span is
	// intact — and correctly ATTRIBUTED to A's system — after B's tick.
	// ────────────────────────────────────────────────────────────────────────
	describe("accessCheck survives a cross-world re-entrant tick", () => {
		it("a system that ticks a second world keeps (and is attributed) its own span", () => {
			// World B: a trivial world ticked from inside A's system.
			const worldB = new ECS();
			const PosB = worldB.registerComponent(["x", "y"] as const);
			const eB = worldB.spawn();
			worldB.addComponent(eB, PosB, { x: 0, y: 0 });
			worldB.addSystems(
				SCHEDULE.UPDATE,
				worldB.registerSystem({
					...openAccess([PosB]),
					name: "world_b_mover",
					fn(ctx) {
						ctx.ref(PosB, eB).x += 1; // declared — ok
					}
				})
			);
			worldB.startup();

			// World A: its system declares access to `Allowed` only. Mid-span it
			// ticks world B, then reads the UNDECLARED `Forbidden`. Once, that
			// read silently passed (B's tick nulled the span); now it must throw,
			// attributed to A's system.
			const worldA = new ECS();
			const Allowed = worldA.registerComponent(["v"] as const);
			const Forbidden = worldA.registerComponent(["w"] as const);
			const eA = worldA.spawn();
			worldA.addComponent(eA, Allowed, { v: 0 });
			worldA.addComponent(eA, Forbidden, { w: 0 });
			worldA.addSystems(
				SCHEDULE.UPDATE,
				worldA.registerSystem({
					...openAccess([Allowed]), // Forbidden intentionally NOT declared
					name: "world_a_reader",
					fn(ctx) {
						ctx.getField(eA, Allowed, "v"); // declared — ok
						worldB.update(1 / 60); // tick a SECOND world inside the span
						ctx.getField(eA, Forbidden, "w"); // UNDECLARED — must throw
					}
				})
			);
			worldA.startup();

			let err: unknown;
			try {
				worldA.update(1 / 60);
			} catch (e) {
				err = e;
			}

			// The undeclared read after B's tick still throws — A's span survived.
			expect(err).toBeInstanceOf(ECSError);
			// Correct attribution: the violation names A's system and Forbidden's
			// id, proving B's interleaved tick neither clobbered nor mis-attributed
			// A's span.
			expect((err as ECSError).message).toContain("world_a_reader");
			expect((err as ECSError).message).toContain(String(Forbidden.id));
			expect((err as ECSError).message).not.toContain("world_b_mover");

			// The inner tick really ran: world B advanced.
			expect(worldB.getField(eB, PosB, "x")).toBe(1);
		});

		it("a system may host-despawn in a SECOND world — the in-system despawn guard is per-world", () => {
			// World B is not mid-iteration when A's system mutates it, so B's
			// immediate host despawn is safe and must not trip the dev guard that
			// protects against `ecs.despawn` from inside the SAME world's system
			// (the accessCheck span is process-global; the guard scopes on the
			// world actually executing its schedule).
			const worldB = new ECS();
			const TagB = worldB.registerTag();
			const eB = worldB.spawn();
			worldB.addComponent(eB, TagB);

			const worldA = new ECS();
			const Allowed = worldA.registerComponent(["v"] as const);
			const eA = worldA.spawn();
			worldA.addComponent(eA, Allowed, { v: 0 });
			let inSystemErr: unknown = null;
			worldA.addSystems(
				SCHEDULE.UPDATE,
				worldA.registerSystem({
					...openAccess([Allowed]),
					name: "world_a_despawner",
					fn() {
						try {
							worldB.despawn(eB); // cross-world host despawn — legal
						} catch (e) {
							inSystemErr = e;
						}
					}
				})
			);
			worldA.startup();
			worldA.update(1 / 60);

			expect(inSystemErr).toBeNull();
			expect(worldB.isAlive(eB)).toBe(false);

			// The same-world guard still fires: despawning in A from A's system throws.
			const worldC = new ECS();
			const TagC = worldC.registerTag();
			const eC = worldC.spawn();
			worldC.addComponent(eC, TagC);
			let sameWorldErr: unknown = null;
			worldC.addSystems(
				SCHEDULE.UPDATE,
				worldC.registerSystem({
					...openAccess([]),
					name: "same_world_despawner",
					fn() {
						try {
							worldC.despawn(eC);
						} catch (e) {
							sameWorldErr = e;
						}
					}
				})
			);
			worldC.startup();
			worldC.update(1 / 60);
			expect(sameWorldErr).toBeInstanceOf(ECSError);
			expect((sameWorldErr as ECSError).message).toContain("same_world_despawner");
		});
	});
});
