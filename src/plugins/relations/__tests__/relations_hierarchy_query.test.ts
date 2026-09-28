/**
 * Hierarchy depth-ordering query term, `.hierarchy(R)`, the in-query
 * analog of flecs `cascade` and bitECS `Hierarchy()`.
 *
 * `.hierarchy(R)` reorders a query's matched entities into hierarchy depth
 * order over the exclusive relation `R` (parents before children). It does not
 * narrow the matched set, so an entity with no `R`-parent is a root (depth 0) and
 * is yielded first. The order is canonical: depth ascending, then entity index
 * ascending within each depth band, a total, insertion-order-independent order.
 * It is iterated via `forEachEntity` (members scatter across archetypes).
 *
 * What this file covers:
 *  - canonical depth order (depth, then eid), parents before children
 *  - the band is globally eid-ascending, not parent-grouped (vs a BFS forest)
 *  - optional `maxDepth` (bitECS depth limit)
 *  - exclusive-only guard (`RELATION_MODE_MISMATCH`) + cycle guard (`RELATION_CYCLE`)
 *  - intersection and composition with dense + sparse terms
 *  - `relationReads: [R]` access declaration (in-system)
 *  - `forEachArchetype` and `count` reject a hierarchy query (no per-archetype span)
 *  - cached, stable instances + single-ordering guard.
 *
 * Entity index == creation order for a fresh world (generation 0), so the
 * within-band order asserted below is creation order. Every node carries a tag so
 * it occupies an archetype row (a component-less entity is "unplaced" and yielded
 * by no query, a pre-existing ECS property, not specific to this term).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../../core/ecs/ecs";
import type { RelationDef } from "../../../core/ecs/relation";
import { registerChildOf } from "../builtin_relations";
import { HIERARCHY_UNBOUNDED } from "../../../core/ecs/query_terms";
import { SCHEDULE } from "../../../core/ecs/phase";
import type { EntityID } from "../../../core/ecs/entity";
import type { SystemContext } from "../../../core/ecs/system_context";
import type { SystemConfig } from "../../../core/ecs/system";
import { relations } from "../../relations";

/** Collect a hierarchy query's yielded entities in order (order is the point,
 * do not sort). */
function order(q: { forEachEntity(cb: (e: EntityID) => void): void }): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
	return out;
}

