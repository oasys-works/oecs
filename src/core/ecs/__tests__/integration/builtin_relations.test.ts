/**
 * Built-in relations — `registerIsA` / `registerChildOf` (#477 / #463).
 *
 * Thin presets over `registerRelation`; these tests prove the IsA/ChildOf
 * acceptance criteria ride the generic relation surface:
 *  - instance-of / parent queries (`sourcesOf` / `targetOf`);
 *  - IsA-chain + hierarchy traversal (`ancestorsOf` / `rootOf` / `cascadeOf`);
 *  - teardown via the default + overridden `onDeleteTarget` policy;
 *  - exclusivity (one direct exemplar / parent);
 *  - NO live component inheritance (IsA records the link only).
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { registerChildOf, registerIsA } from "../../builtin_relations";
import { getEntityIndex, type EntityID } from "../../entity";

const idx = (es: EntityID[]): number[] => es.map(getEntityIndex).sort((a, b) => a - b);

describe("register_is_a", () => {
	it("instance-of query: sources_of lists all instances of an exemplar", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const exemplar = world.spawn();
		const i1 = world.spawn();
		const i2 = world.spawn();
		world.relations.add(i1, IsA, exemplar);
		world.relations.add(i2, IsA, exemplar);

		expect(idx(world.relations.sourcesOf(exemplar, IsA))).toEqual(idx([i1, i2]));
		expect(world.relations.targetOf(i1, IsA)).toBe(exemplar);
		expect(world.relations.has(i1, IsA)).toBe(true);
	});

	it("is exclusive — re-adding replaces the exemplar", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const e1 = world.spawn();
		const e2 = world.spawn();
		const inst = world.spawn();
		world.relations.add(inst, IsA, e1);
		world.relations.add(inst, IsA, e2); // exclusive: replaces e1
		expect(world.relations.targetOf(inst, IsA)).toBe(e2);
		expect(idx(world.relations.sourcesOf(e1, IsA))).toEqual([]);
		expect(idx(world.relations.sourcesOf(e2, IsA))).toEqual(idx([inst]));
	});

	it("walks the IsA chain: instance → exemplar → grand-exemplar", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const grand = world.spawn();
		const exemplar = world.spawn();
		const inst = world.spawn();
		world.relations.add(exemplar, IsA, grand);
		world.relations.add(inst, IsA, exemplar);

		expect(world.relations.ancestorsOf(inst, IsA).map(getEntityIndex)).toEqual(
			[inst, exemplar, grand].map(getEntityIndex)
		);
		expect(world.relations.rootOf(inst, IsA)).toBe(grand);
		// cascade: down the chain, parents before children.
		expect(world.relations.cascadeOf(grand, IsA).map(getEntityIndex)).toEqual(
			[grand, exemplar, inst].map(getEntityIndex)
		);
	});

	it("default policy ('clear'): destroying an exemplar drops the link but keeps instances", () => {
		const world = new ECS();
		const IsA = registerIsA(world); // default onDeleteTarget: "clear"
		const exemplar = world.spawn();
		const inst = world.spawn();
		world.relations.add(inst, IsA, exemplar);

		world.despawn(exemplar);
		world.flush();
		expect(world.isAlive(inst)).toBe(true);
		expect(world.relations.has(inst, IsA)).toBe(false);
		expect(world.relations.targetOf(inst, IsA)).toBeUndefined();
	});

	it("'delete' override: destroying an exemplar cascade-destroys its instances", () => {
		const world = new ECS();
		const IsA = registerIsA(world, { onDeleteTarget: "delete" });
		const exemplar = world.spawn();
		const i1 = world.spawn();
		const i2 = world.spawn();
		world.relations.add(i1, IsA, exemplar);
		world.relations.add(i2, IsA, exemplar);

		world.despawn(exemplar);
		world.flush();
		expect(world.isAlive(exemplar)).toBe(false);
		expect(world.isAlive(i1)).toBe(false);
		expect(world.isAlive(i2)).toBe(false);
	});

	it("records the link only — NO live component inheritance", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const Pos = world.registerComponent(["x"] as const);
		const exemplar = world.spawn();
		const inst = world.spawn();
		world.addComponent(exemplar, Pos, { x: 5 });
		world.addComponent(inst, Pos, { x: 1 });
		world.relations.add(inst, IsA, exemplar);

		// The instance keeps its OWN value; nothing is inherited/shared.
		expect(world.getField(inst, Pos, "x")).toBe(1);
		world.setField(exemplar, Pos, "x", 99);
		expect(world.getField(inst, Pos, "x")).toBe(1); // exemplar's change does not leak in
	});
});

describe("register_child_of", () => {
	it("parent → children query and up-chain traversal", () => {
		const world = new ECS();
		const ChildOf = registerChildOf(world);
		const parent = world.spawn();
		const c1 = world.spawn();
		const c2 = world.spawn();
		world.relations.add(c1, ChildOf, parent);
		world.relations.add(c2, ChildOf, parent);

		expect(idx(world.relations.sourcesOf(parent, ChildOf))).toEqual(idx([c1, c2]));
		expect(world.relations.ancestorsOf(c1, ChildOf).map(getEntityIndex)).toEqual(
			[c1, parent].map(getEntityIndex)
		);
		expect(world.relations.targetOf(c1, ChildOf)).toBe(parent);
	});

	it("default policy ('delete'): destroying a parent cascade-destroys the subtree", () => {
		const world = new ECS();
		const ChildOf = registerChildOf(world); // default onDeleteTarget: "delete"
		const gp = world.spawn();
		const p = world.spawn();
		const c = world.spawn();
		world.relations.add(p, ChildOf, gp);
		world.relations.add(c, ChildOf, p);

		world.despawn(gp);
		world.flush();
		expect(world.isAlive(gp)).toBe(false);
		expect(world.isAlive(p)).toBe(false);
		expect(world.isAlive(c)).toBe(false);
	});

	it("'clear' override: children survive a parent's destruction as roots", () => {
		const world = new ECS();
		const ChildOf = registerChildOf(world, { onDeleteTarget: "clear" });
		const parent = world.spawn();
		const child = world.spawn();
		world.relations.add(child, ChildOf, parent);

		world.despawn(parent);
		world.flush();
		expect(world.isAlive(child)).toBe(true);
		expect(world.relations.has(child, ChildOf)).toBe(false);
		expect(world.relations.rootOf(child, ChildOf)).toBe(child); // now its own root
	});
});
