/**
 * Row-plane invariants (`_bufs` / `_eids` / `_rowCap` / `_colCap`).
 *
 * The Archetype caches its columns' raw backing views and their joint capacity
 * so an append is one compare and a direct `bufs[i][row]` store, instead of a
 * `ColumnBacking.push` per column per row. `_syncRowPlane` is the sole writer of
 * that cache, and the two hazards it has to cover are pinned here:
 *
 *  1. **A grow that THROWS still has to leave the plane consistent.** The
 *     entity-id array reallocates before the column grow is attempted, so from
 *     that instant the cached `_eids` addresses an orphaned buffer. A SAB-cap
 *     grow throwing out of `growHandler` is a state the world is meant to
 *     survive — it is the whole basis of the fail-closed `Store.spawn` /
 *     `spawnMany` contract — so the re-sync must happen on that path too.
 *
 *  2. **A shortfall in the entity-id term alone must not reach `growHandler`.**
 *     `_rowCap` is the min of the entity-id capacity and the columns', but the
 *     grow *decision* belongs to the column term: asking the store to grow when
 *     the columns already fit computes `newCapacity === oldCapacity`, finds
 *     nothing to resize, and still falls through to a full snapshot → create →
 *     restore of the whole column store plus a `refreshViews` on every
 *     archetype. Reachable both from a tag-only archetype (no columns at all)
 *     and from the capacity skew `restoreHostRows` leaves behind when it
 *     grows the entity-id array to the restored row COUNT, not the capacity.
 *
 * These drive `Archetype` directly with the heap column factory (as
 * `archetype.test.ts` does) because that is the only way to force the two
 * capacities apart and to install a `growHandler` that fails on demand.
 */

import { describe, expect, it } from "vitest";
import {
	Archetype,
	asArchetypeId,
	type ArchetypeColumnLayout,
	type ColumnFactory
} from "../../archetype";
import { asComponentId } from "../../component";
import { createEntityId } from "../../entity";
import { BitSet, TypedArrayFor } from "../../../../type_primitives";

function makeHeapFactory(initialCapacity: number): ColumnFactory {
	return (_cid, _fidx, tag) => new TypedArrayFor[tag](initialCapacity);
}

const archId = (n: number) => asArchetypeId(n);
const compId = (n: number) => asComponentId(n);
const entity = (index: number) => createEntityId(index, 0);

function makeMask(...ids: number[]): BitSet {
	const mask = new BitSet();
	for (const id of ids) mask.set(id);
	return mask;
}

const V_LAYOUT: ArchetypeColumnLayout = {
	componentId: compId(1),
	fieldNames: ["v"],
	fieldIndex: { v: 0 },
	fieldTypes: ["f64"]
};

/** `eidCapacity` seeds the entity-id array, `colCapacity` every column — the
 * two terms of `_rowCap`, deliberately settable apart. */
function makeArchetype(eidCapacity: number, colCapacity: number): Archetype {
	return new Archetype(
		archId(0),
		makeMask(1),
		[V_LAYOUT],
		eidCapacity,
		makeHeapFactory(colCapacity)
	);
}

function append(a: Archetype, id: number, value: number): void {
	const row = a.addEntity(entity(id));
	a.writeFields(row, compId(1), { v: value }, 1);
}

