/**
 * The verbs that take more than one argument, and the two loops behind
 * `singleEntity`.
 *
 * `changed` and `withoutRelation` each split on argument count. The one-argument
 * branch reads a per-term cache keyed on the query id, and the many-argument
 * branch builds a fresh query instead. Both branches are live, and only the
 * one-argument branch had a test. A cache that handed back a one-term result for
 * a two-term call would pass every earlier test in this suite.
 *
 * `singleEntity` splits the same way: a dense-only query reads `entityCount`,
 * and a query carrying a sparse, relation or hierarchy term walks its entities
 * instead. The walk is the branch this file covers.
 */

import { describe, expect, it } from "vitest";
import type { ComponentDef } from "../../component";
import { ECS } from "../../ecs";
import type { Query } from "../../query";
import { SCHEDULE } from "../../schedule";
import type { SystemDescriptor } from "../../system";
import { ECS_ERROR, isEcsError } from "../../utils/error";
import { openAccess } from "../test_helpers";
import { relations } from "../../../../capabilities/relations";

/** A system that bumps the changed tick of `def`'s column on every archetype
 * that `q` matches. Ordered before the reader in each test below. */
function writer(world: ECS, q: Query<ComponentDef[]>, def: ComponentDef, field: string): SystemDescriptor {
	return world.registerSystem({
		...openAccess([def]),
		fn() {
			for (const arch of q.nonEmptyArchs()) arch.getColumnMut(def, field, world.getChangeTick());
		}
	});
}

describe("Query.changed with more than one component", () => {
	it("visits an archetype once when any named component changed", () => {
		const world = ECS.create({ plugins: [relations()] });
		const A = world.registerComponent({ a: "f64" });
		const B = world.registerComponent({ b: "f64" });
		const Left = world.registerComponent({ l: "f64" });
		const Right = world.registerComponent({ r: "f64" });

		// Three archetypes all hold A and B. `Left`, `Right` and neither
		// separate them, so a writer can bump one column in a chosen subset.
		// The third archetype is the one that matters: both named components
		// change there, so it is the only place the inner loop can visit twice.
		const el = world.spawn();
		world.addComponent(el, A, { a: 0 });
		world.addComponent(el, B, { b: 0 });
		world.addComponent(el, Left, { l: 0 });
		const er = world.spawn();
		world.addComponent(er, A, { a: 0 });
		world.addComponent(er, B, { b: 0 });
		world.addComponent(er, Right, { r: 0 });
		const eb = world.spawn();
		world.addComponent(eb, A, { a: 0 });
		world.addComponent(eb, B, { b: 0 });

		let onlyA = 0;
		let onlyB = 0;
		let both = 0;
		const q = world.query(A, B);
		// A changes everywhere except the right archetype, B everywhere except
		// the left one. They overlap on the third.
		const writeA = writer(world, world.query(A).without(Right), A, "a");
		const writeB = writer(world, world.query(B).without(Left), B, "b");
		const reader = world.registerSystem({
			...openAccess([A, B, Left, Right]),
			fn() {
				onlyA = 0;
				onlyB = 0;
				both = 0;
				q.changed(A).forEach(() => onlyA++);
				q.changed(B).forEach(() => onlyB++);
				q.changed(A, B).forEach(() => both++);
			}
		});

		world.addSystems(
			SCHEDULE.UPDATE,
			writeA,
			writeB,
			{ system: reader, ordering: { after: [writeA, writeB] } }
		);
		world.startup();
		// The reader zeroes its own counters, so what survives is the last tick.
		// The first tick cannot measure anything: the spawn writes stamp every
		// column, and the reader's first run reports all of them.
		for (let i = 0; i < 3; i++) world.update(1 / 60);

		expect(onlyA).toBe(2); // the left archetype and the overlapping one
		expect(onlyB).toBe(2); // the right archetype and the overlapping one
		// The union of the three, each counted once. The overlapping archetype
		// matches both ids, so a loop that did not stop at the first match would
		// report four.
		expect(both).toBe(3);
	});

	it("caches the one-argument form and builds the many-argument form fresh", () => {
		const world = ECS.create({ plugins: [relations()] });
		const A = world.registerComponent({ a: "f64" });
		const B = world.registerComponent({ b: "f64" });
		const q = world.query(A, B);

		expect(q.changed(A)).toBe(q.changed(A));
		// No cache key covers a list, so each call allocates. The invariant that
		// matters is that a two-term call never lands on the one-term entry.
		expect(q.changed(A, B)).not.toBe(q.changed(A));
	});
});

describe("Query.withoutRelation with more than one relation", () => {
	it("excludes a source holding either relation", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Pos = world.registerComponent({ x: "f64" });
		const R1 = world.relations.register();
		const R2 = world.relations.register();

		const target = world.spawn();
		const clean = world.spawn();
		world.addComponent(clean, Pos, { x: 0 });
		const holdsR1 = world.spawn();
		world.addComponent(holdsR1, Pos, { x: 1 });
		world.relations.add(holdsR1, R1, target);
		const holdsR2 = world.spawn();
		world.addComponent(holdsR2, Pos, { x: 2 });
		world.relations.add(holdsR2, R2, target);

		const seen = (q: { forEachEntity: (cb: (e: number) => void) => void }): number[] => {
			const out: number[] = [];
			q.forEachEntity((e) => out.push(Number(e)));
			return out.sort((l, r) => l - r);
		};

		const base = world.query(Pos);
		const expected = [clean, holdsR1, holdsR2].map(Number).sort((l, r) => l - r);
		expect(seen(base as never)).toEqual(expected);
		expect(seen(base.withoutRelation(R1) as never)).toEqual(
			[clean, holdsR2].map(Number).sort((l, r) => l - r)
		);
		// Both terms at once. The chained form must drop both sources, not the
		// last relation alone.
		expect(seen(base.withoutRelation(R1, R2) as never)).toEqual([Number(clean)]);
	});
});

describe("Query.singleEntity on a query that is not dense-only", () => {
	it("walks the entities to count them, and throws on a count other than one", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Pos = world.registerComponent({ x: "f64" });
		const Mark = world.registerSparseComponent({ v: "f64" });
		const q = world.query(Pos).withSparse(Mark);

		// Zero matches: the walk counts nothing, and the dev guard throws.
		let empty: unknown;
		try {
			q.singleEntity();
		} catch (err) {
			empty = err;
		}
		expect(isEcsError(empty)).toBe(true);
		if (isEcsError(empty)) expect(empty.category).toBe(ECS_ERROR.QUERY_NOT_SINGLETON);

		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 2 });
		// `b` alone carries the sparse term, so the dense count is two and the
		// walk count is one. Reading `entityCount` here would throw the
		// dense-only guard instead of returning `b`.
		world.addSparse(b, Mark, { v: 1 });
		expect(q.singleEntity()).toBe(b);

		world.addSparse(a, Mark, { v: 1 });
		expect(() => q.singleEntity()).toThrow(/found 2/);
	});
});
