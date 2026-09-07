/**
 * The solid plugin, held to what it publishes and when.
 *
 * Every test drives a real world: `ECS.create({ plugins: [solid()] })`, a dense
 * component, and systems that write by id or through a chunk loop. The claims
 * are the value each cell carries, the key set, and the number of projections.
 * A projection count is the only way to see that a quiet entity costs nothing,
 * so a spy stands in wherever a count carries the claim.
 *
 * Scope note: the root vitest runs under the `node` condition, where solid-js
 * resolves to its server build. A signal there holds a value, consults no
 * comparator and schedules no effect. So these tests assert the value contract,
 * and the `eq` tests assert that the comparator reaches the signal and then run
 * it by hand. That a real Solid `<For>` re-renders off `keys()`, and that an
 * equal write wakes nobody, are browser-condition claims proven elsewhere.
 */

import { batch, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ECS } from "../../../core/ecs/ecs";
import { SCHEDULE } from "../../../core/ecs/phase";
import { observers } from "../../../plugins/observers";
import { openAccess } from "../../../core/ecs/__tests__/test_helpers";
import { solid } from "../index";
import type { ComponentDef, EntityID, Query, SystemContext } from "../../../core/ecs";

// `batch` is the one call the plugin makes once per tick, whatever the
// number of views. Counting it needs the real implementation behind a spy, so
// the module is mocked with everything else left alone.
vi.mock("solid-js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("solid-js")>();
	return { ...actual, batch: vi.fn(actual.batch), createSignal: vi.fn(actual.createSignal) };
});

const DT = 1 / 60;

type PosSchema = { x: "f64"; y: "f64" };

/** A world with the plugin, one dense component, and one system whose body
 * the test fills in per tick. */
function makeWorld(): {
	world: ReturnType<typeof ECS.create<[ReturnType<typeof solid>]>>;
	Pos: ComponentDef<PosSchema>;
	query: Query<[ComponentDef<PosSchema>]>;
	run: (fn: (ctx: SystemContext) => void) => void;
	tick: () => void;
} {
	const world = ECS.create({ plugins: [solid()] });
	const Pos = world.registerComponent<PosSchema>({ x: "f64", y: "f64" }, { name: "Pos" });
	const query = world.query(Pos);
	let body: ((ctx: SystemContext) => void) | null = null;
	world.addSystems(
		SCHEDULE.UPDATE,
		world.registerSystem({
			...openAccess([Pos as ComponentDef]),
			spawns: [[Pos as ComponentDef]],
			fn: (ctx) => {
				const b = body;
				body = null;
				if (b !== null) b(ctx);
			}
		})
	);
	return {
		world,
		Pos,
		query,
		run: (fn) => {
			body = fn;
			world.update(DT);
		},
		tick: () => world.update(DT)
	};
}

beforeEach(() => {
	vi.mocked(batch).mockClear();
});

describe("the seed", () => {
	it("publishes every enabled member and leaves a disabled one out", () => {
		const { world, Pos } = makeWorld();
		const a = world.spawn();
		const b = world.spawn();
		const off = world.spawn();
		for (const e of [a, b, off]) world.addComponent(e, Pos, { x: (e as number) + 1, y: 0 });
		world.disable(off);
		world.startup();

		const view = world.solid.fields(Pos, ["x"]);
		expect(view.cell(a)()).toEqual({ x: (a as number) + 1 });
		expect(view.cell(b)()).toEqual({ x: (b as number) + 1 });
		expect(view.cell(off)()).toBeUndefined();
		expect([...view.keys()].sort()).toEqual([a, b].sort());
	});
});

describe("the set half", () => {
	it("publishes a by-id write at the tick tail and re-projects nobody after it", () => {
		const { world, Pos, run, tick } = makeWorld();
		const a = world.spawn();
		const b = world.spawn();
		const late = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 0 });
		world.addComponent(b, Pos, { x: 2, y: 0 });
		world.startup();

		const project = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const view = world.solid.component(Pos, project);
		expect(project).toHaveBeenCalledTimes(2);
		project.mockClear();

		run((ctx) => {
			ctx.setField(a, Pos, "x", 42);
			ctx.commands.add(late, Pos, { x: 7, y: 0 });
		});
		expect(view.cell(a)()).toBe(42);
		expect(view.cell(late)()).toBe(7);
		expect(view.cell(b)()).toBe(2);
		expect(project).toHaveBeenCalledTimes(2);

		// A tick nobody wrote projects nothing, and the pending set is spent.
		tick();
		expect(project).toHaveBeenCalledTimes(2);
		expect(view.cell(a)()).toBe(42);
	});
});