describe(".hierarchy(R), canonical depth ordering", () => {
	it("yields parents before children: depth ascending, then eid ascending in band", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world); // exclusive

		// Create deliberately so that lower-index entities live deeper, proving the
		// primary key is depth (not raw eid): r(0)=root, x(1)/y(2)=grandchildren,
		// p(3)/q(4)=children of r.
		const r = world.spawn();
		const x = world.spawn();
		const y = world.spawn();
		const p = world.spawn();
		const q = world.spawn();
		for (const e of [r, x, y, p, q]) world.addComponent(e, Node);

		world.relations.add(p, ChildOf, r); // depth 1
		world.relations.add(q, ChildOf, r); // depth 1
		world.relations.add(x, ChildOf, p); // depth 2
		world.relations.add(y, ChildOf, q); // depth 2

		// depth 0: [r] . Depth 1: [p, q] (3 < 4) . Depth 2: [x, y] (1 < 2)
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([r, p, q, x, y].map(Number));
	});

	it("forEachIds gives the depth order of forEachEntity", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const ids = Array.from({ length: 6 }, () => world.spawn());
		for (const e of ids) world.addComponent(e, Node);
		world.relations.add(ids[0], ChildOf, ids[3]);
		world.relations.add(ids[1], ChildOf, ids[0]);
		world.relations.add(ids[5], ChildOf, ids[3]);
		const q = world.query(Node).hierarchy(ChildOf);
		const got: number[] = [];
		q.forEachIds((batch, count) => {
			for (let i = 0; i < count; i++) got.push(batch[i] as number);
		});
		expect(got).toEqual(order(q));
	});

	it("a lone matched entity with no relation is a root (depth 0)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const solo = world.spawn();
		world.addComponent(solo, Node);
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([solo as number]);
	});

	it("orders a forest globally by eid within a band, not parent-grouped (vs bfs)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);

		// Two roots. Each one child. Create the second root's child (cB) before the
		// first root's child (cA), so within depth 1 the canonical order is cB < cA
		// even though cB's parent (r2) has the higher index. A BFS-per-root walk
		// would instead group as [r1, r2, cA, cB]. This pins the depth-band-eid
		// semantics.
		const r1 = world.spawn(); // 0
		const r2 = world.spawn(); // 1
		const cB = world.spawn(); // 2, child of r2
		const cA = world.spawn(); // 3, child of r1
		for (const e of [r1, r2, cB, cA]) world.addComponent(e, Node);
		world.relations.add(cA, ChildOf, r1);
		world.relations.add(cB, ChildOf, r2);

		// depth 0: [r1, r2] . Depth 1: [cB, cA] (index 2 < 3)
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([r1, r2, cB, cA].map(Number));
	});

	it("re-targeting a parent re-buckets the subtree's depth", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const a = world.spawn();
		const b = world.spawn();
		const c = world.spawn();
		for (const e of [a, b, c]) world.addComponent(e, Node);
		world.relations.add(b, ChildOf, a); // b depth 1
		world.relations.add(c, ChildOf, b); // c depth 2 → [a, b, c]
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([a, b, c].map(Number));

		// Re-parent c onto a (exclusive replace): c becomes depth 1 alongside b.
		world.relations.add(c, ChildOf, a);
		// depth 0: [a] . Depth 1: [b, c] (index b < c)
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([a, b, c].map(Number));
	});

	it("a dangling (dead) parent makes the orphaned child a root (depth 0)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world, { onDeleteTarget: "orphan" });
		const root = world.spawn();
		const child = world.spawn();
		const grand = world.spawn();
		for (const e of [root, child, grand]) world.addComponent(e, Node);
		world.relations.add(child, ChildOf, root);
		world.relations.add(grand, ChildOf, child);

		world.despawn(root);
		world.flush(); // child now dangles at a dead handle (orphan policy)
		expect(world.isAlive(root)).toBe(false);

		// child is now a root (dead parent → depth 0), grand is its child (depth 1).
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([child, grand].map(Number));
	});
});

describe(".hierarchy(R), maxDepth", () => {
	it("drops entities deeper than maxDepth (inclusive)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn(); // depth 0
		const c = world.spawn(); // depth 1
		const g = world.spawn(); // depth 2
		for (const e of [r, c, g]) world.addComponent(e, Node);
		world.relations.add(c, ChildOf, r);
		world.relations.add(g, ChildOf, c);

		expect(order(world.query(Node).hierarchy(ChildOf, 0))).toEqual([r as number]);
		expect(order(world.query(Node).hierarchy(ChildOf, 1))).toEqual([r, c].map(Number));
		expect(order(world.query(Node).hierarchy(ChildOf, 2))).toEqual([r, c, g].map(Number));
		expect(order(world.query(Node).hierarchy(ChildOf, HIERARCHY_UNBOUNDED))).toEqual(
			[r, c, g].map(Number)
		);
	});
});

