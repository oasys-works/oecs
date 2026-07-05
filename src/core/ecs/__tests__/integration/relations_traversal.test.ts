/**
 * Relations — traversal over an exclusive relation's tree (#474 / ADR-0011).
 *
 * Covers the issue's acceptance criteria:
 *  - `ancestorsOf` / `rootOf`: walk an exclusive relation from a source up to
 *    its chain root (a multi-level parent chain);
 *  - `cascadeOf`: breadth-first subtree walk that visits parents before
 *    children, deterministically (children ascending by id);
 *  - the cycle guard: a cycle in a traversable relation throws `RELATION_CYCLE`
 *    in `__DEV__` rather than hanging;
 *  - traversal is exclusive-only: a multi relation throws `RELATION_MODE_MISMATCH`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { RelationDef } from "../../relation";
import { getEntityIndex, type EntityID } from "../../entity";

const ids = (es: EntityID[]): number[] => es.map((e) => e as number);
const getIndex = (e: EntityID): number => getEntityIndex(e);

describe("ECS relation traversal — up chain (#474)", () => {
	it("walks a multi-level chain from a source to its root", () => {
		const world = new ECS();
		const ChildOf = world.relations.register(); // exclusive
		const root = world.createEntity();
		const mid = world.createEntity();
		const leaf = world.createEntity();

		// leaf -> mid -> root
		world.relations.add(leaf, ChildOf, mid);
		world.relations.add(mid, ChildOf, root);

		expect(ids(world.relations.ancestorsOf(leaf, ChildOf))).toEqual(ids([leaf, mid, root]));
		expect(ids(world.relations.ancestorsOf(mid, ChildOf))).toEqual(ids([mid, root]));
		expect(world.relations.rootOf(leaf, ChildOf)).toBe(root);
		expect(world.relations.rootOf(mid, ChildOf)).toBe(root);
	});

	it("returns a lone source as its own chain and root", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		const solo = world.createEntity();

		expect(ids(world.relations.ancestorsOf(solo, ChildOf))).toEqual(ids([solo]));
		expect(world.relations.rootOf(solo, ChildOf)).toBe(solo);
	});

	it("re-targeting moves the chain root", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		const a = world.createEntity();
		const b = world.createEntity();
		const c = world.createEntity();

		world.relations.add(a, ChildOf, b);
		expect(world.relations.rootOf(a, ChildOf)).toBe(b);

		// Exclusive: re-targeting a's parent to c replaces b.
		world.relations.add(a, ChildOf, c);
		expect(ids(world.relations.ancestorsOf(a, ChildOf))).toEqual(ids([a, c]));
		expect(world.relations.rootOf(a, ChildOf)).toBe(c);
	});

	it("up-walk stops at a dangling dead handle, not the recycled slot's occupant", () => {
		// Regression (review #493, rank 1): the up-walk advanced by entity INDEX
		// via the index-keyed sparse store, so a dangling target handle (orphan
		// policy) whose slot was recycled would splice the chain onto the
		// unrelated new occupant. It must terminate at the dead handle instead.
		const world = new ECS();
		const ChildOf = world.relations.register(); // exclusive, orphan default
		const root = world.createEntity(); // index 0
		const mid = world.createEntity(); // index 1
		const leaf = world.createEntity(); // index 2
		world.relations.add(leaf, ChildOf, mid);
		world.relations.add(mid, ChildOf, root);

		// Destroy mid; orphan policy leaves leaf pointing at the dead handle.
		world.destroyEntity(mid);
		world.flush();
		expect(world.isAlive(mid)).toBe(false);

		// Recycle mid's slot (index 1, fresh generation) into an unrelated entity
		// that has its OWN parent — the trigger for the old splice bug.
		const recycled = world.createEntity();
		const other = world.createEntity();
		world.relations.add(recycled, ChildOf, other);
		expect(getIndex(recycled)).toBe(getIndex(mid)); // same slot, recycled

		// The chain ends at the dangling dead handle (== mid), never reaching the
		// recycled occupant or its parent.
		const chain = world.relations.ancestorsOf(leaf, ChildOf);
		expect(chain[0]).toBe(leaf);
		expect(chain).toHaveLength(2);
		expect(chain[1]).toBe(mid);
		expect(world.isAlive(chain[1])).toBe(false);
		expect(ids(chain)).not.toContain(recycled as number);
		expect(ids(chain)).not.toContain(other as number);
		// rootOf returns the dangling handle (caller detects via isAlive),
		// not the unrelated recycled entity.
		expect(world.relations.rootOf(leaf, ChildOf)).toBe(mid);
		expect(world.isAlive(world.relations.rootOf(leaf, ChildOf))).toBe(false);
	});
});

describe("ECS relation traversal — cascade (#474)", () => {
	it("visits parents before children, breadth-first", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		// Tree:        root
		//             /    \
		//           c0      c1
		//          /  \
		//        g0    g1
		const root = world.createEntity();
		const c0 = world.createEntity();
		const c1 = world.createEntity();
		const g0 = world.createEntity();
		const g1 = world.createEntity();

		world.relations.add(c0, ChildOf, root);
		world.relations.add(c1, ChildOf, root);
		world.relations.add(g0, ChildOf, c0);
		world.relations.add(g1, ChildOf, c0);

		const order = world.relations.cascadeOf(root, ChildOf);
		// root first, then its children (ascending id), then grandchildren.
		expect(ids(order)).toEqual(ids([root, c0, c1, g0, g1]));

		// Every node appears after its parent.
		const pos = new Map(ids(order).map((id, i) => [id, i]));
		for (const child of [c0, c1, g0, g1]) {
			const parent = world.relations.targetOf(child, ChildOf)!;
			expect(pos.get(child as number)!).toBeGreaterThan(pos.get(parent as number)!);
		}
	});

	it("a leaf cascades to just itself", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		const leaf = world.createEntity();
		expect(ids(world.relations.cascadeOf(leaf, ChildOf))).toEqual(ids([leaf]));
	});
});

describe("ECS relation traversal — cycle guard (#474)", () => {
	it("throws RELATION_CYCLE on an up-walk through a cycle (no hang)", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		const a = world.createEntity();
		const b = world.createEntity();
		const c = world.createEntity();

		// a -> b -> c -> a  (a malformed, cyclic chain)
		world.relations.add(a, ChildOf, b);
		world.relations.add(b, ChildOf, c);
		world.relations.add(c, ChildOf, a);

		expect(() => world.relations.ancestorsOf(a, ChildOf)).toThrow(/cycle/i);
		expect(() => world.relations.rootOf(b, ChildOf)).toThrow(/cycle/i);
	});

	it("throws RELATION_CYCLE on a cascade through a cycle (no hang)", () => {
		const world = new ECS();
		const ChildOf = world.relations.register();
		const a = world.createEntity();
		const b = world.createEntity();

		// a <-> b (each is the other's parent)
		world.relations.add(a, ChildOf, b);
		world.relations.add(b, ChildOf, a);

		expect(() => world.relations.cascadeOf(a, ChildOf)).toThrow(/cycle/i);
	});
});

describe("ECS relation traversal — exclusive only (#474)", () => {
	it("throws on a multi relation", () => {
		const world = new ECS();
		const Likes = world.relations.register({ multi: true });
		const src = world.createEntity();
		const tgt = world.createEntity();
		world.relations.add(src, Likes, tgt);

		// cast (§10c): deliberately defeat the cardinality brand to assert the
		// runtime RELATION_MODE_MISMATCH backstop (POLISH_AUDIT #7)
		const LikesAsExclusive = Likes as unknown as RelationDef<"exclusive">;
		expect(() => world.relations.ancestorsOf(src, LikesAsExclusive)).toThrow();
		expect(() => world.relations.rootOf(src, LikesAsExclusive)).toThrow();
		expect(() => world.relations.cascadeOf(tgt, LikesAsExclusive)).toThrow();
	});
});