describe("a cell", () => {
	it("is one signal per row, made once and kept across a delete", () => {
		const { world, Pos, run } = makeWorld();
		world.startup();
		const view = world.solid.component(Pos, (row) => row.field("x"));

		// Asked for before the row exists, so it starts absent.
		let born = 0 as EntityID;
		const held = view.cell(0 as EntityID);
		expect(held()).toBeUndefined();

		run((ctx) => {
			born = ctx.commands.spawn();
			ctx.commands.add(born, Pos, { x: 4, y: 0 });
		});
		// The spawn reuses index 0, so the accessor asked for above is this
		// row's accessor, and `cell` hands back the same one.
		expect(born as number).toBe(0);
		expect(view.cell(born)).toBe(held);
		expect(held()).toBe(4);

		run((ctx) => ctx.commands.despawn(born));
		expect(held()).toBeUndefined();
		expect(view.cell(born)).toBe(held);
	});

	it("hands its eq to the signal, and keeps an absent row away from it", () => {
		const { world, Pos } = makeWorld();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 0 });
		world.startup();

		const eq = vi.fn((_prev: number, _next: number) => true);
		const view = world.solid.component(Pos, (row) => row.field("x"), { eq });
		vi.mocked(createSignal).mockClear();
		const cell = view.cell(a);
		expect(cell()).toBe(1);

		// A signal skips an equal write through its `equals`. The server build
		// this suite runs under holds a value and consults nothing, so the claim
		// is that the cell carries the comparator and that the comparator is the
		// caller's `eq`. Take it off the call and run it.
		const options = vi.mocked(createSignal).mock.calls[0][1] as {
			equals: (prev: number | undefined, next: number | undefined) => boolean;
		};
		expect(options.equals(1, 2)).toBe(true);
		expect(eq).toHaveBeenCalledWith(1, 2);

		// An absent row is not a pair `eq` was written for. Identity answers the
		// absent-to-absent case, and a one-sided absence is a change.
		eq.mockClear();
		expect(options.equals(undefined, undefined)).toBe(true);
		expect(options.equals(1, undefined)).toBe(false);
		expect(options.equals(undefined, 2)).toBe(false);
		expect(eq).not.toHaveBeenCalled();
	});

	it("compares the listed fields, so an unchanged record wakes nobody", () => {
		const { world, Pos } = makeWorld();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 2 });
		world.startup();

		const view = world.solid.fields(Pos, ["x"]);
		vi.mocked(createSignal).mockClear();
		view.cell(a);
		const options = vi.mocked(createSignal).mock.calls[0][1] as {
			equals: (prev: { x: number } | undefined, next: { x: number } | undefined) => boolean;
		};
		// Two records of the same listed value, and never the same object.
		expect(options.equals({ x: 1 }, { x: 1 })).toBe(true);
		expect(options.equals({ x: 1 }, { x: 3 })).toBe(false);
	});
});

