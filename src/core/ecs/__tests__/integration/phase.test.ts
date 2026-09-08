/**
 * The open phase set.
 *
 * A world starts with the seven built-in phases. `ecs.addPhase` adds one more
 * slot to a loop and hands back a handle. This file holds the rule that makes
 * the feature worth having: a plugin that owns a slot runs between two
 * built-ins it names, and not wherever insertion order inside a shared phase
 * happens to put it.
 *
 * The plugin here installs through `PluginHost.world`, which is the same bare
 * world a plugin outside this package gets, so the seam it uses is the
 * published one.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE, type Phase } from "../../phase";
import { ECSError, ECS_ERROR } from "../../utils/error";
import type { Plugin, PluginHost } from "../../plugin";
import { FrameTraceRecorder } from "../../frame_trace";

/** The surface the phase-owning plugin contributes. */
interface PhysicsPlugin {
	readonly physics: { readonly phase: Phase };
}

/** A plugin that owns one update-loop slot between `PRE_UPDATE` and `UPDATE`,
 * and schedules its own system into it. `order` records the run order. */
function physics(order: string[]): Plugin<PhysicsPlugin> {
	return {
		name: "physics",
		install(host: PluginHost): PhysicsPlugin {
			const phase = host.world.addPhase("physics", {
				loop: "update",
				after: [SCHEDULE.PRE_UPDATE],
				before: [SCHEDULE.UPDATE]
			});
			host.world.addSystems(
				phase,
				host.world.registerSystem({
					name: "integrate",
					reads: [],
					writes: [],
					fn: () => order.push("integrate")
				})
			);
			return { physics: { phase } };
		}
	};
}

/** Run `fn` and return the `ECSError` it threw. */
function thrown(fn: () => unknown): ECSError {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(ECSError);
		return e as ECSError;
	}
	expect.unreachable("expected a fault, got a value");
	throw new Error("unreachable");
}