describe("Archetype row plane", () => {
	//=========================================================
	// 1. Throwing grow
	//=========================================================

	it("keeps the row plane usable after growHandler throws", () => {
		// Both terms short (4 and 4), so row 5 is genuinely owed a COLUMN grow and
		// the request reaches `growHandler`.
		const a = makeArchetype(4, 4);
		for (let i = 0; i < 3; i++) append(a, 10 + i, 100 + i);

		// Stand in for the SAB allocator refusing the grow at its cap.
		a.growHandler = () => {
			throw new Error("store cap exceeded");
		};
		expect(() => a.ensureRowCapacity(2)).toThrow("store cap exceeded");

		// Fail-closed: the reserve is all-or-nothing, so nothing was appended and
		// the existing rows still read back.
		expect([...a.entityList]).toEqual([10, 11, 12]);

		// The entity-id array DID reallocate before the throw (4 → 8). The plane
		// must now address that new buffer, so this append lands where the next
		// sync will look for it — not in the orphaned pre-grow one.
		append(a, 13, 103);
		expect([...a.entityList]).toEqual([10, 11, 12, 13]);

		// Force the next `_syncRowPlane`, which is where a plane left stale by the
		// throw surfaces: it swaps in the buffer `ensureCapacity` allocated, and
		// row 13 — written to the orphan — comes back as 0.
		a.growHandler = null;
		append(a, 14, 104);
		expect([...a.entityList]).toEqual([10, 11, 12, 13, 14]);
		for (let i = 0; i < 5; i++) {
			expect(a.readField(i, compId(1), "v")).toBe(100 + i);
		}
	});

	it("keeps the row plane usable after a heap column grow throws", () => {
		// Same hazard on the `growHandler === null` branch: a column whose
		// `ensureCapacity` throws (an allocation failure) after the entity-id array
		// has already moved.
		const a = makeArchetype(4, 4);
		for (let i = 0; i < 3; i++) append(a, 10 + i, 100 + i);

		const col = a._flatColumns[0];
		const realEnsure = col.ensureCapacity.bind(col);
		col.ensureCapacity = () => {
			throw new Error("column allocation failed");
		};
		expect(() => a.ensureRowCapacity(2)).toThrow("column allocation failed");

		col.ensureCapacity = realEnsure;
		append(a, 13, 103);
		append(a, 14, 104);
		expect([...a.entityList]).toEqual([10, 11, 12, 13, 14]);
		for (let i = 0; i < 5; i++) {
			expect(a.readField(i, compId(1), "v")).toBe(100 + i);
		}
	});

	//=========================================================
	// 2. Which capacity term owns the grow decision
	//=========================================================

	it("an entity-id-only shortfall never asks the store to grow", () => {
		// The skew `restoreHostRows` leaves: entity-id capacity 4 against columns
		// of 64.
		const a = makeArchetype(4, 64);
		let growCalls = 0;
		a.growHandler = () => {
			growCalls++;
		};

		for (let i = 0; i < 10; i++) append(a, i, i * 10);

		// Ten rows crossed the entity-id capacity twice (4 → 8 → 16) and the
		// columns' 64 never — so no column-store realloc was owed, and none was
		// requested.
		expect(growCalls).toBe(0);
		expect([...a.entityList]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		for (let i = 0; i < 10; i++) {
			expect(a.readField(i, compId(1), "v")).toBe(i * 10);
		}
	});

	it("a tag-only archetype grows its entity ids without asking the store", () => {
		// No columns at all — the always-true case of the same guard.
		const a = new Archetype(archId(0), makeMask(1), [], 4);
		let growCalls = 0;
		a.growHandler = () => {
			growCalls++;
		};

		for (let i = 0; i < 10; i++) a.addEntity(entity(i));

		expect(growCalls).toBe(0);
		expect([...a.entityList]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("a column shortfall does reach growHandler", () => {
		// The guard must not over-suppress: with the entity-id array roomy (64) and
		// the columns at 4, row 5 IS owed a column grow.
		const a = makeArchetype(64, 4);
		let growCalls = 0;
		// Deliberately delivers no capacity, standing in for a grow that silently
		// failed. Every append writes through the cached plane without bounds
		// checks, so the reserve's own post-condition has to catch it.
		a.growHandler = () => {
			growCalls++;
		};

		for (let i = 0; i < 4; i++) append(a, i, i);
		expect(() => a.addEntity(entity(4))).toThrow(
			/left capacity 4 below the required 5/
		);
		expect(growCalls).toBe(1);
	});
});
