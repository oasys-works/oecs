/**
 * Batch-4 API additions (POLISH_AUDIT #9 / M7 / M8 + combinators + dispose):
 *  - total `has*` probes + `tryGetField` (dead/missing → undefined, no throw);
 *  - `Query.firstEntity` / `Query.singleEntity`;
 *  - host-side `ecs.refRead` parity with `ctx.refRead`;
 *  - run-condition combinators `not` / `allOf` / `anyOf`;
 *  - `ObserverHandle[Symbol.dispose]` (`using` support).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, isEcsError } from "../../utils/error";
import { not, allOf, anyOf, runEveryNTicks, type ConditionContext } from "../../run_condition";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";

function staleOf(e: number): never {
	return (e + (1 << 20)) as never; // same index, bumped generation — dead
}

describe("total has* + tryGetField (#9)", () => {
	it("hasComponent/hasSparse/hasRelation return false for a dead entity", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const Tag = world.registerSparseComponent({ v: "f64" });
		const R = world.relations.register();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		world.addSparse(e, Tag, { v: 2 });
		const stale = staleOf(e as number);
		expect(world.hasComponent(stale, Pos)).toBe(false);
		expect(world.hasSparse(stale, Tag)).toBe(false);
		expect(world.relations.has(stale, R)).toBe(false);
	});

	it("tryGetField: value when held, undefined for missing component or dead id", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const Vel = world.registerComponent({ vx: "f64" });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 42 });
		expect(world.tryGetField(e, Pos, "x")).toBe(42);
		expect(world.tryGetField(e, Vel, "vx")).toBeUndefined();
		expect(world.tryGetField(staleOf(e as number), Pos, "x")).toBeUndefined();
	});

	it("ctx.tryGetField mirrors the host total read inside a system", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const Vel = world.registerComponent({ vx: "f64" });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 42 });

		const seen: (number | undefined)[] = [];
		const sys = world.registerSystem({
			reads: [Pos, Vel],
			writes: [],
			fn(ctx) {
				seen.push(ctx.tryGetField(e, Pos, "x"));
				seen.push(ctx.tryGetField(e, Vel, "vx"));
				seen.push(ctx.tryGetField(staleOf(e as number), Pos, "x"));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);

		expect(seen).toEqual([42, undefined, undefined]);
	});
});

describe("Query.firstEntity / singleEntity (M8)", () => {
	it("firstEntity: undefined on no match, an entity on match", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const q = world.query(Pos);
		expect(q.firstEntity()).toBeUndefined();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		expect(q.firstEntity()).toBe(e);
	});

	it("singleEntity: returns the singleton, dev-throws on 0 and on >1", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const q = world.query(Pos);

		let caught: unknown;
		try {
			q.singleEntity();
		} catch (err) {
			caught = err;
		}
		expect(isEcsError(caught)).toBe(true);
		if (isEcsError(caught)) expect(caught.category).toBe(ECS_ERROR.QUERY_NOT_SINGLETON);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });
		expect(q.singleEntity()).toBe(e);

		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 2 });
		expect(() => q.singleEntity()).toThrow(/found 2/);
	});

	it("firstEntity honors sparse terms via the walk fallback", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const Mark = world.registerSparseComponent({ v: "f64" });
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1 });
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 2 });
		world.addSparse(b, Mark, { v: 1 });
		expect(world.query(Pos).withSparse(Mark).firstEntity()).toBe(b);
	});
});

describe("host refRead (M7)", () => {
	it("reads whole-component fields through a readonly ref", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64", y: "f64" });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 3, y: 4 });
		const ref = world.refRead(Pos, e);
		expect(ref.x).toBe(3);
		expect(ref.y).toBe(4);
	});
});

describe("run-condition combinators", () => {
	const ctx = { ecsTick: 4 } as unknown as ConditionContext;
	it("not / allOf / anyOf evaluate and merge declares", () => {
		const every2 = runEveryNTicks(2); // true at tick 4
		const every3 = runEveryNTicks(3); // false at tick 4
		expect(not(every3).evaluate(ctx)).toBe(true);
		expect(allOf(every2, every3).evaluate(ctx)).toBe(false);
		expect(anyOf(every2, every3).evaluate(ctx)).toBe(true);
		expect(not(every3).name).toBe("not(runEveryNTicks(3))");
		expect(allOf(every2, every3).name).toContain("allOf(");
	});
});

describe("ObserverHandle Symbol.dispose", () => {
	it("using-disposal unregisters the observer (parity with dispose())", () => {
		const world = new ECS({ deterministic: true });
		const Tag = world.registerTag();
		let fires = 0;
		const e1 = world.spawn();
		const e2 = world.spawn();
		const sys = world.registerSystem({
			...openAccess([Tag]),
			fn: (ctx) => {
				if (!ctx.hasComponent(e1, Tag)) ctx.commands.add(e1, Tag);
				else if (!ctx.hasComponent(e2, Tag)) ctx.commands.add(e2, Tag);
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		{
			using h = world.observe(Tag, { onAdd: () => fires++, access: openAccess([Tag]) });
			void h;
			world.update(1 / 60); // deferred add flushes → onAdd fires
			expect(fires).toBe(1);
		}
		// handle disposed at block exit — e2 gains Tag, observer is gone
		world.update(1 / 60);
		expect(fires).toBe(1);
		expect(world.hasComponent(e2, Tag)).toBe(true);
	});
});
