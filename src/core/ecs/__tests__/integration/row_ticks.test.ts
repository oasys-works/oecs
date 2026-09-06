/**
 * The row grain of change detection: `cols.ticks(def)`, the row tick plane,
 * and the two-source drain (`Store.drainSet`) behind an entity-level onSet.
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { snapshots } from "../../../../plugins/snapshots";
import { Store } from "../../store";
import { SCHEDULE } from "../../schedule";
import { getEntityIndex, type EntityID } from "../../entity";
import { ECS_ERROR } from "../../utils/error";
import { openAccess } from "../test_helpers";
import { observers } from "../../../../plugins/observers";



function world() {
	const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
	const Pos = ecs.registerComponent(["x"] as const, "i32");
	const Tag = ecs.registerTag();
	const fired: number[] = [];
	ecs.observe(Pos, {
		onSet: (eid) => fired.push(getEntityIndex(eid)),
		granularity: "entity",
		access: openAccess([Pos])
	});
	const ids: EntityID[] = [];
	for (let i = 0; i < 6; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 0 });
		ids.push(e);
	}
	return { ecs, Pos, Tag, ids, fired };
}

const idx = (ids: EntityID[], ...at: number[]) => at.map((i) => getEntityIndex(ids[i])).sort((a, b) => a - b);

describe("cols.ticks, the row record", () => {
	it("fires once per stamped row, in entity order, and never for a row left alone", () => {
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				q.forEachChunk((cols, n) => {
					const { x } = cols.mut(Pos);
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) {
						if (i % 2 === 1) {
							x[i] = i;
							t[i] = cols.tick;
						}
					}
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 1, 3, 5));
		expect(fired).toEqual([...fired].sort((a, b) => a - b));
	});

	it("does not fire for a chunk loop that takes the column and stamps nothing", () => {
		const { ecs, Pos, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				q.forEachChunk((cols) => {
					cols.mut(Pos);
					cols.ticks(Pos);
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("keeps the by-id record of an archetype the scan does not visit", () => {
		// A scan frame covers the archetypes a writer stamped. `markChanged`
		// stamps no archetype, so an entity it records in an archetype nobody
		// wrote comes from the list.
		const { ecs, Pos, Tag, ids, fired } = world();
		ecs.addComponent(ids[5], Tag);
		const plain = ecs.query(Pos).not(Tag);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				plain.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[0]) t[i] = cols.tick;
				});
				ctx.markChanged(ids[5], Pos);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 0, 5));
	});

	it("collapses a setField and a row stamp on one entity into one firing", () => {
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				ctx.setField(ids[2], Pos, "x", 7);
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[2]) t[i] = cols.tick;
				});
				ctx.setField(ids[2], Pos, "x", 8);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 2));
	});

	it("skips a disabled row, and reports it again once enabled and stamped", () => {
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		let stampAll = true;
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				if (!stampAll) return;
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) t[i] = cols.tick;
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.disable(ids[1]);
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 0, 2, 3, 4, 5));
		fired.length = 0;
		stampAll = false;
		ecs.enable(ids[1]);
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
		stampAll = true;
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 0, 1, 2, 3, 4, 5));
	});

	it("carries a row's record across a transition made after the stamp", () => {
		const { ecs, Pos, Tag, ids, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos, Tag]),
			fn: (ctx) => {
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[3]) t[i] = cols.tick;
				});
				ctx.commands.add(ids[3], Tag);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 3));
		expect(ecs.hasComponent(ids[3], Tag)).toBe(true);
	});

	it("does not fire for a stamped row whose entity is destroyed before the drain", () => {
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[4]) t[i] = cols.tick;
				});
				ctx.commands.despawn(ids[4]);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("keeps the record with the row through a swap-remove of another entity", () => {
		// Destroying the last row's neighbour moves the last row down. The
		// record must follow the moved row, and the removed row's slot must not
		// report the entity that landed in it.
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[5]) t[i] = cols.tick;
				});
				ctx.commands.despawn(ids[0]);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		expect(fired).toEqual(idx(ids, 5));
	});

	it("survives a grow of the archetype between the stamp and the drain", () => {
		const ecs = ECS.create({ ...({ deterministic: true, memory: { entities: 64, columnCapacity: 8 } }), plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		const fired: number[] = [];
		ecs.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const T = ecs.template(Pos({ x: 0 }));
		const first = ecs.spawn(T);
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({ ...openAccess([Pos]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		// A host stamp, then enough host spawns to grow the archetype past its
		// column capacity, then the drain.
		q.forEachChunk((cols, n) => {
			const t = cols.ticks(Pos);
			for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === first) t[i] = cols.tick;
		});
		for (let i = 0; i < 40; i++) ecs.spawn(T);
		ecs.update(1 / 60);
		expect(fired).toEqual([getEntityIndex(first)]);
		expect(ecs.query(Pos).entityCount).toBe(41);
	});

	it("throws for a component no entity-level onSet tracks", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Vel = ecs.registerComponent(["v"] as const, "i32");
		ecs.spawn(ecs.template(Vel({ v: 0 })));
		const q = ecs.query(Vel);
		expect(() => q.forEachChunk((cols) => void cols.ticks(Vel))).toThrow(
			expect.objectContaining({ category: ECS_ERROR.ROW_TICKS_NOT_TRACKED })
		);
	});

	it("reports nothing a stamp before a snapshot restore recorded", () => {
		const { ecs, Pos, ids, fired } = world();
		const q = ecs.query(Pos);
		let stamp = false;
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				if (!stamp) return;
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[2]) t[i] = cols.tick;
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		const bytes = ecs.snapshots.capture();
		ecs.update(1 / 60);
		fired.length = 0;
		stamp = true;
		// A raw stamp lands, then the restore replaces the rows under it.
		q.forEachChunk((cols, n) => {
			const t = cols.ticks(Pos);
			for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === ids[2]) t[i] = cols.tick;
		});
		ecs.snapshots.restore(bytes);
		stamp = false;
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
	});

	it("drops a tracked component's pending records when its last observer is disposed", () => {
		const { ecs, Pos, ids } = world();
		const late: number[] = [];
		const q = ecs.query(Pos);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				q.forEachChunk((cols, n) => {
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) t[i] = cols.tick;
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		// The fixture's observer fired for every row. Replace it: the stamps made
		// before the new one registered must not come back.
		const handle = ecs.observe(Pos, {
			onSet: (eid) => late.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		ecs.removeSystem(sys);
		ecs.update(1 / 60);
		expect(late).toEqual([]);
		handle.dispose();
		void ids;
	});
});

describe("the tick plane of a freed slot", () => {
	it("does not report a template spawn into the slot a stamped row left", () => {
		// The last row's entity is stamped, then despawned: its slot keeps the
		// stamp unless the next append zeroes the tick plane. A template spawn
		// lands in that slot, in a frame where the drain scans, and it must not
		// fire: an insert is structural, and `onAdd` reports it.
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		const fired: number[] = [];
		ecs.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const T = ecs.template(Pos({ x: 0 }));
		const ids: EntityID[] = [];
		for (let i = 0; i < 4; i++) ids.push(ecs.spawn(T));
		const sys = ecs.registerSystem({ ...openAccess([Pos]), fn: () => {} });
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		const q = ecs.query(Pos);
		const last = ids[3];
		q.forEachChunk((cols, n) => {
			const t = cols.ticks(Pos);
			for (let i = 0; i < n; i++) if (cols.arch.entityIds[i] === last) t[i] = cols.tick;
		});
		ecs.despawn(last);
		const fresh = ecs.spawn(T);
		ecs.update(1 / 60);
		expect(fired).toEqual([]);
		expect(ecs.isAlive(fresh)).toBe(true);
	});
});

describe("the row grain as a pull: trackRows, ticksRead and changed().forEachChunk", () => {
	it("reports the rows written since the reader's previous run, once each", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		ecs.trackRows(Pos);
		const ids: EntityID[] = [];
		for (let i = 0; i < 6; i++) {
			const e = ecs.spawn();
			ecs.addComponent(e, Pos, { x: 0 });
			ids.push(e);
		}
		let frame = 0;
		const writer = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				if (frame === 1) ctx.setField(ids[1], Pos, "x", 1);
				if (frame === 1) ctx.ref(Pos, ids[4]).x = 4;
				if (frame === 2) ctx.cursor(Pos).at(ids[2]).x = 2;
			}
		});
		const seen: number[][] = [];
		const moved = ecs.query(Pos).changed(Pos);
		const reader = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				const rows: number[] = [];
				moved.forEachChunk((cols, n) => {
					const t = cols.ticksRead(Pos);
					const eids = cols.arch.entityIds;
					for (let i = 0; i < n; i++) if (t[i] > cols.since) rows.push(getEntityIndex(eids[i]));
				});
				seen.push(rows.sort((a, b) => a - b));
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, writer, { system: reader, ordering: { after: [writer] } });
		ecs.startup();
		for (frame = 0; frame < 4; frame++) ecs.update(1 / 60);
		// Frame 0: the spawn made no record, so no row. Frame 1: the two writes.
		// Frame 2: the cursor write. Frame 3: nothing.
		expect(seen).toEqual([[], idx(ids, 1, 4), idx(ids, 2), []]);
	});

	it("sees a row stamped in a chunk loop through ticksRead, and never a row left alone", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		ecs.trackRows(Pos);
		const T = ecs.template(Pos({ x: 0 }));
		const ids: EntityID[] = [];
		for (let i = 0; i < 5; i++) ids.push(ecs.spawn(T));
		const q = ecs.query(Pos);
		const writer = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				q.forEachChunk((cols, n) => {
					const { x } = cols.mut(Pos);
					const t = cols.ticks(Pos);
					for (let i = 0; i < n; i++) {
						if (i === 3) {
							x[i] = 9;
							t[i] = cols.tick;
						}
					}
				});
			}
		});
		const seen: number[] = [];
		const reader = ecs.registerSystem({
			...openAccess([Pos]),
			fn: () => {
				q.changed(Pos).forEachChunk((cols, n) => {
					const t = cols.ticksRead(Pos);
					for (let i = 0; i < n; i++) if (t[i] > cols.since) seen.push(getEntityIndex(cols.arch.entityIds[i]));
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, writer, { system: reader, ordering: { after: [writer] } });
		ecs.startup();
		ecs.update(1 / 60);
		expect(seen).toEqual(idx(ids, 3));
	});

	it("hands a plain chunk loop the change tick of the system's own previous run", () => {
		// The two cases above read `cols.since` through `changed().forEachChunk`,
		// which is a different method on a different class. A plain `forEachChunk`
		// fills the same field, and this pins it.
		//
		// The expected value comes from the schedule, not from a run. Before each
		// body the phase loop reads the system's slot into `lastRunTick`, then
		// advances the change tick and hands that value to the pass as `cols.tick`,
		// then writes it back to the slot after the body. So the `since` of one
		// pass is the `tick` of the pass before it, and 0 before the first.
		const ecs = ECS.create({ ...({ deterministic: true }) });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		ecs.spawn(ecs.template(Pos({ x: 0 })));
		const q = ecs.query(Pos);
		const ticks: number[] = [];
		const sinces: number[] = [];
		ecs.addSystems(
			SCHEDULE.UPDATE,
			ecs.registerSystem({
				...openAccess([Pos]),
				fn: () => {
					q.forEachChunk((cols) => {
						ticks.push(cols.tick);
						sinces.push(cols.since);
					});
				}
			})
		);
		ecs.startup();
		for (let i = 0; i < 4; i++) ecs.update(1 / 60);

		expect(sinces).toEqual([0, ...ticks.slice(0, -1)]);
		// Non-vacuous. Every run takes a tick of its own, so the expectation above
		// is not a list of zeroes that any value would satisfy.
		expect(ticks.length).toBeGreaterThan(1);
		expect(new Set(ticks).size).toBe(ticks.length);
		expect(Math.min(...ticks)).toBeGreaterThan(0);
	});

	it("throws through ticksRead when no row ticks exist, and trackRows is idempotent", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const Vel = ecs.registerComponent(["v"] as const, "i32");
		ecs.spawn(ecs.template(Vel({ v: 0 })));
		const q = ecs.query(Vel);
		expect(() => q.forEachChunk((cols) => void cols.ticksRead(Vel))).toThrow(
			expect.objectContaining({ category: ECS_ERROR.ROW_TICKS_NOT_TRACKED })
		);
		ecs.trackRows(Vel);
		ecs.trackRows(Vel);
		expect(() => q.forEachChunk((cols) => void cols.ticksRead(Vel))).not.toThrow();
	});

	it("accepts a sparse component, and rejects a malformed handle", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), observers()] });
		const S = ecs.registerSparseComponent({ v: "i32" });
		expect(() => ecs.trackRows(S)).not.toThrow();
		expect(() => ecs.trackRows({} as never)).toThrow(
			expect.objectContaining({ category: ECS_ERROR.COMPONENT_NOT_REGISTERED })
		);
	});
});

describe("the by-id record switches to the scan past the list cap", () => {
	it("fires once per written entity when a system writes far more rows than the cap", () => {
		// The cap is a fraction of the live count with a floor, so a small world
		// crosses it with a few hundred by-id writes. Every written entity must
		// still fire exactly one time, and an entity recorded by `markChanged`
		// in an archetype nobody wrote must still fire from the list.
		const ecs = ECS.create({ ...({ deterministic: true, memory: { entities: 4096 } }), plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		const Tag = ecs.registerTag();
		const fired: number[] = [];
		ecs.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		const T = ecs.template(Pos({ x: 0 }));
		const ids: EntityID[] = [];
		for (let i = 0; i < 1000; i++) ids.push(ecs.spawn(T));
		const apart = ecs.spawn(T);
		ecs.addComponent(apart, Tag);
		const sys = ecs.registerSystem({
			...openAccess([Pos]),
			fn: (ctx) => {
				for (let i = 0; i < ids.length; i += 2) ctx.setField(ids[i], Pos, "x", i);
				ctx.markChanged(apart, Pos);
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(1 / 60);
		const want = [];
		for (let i = 0; i < ids.length; i += 2) want.push(getEntityIndex(ids[i]));
		want.push(getEntityIndex(apart));
		expect(fired).toEqual(want.sort((a, b) => a - b));
		fired.length = 0;
		ecs.update(1 / 60);
		expect(fired.length).toBe(501);
	});
});

describe("the drain baseline of an entity-level onSet", () => {
	it("reports the first write after the observer joins a tracked component", () => {
		const ecs = ECS.create({ plugins: [snapshots(), observers()] });
		const Pos = ecs.registerComponent(["x"] as const, "i32");
		// The plane exists before the observer, which `trackRows` alone gives.
		ecs.trackRows(Pos);
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 0 });
		// A write that stamps the row while nothing drains it.
		ecs.setField(e, Pos, "x", 1);
		ecs.update(1 / 60);

		const fired: number[] = [];
		ecs.observe(Pos, {
			onSet: (eid) => fired.push(getEntityIndex(eid)),
			granularity: "entity",
			access: openAccess([Pos])
		});
		ecs.setField(e, Pos, "x", 2);
		ecs.update(1 / 60);
		expect(fired).toEqual([getEntityIndex(e)]);
	});

	it("reports one entity one time when the component leaves and joins between writes", () => {
		const { ecs, Pos, ids, fired } = world();
		ecs.update(1 / 60);
		fired.length = 0;
		const e = ids[0];
		ecs.setField(e, Pos, "x", 1);
		// The new row has no stamp to carry, so the record path reopens.
		ecs.removeComponent(e, Pos);
		ecs.addComponent(e, Pos, { x: 0 });
		ecs.setField(e, Pos, "x", 2);
		ecs.update(1 / 60);
		expect(fired).toEqual([getEntityIndex(e)]);
	});

	it("gives a tag no row ticks, because no write can record one", () => {
		// The record paths read `Archetype.rowTicks[cid]` with no test, on the
		// promise of `rowTicks`. `installTicks` gives a fieldless component no
		// column, so the flag must stay false for one, or the promise is a lie.
		const store = new Store();
		const Tag = store.registerComponent({});
		store.trackRows(Tag);
		expect(store.anyDirtyTracked).toBe(false);

		const Pos = store.registerComponent({ x: "i32" });
		store.trackRows(Pos);
		expect(store.anyDirtyTracked).toBe(true);
	});
});