describe(".hierarchy(R), intersection and composition", () => {
	it("intersects the matched set with a dense require term (depth stays structural)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Pos = world.registerComponent(["x", "y"] as const);
		const ChildOf = registerChildOf(world);
		// root has no Pos → not matched, but still counts toward child depth.
		const root = world.spawn();
		const child = world.spawn();
		const grand = world.spawn();
		world.addComponent(child, Pos, { x: 0, y: 0 });
		world.addComponent(grand, Pos, { x: 1, y: 1 });
		world.relations.add(child, ChildOf, root); // child structural depth 1
		world.relations.add(grand, ChildOf, child); // grand structural depth 2

		// root excluded, because it has no Pos. child(depth 1) before grand(depth 2).
		expect(order(world.query(Pos).hierarchy(ChildOf))).toEqual([child, grand].map(Number));
	});

	it("composes with andSparse (both must hold), preserving depth order", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const Marked = world.registerSparseTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn();
		const a = world.spawn();
		const b = world.spawn();
		for (const e of [r, a, b]) world.addComponent(e, Node);
		world.relations.add(a, ChildOf, r);
		world.relations.add(b, ChildOf, a);
		world.addSparse(r, Marked);
		world.addSparse(b, Marked); // a is NOT marked

		// Only marked nodes, still depth ordered: r(0) then b(2).
		expect(order(world.query(Node).andSparse(Marked).hierarchy(ChildOf))).toEqual(
			[r, b].map(Number)
		);
	});

	it("is carried through dense composition regardless of order", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn();
		const c = world.spawn();
		for (const e of [r, c]) world.addComponent(e, Node);
		world.relations.add(c, ChildOf, r);
		// hierarchy(R).and(Node) keeps the ordering term, equals query(Node).hierarchy(R).
		expect(order(world.query().hierarchy(ChildOf).and(Node))).toEqual([r, c].map(Number));
		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([r, c].map(Number));
	});

	it("survives an andSparse term composed after hierarchy (routes through _deriveSparse)", () => {
		// The drop-on-compose trap: a sparse term composed onto a
		// hierarchy-bearing query must thread `_hierarchy` through `_deriveSparse`,
		// or the ordering is silently lost. Build the same world as the
		// hierarchy-last sparse test and assert both orders agree with the spec.
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const Marked = world.registerSparseTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn(); // depth 0, marked
		const a = world.spawn(); // depth 1, NOT marked
		const b = world.spawn(); // depth 2, marked
		for (const e of [r, a, b]) world.addComponent(e, Node);
		world.relations.add(a, ChildOf, r);
		world.relations.add(b, ChildOf, a);
		world.addSparse(r, Marked);
		world.addSparse(b, Marked);

		// Spec: marked ∩ Node, depth-ordered → r(0) before b(2).
		const expected = [r, b].map(Number);
		expect(order(world.query(Node).hierarchy(ChildOf).andSparse(Marked))).toEqual(expected);
		// Hierarchy-last form must agree (the term is symmetric under composition).
		expect(order(world.query(Node).andSparse(Marked).hierarchy(ChildOf))).toEqual(expected);
	});

	it("survives an andRelation term composed after hierarchy (routes through _deriveRelation)", () => {
		// Same trap on the relation-wildcard derive path. ChildOf defines the tree
		// a second relation Tagged is the (R, *) membership filter composed last.
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const Tagged = world.relations.register();
		const r = world.spawn(); // depth 0, tagged
		const a = world.spawn(); // depth 1, NOT tagged
		const b = world.spawn(); // depth 2, tagged
		const t = world.spawn(); // relation target
		for (const e of [r, a, b]) world.addComponent(e, Node);
		world.relations.add(a, ChildOf, r);
		world.relations.add(b, ChildOf, a);
		world.relations.add(r, Tagged, t);
		world.relations.add(b, Tagged, t);

		// Spec: sources holding Tagged ∩ Node, depth-ordered → r(0) before b(2).
		const expected = [r, b].map(Number);
		expect(order(world.query(Node).hierarchy(ChildOf).andRelation(Tagged))).toEqual(expected);
		// Hierarchy-last form must agree.
		expect(order(world.query(Node).andRelation(Tagged).hierarchy(ChildOf))).toEqual(expected);
	});

	it("excludes disabled entities by default, includes them with includeDisabled()", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn();
		const a = world.spawn();
		for (const e of [r, a]) world.addComponent(e, Node);
		world.relations.add(a, ChildOf, r);
		world.disable(a);

		expect(order(world.query(Node).hierarchy(ChildOf))).toEqual([r as number]);
		expect(order(world.query(Node).hierarchy(ChildOf).includeDisabled())).toEqual(
			[r, a].map(Number)
		);
	});
});

