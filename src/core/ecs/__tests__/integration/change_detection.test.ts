import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { openAccess } from "../test_helpers";

describe("Change Detection", () => {
	//=========================================================
	// Tick basics
	//=========================================================

	it("get_column (mutable) sets _changed_tick on archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		// White-box: touches `_changedTick`/the mutable `getColumnMut`, so iterate
		// the `@internal` concrete archetype list rather than the public view.
		for (const arch of q.nonEmptyArchs()) {
			// The host addComponent above stamped the insert, so read the value
			// rather than assume it, then stamp a distinct one.
			const before = arch.changedTick[Pos.id];
			arch.getColumnMut(Pos, "x", before + 5);
			expect(arch.changedTick[Pos.id]).toBe(before + 5);
		}
	});

	it("get_column_read does not set _changed_tick", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		for (const arch of q.nonEmptyArchs()) {
			const before = arch.changedTick[Pos.id];
			arch.getColumnRead(Pos, "x");
			expect(arch.changedTick[Pos.id]).toBe(before);
		}
	});

	//=========================================================
	// ref (mutable) ticks eagerly
	//=========================================================

	it("ref ticks component as changed at creation time", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		let ticked = false;
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				ctx.ref(Pos, e);
				// Check the archetype directly. The stamp is the change tick of this
				// run, and not the frame tick.
				const q = world.query(Pos);
				for (const arch of q.nonEmptyArchs()) {
					expect(arch.changedTick[Pos.id]).toBe(world.getChangeTick());
					ticked = true;
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(1 / 60);
		expect(ticked).toBe(true);
	});

	//=========================================================
	// ChangedQuery filtering
	//=========================================================

	it("changed() includes archetypes modified this tick", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });
		world.addComponent(e, Vel, { vx: 1, vy: 1 });

		let changeCount = 0;
		const wq = world.query(Pos, Vel);
		const writer = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn() {
				for (const arch of wq.nonEmptyArchs()) {
					arch.getColumnMut(Pos, "x", world.getChangeTick());
				}
			}
		});

		const dq = world.query(Pos, Vel);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn() {
				dq.changed(Pos).forEach(() => {
					changeCount++;
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();

		world.update(1 / 60);
		expect(changeCount).toBe(1);

		world.update(1 / 60);
		expect(changeCount).toBe(2);
	});

	// One write is reported once, whichever of the two systems runs first.
	// A frame tick cannot order a writer and a reader inside one frame, so a
	// write by an earlier system was reported on that frame and again on the
	// next. The change tick advances before every run, so it can.
	function oneWriteOnce(writerFirst: boolean): number[] {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		// Writer mutates only on frame 1. Skips every other frame.
		const writer = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				if (ctx.ecsTick === 1) ctx.setField(e, Pos, "x", 1);
			}
		});

		const changeTicks: number[] = [];
		const dq = world.query(Pos);
		const detector = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				dq.changed(Pos).forEach(() => {
					changeTicks.push(ctx.ecsTick);
				});
			}
		});

		if (writerFirst) {
			world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		} else {
			world.addSystems(SCHEDULE.UPDATE, detector, { system: writer, ordering: { after: [detector] } });
		}
		world.startup();
		for (let i = 0; i < 4; i++) world.update(1 / 60);
		return changeTicks;
	}

	it("changed() reports a write once when the writer runs before the reader", () => {
		// Frame 0 reports the row the spawn inserted. Frame 1 reports the write,
		// made earlier in the same frame. Frames 2 and 3 report nothing.
		expect(oneWriteOnce(true)).toEqual([0, 1]);
	});

	it("changed() reports a write once when the writer runs after the reader", () => {
		// The write on frame 1 lands after the reader ran, so the reader sees it
		// on frame 2, and never again.
		expect(oneWriteOnce(false)).toEqual([0, 2]);
	});

	it("changed() reports a host write between frames once", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const changeTicks: number[] = [];
		const dq = world.query(Pos);
		const detector = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				dq.changed(Pos).forEach(() => {
					changeTicks.push(ctx.ecsTick);
				});
			}
		});
		world.addSystems(SCHEDULE.UPDATE, detector);
		world.startup();
		world.update(1 / 60); // frame 0 reports the spawn
		world.update(1 / 60);
		world.setField(e, Pos, "x", 5); // between frames 1 and 2
		world.update(1 / 60);
		world.update(1 / 60);
		expect(changeTicks).toEqual([0, 2]);
	});

	it("changed() does not report a system's own stamp on its next run", () => {
		// A system that takes the mutable column group every frame stamps the
		// archetype every frame. Its own `changed()` must not fire on that stamp
		// a frame later, or the query would fire on every frame for a writer.
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const seen: number[] = [];
		const q = world.query(Pos);
		const sys = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				// Read first: the previous frame's own stamp must not show.
				q.changed(Pos).forEach(() => seen.push(ctx.ecsTick));
				q.forEachChunk((cols) => void cols.mut(Pos));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		for (let i = 0; i < 4; i++) world.update(1 / 60);
		// Frame 0 reports the spawn. Nothing after that.
		expect(seen).toEqual([0]);
	});

	//=========================================================
	// Structural transitions tick destination
	//=========================================================

	it("structural transition ticks all components on destination archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Tag = world.registerTag();

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1, y: 2 });

		world.startup();
		world.update(1 / 60);
		world.update(1 / 60);

		// addComponent triggers an archetype transition that stamps the change
		// tick of the host window, the value `update()` leaves behind.
		const capturedTick = world.getChangeTick();
		world.addComponent(e, Tag);

		const q = world.query(Pos, Tag);
		let checked = false;
		for (const arch of q.nonEmptyArchs()) {
			// moveEntityFrom marks all dst components as changed at the
			// transition's tick.
			expect(arch.changedTick[Pos.id]).toBe(capturedTick);
			checked = true;
		}
		expect(checked).toBe(true);
	});

	//=========================================================
	// addEntity does not tick
	//=========================================================

	it("add_entity zero-fill does not independently tick", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		world.startup();
		world.update(1 / 60);
		world.update(1 / 60);

		// The host window's change tick, the value the addComponent below stamps.
		const capturedTick = world.getChangeTick();
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		let checked = false;
		for (const arch of q.nonEmptyArchs()) {
			// Ticked by writeFields in addComponent at the current ECS tick,
			// not by addEntity's zero-fill (which pushes zeroes without ticking).
			expect(arch.changedTick[Pos.id]).toBe(capturedTick);
			checked = true;
		}
		expect(checked).toBe(true);
	});
});
