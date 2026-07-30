import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";

/**
 * `ECS.cursor` / `ECS.cursorRead` and their `ctx` twins — the re-pointable
 * single-entity accessor (ref.ts §Re-pointable cursor).
 *
 * The cursor exists for speed, but the reason it is a separate type rather than a
 * faster `ref` is that it follows entities ACROSS archetypes: its accessors read
 * through the archetype row plane rather than closing over one column group. So
 * the cases that matter here are the ones where the thing a cursor points at
 * moves — a different archetype, a swap-removed row, a grown column — and the
 * ones where `at()` must refuse.
 */
describe("cursor", () => {
	it("reads and writes the entity it is pointed at", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" }, { name: "Pos" });
		const a = ecs.spawn(ecs.template(Pos({ x: 1, y: 2 })));
		const b = ecs.spawn(ecs.template(Pos({ x: 10, y: 20 })));

		const p = ecs.cursor(Pos);
		p.at(a);
		expect(p.x).toBe(1);
		expect(p.y).toBe(2);

		p.at(b);
		expect(p.x).toBe(10);

		p.x = 99;
		expect(ecs.getField(b, Pos, "x")).toBe(99);
		// ...and `a` was not touched by the write that followed the repoint.
		expect(ecs.getField(a, Pos, "x")).toBe(1);
	});

	it("returns itself from at(), so a single read stays one expression", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const e = ecs.spawn(ecs.template(Pos({ x: 7 })));
		expect(ecs.cursor(Pos).at(e).x).toBe(7);
	});

	it("follows an entity into a different archetype", () => {
		// The case a ref cannot handle: a ref's prototype is bound to one column
		// group, so it would keep reading the old archetype's column.
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const Vel = ecs.registerComponent({ v: "f64" }, { name: "Vel" });
		const e = ecs.spawn(ecs.template(Pos({ x: 5 })));

		const p = ecs.cursor(Pos);
		p.at(e);
		expect(p.x).toBe(5);

		ecs.addComponent(e, Vel, { v: 1 }); // Pos-only archetype → Pos+Vel
		p.at(e);
		expect(p.x).toBe(5);
		p.x = 6;
		expect(ecs.getField(e, Pos, "x")).toBe(6);
	});

	it("re-resolves the row after a swap-remove moves it", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const first = ecs.spawn(ecs.template(Pos({ x: 1 })));
		const last = ecs.spawn(ecs.template(Pos({ x: 2 })));

		const p = ecs.cursor(Pos);
		p.at(last);
		expect(p.x).toBe(2);

		// Despawning `first` swaps `last` into row 0. A cursor pointed before the
		// mutation is stale by contract, but re-pointing must see the new row.
		ecs.despawn(first);
		p.at(last);
		expect(p.x).toBe(2);
		p.x = 3;
		expect(ecs.getField(last, Pos, "x")).toBe(3);
	});

	it("still addresses the right column after a grow replaces the buffers", () => {
		// The cursor holds `Archetype._bufs`, which a grow refills IN PLACE — this
		// is what that invariant buys.
		const ecs = new ECS({ memory: { columnCapacity: 4 } });
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const e = ecs.spawn(ecs.template(Pos({ x: 42 })));
		const p = ecs.cursor(Pos);
		p.at(e);
		expect(p.x).toBe(42);

		// Well past the initial capacity, forcing at least one grow.
		ecs.spawnMany(ecs.template(Pos({ x: 0 })), 200);
		p.at(e);
		expect(p.x).toBe(42);
		p.x = 43;
		expect(ecs.getField(e, Pos, "x")).toBe(43);
	});

	it("stamps the change tick on a mutable cursor but not a read-only one", () => {
		// White-box on `_changedTick`, like the `getColumn` cases in
		// integration/change_detection.test.ts: `changed()` compares against the
		// ITERATING SYSTEM's last run tick, so the tick itself is the honest
		// assertion for an accessor used outside a system.
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const e = ecs.spawn(ecs.template(Pos({ x: 1 })));
		const q = ecs.query(Pos);
		const tickOf = () => {
			let t = -1;
			for (const arch of q._nonEmpty()) t = arch._changedTick[Pos.id];
			return t;
		};

		// Advance the store tick so a stamp is distinguishable from the spawn's.
		ecs.update(1 / 60);
		ecs.update(1 / 60);
		const before = tickOf();

		ecs.cursorRead(Pos).at(e);
		expect(tickOf()).toBe(before);

		ecs.cursor(Pos).at(e);
		expect(tickOf()).toBeGreaterThan(before);
	});

	it("is seen by a changed() query when repointed inside a system", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const e = ecs.spawn(ecs.template(Pos({ x: 1 })));

		let seen = 0;
		const dq = ecs.query(Pos);
		const writer = ecs.registerSystem({
			...openAccess([Pos]),
			fn() {
				ecs.cursor(Pos).at(e);
			}
		});
		const detector = ecs.registerSystem({
			...openAccess([Pos]),
			fn() {
				dq.changed(Pos).forEach(() => {
					seen++;
				});
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		ecs.startup();

		ecs.update(1 / 60);
		expect(seen).toBe(1);
	});

	it("rejects a component whose field name collides with at()", () => {
		const ecs = new ECS();
		const Odd = ecs.registerComponent({ at: "f64" }, { name: "Odd" });
		expect(() => ecs.cursor(Odd)).toThrow(/field named "at"/);
	});

	it("shares one prototype across cursors for the same component", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const a = ecs.cursor(Pos);
		const b = ecs.cursor(Pos);
		expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
	});

	// The access check is on `at()`, not only on the call that makes the cursor.
	// A cursor is made one time and then kept, so it outlives the span that made
	// it — the two ways it escapes are below. Both wrote an undeclared component
	// with no error while the check was at the creation site only.
	describe("declared-access check follows the cursor to its point of use", () => {
		/** A system that declares `Tick` and nothing else. */
		const tickOnly = (name: string, Tick: any, fn: () => void) => ({
			name,
			reads: [Tick],
			writes: [Tick],
			spawns: [],
			despawns: [],
			transitions: [],
			resourceReads: [],
			resourceWrites: [],
			fn
		});

		it("throws for a host-made cursor that a system body uses", () => {
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
			const Tick = ecs.registerComponent({ n: "f64" }, { name: "Tick" });
			const e = ecs.spawn(ecs.template(Pos({ x: 1 }), Tick({ n: 0 })));

			// Made at host level, where no system is active — so the check at the
			// creation site passes, and only `at()` can catch this.
			const p = ecs.cursor(Pos);

			let err: unknown = null;
			const sys = ecs.registerSystem(
				tickOnly("declares_only_tick", Tick, () => {
					try {
						p.at(e);
					} catch (ex) {
						err = ex;
					}
				})
			);
			ecs.addSystems(SCHEDULE.UPDATE, sys);
			ecs.update(1 / 60);

			expect(String(err)).toMatch(/performed write on .*Pos.*didn't declare it/);
			expect(ecs.getField(e, Pos, "x")).toBe(1); // the write never landed
		});

		it("throws for a ctx cursor that escapes into another system", () => {
			// Worse than the host case: the cursor satisfies the DeclaredWrite
			// typestate in the system that makes it, and then writes an undeclared
			// component in the next one — both layers of the guarantee bypassed.
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
			const Tick = ecs.registerComponent({ n: "f64" }, { name: "Tick" });
			const e = ecs.spawn(ecs.template(Pos({ x: 1 }), Tick({ n: 0 })));

			let escaped: { at(id: any): unknown } | null = null;
			const owner = ecs.registerSystem({
				name: "owns_pos",
				reads: [Pos],
				writes: [Pos],
				spawns: [],
				despawns: [],
				transitions: [],
				resourceReads: [],
				resourceWrites: [],
				fn(ctx) {
					escaped ??= ctx.cursor(Pos);
				}
			});
			let err: unknown = null;
			const thief = ecs.registerSystem(
				tickOnly("declares_only_tick", Tick, () => {
					try {
						escaped?.at(e);
					} catch (ex) {
						err = ex;
					}
				})
			);
			ecs.addSystems(SCHEDULE.UPDATE, owner, {
				system: thief,
				ordering: { after: [owner] }
			});
			ecs.update(1 / 60);

			expect(String(err)).toMatch(/performed write on .*Pos.*didn't declare it/);
			expect(ecs.getField(e, Pos, "x")).toBe(1);
		});

		it("checks a read-only cursor against reads, not writes", () => {
			// `cursorRead` needs `reads` only — a system that declares the component
			// read-only may point one, and the mutable variant still may not.
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
			const e = ecs.spawn(ecs.template(Pos({ x: 5 })));

			const readCursor = ecs.cursorRead(Pos);
			const writeCursor = ecs.cursor(Pos);

			let readErr: unknown = null;
			let writeErr: unknown = null;
			const sys = ecs.registerSystem({
				name: "reads_pos_only",
				reads: [Pos],
				writes: [],
				spawns: [],
				despawns: [],
				transitions: [],
				resourceReads: [],
				resourceWrites: [],
				fn() {
					try {
						readCursor.at(e);
					} catch (ex) {
						readErr = ex;
					}
					try {
						writeCursor.at(e);
					} catch (ex) {
						writeErr = ex;
					}
				}
			});
			ecs.addSystems(SCHEDULE.UPDATE, sys);
			ecs.update(1 / 60);

			expect(readErr).toBeNull();
			expect(String(writeErr)).toMatch(/performed write on .*Pos.*didn't declare it/);
		});

		it("stays lenient at host level, where no system is active", () => {
			// The unattributable case the access check deliberately skips — an
			// `at()` outside every span must not start throwing.
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
			const e = ecs.spawn(ecs.template(Pos({ x: 1 })));
			const p = ecs.cursor(Pos);
			expect(() => p.at(e)).not.toThrow();
			p.x = 2;
			expect(ecs.getField(e, Pos, "x")).toBe(2);
		});

		it("passes for a host-made cursor the running system does declare", () => {
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
			const e = ecs.spawn(ecs.template(Pos({ x: 1 })));
			const p = ecs.cursor(Pos);

			const sys = ecs.registerSystem({
				...openAccess([Pos]),
				name: "declares_pos",
				fn() {
					p.at(e);
					p.x = 42;
				}
			});
			ecs.addSystems(SCHEDULE.UPDATE, sys);
			expect(() => ecs.update(1 / 60)).not.toThrow();
			expect(ecs.getField(e, Pos, "x")).toBe(42);
		});
	});

	it("works inside a system through ctx", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" }, { name: "Pos" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2 })), 8);

		const sys = ecs.registerSystem({
			name: "sweep",
			reads: [Pos],
			writes: [Pos],
			fn(ctx) {
				const p = ctx.cursor(Pos);
				for (let i = 0; i < ids.length; i++) {
					p.at(ids[i]);
					p.x += p.y;
				}
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.update(1 / 60);
		for (const e of ids) expect(ecs.getField(e, Pos, "x")).toBe(3);
	});
});
