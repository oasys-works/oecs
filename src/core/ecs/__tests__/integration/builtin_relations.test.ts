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
		const exemplar = world.createEntity();
		const i1 = world.createEntity();
		const i2 = world.createEntity();
		world.addRelation(i1, IsA, exemplar);
		world.addRelation(i2, IsA, exemplar);

		expect(idx(world.sourcesOf(IsA, exemplar))).toEqual(idx([i1, i2]));
		expect(world.targetOf(i1, IsA)).toBe(exemplar);
		expect(world.hasRelation(i1, IsA)).toBe(true);
	});

	it("is exclusive — re-adding replaces the exemplar", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const e1 = world.createEntity();
		const e2 = world.createEntity();
		const inst = world.createEntity();
		world.addRelation(inst, IsA, e1);
		world.addRelation(inst, IsA, e2); // exclusive: replaces e1
		expect(world.targetOf(inst, IsA)).toBe(e2);
		expect(idx(world.sourcesOf(IsA, e1))).toEqual([]);
		expect(idx(world.sourcesOf(IsA, e2))).toEqual(idx([inst]));
	});

	it("walks the IsA chain: instance → exemplar → grand-exemplar", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const grand = world.createEntity();
		const exemplar = world.createEntity();
		const inst = world.createEntity();
		world.addRelation(exemplar, IsA, grand);
		world.addRelation(inst, IsA, exemplar);

		expect(world.ancestorsOf(inst, IsA).map(getEntityIndex)).toEqual(
			[inst, exemplar, grand].map(getEntityIndex)
		);
		expect(world.rootOf(inst, IsA)).toBe(grand);
		// cascade: down the chain, parents before children.
		expect(world.cascadeOf(grand, IsA).map(getEntityIndex)).toEqual(
			[grand, exemplar, inst].map(getEntityIndex)
		);
	});

	it("default policy ('clear'): destroying an exemplar drops the link but keeps instances", () => {
		const world = new ECS();
		const IsA = registerIsA(world); // default onDeleteTarget: "clear"
		const exemplar = world.createEntity();
		const inst = world.createEntity();
		world.addRelation(inst, IsA, exemplar);

		world.destroyEntity(exemplar);
		world.flush();
		expect(world.isAlive(inst)).toBe(true);
		expect(world.hasRelation(inst, IsA)).toBe(false);
		expect(world.targetOf(inst, IsA)).toBeUndefined();
	});

	it("'delete' override: destroying an exemplar cascade-destroys its instances", () => {
		const world = new ECS();
		const IsA = registerIsA(world, { onDeleteTarget: "delete" });
		const exemplar = world.createEntity();
		const i1 = world.createEntity();
		const i2 = world.createEntity();
		world.addRelation(i1, IsA, exemplar);
		world.addRelation(i2, IsA, exemplar);

		world.destroyEntity(exemplar);
		world.flush();
		expect(world.isAlive(exemplar)).toBe(false);
		expect(world.isAlive(i1)).toBe(false);
		expect(world.isAlive(i2)).toBe(false);
	});

	it("records the link only — NO live component inheritance", () => {
		const world = new ECS();
		const IsA = registerIsA(world);
		const Pos = world.registerComponent(["x"] as const);
		const exemplar = world.createEntity();
		const inst = world.createEntity();
		world.addComponent(exemplar, Pos, { x: 5 });
		world.addComponent(inst, Pos, { x: 1 });
		world.addRelation(inst, IsA, exemplar);

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
		const parent = world.createEntity();
		const c1 = world.createEntity();
		const c2 = world.createEntity();
		world.addRelation(c1, ChildOf, parent);
		world.addRelation(c2, ChildOf, parent);

		expect(idx(world.sourcesOf(ChildOf, parent))).toEqual(idx([c1, c2]));
		expect(world.ancestorsOf(c1, ChildOf).map(getEntityIndex)).toEqual(
			[c1, parent].map(getEntityIndex)
		);
		expect(world.targetOf(c1, ChildOf)).toBe(parent);
	});

	it("default policy ('delete'): destroying a parent cascade-destroys the subtree", () => {
		const world = new ECS();
		const ChildOf = registerChildOf(world); // default onDeleteTarget: "delete"
		const gp = world.createEntity();
		const p = world.createEntity();
		const c = world.createEntity();
		world.addRelation(p, ChildOf, gp);
		world.addRelation(c, ChildOf, p);

		world.destroyEntity(gp);
		world.flush();
		expect(world.isAlive(gp)).toBe(false);
		expect(world.isAlive(p)).toBe(false);
		expect(world.isAlive(c)).toBe(false);
	});

	it("'clear' override: children survive a parent's destruction as roots", () => {
		const world = new ECS();
		const ChildOf = registerChildOf(world, { onDeleteTarget: "clear" });
		const parent = world.createEntity();
		const child = world.createEntity();
		world.addRelation(child, ChildOf, parent);

		world.destroyEntity(parent);
		world.flush();
		expect(world.isAlive(child)).toBe(true);
		expect(world.hasRelation(child, ChildOf)).toBe(false);
		expect(world.rootOf(child, ChildOf)).toBe(child); // now its own root
	});
});