describe("a phase a plugin adds", () => {
	it("runs between the two built-ins it names, whatever order the app registers in", () => {
		const order: string[] = [];
		const world = ECS.create({ plugins: [physics(order)] });
		// Registered after the plugin's system, and into the phase that runs
		// first. Insertion order alone would put `early` last, so the assertion
		// below is about the phase order and nothing else.
		world.addSystems(
			SCHEDULE.PRE_UPDATE,
			world.registerSystem({ name: "early", reads: [], writes: [], fn: () => order.push("early") })
		);
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({ name: "late", reads: [], writes: [], fn: () => order.push("late") })
		);
		world.startup();
		order.length = 0;
		world.update(1 / 60);
		expect(order).toEqual(["early", "integrate", "late"]);
	});

	it("hands back a handle whose identity, and not whose name, picks the phase", () => {
		const order: string[] = [];
		const world = ECS.create({ plugins: [physics(order)] });
		// A second phase with the same name is a second phase. Its system runs
		// once, not twice, and the two lists stay apart.
		const second = world.addPhase("physics", { loop: "update", after: [SCHEDULE.UPDATE] });
		expect(second).not.toBe(world.physics.phase);
		world.addSystems(
			second,
			world.registerSystem({
				name: "second",
				reads: [],
				writes: [],
				fn: () => order.push("second")
			})
		);
		world.startup();
		order.length = 0;
		world.update(1 / 60);
		expect(order).toEqual(["integrate", "second"]);
	});

	it("runs at the tail of its loop when it names no neighbour", () => {
		const order: string[] = [];
		const world = new ECS();
		const tail = world.addPhase("tail", { loop: "update" });
		world.addSystems(
			tail,
			world.registerSystem({ reads: [], writes: [], fn: () => order.push("tail") })
		);
		world.addSystems(
			SCHEDULE.POST_UPDATE,
			world.registerSystem({ reads: [], writes: [], fn: () => order.push("post") })
		);
		world.startup();
		order.length = 0;
		world.update(1 / 60);
		expect(order).toEqual(["post", "tail"]);
	});

	it("runs once per startup when its loop is startup, and never on an update", () => {
		const order: string[] = [];
		const world = new ECS();
		const seed = world.addPhase("seed", { loop: "startup", before: [SCHEDULE.STARTUP] });
		world.addSystems(
			seed,
			world.registerSystem({ reads: [], writes: [], fn: () => order.push("seed") })
		);
		world.addSystems(
			SCHEDULE.PRE_STARTUP,
			world.registerSystem({ reads: [], writes: [], fn: () => order.push("pre") })
		);
		world.startup();
		expect(order).toEqual(["pre", "seed"]);
		world.update(1 / 60);
		expect(order).toEqual(["pre", "seed"]);
	});

	it("drives the fixed accumulator when its loop is fixed", () => {
		const order: string[] = [];
		const world = new ECS({ fixedTimestep: 1 / 60 });
		const step = world.addPhase("step", { loop: "fixed" });
		world.addSystems(
			step,
			world.registerSystem({ reads: [], writes: [], fn: () => order.push("step") })
		);
		world.startup();
		order.length = 0;
		// Two whole fixed steps of delta, so the accumulator runs the phase twice.
		world.update(2 / 60);
		expect(order).toEqual(["step", "step"]);
	});

	it("leaves the fixed accumulator asleep while its fixed phase holds no system", () => {
		const world = new ECS({ fixedTimestep: 1 / 60 });
		// An empty fixed phase is a phase, not a system. The world asks whether
		// any fixed system exists, so adding the slot alone must not wake the
		// accumulator loop.
		world.addPhase("step", { loop: "fixed" });
		const trace = new FrameTraceRecorder();
		world.setTrace(trace);
		world.startup();
		world.update(2 / 60);
		const frames = trace.frames();
		const flushed = frames[frames.length - 1]!.events.filter((e) => e.kind === "flush_begin").map(
			(e) => (e as { phase: string }).phase
		);
		expect(flushed).not.toContain("step");
		expect(flushed).not.toContain(SCHEDULE.FIXED_UPDATE);
	});

	it("names itself in the frame trace", () => {
		const world = new ECS();
		const phase = world.addPhase("physics", { loop: "update", before: [SCHEDULE.UPDATE] });
		world.addSystems(
			phase,
			world.registerSystem({ name: "integrate", reads: [], writes: [], fn: () => {} })
		);
		const trace = new FrameTraceRecorder();
		world.setTrace(trace);
		world.startup();
		world.update(1 / 60);
		const frames = trace.frames();
		const frame = frames[frames.length - 1]!;
		const starts = frame.events.filter((e) => e.kind === "system_start");
		expect(starts.map((e) => (e as { phase: string }).phase)).toContain("physics");
	});
});

describe("a phase the world does not own", () => {
	it("refuses a handle another world made", () => {
		const a = new ECS();
		const b = new ECS();
		const phase = a.addPhase("physics", { loop: "update" });
		const err = thrown(() =>
			b.addSystems(phase, b.registerSystem({ reads: [], writes: [], fn: () => {} }))
		);
		expect(err.category).toBe(ECS_ERROR.UNKNOWN_PHASE);
		expect(err.message).toContain("physics");
	});

	it("refuses a name no built-in spells", () => {
		const world = new ECS();
		const err = thrown(() =>
			world.addSystems(
				"PHYSICS" as SCHEDULE,
				world.registerSystem({ reads: [], writes: [], fn: () => {} })
			)
		);
		expect(err.category).toBe(ECS_ERROR.UNKNOWN_PHASE);
	});

	it("refuses a phase ordering with a cycle", () => {
		const world = new ECS();
		const a = world.addPhase("a", { loop: "update", before: [SCHEDULE.PRE_UPDATE] });
		const err = thrown(() =>
			world.addPhase("b", { loop: "update", before: [a], after: [SCHEDULE.UPDATE] })
		);
		expect(err.category).toBe(ECS_ERROR.CIRCULAR_PHASE_DEPENDENCY);
	});
});