describe(".hierarchy(R), guards", () => {
	it("throws RELATION_MODE_MISMATCH on a multi relation (exclusive-only)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const Likes = world.relations.register({ multi: true });
		const a = world.spawn();
		world.addComponent(a, Node);
		// cast: deliberately defeat the cardinality brand to assert the
		// runtime RELATION_MODE_MISMATCH backstop
		expect(() =>
			world
				.query(Node)
				.hierarchy(Likes as unknown as RelationDef<"exclusive">)
				.forEachEntity(() => {})
		).toThrow(/multi-target/);
	});

	it("throws RELATION_CYCLE on a cyclic chain in __DEV__", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = world.relations.register(); // exclusive; bypass child_of for a raw cycle
		const a = world.spawn();
		const b = world.spawn();
		for (const e of [a, b]) world.addComponent(e, Node);
		world.relations.add(a, ChildOf, b);
		world.relations.add(b, ChildOf, a); // cycle
		expect(() =>
			world
				.query(Node)
				.hierarchy(ChildOf)
				.forEachEntity(() => {})
		).toThrow(/cycle/i);
	});

	it("forEachArchetype, count and archetypeCount reject a hierarchy query (no per-archetype span)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const q = world.query(Node).hierarchy(ChildOf);
		expect(() => q.forEachArchetype(() => {})).toThrow(/forEachEntity/);
		expect(() => q.entityCount).toThrow(/forEachEntity/);
		expect(() => q.archetypeCount).toThrow(/forEachEntity/);
	});

	it("rejects a second hierarchy ordering on the same query", () => {
		const world = ECS.create({ plugins: [relations()] });
		const A = world.relations.register();
		const B = world.relations.register();
		expect(() => world.query().hierarchy(A).hierarchy(B)).toThrow(/already set/i);
	});

	it("rejects a negative or non-integer maxDepth (caller typo), accepts valid limits", () => {
		const world = ECS.create({ plugins: [relations()] });
		const R = world.relations.register();
		expect(() => world.query().hierarchy(R, -1)).toThrow(/maxDepth/);
		expect(() => world.query().hierarchy(R, 1.5)).toThrow(/maxDepth/);
		expect(() => world.query().hierarchy(R, NaN)).toThrow(/maxDepth/);
		// Valid limits do not throw: 0, a positive integer, and the unbounded sentinel.
		expect(() => world.query().hierarchy(R, 0)).not.toThrow();
		expect(() => world.query().hierarchy(R, 3)).not.toThrow();
		expect(() => world.query().hierarchy(R, HIERARCHY_UNBOUNDED)).not.toThrow();
	});
});

describe(".hierarchy(R), cached, stable instances", () => {
	it("repeated unbounded hierarchy from the same parent returns the identical Query", () => {
		const world = ECS.create({ plugins: [relations()] });
		const R = world.relations.register();
		const base = world.query();
		expect(base.hierarchy(R)).toBe(base.hierarchy(R));
	});

	it("a maxDepth-limited hierarchy mints fresh (not cached)", () => {
		const world = ECS.create({ plugins: [relations()] });
		const R = world.relations.register();
		const base = world.query();
		expect(base.hierarchy(R, 2)).not.toBe(base.hierarchy(R, 2));
	});
});

describe(".hierarchy(R), access declaration (relationReads)", () => {
	function base(overrides: Partial<SystemConfig>): SystemConfig {
		return {
			reads: [],
			writes: [],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn: (_ctx: SystemContext, _dt: number) => {},
			...overrides
		};
	}

	it("throws when a system iterates a hierarchy query without relationReads", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const a = world.spawn();
		world.addComponent(a, Node);
		const q = world.query(Node).hierarchy(ChildOf);

		const sys = world.registerSystem(
			base({
				name: "hierarchy_undeclared",
				fn() {
					q.forEachEntity(() => {});
				}
			})
		);
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).toThrow(/relation.*did not declare/);
	});

	it("passes when relationReads declares the hierarchy relation", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Node = world.registerTag();
		const ChildOf = registerChildOf(world);
		const r = world.spawn();
		const c = world.spawn();
		for (const e of [r, c]) world.addComponent(e, Node);
		world.relations.add(c, ChildOf, r);
		const q = world.query(Node).hierarchy(ChildOf);

		const seen: number[] = [];
		const sys = world.registerSystem(
			base({
				name: "hierarchy_declared",
				relationReads: [ChildOf],
				fn() {
					q.forEachEntity((e) => seen.push(e as number));
				}
			})
		);
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		expect(() => world.update(0)).not.toThrow();
		expect(seen).toEqual([r, c].map(Number));
	});
});
