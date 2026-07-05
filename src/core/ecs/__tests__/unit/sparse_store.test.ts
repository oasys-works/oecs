/**
 * Sparse storage class — out-of-identity components (#468 / ADR-0011).
 *
 * Covers the substrate slice's acceptance criteria:
 *  - CRUD (register / add / has / get / set / remove) through the public `ECS`.
 *  - The no-transition invariant: a sparse add/remove churn cycle leaves both
 *    `archetype_count` and the entity's `archetype_id` unchanged.
 *  - Sparse data stays correct under entity destroy + swap-remove of dense
 *    neighbours (data is keyed by entity index, not archetype row).
 *  - Sparse registration does not consume a bitmask identity bit
 *    (`STORE_DESCRIPTOR_COMPONENT_LIMIT` independence).
 *  - Interaction with dense add/remove on the same entity.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import { SparseComponentStore } from "../../sparse_store";
import { STORE_DESCRIPTOR_COMPONENT_LIMIT } from "../../../store/descriptor";

const Pos = { x: "f64", y: "f64" } as const;
const Hp = { hp: "f64" } as const;
const Cooldown = { ready_at: "f64", charges: "i32" } as const;

describe("SparseComponentStore (substrate)", () => {
	it("stores, reads, overwrites and removes rows keyed by index", () => {
		const store = new SparseComponentStore(["hp"], ["f64"]);
		expect(store.has(5)).toBe(false);
		expect(store.getField(5, 0)).toBeUndefined();

		store.setRow(5, { hp: 10 });
		expect(store.has(5)).toBe(true);
		expect(store.getField(5, 0)).toBe(10);
		expect(store.size).toBe(1);

		// Overwrite semantics: latest write wins.
		store.setRow(5, { hp: 99 });
		expect(store.getField(5, 0)).toBe(99);
		expect(store.size).toBe(1);

		expect(store.setField(5, 0, 42)).toBe(true);
		expect(store.getField(5, 0)).toBe(42);

		expect(store.remove(5)).toBe(true);
		expect(store.has(5)).toBe(false);
		expect(store.remove(5)).toBe(false);
	});

	it("defaults missing fields to 0 and stores a tag as an empty row", () => {
		const data = new SparseComponentStore(["ready_at", "charges"], ["f64", "i32"]);
		data.setRow(1, { ready_at: 7 }); // `charges` omitted
		expect(data.getField(1, 0)).toBe(7);
		expect(data.getField(1, 1)).toBe(0);

		const tag = new SparseComponentStore([], []);
		tag.setRow(2, {});
		expect(tag.has(2)).toBe(true);
		expect(tag.indices).toContain(2);
	});

	it("set_field on an absent index is a no-op returning false", () => {
		const store = new SparseComponentStore(["hp"], ["f64"]);
		expect(store.setField(3, 0, 5)).toBe(false);
	});
});

describe("ECS sparse component API (#468)", () => {
	it("registers and does full CRUD through the public surface", () => {
		const ecs = new ECS();
		const Health = ecs.registerSparseComponent(Hp);
		const e = ecs.spawn();

		expect(ecs.hasSparse(e, Health)).toBe(false);

		ecs.addSparse(e, Health, { hp: 50 });
		expect(ecs.hasSparse(e, Health)).toBe(true);
		expect(ecs.getSparseField(e, Health, "hp")).toBe(50);

		ecs.setSparseField(e, Health, "hp", 25);
		expect(ecs.getSparseField(e, Health, "hp")).toBe(25);

		ecs.removeSparse(e, Health);
		expect(ecs.hasSparse(e, Health)).toBe(false);
	});

	it("supports the array shorthand and multi-field schemas", () => {
		const ecs = new ECS();
		const Cd = ecs.registerSparseComponent(Cooldown);
		const Pair = ecs.registerSparseComponent(["a", "b"]); // f64 shorthand
		const e = ecs.spawn();

		ecs.addSparse(e, Cd, { ready_at: 3, charges: 2 });
		ecs.addSparse(e, Pair, { a: 1, b: 4 });

		expect(ecs.getSparseField(e, Cd, "charges")).toBe(2);
		expect(ecs.getSparseField(e, Pair, "b")).toBe(4);
	});

	it("registers a sparse tag (membership only)", () => {
		const ecs = new ECS();
		const Stunned = ecs.registerSparseTag();
		const e = ecs.spawn();

		expect(ecs.hasSparse(e, Stunned)).toBe(false);
		ecs.addSparse(e, Stunned);
		expect(ecs.hasSparse(e, Stunned)).toBe(true);
		ecs.removeSparse(e, Stunned);
		expect(ecs.hasSparse(e, Stunned)).toBe(false);
	});
});

describe("sparse no-transition invariant (#468)", () => {
	it("add/remove churn leaves archetype_count and the entity's archetype_id stable", () => {
		const store = new Store();
		const Position = store.registerComponent(Pos);
		const Health = store.registerSparseComponent(Hp);

		const e = store.createEntity();
		store.addComponent(e, Position, { x: 1, y: 2 });

		const archCountBefore = store.archetypeCount;
		const archIdBefore = store.getEntityArchetype(e).id;

		// One churn cycle, repeated — never touches the archetype graph.
		for (let i = 0; i < 5; i++) {
			store.addSparse(e, Health, { hp: i });
			expect(store.hasSparse(e, Health)).toBe(true);
			expect(store.getSparseField(e, Health, "hp")).toBe(i);
			store.removeSparse(e, Health);
			expect(store.hasSparse(e, Health)).toBe(false);
		}

		expect(store.archetypeCount).toBe(archCountBefore);
		expect(store.getEntityArchetype(e).id).toBe(archIdBefore);
	});
});

describe("sparse independence from the bitmask identity (#468)", () => {
	it("does not count against STORE_DESCRIPTOR_COMPONENT_LIMIT", () => {
		const store = new Store();

		// Saturate the dense component cap.
		for (let i = 0; i < STORE_DESCRIPTOR_COMPONENT_LIMIT; i++) {
			store.registerComponent({ ["f" + i]: "f64" });
		}
		// A 129th DENSE component must throw...
		expect(() => store.registerComponent({ overflow: "f64" })).toThrow();

		// ...but sparse components register freely past the cap, and plenty of
		// them — they live in a separate id space outside the mask.
		const e = store.createEntity();
		for (let i = 0; i < 300; i++) {
			const def = store.registerSparseComponent({ v: "f64" });
			store.addSparse(e, def, { v: i });
			expect(store.getSparseField(e, def, "v")).toBe(i);
		}
	});
});

describe("sparse correctness under destroy + dense swap-remove (#468)", () => {
	it("survives swap-remove of a dense neighbour (data keyed by index, not row)", () => {
		const store = new Store();
		const Position = store.registerComponent(Pos);
		const Health = store.registerSparseComponent(Hp);

		const a = store.createEntity();
		const b = store.createEntity();
		const c = store.createEntity();
		// Same archetype → rows 0,1,2 in one dense column.
		store.addComponent(a, Position, { x: 0, y: 0 });
		store.addComponent(b, Position, { x: 0, y: 0 });
		store.addComponent(c, Position, { x: 0, y: 0 });
		store.addSparse(a, Health, { hp: 10 });
		store.addSparse(b, Health, { hp: 20 });
		store.addSparse(c, Health, { hp: 30 });

		// Destroying b swap-removes c into b's dense row. Sparse data is keyed by
		// entity index, so a's and c's rows are undisturbed.
		store.destroyEntity(b);

		expect(store.isAlive(b)).toBe(false);
		expect(store.hasSparse(a, Health)).toBe(true);
		expect(store.getSparseField(a, Health, "hp")).toBe(10);
		expect(store.hasSparse(c, Health)).toBe(true);
		expect(store.getSparseField(c, Health, "hp")).toBe(30);
	});

	it("purges sparse data on destroy so a recycled slot starts clean (deferred)", () => {
		const store = new Store();
		const Health = store.registerSparseComponent(Hp);

		const e = store.createEntity();
		store.addSparse(e, Health, { hp: 7 });

		store.destroyEntityDeferred(e);
		store.flushDestroyed();

		// The freed index is recycled by the next createEntity.
		const reused = store.createEntity();
		expect(store.hasSparse(reused, Health)).toBe(false);
	});

	it("purges sparse data on immediate destroy too", () => {
		const store = new Store();
		const Health = store.registerSparseComponent(Hp);

		const e = store.createEntity();
		store.addSparse(e, Health, { hp: 7 });
		store.destroyEntity(e);

		const reused = store.createEntity();
		expect(store.hasSparse(reused, Health)).toBe(false);
	});
});

describe("sparse interaction with dense add/remove on the same entity (#468)", () => {
	it("sparse data survives a dense archetype transition", () => {
		const store = new Store();
		const Position = store.registerComponent(Pos);
		const Health = store.registerSparseComponent(Hp);

		const e = store.createEntity();
		store.addSparse(e, Health, { hp: 100 });

		// Adding then removing a dense component moves the entity across
		// archetypes (a row copy) — the sparse store is out of identity and
		// untouched.
		store.addComponent(e, Position, { x: 1, y: 1 });
		expect(store.getSparseField(e, Health, "hp")).toBe(100);
		store.removeComponent(e, Position);
		expect(store.getSparseField(e, Health, "hp")).toBe(100);

		// And removing the sparse component leaves the dense side alone.
		store.addComponent(e, Position, { x: 2, y: 2 });
		store.removeSparse(e, Health);
		expect(store.hasSparse(e, Health)).toBe(false);
		expect(store.hasComponent(e, Position)).toBe(true);
	});
});