describe("the structural half", () => {
	it("adds a deferred spawn, drops a despawn, and skips an entity that did both", () => {
		const { world, Pos, run } = makeWorld();
		world.startup();
		const project = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const view = world.solid.component(Pos, project);
		project.mockClear();

		let spawned = 0 as EntityID;
		run((ctx) => {
			spawned = ctx.commands.spawn();
			ctx.commands.add(spawned, Pos, { x: 5, y: 0 });
		});
		expect(view.cell(spawned)()).toBe(5);
		expect([...view.keys()]).toEqual([spawned]);
		expect(project).toHaveBeenCalledTimes(1);

		run((ctx) => ctx.commands.despawn(spawned));
		expect(view.cell(spawned)()).toBeUndefined();
		expect([...view.keys()]).toEqual([]);

		// Born and dead inside one tick: the view never held it, so Solid never
		// hears of it and the projection never runs.
		project.mockClear();
		let ghost = 0 as EntityID;
		run((ctx) => {
			ghost = ctx.commands.spawn();
			ctx.commands.add(ghost, Pos, { x: 9, y: 0 });
			ctx.commands.despawn(ghost);
		});
		expect(project).toHaveBeenCalledTimes(0);
		expect(view.cell(ghost)()).toBeUndefined();
		expect([...view.keys()]).toEqual([]);
	});

	it("drops a disabled entity and brings it back on enable with its current value", () => {
		const { world, Pos, run } = makeWorld();
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 3, y: 0 });
		world.startup();
		const view = world.solid.fields(Pos, ["x"]);
		expect(view.cell(a)()).toEqual({ x: 3 });

		run((ctx) => ctx.commands.disable(a));
		expect(view.cell(a)()).toBeUndefined();
		expect([...view.keys()]).toEqual([]);

		// The value moves while the entity is out of the view, and the enable
		// publishes what the store holds now, not what it held on the way out.
		world.setField(a, Pos, "x", 11);
		run((ctx) => ctx.commands.enable(a));
		expect(view.cell(a)()).toEqual({ x: 11 });
		expect([...view.keys()]).toEqual([a]);
	});
});

describe("the column grain", () => {
	it("publishes every enabled row a chunk loop wrote, and nothing on a quiet tick", () => {
		const { world, Pos, query, run, tick } = makeWorld();
		const ids: EntityID[] = [];
		for (let i = 0; i < 4; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: 0 });
			ids.push(e);
		}
		world.disable(ids[3]);
		world.startup();

		const project = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const view = world.solid.component(Pos, project, { grain: "column" });
		expect(project).toHaveBeenCalledTimes(3);
		project.mockClear();

		run(() => {
			query.forEachChunk((cols, count) => {
				const { x } = cols.mut(Pos);
				for (let i = 0; i < count; i++) x[i] += 100;
			});
		});
		expect(project).toHaveBeenCalledTimes(3);
		expect(view.cell(ids[0])()).toBe(100);
		expect(view.cell(ids[2])()).toBe(102);
		expect(view.cell(ids[3])()).toBeUndefined();

		tick();
		expect(project).toHaveBeenCalledTimes(3);
	});

	it("projects nobody on the first quiet tick, whatever the plane already holds", () => {
		// The seed publishes every member, so the baseline of a new view sits
		// above every stamp the plane carries. A baseline of zero would project
		// each archetype the world ever touched, one time, at the first settle.
		const { world, Pos, tick } = makeWorld();
		for (let i = 0; i < 4; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: 0 });
		}
		world.startup();
		tick();

		const project = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		world.solid.component(Pos, project, { grain: "column" });
		expect(project).toHaveBeenCalledTimes(4);
		project.mockClear();

		tick();
		expect(project).toHaveBeenCalledTimes(0);
	});
});

describe("the Solid flush", () => {
	it("batches once per update whatever the number of views, and never without one", () => {
		const { world, Pos, run } = makeWorld();
		const Vel = world.registerComponent({ v: "f64" }, { name: "Vel" });
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 0 });
		world.addComponent(a, Vel, { v: 1 });
		world.startup();
		world.solid.fields(Pos, ["x"]);
		world.solid.fields(Vel, ["v"]);

		vi.mocked(batch).mockClear();
		run(() => {});
		expect(vi.mocked(batch)).toHaveBeenCalledTimes(1);

		const bare = ECS.create({ plugins: [solid()] });
		bare.startup();
		vi.mocked(batch).mockClear();
		bare.update(DT);
		expect(vi.mocked(batch)).toHaveBeenCalledTimes(0);
	});
});

