/**
 * Change detection for a sparse component: the row tick for each entity
 * index, the entity-level onSet that reads it, and the `sparseChanged` pull.
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { snapshots } from "../../../../capabilities/snapshots";
import { SCHEDULE } from "../../schedule";
import { getEntityIndex, type EntityID } from "../../entity";
import { ECS_ERROR } from "../../utils/error";
import { openAccess } from "../test_helpers";
import { observers } from "../../../../capabilities/observers";

function world() {
	const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
	const Pos = ecs.registerComponent(["x"] as const, "i32");
	const Cool = ecs.registerSparseComponent({ v: "i32" }, { name: "Cool" });
	const fired: number[] = [];
	ecs.observe(Cool, {
		onSet: (eid) => fired.push(getEntityIndex(eid)),
		granularity: "entity",
		access: openAccess([], [], [Cool])
	});
	const ids: EntityID[] = [];
	for (let i = 0; i < 5; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 0 });
		ecs.addSparse(e, Cool, { v: 0 });
		ids.push(e);
	}
	return { ecs, Pos, Cool, ids, fired };
}

const idx = (ids: EntityID[], ...at: number[]) => at.map((i) => getEntityIndex(ids[i])).sort((a, b) => a - b);

describe("a sparse component with an entity-level onSet", () => {
	it("fires once for each entity a setSparseField wrote, in entity order, and not for an add", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				ctx.setSparseField(ids[3], Cool, "v", 1);
				ctx.setSparseField(ids[1], Cool, "v", 2);
				ctx.setSparseField(ids[1], Cool, "v", 3);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		// The five adds before startup made no record.
		expect(fired).toEqual(idx(ids, 1, 3));
		fired.length = 0;
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 1, 3));
	});

	it("records a mutable sparse cursor on each at, and a read-only one never", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				const w = ctx.sparseCursor(Cool);
				w.at(ids[2]).v = 7;
				w.at(ids[4]);
				const r = ctx.sparseCursorRead(Cool);
				void r.at(ids[0]).v;
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 2, 4));
	});

	it("records a host write between frames and fires once", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({ ...openAccess([], [], [Cool]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		ecs.setSparseField(ids[0], Cool, "v", 9);
		ecs.sparseCursor(Cool).at(ids[4]).v = 8;
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 0, 4));
		fired.length = 0;
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("skips a disabled entity, and does not fire for one that left the component", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				ctx.setSparseField(ids[1], Cool, "v", 1);
				ctx.setSparseField(ids[2], Cool, "v", 1);
				ctx.removeSparse(ids[2], Cool);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.disable(ids[1]);
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("does not fire for a member re-added into a slot with a stale tick", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({ ...openAccess([], [], [Cool]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.setSparseField(ids[2], Cool, "v", 5);
		ecs.removeSparse(ids[2], Cool);
		ecs.addSparse(ids[2], Cool, { v: 6 });
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("drops the pending records when the last observer is disposed", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Cool = ecs.registerSparseComponent({ v: "i32" });
		const first: number[] = [];
		const h = ecs.observe(Cool, {
			onSet: (eid) => first.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([], [], [Cool])
		});
		const e = ecs.spawn();
		ecs.addSparse(e, Cool, { v: 0 });
		const sys = ecs.registerSystem({ ...openAccess([], [], [Cool]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.setSparseField(e, Cool, "v", 1);
		h.dispose();
		const late: number[] = [];
		ecs.observe(Cool, {
			onSet: (eid) => late.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([], [], [Cool])
		});
		ecs.update(1 / 60);
		expect(first).toEqual([]);
		expect(late).toEqual([]);
	});

	it("rejects every other callback shape on a sparse component", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Cool = ecs.registerSparseComponent({ v: "i32" });
		const bad = () =>
			ecs.observe(Cool as never, {
				onAdd: () => {},
				access: openAccess([], [], [Cool])
			});
		expect(bad).toThrow(expect.objectContaining({ category: ECS_ERROR.OBSERVER_INVALID_CONFIG }));
		const arch = () =>
			ecs.observe(Cool as never, {
				onSet: () => {},
				granularity: "archetype",
				access: openAccess([], [], [Cool])
			});
		expect(arch).toThrow(expect.objectContaining({ category: ECS_ERROR.OBSERVER_INVALID_CONFIG }));
	});
});

describe("sparseChanged, the row grain of a sparse component as a pull", () => {
	it("is true for the run after a write, and false after that", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Cool = ecs.registerSparseComponent({ v: "i32" });
		ecs.trackRows(Cool);
		ecs.trackRows(Cool);
		const a = ecs.spawn();
		const b = ecs.spawn();
		ecs.addSparse(a, Cool, { v: 0 });
		ecs.addSparse(b, Cool, { v: 0 });
		let frame = 0;
		const writer = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				if (frame === 1) ctx.setSparseField(a, Cool, "v", 1);
			}
		});
		const seen: boolean[][] = [];
		const reader = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				seen.push([ctx.sparseChanged(Cool, a), ctx.sparseChanged(Cool, b)]);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, writer, { system: reader, ordering: { after: [writer] } });
		ecs.startup();
		for (frame = 0; frame < 3; frame++) ecs.update(1 / 60);
		expect(seen).toEqual([
			[false, false],
			[true, false],
			[false, false]
		]);
	});

	it("throws without row ticks, and reads false for a non-member", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Cool = ecs.registerSparseComponent({ v: "i32" });
		const e = ecs.spawn();
		const outside = ecs.spawn();
		ecs.addSparse(e, Cool, { v: 0 });
		let threw: unknown = null;
		let nonMember: boolean | null = null;
		const sys = ecs.registerSystem({
			...openAccess([], [], [Cool]),
			fn: (ctx) => {
				try {
					ctx.sparseChanged(Cool, e);
				} catch (err) {
					threw = err;
				}
				ecs.trackRows(Cool);
				ecs.setSparseField(e, Cool, "v", 1);
				nonMember = ctx.sparseChanged(Cool, outside);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(threw).toEqual(expect.objectContaining({ category: ECS_ERROR.ROW_TICKS_NOT_TRACKED }));
		expect(nonMember).toBe(false);
	});

	it("reports nothing a stamp before a sparse restore recorded", () => {
		const { ecs, Cool, ids, fired } = world();
		const sys = ecs.registerSystem({ ...openAccess([], [], [Cool]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		const bytes = ecs.snapshots.captureSparse();
		ecs.setSparseField(ids[3], Cool, "v", 4);
		ecs.snapshots.restoreSparse(bytes);
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});
});
