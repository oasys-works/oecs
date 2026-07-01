/**
 * Store SAB shadow (#171 §6.1.9 Phase 1).
 *
 * The Store now maintains a parallel ColumnStore alongside its heap-backed
 * archetype columns. The shadow is built incrementally — every new
 * archetype discovered via `archGetOrCreateFromMask` plants a
 * matching region in the SAB via `extendColumnStore`. Heap columns remain
 * the source of truth; the shadow is not read in Phase 1.
 *
 * These tests pin the discovery path so the upcoming Phase 2 flip to
 * `Archetype.fromColumnStore` lands on top of a shadow whose archetype
 * graph already matches the heap-side one one-for-one.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { TYPE_TAG, columnKey, readStoreHeader } from "../../../store";
import type { ColumnStore } from "../../../store";

// `ColumnStore.header` is the cached snapshot captured at create-time;
// `extendColumnStore` writes the canonical view_stamp into the DataView and
// leaves the cached header alone. Read via the DataView for the truth.
function liveViewStamp(s: ColumnStore): number {
	return readStoreHeader(s.view).viewStamp;
}

const Position = { x: "f64", y: "f64" } as const;
const Velocity = { vx: "f32", vy: "f32" } as const;
const Health = { current: "i32", max: "i32" } as const;
const Tag = {} as const;

describe("Store — SAB shadow (#171 §6.1.9 Phase 1)", () => {
	it("seeds the SAB shadow with the empty archetype at construction", () => {
		const store = new Store();
		// The constructor plants the empty (zero-component) archetype.
		expect(store.archetypeCount).toBe(1);
		expect(store.columnStore.archetypes.size).toBe(1);
		const emptyArch = store.columnStore.archetypes.get(0);
		expect(emptyArch).toBeDefined();
		expect(emptyArch!.columns.size).toBe(0);
	});

	it("mirrors Store.archetype_count after sequential single-component adds", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const a = store.createEntity();
		// Walks: empty → [Pos] → [Pos, Vel]
		store.addComponent(a, Pos, { x: 1, y: 2 });
		store.addComponent(a, Vel, { vx: 3, vy: 4 });

		expect(store.archetypeCount).toBe(3);
		expect(store.columnStore.archetypes.size).toBe(3);
		for (let i = 0; i < store.archetypeCount; i++) {
			expect(store.columnStore.archetypes.has(i)).toBe(true);
		}
	});

	it("planted columns match heap layout: count, type_tag, field_id", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position); // 2 × f64
		const Hp = store.registerComponent(Health); // 2 × i32

		const a = store.createEntity();
		store.addComponent(a, Pos, { x: 1, y: 2 });
		store.addComponent(a, Hp, { current: 10, max: 20 });

		// Final archetype carries both components: 4 columns total.
		const finalId = store.archetypeCount - 1;
		const storeArch = store.columnStore.archetypes.get(finalId);
		expect(storeArch).toBeDefined();
		expect(storeArch!.columns.size).toBe(4);

		// Per-(component_id, field_id) tags reflect the schema.
		const posX = storeArch!.columns.get(columnKey(Pos.id, 0));
		const posY = storeArch!.columns.get(columnKey(Pos.id, 1));
		const hpCur = storeArch!.columns.get(columnKey(Hp.id, 0));
		const hpMax = storeArch!.columns.get(columnKey(Hp.id, 1));
		expect(posX?.typeTag).toBe(TYPE_TAG.f64);
		expect(posY?.typeTag).toBe(TYPE_TAG.f64);
		expect(hpCur?.typeTag).toBe(TYPE_TAG.i32);
		expect(hpMax?.typeTag).toBe(TYPE_TAG.i32);
	});

	it("tag-only archetypes plant zero-column descriptors", () => {
		const store = new Store();
		const T = store.registerComponent(Tag);

		const a = store.createEntity();
		store.addComponent(a, T);

		// Two archetypes: empty + [T]. [T] has no fields → zero columns.
		expect(store.archetypeCount).toBe(2);
		expect(store.columnStore.archetypes.size).toBe(2);
		const tagArch = store.columnStore.archetypes.get(1);
		expect(tagArch).toBeDefined();
		expect(tagArch!.columns.size).toBe(0);
	});

	it("bumps view_stamp once per new archetype (cumulative)", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		// One bump for the empty archetype planted at construction
		// (extend over an empty seed store).
		expect(liveViewStamp(store.columnStore)).toBe(1);

		const a = store.createEntity();
		store.addComponent(a, Pos, { x: 1, y: 2 });
		// +1 for the [Pos] archetype.
		expect(liveViewStamp(store.columnStore)).toBe(2);

		store.addComponent(a, Vel, { vx: 3, vy: 4 });
		// +1 for the [Pos, Vel] archetype.
		expect(liveViewStamp(store.columnStore)).toBe(3);
	});

	it("does not plant duplicate archetypes when the same mask is discovered twice", () => {
		const store = new Store();
		const Pos = store.registerComponent(Position);

		const a = store.createEntity();
		const b = store.createEntity();
		store.addComponent(a, Pos, { x: 1, y: 2 });
		const stampAfterFirst = liveViewStamp(store.columnStore);

		// Reusing the same archetype mask must not extend the SAB —
		// the heap-side dedup at arch_map.get(hash) short-circuits before
		// the extend call.
		store.addComponent(b, Pos, { x: 5, y: 6 });
		expect(store.archetypeCount).toBe(2);
		expect(store.columnStore.archetypes.size).toBe(2);
		expect(liveViewStamp(store.columnStore)).toBe(stampAfterFirst);
	});

	it("records the BitSet's first 64 bits in the SAB component_mask", () => {
		const store = new Store();
		// Pos = component 0, Vel = component 1.
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		const a = store.createEntity();
		store.addComponent(a, Pos, { x: 1, y: 2 });
		store.addComponent(a, Vel, { vx: 3, vy: 4 });

		const finalId = store.archetypeCount - 1;
		const storeArch = store.columnStore.archetypes.get(finalId)!;
		expect(storeArch.componentMask[0]).toBe(
			(1 << Pos.id) | (1 << Vel.id)
		);
		expect(storeArch.componentMask[1]).toBe(0);
		expect(storeArch.componentMask[2]).toBe(0);
		expect(storeArch.componentMask[3]).toBe(0);
	});
});
