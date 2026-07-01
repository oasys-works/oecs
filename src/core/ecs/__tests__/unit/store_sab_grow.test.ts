/**
 * Store SAB grow + refresh (#171 §6.1.9 Phase 3).
 *
 * Insertions that would exceed an archetype's SAB row capacity now trigger
 * a host-side `growColumnStore` + `refreshViews` dance via a handler
 * installed by `Store` on every SAB-backed `Archetype`. After the handler
 * runs, the offending push is guaranteed to fit; live rows of every other
 * archetype are carried forward and their column views are repointed at
 * the new SAB.
 *
 * These tests pin the surface — capacity doubling, view-stamp bump per
 * grow, data preservation across grow on the growing archetype AND on its
 * unaffected neighbours, and SAB-identity replacement (the realloc-and-
 * republish strategy from plan §8.4).
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { readStoreHeader, type ColumnStore } from "../../../store";
import type { EntityID } from "../../entity";

const Position = { x: "f64", y: "f64" } as const;
const Velocity = { vx: "f64", vy: "f64" } as const;

// `ColumnStore.header` is the cached snapshot captured at create-time; the
// canonical view_stamp lives in the DataView. Reading via the DataView is
// the truth (matches the convention in store_sab_shadow.test.ts).
function liveViewStamp(s: ColumnStore): number {
	return readStoreHeader(s.view).viewStamp;
}

describe("Store — SAB grow + refresh (#171 §6.1.9 Phase 3)", () => {
	it("inserting past initial capacity grows the SAB and preserves earlier rows", () => {
		const store = new Store(4);
		const Pos = store.registerComponent(Position);

		const entities: EntityID[] = [];
		for (let i = 0; i < 13; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i * 10 });
			entities.push(e);
		}

		// All 13 entities live with their original values — including the
		// first 4 written before any grow happened.
		const arch = store.getEntityArchetype(entities[0]);
		expect(arch.entityCount).toBe(13);
		const xs = arch.getColumnRead(Pos, "x");
		const ys = arch.getColumnRead(Pos, "y");
		for (let i = 0; i < 13; i++) {
			const row = store.getEntityRow(entities[i]);
			expect(xs[row]).toBe(i);
			expect(ys[row]).toBe(i * 10);
		}
	});

	it("doubles the offending archetype's row capacity (does not jump to N exactly)", () => {
		// `Store` doubles until the new capacity covers `length + additional`,
		// matching the §8.3 amortised-O(N) growth strategy. Starting from
		// initialCapacity=4 and inserting 10 entities crosses 4 → 8 → 16.
		const store = new Store(4);
		const Pos = store.registerComponent(Position);

		let firstEid: EntityID | null = null;
		for (let i = 0; i < 10; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
			if (firstEid === null) firstEid = e;
		}

		// Read row_capacity off the SAB descriptor for the [Pos] archetype.
		const posArchId = store.getEntityArchetype(firstEid!).id as unknown as number;
		const storeArch = store.columnStore.archetypes.get(posArchId);
		expect(storeArch).toBeDefined();
		expect(storeArch!.rowCapacity).toBe(16);
	});

	it("bumps view_stamp once per grow on top of the per-extend bumps", () => {
		const store = new Store(4);
		const Pos = store.registerComponent(Position);

		// Construction extends once for the empty archetype.
		// The first addComponent extends once more for the [Pos] archetype.
		// view_stamp == 2 after that.
		const e0 = store.createEntity();
		store.addComponent(e0, Pos, { x: 0, y: 0 });
		const stampAfterExtend = liveViewStamp(store.columnStore);

		// Drive past initial capacity (4) → grow to 8. +1 to view_stamp.
		for (let i = 1; i < 6; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
		}
		expect(liveViewStamp(store.columnStore)).toBe(stampAfterExtend + 1);

		// Drive past doubled capacity (8) → grow to 16. +1 more.
		for (let i = 6; i < 12; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
		}
		expect(liveViewStamp(store.columnStore)).toBe(stampAfterExtend + 2);
	});

	it("preserves OTHER archetypes' rows when one grows", () => {
		// Build two archetypes with rows: [Pos] and [Pos, Vel]. Force the
		// [Pos] archetype past capacity. The [Pos, Vel] archetype's live
		// rows must survive the realloc.
		const store = new Store(4);
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		// 3 entities in [Pos, Vel].
		const pvEntities: EntityID[] = [];
		for (let i = 0; i < 3; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: 100 + i, y: 200 + i });
			store.addComponent(e, Vel, { vx: 300 + i, vy: 400 + i });
			pvEntities.push(e);
		}

		// Now push 13 entities into [Pos] only (forces grow at 4, 8).
		const pEntities: EntityID[] = [];
		for (let i = 0; i < 13; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i * 10 });
			pEntities.push(e);
		}

		// [Pos, Vel] entities still have correct data.
		for (let i = 0; i < 3; i++) {
			const arch = store.getEntityArchetype(pvEntities[i]);
			const row = store.getEntityRow(pvEntities[i]);
			expect(arch.getColumnRead(Pos, "x")[row]).toBe(100 + i);
			expect(arch.getColumnRead(Pos, "y")[row]).toBe(200 + i);
			expect(arch.getColumnRead(Vel, "vx")[row]).toBe(300 + i);
			expect(arch.getColumnRead(Vel, "vy")[row]).toBe(400 + i);
		}

		// [Pos] entities also correct.
		for (let i = 0; i < 13; i++) {
			const arch = store.getEntityArchetype(pEntities[i]);
			const row = store.getEntityRow(pEntities[i]);
			expect(arch.getColumnRead(Pos, "x")[row]).toBe(i);
			expect(arch.getColumnRead(Pos, "y")[row]).toBe(i * 10);
		}
	});

	it("preserves the ColumnStore identity across a grow (growable in-place, #237)", () => {
		const store = new Store(4);
		const Pos = store.registerComponent(Position);

		// Seed under capacity, capture the pre-grow SAB.
		for (let i = 0; i < 3; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
		}
		const preGrowSab = store.columnStore.buffer;

		// Cross the capacity boundary.
		for (let i = 3; i < 10; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
		}

		// With the default `growableSabAllocator` (since #237 Option A),
		// the SAB is grown in place — same instance, larger byteLength.
		// The realloc-and-republish behaviour from #171 §8.4 still works
		// (it's selected by passing `DEFAULT_SAB_ALLOCATOR` explicitly) but
		// is no longer the default. The view_stamp still bumps so callers
		// see grow as observable.
		expect(store.columnStore.buffer).toBe(preGrowSab);
		expect(store.columnStore.buffer.byteLength).toBeGreaterThanOrEqual(preGrowSab.byteLength);
	});
});
