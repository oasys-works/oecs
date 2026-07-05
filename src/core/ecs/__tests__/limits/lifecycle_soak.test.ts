/**
 * Lifecycle / duration soak — the monotonic memory-envelope axis.
 *
 * The op-count-bounded soak (`entity_scale.test.ts`, "no corruption at moderate
 * scale") already covers correctness-at-scale, and the generation-exhaustion
 * slot-retirement path (`unit/store.test.ts`, #376) covers clean recycle vs.
 * retire at a slot's boundary. Those are intentionally NOT re-covered here.
 *
 * THIS file covers the remaining axis: a duration / lifecycle-bounded churn whose
 * *cumulative* creates far exceed *peak concurrency*, asserting the allocator's
 * by-design envelope properties:
 *
 *   1. `entityCount` returns to baseline after bounded-live churn; survivors stay
 *      alive with intact data, and every dead handle stays dead.
 *   2. Total backing `byteLength` ratchets to peak concurrency and NEVER grows
 *      again — no per-cycle creep keyed to *cumulative* creates.
 *   3. `entityHighWater` stays flat under steady-state churn because freed slots
 *      recycle, and advances ONLY when a slot's generation legitimately retires
 *      (#376).
 *
 * `entityHighWater` is read through the store's entity-index region `length`
 * header — exactly the field `Store.createEntity` mirrors the private counter
 * into (`store.ts`) for the SAB/WASM reader — so the test observes the
 * production value, not a TS-side proxy.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import { getEntityIndex, MAX_LIVE_GENERATION, type EntityID } from "../../entity";
import { entityIndexLength } from "../../../store";

const Position = ["x", "y"] as const;

/** Read the slot high-water (== the private `Store.entityHighWater`) the way
 * the SAB/WASM reader does: the `length` field of the entity-index region.
 * Re-reads `columnStore` each call so a mid-soak buffer grow can't stale the
 * view. */
function highWater(store: ECS | Store): number {
	const cs = store.columnStore;
	return entityIndexLength(cs.view, cs.header.entityIndexOff);
}

describe("Lifecycle / duration soak (#782)", () => {
	it("bounded-live churn returns entityCount to baseline; survivors keep their data, dead handles stay dead", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		// A permanent baseline whose data must survive all the churn around it.
		const survivors: EntityID[] = [];
		for (let i = 0; i < 500; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i * 2 });
			survivors.push(e);
		}
		const baseline = world.entityCount;
		expect(baseline).toBe(500);

		// Churn 50 batches of 200 temporaries through full birth→death cycles.
		// Cumulative creates = 10_000, but live count never exceeds baseline + 200.
		const dead: EntityID[] = [];
		for (let cycle = 0; cycle < 50; cycle++) {
			const temps: EntityID[] = [];
			for (let i = 0; i < 200; i++) {
				const e = world.spawn();
				world.addComponent(e, Pos, { x: -1, y: -1 });
				temps.push(e);
			}
			for (const t of temps) world.despawn(t);
			world.flush();
			dead.push(...temps);
		}

		// Back to baseline exactly — no live count leaked by the churn.
		expect(world.entityCount).toBe(baseline);
		// Survivors alive with untouched data despite ~10k swap-remove relocations.
		for (let i = 0; i < survivors.length; i++) {
			expect(world.isAlive(survivors[i])).toBe(true);
			expect(world.getField(survivors[i], Pos, "x")).toBe(i);
			expect(world.getField(survivors[i], Pos, "y")).toBe(i * 2);
		}
		// Every temporary handle reads dead — recycled slots don't resurrect them.
		for (const d of dead) expect(world.isAlive(d)).toBe(false);
	});

	it("backing byteLength and high-water ratchet to peak concurrency, then never grow again under churn", () => {
		const PEAK = 1000;
		const CHURN = 500;
		const CYCLES = 30;

		const world = new ECS();
		const Pos = world.registerComponent(Position);

		// Rolling FIFO window held at exactly PEAK live entities.
		const live: EntityID[] = [];
		const spawn = (n: number): void => {
			for (let i = 0; i < n; i++) {
				const e = world.spawn();
				world.addComponent(e, Pos, { x: i, y: i });
				live.push(e);
			}
		};
		const despawn = (n: number): void => {
			for (let i = 0; i < n; i++) world.despawn(live[i]);
			live.splice(0, n);
			world.flush();
		};

		// Warm-up: reach peak concurrency AND run one full churn cycle so every
		// one-time lazy growth (column doublings, region first-touch, free-list
		// priming) happens BEFORE we lock the high-water marks.
		spawn(PEAK);
		despawn(CHURN);
		spawn(CHURN);

		const peakBytes = world.columnStore.buffer.byteLength;
		const peakHw = highWater(world);
		expect(world.entityCount).toBe(PEAK);

		// Soak: cumulative creates climb to PEAK + CYCLES*CHURN (= 16_000) while the
		// live count is pinned at PEAK. A naive cumulative-keyed allocator would
		// ratchet byteLength / high-water every cycle; recycling keeps both flat.
		for (let cycle = 0; cycle < CYCLES; cycle++) {
			despawn(CHURN);
			spawn(CHURN);
			expect(world.columnStore.buffer.byteLength).toBe(peakBytes);
			expect(highWater(world)).toBe(peakHw);
			expect(world.entityCount).toBe(PEAK);
		}
	});

	it("high-water stays flat across a slot's live generations, then advances by exactly one when the slot retires", () => {
		// Immediate-destroy Store so the slot recycles without a flush round.
		const store = new Store();

		let id = store.createEntity(); // slot 0, high-water 0 → 1
		expect(getEntityIndex(id)).toBe(0);
		expect(highWater(store)).toBe(1);

		// Cycle slot 0 through every live generation. Each destroy+recreate reuses
		// the freed index, so the high-water never moves.
		for (let g = 0; g < MAX_LIVE_GENERATION; g++) {
			store.destroyEntity(id);
			id = store.createEntity();
			expect(getEntityIndex(id)).toBe(0);
			expect(highWater(store)).toBe(1);
		}

		// Slot 0 now holds MAX_LIVE_GENERATION; the next destroy exhausts its
		// counter and RETIRES the slot (#376) instead of recycling it — so the
		// following allocation must take a fresh slot and bump the high-water.
		store.destroyEntity(id);
		const next = store.createEntity();
		expect(getEntityIndex(next)).toBe(1);
		expect(highWater(store)).toBe(2);
	});
});