describe("two views on one component", () => {
	it("keeps the survivor publishing, and leaves no record behind once both are gone", () => {
		const { world, Pos, query, run, tick } = makeWorld();
		const a = world.spawn();
		const b = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 0 });
		world.addComponent(b, Pos, { x: 2, y: 0 });
		world.startup();

		const byEntity = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const byColumn = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const entityView = world.solid.component(Pos, byEntity);
		const columnView = world.solid.component(Pos, byColumn, { grain: "column" });
		byEntity.mockClear();
		byColumn.mockClear();

		run((ctx) => ctx.setField(a, Pos, "x", 10));
		expect(entityView.cell(a)()).toBe(10);
		expect(columnView.cell(a)()).toBe(10);
		expect(byEntity).toHaveBeenCalledTimes(1);

		// One leaves. The other keeps its own grain.
		entityView.dispose();
		byEntity.mockClear();
		byColumn.mockClear();
		run(() => {
			query.forEachChunk((cols, count) => {
				const { x } = cols.mut(Pos);
				for (let i = 0; i < count; i++) x[i] = 50;
			});
		});
		expect(byEntity).toHaveBeenCalledTimes(0);
		expect(byColumn).toHaveBeenCalledTimes(2);
		expect(columnView.cell(b)()).toBe(50);

		// Both gone: a write in this tick is recorded for nobody.
		columnView.dispose();
		byColumn.mockClear();
		run((ctx) => ctx.setField(a, Pos, "x", 77));
		expect(byEntity).toHaveBeenCalledTimes(0);
		expect(byColumn).toHaveBeenCalledTimes(0);

		// A view built afterwards seeds and then sits quiet. A record the store
		// kept while no view existed would show up here as an extra projection.
		const later = vi.fn((row: { field(name: "x"): number }) => row.field("x"));
		const fresh = world.solid.component(Pos, later);
		expect(later).toHaveBeenCalledTimes(2);
		expect(fresh.cell(a)()).toBe(77);
		tick();
		expect(later).toHaveBeenCalledTimes(2);
	});
});

describe("coexistence with observers", () => {
	it.each([
		["observers first", true],
		["solid first", false]
	])("%s: both consumers see one by-id write", (_label, observersFirst) => {
		const world = observersFirst
			? ECS.create({ plugins: [observers(), solid()] })
			: ECS.create({ plugins: [solid(), observers()] });
		const Pos = world.registerComponent<PosSchema>({ x: "f64", y: "f64" }, { name: "Pos" });
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 1, y: 0 });

		const seen: EntityID[] = [];
		world.observe(Pos as ComponentDef, {
			granularity: "entity",
			onSet: (eid) => seen.push(eid),
			access: openAccess([Pos as ComponentDef])
		});
		const view = world.solid.component(Pos, (row) => row.field("x"));

		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				...openAccess([Pos as ComponentDef]),
				fn: (ctx) => ctx.setField(a, Pos, "x", 99)
			})
		);
		world.startup();
		seen.length = 0;
		world.update(DT);

		expect(seen).toEqual([a]);
		expect(view.cell(a)()).toBe(99);
	});
});

describe("the singleton view", () => {
	it("follows its target, ignores another member, and resets when the target dies", () => {
		const { world, Pos, run } = makeWorld();
		const target = world.spawn();
		const other = world.spawn();
		world.addComponent(target, Pos, { x: 1, y: 2 });
		world.addComponent(other, Pos, { x: 500, y: 600 });
		world.startup();

		const view = world.solid.singleton(Pos, target, ["x", "y"]);
		expect(view.value.x).toBe(1);
		expect(view.value.y).toBe(2);

		run((ctx) => ctx.setField(other, Pos, "x", 501));
		expect(view.value.x).toBe(1);
		expect(view.value.y).toBe(2);

		run((ctx) => ctx.setField(target, Pos, "x", 33));
		expect(view.value.x).toBe(33);

		// No row to delete, so the channel states its empty value: the values the
		// store held when the view was built.
		run((ctx) => ctx.commands.despawn(target));
		expect(view.value.x).toBe(0);
		expect(view.value.y).toBe(0);
	});
});

describe("a sparse definition", () => {
	it("is refused by name, because a cursor and the dense feed need a dense shape", () => {
		const { world } = makeWorld();
		const Cool = world.registerSparseComponent({ v: "f64" });
		expect(() =>
			(world.solid as unknown as { component(def: unknown, p: unknown): void }).component(
				Cool,
				() => 0
			)
		).toThrow(TypeError);
		expect(() =>
			(world.solid as unknown as { component(def: unknown, p: unknown): void }).component(
				Cool,
				() => 0
			)
		).toThrow(/solid\.component/);
	});
});
