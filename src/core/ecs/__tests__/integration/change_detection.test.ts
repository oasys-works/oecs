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
		// White-box: touches `_changedTick`/the mutable `getColumn`, so iterate
		// the `@internal` concrete archetype list rather than the public view.
		for (const arch of q._nonEmpty()) {
			expect(arch._changedTick[Pos.id]).toBe(0);
			arch.getColumn(Pos, "x", 5);
			expect(arch._changedTick[Pos.id]).toBe(5);
		}
	});

	it("get_column_read does NOT set _changed_tick", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		for (const arch of q._nonEmpty()) {
			arch.getColumnRead(Pos, "x");
			expect(arch._changedTick[Pos.id]).toBe(0);
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
				// Check the archetype directly
				const q = world.query(Pos);
				for (const arch of q._nonEmpty()) {
					expect(arch._changedTick[Pos.id]).toBe(ctx.ecsTick);
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
			fn(ctx) {
				for (const arch of wq._nonEmpty()) {
					arch.getColumn(Pos, "x", ctx.ecsTick);
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

	it("changed() detects writes from a prior tick when writer skips", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);
		const Vel = world.registerComponent(["vx", "vy"] as const);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });
		world.addComponent(e, Vel, { vx: 1, vy: 1 });

		// Writer mutates only on tick 0; skips every later tick.
		const wq = world.query(Pos, Vel);
		const writer = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				if (ctx.ecsTick !== 0) return;
				for (const arch of wq._nonEmpty()) {
					arch.getColumn(Pos, "x", ctx.ecsTick);
				}
			}
		});

		const changeTicks: number[] = [];
		const dq = world.query(Pos, Vel);
		const detector = world.registerSystem({
			...openAccess([Pos, Vel]),
			fn(ctx) {
				dq.changed(Pos).forEach(() => {
					changeTicks.push(ctx.ecsTick);
				});
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
		world.startup();

		world.update(1 / 60); // tick 0: writer mutates, detector observes
		world.update(1 / 60); // tick 1: writer skips, detector must still see the prior-tick change
		world.update(1 / 60); // tick 2: detector already observed on tick 1, no further change

		expect(changeTicks).toEqual([0, 1]);
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

		// Capture the ECS tick in effect, rather than hard-coding a value
		// reconstructed from store._tick bookkeeping. store._tick is set at the
		// start of each update() and left in place afterwards, so the tick a
		// system observes on the final update is the same one a following
		// immediate-mode transition stamps.
		let capturedTick = -1;
		const probe = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				capturedTick = ctx.ecsTick;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, probe);
		world.startup();
		world.update(1 / 60);
		world.update(1 / 60);

		// addComponent triggers an archetype transition that stamps the
		// current store tick — exactly the tick the system observed.
		world.addComponent(e, Tag);

		const q = world.query(Pos, Tag);
		let checked = false;
		for (const arch of q._nonEmpty()) {
			// moveEntityFrom marks all dst components as changed at the
			// transition's tick.
			expect(arch._changedTick[Pos.id]).toBe(capturedTick);
			checked = true;
		}
		expect(checked).toBe(true);
	});

	//=========================================================
	// addEntity does NOT tick
	//=========================================================

	it("add_entity zero-fill does not independently tick", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x", "y"] as const);

		// Capture the ECS tick in effect for the addComponent below instead
		// of hard-coding it (see the structural-transition test above for why a
		// system's observed tick equals a following addComponent's stamp).
		let capturedTick = -1;
		const probe = world.registerSystem({
			...openAccess([Pos]),
			fn(ctx) {
				capturedTick = ctx.ecsTick;
			}
		});
		world.addSystems(SCHEDULE.UPDATE, probe);
		world.startup();
		world.update(1 / 60);
		world.update(1 / 60);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		let checked = false;
		for (const arch of q._nonEmpty()) {
			// Ticked by writeFields in addComponent at the current ECS tick,
			// not by addEntity's zero-fill (which pushes zeroes without ticking).
			expect(arch._changedTick[Pos.id]).toBe(capturedTick);
			checked = true;
		}
		expect(checked).toBe(true);
	});
});
