/**
 * The per-world frame-trace seam. Asserts that a `FrameTraceRecorder`
 * attached via `ECS.setTrace` captures one frame per `update()`, with the causal
 * nesting the seam promises: `ctx.commands.*` events land inside the issuing
 * system's `systemStart`/`systemEnd` span, and observer firings land between a
 * `flushBegin`/`flushEnd` pair (after the system that triggered them). The
 * separate guarantee that the seam is *inert* (never perturbs `stateHash`) is
 * pinned by the gordian-knot golden vectors; here we assert it locally too.
 */
import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { eventKey } from "../../event";
import { FrameTraceRecorder, type FrameTraceEvent } from "../../frame_trace";
import { openAccess } from "../test_helpers";

/** Index of the first event matching `pred`, or -1. */
function find(events: readonly FrameTraceEvent[], pred: (e: FrameTraceEvent) => boolean): number {
	return events.findIndex(pred);
}

describe("frame-trace seam", () => {
	it("captures one frame per update, bracketed by tick_begin/tick_end", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const sys = world.registerSystem({
			name: "spawner",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => {
				ctx.commands.spawn(Pos({ x: 1 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);
		world.update(1 / 60);

		const frames = rec.frames();
		expect(frames.length).toBe(2);
		expect(frames[0]!.tick).toBe(0);
		expect(frames[1]!.tick).toBe(1);
		// tick_begin/tick_end bracket the frame (they are not in the event list —
		// they open/close it), and the dt is recorded.
		expect(frames[0]!.dt).toBeCloseTo(1 / 60);
		// Each frame saw the system run.
		for (const f of frames) {
			expect(
				find(f.events, (e) => e.kind === "system_start" && e.system === "spawner")
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("nests a queued command inside the issuing system's span", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const sys = world.registerSystem({
			name: "spawner",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => {
				ctx.commands.spawn(Pos({ x: 7 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);

		const ev = rec.frames()[0]!.events;
		const start = find(ev, (e) => e.kind === "system_start" && e.system === "spawner");
		const spawn = find(ev, (e) => e.kind === "command_queued" && e.op === "spawn");
		const end = find(ev, (e) => e.kind === "system_end" && e.system === "spawner");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(spawn).toBeGreaterThan(start);
		expect(end).toBeGreaterThan(spawn);
	});

	it("records every deferred op as command_queued — spawn's bundle attaches included", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const Vel = world.registerComponent({ vx: "i32" });
		let victim = -1;
		const sys = world.registerSystem({
			name: "mutator",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => {
				// One of each deferred op; every one must surface in the trace.
				const e = ctx.commands.spawn(Pos({ x: 1 }), Vel({ vx: 2 }));
				if (victim === -1) victim = e as number;
				else {
					ctx.commands.add(e, Pos, { x: 3 });
					ctx.commands.remove(e, Pos);
					ctx.commands.disable(e);
					ctx.commands.enable(e);
					ctx.commands.despawn(e);
				}
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60); // frame 0: spawn only (sets victim)
		world.update(1 / 60); // frame 1: the full op set

		// Frame 0: the spawn AND its two bundle attaches are each traced.
		const f0 = rec.frames()[0]!.events;
		expect(f0.filter((e) => e.kind === "command_queued" && e.op === "spawn").length).toBe(1);
		expect(f0.filter((e) => e.kind === "command_queued" && e.op === "add").length).toBe(2);

		// Frame 1: every deferred op kind appears.
		const f1 = rec.frames()[1]!.events;
		for (const op of ["add", "remove", "disable", "enable", "despawn"] as const) {
			expect(
				find(f1, (e) => e.kind === "command_queued" && e.op === op),
				`op '${op}' missing from trace`
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("fires observer events inside a flush, after the triggering system", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const added: number[] = [];
		world.observe(Pos, { onAdd: (eid) => added.push(eid as number), access: openAccess([Pos]) });
		const sys = world.registerSystem({
			name: "spawner",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => {
				ctx.commands.spawn(Pos({ x: 3 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);

		expect(added.length).toBe(1); // observer actually fired
		const ev = rec.frames()[0]!.events;
		const end = find(ev, (e) => e.kind === "system_end" && e.system === "spawner");
		const fb = find(ev, (e) => e.kind === "flush_begin");
		const obs = find(ev, (e) => e.kind === "observer_fired" && e.op === "add");
		expect(end).toBeGreaterThanOrEqual(0);
		expect(obs).toBeGreaterThan(end); // observer fires after the system returns
		// The observer firing is bracketed by a flushBegin … flushEnd pair.
		expect(fb).toBeGreaterThanOrEqual(0);
		const fe = ev.findIndex((e, i) => i > obs && e.kind === "flush_end");
		expect(fe).toBeGreaterThan(obs);
	});

	it("labels observer_fired with the observer's name, falling back to the component debug name", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" }, { name: "Pos" });
		const Vel = world.registerComponent({ vx: "i32" }); // unnamed
		world.observe(Pos, { name: "pos-watcher", onAdd: () => {}, access: openAccess([Pos]) });
		world.observe(Pos, { onAdd: () => {}, access: openAccess([Pos]) });
		world.observe(Vel, { onAdd: () => {}, access: openAccess([Vel]) });
		const sys = world.registerSystem({
			name: "spawner",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => {
				ctx.commands.spawn(Pos({ x: 1 }), Vel({ vx: 2 }));
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);

		const labels = rec
			.frames()[0]!
			.events.filter((e) => e.kind === "observer_fired" && e.op === "add")
			.map((e) => (e as { observer: string }).observer);
		expect(labels).toContain("pos-watcher"); // explicit ObserverConfig.name
		expect(labels).toContain("observer(Pos)"); // component debug-name fallback
		expect(labels).toContain(`observer(${Vel.id})`); // bare-cid fallback
	});

	it("records event emit/read", () => {
		const world = new ECS({ deterministic: true });
		const Ping = eventKey<{ n: number }>("Ping");
		world.events.register(Ping, ["n"]);
		const emitter = world.registerSystem({
			name: "emitter",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => ctx.emit(Ping, { n: 42 })
		});
		const reader = world.registerSystem({
			name: "reader",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => void ctx.read(Ping)
		});
		world.addSystems(SCHEDULE.UPDATE, emitter, { system: reader, ordering: { after: [emitter] } });
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);

		const ev = rec.frames()[0]!.events;
		expect(find(ev, (e) => e.kind === "event_emitted" && e.key === "Ping")).toBeGreaterThanOrEqual(
			0
		);
		const read = ev.find((e) => e.kind === "event_read");
		expect(read).toBeDefined();
		expect(read!.kind === "event_read" && read!.count).toBe(1);
	});

	it("detaching the sink (null) stops capture without error", () => {
		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const sys = world.registerSystem({
			name: "spawner",
			exclusive: true,
			reads: [],
			writes: [],
			fn: (ctx) => void ctx.commands.spawn(Pos({ x: 1 }))
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const rec = new FrameTraceRecorder();
		world.setTrace(rec);
		world.update(1 / 60);
		world.setTrace(null);
		world.update(1 / 60); // no sink — must not throw, must not grow the capture
		expect(rec.frames().length).toBe(1);
	});

	it("fires phase_boundary at each phase's post-flush settle point, in order", () => {
		// A sink that records flushEnd and phaseBoundary into one stream, so we can
		// pin that phaseBoundary fires immediately AFTER its phase's flushEnd — the
		// consistent, fingerprint-able point.
		class PhaseProbe extends FrameTraceRecorder {
			readonly marks: string[] = [];
			override flushEnd(phase: SCHEDULE): void {
				super.flushEnd(phase);
				this.marks.push(`flush_end:${phase}`);
			}
			override phaseBoundary(phase: SCHEDULE): void {
				this.marks.push(`phase_boundary:${phase}`);
			}
		}

		const world = new ECS({ deterministic: true });
		const sys = world.registerSystem({ name: "noop", reads: [], writes: [], fn: () => {} });
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		const probe = new PhaseProbe();
		world.setTrace(probe);
		world.update(1 / 60);

		// No fixed systems → one boundary per update phase, each right after its flush.
		expect(probe.marks).toEqual([
			`flush_end:${SCHEDULE.PRE_UPDATE}`,
			`phase_boundary:${SCHEDULE.PRE_UPDATE}`,
			`flush_end:${SCHEDULE.UPDATE}`,
			`phase_boundary:${SCHEDULE.UPDATE}`,
			`flush_end:${SCHEDULE.POST_UPDATE}`,
			`phase_boundary:${SCHEDULE.POST_UPDATE}`
		]);
	});

	it("the POST_UPDATE phase_boundary hash reconciles with the per-tick state_hash", () => {
		// stateHash() read at the POST_UPDATE boundary equals the post-update per-tick
		// hash, for a world with no onSet observers — proving the seam fires at the
		// settled point and the in-frame read sees the same state the tick-end hash does.
		class HashAtPost extends FrameTraceRecorder {
			postHash = 0;
			constructor(private readonly world: ECS) {
				super();
			}
			override phaseBoundary(phase: SCHEDULE): void {
				if (phase === SCHEDULE.POST_UPDATE) this.postHash = this.world.snapshots.stateHash();
			}
		}

		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0 });
		const mover = world.registerSystem({
			name: "mover",
			reads: [],
			writes: [Pos],
			fn: (ctx) => ctx.setField(e, Pos, "x", (ctx.ecsTick + 1) | 0)
		});
		world.addSystems(SCHEDULE.UPDATE, mover);
		world.startup();
		world.flush();

		const probe = new HashAtPost(world);
		world.setTrace(probe);
		for (let i = 0; i < 4; i++) {
			world.update(1 / 60);
			expect(probe.postHash).toBe(world.snapshots.stateHash());
		}
	});

	it("does NOT reconcile when an onSet observer mutates at the tail (the documented limitation, fenced)", () => {
		// The complement of the reconciliation test above, fencing the stated
		// limitation: the POST_UPDATE phaseBoundary fires BEFORE the tick-tail onSet
		// dispatch (ecs.ts), so a world whose onSet observer mutates hash-relevant state
		// at the tail reads a boundary hash that PRECEDES that mutation — it must diverge
		// from the final per-tick hash. Without this, a refactor that moved the boundary
		// to after dispatchSet would silently break the documented semantics (and
		// soundness for any consumer that registers onSet observers) yet keep every
		// existing assertion green; here that move would flip this `.not.toBe` to fail.
		class HashAtPost extends FrameTraceRecorder {
			postHash = 0;
			constructor(private readonly world: ECS) {
				super();
			}
			override phaseBoundary(phase: SCHEDULE): void {
				if (phase === SCHEDULE.POST_UPDATE) this.postHash = this.world.snapshots.stateHash();
			}
		}

		const world = new ECS({ deterministic: true });
		const Pos = world.registerComponent({ x: "i32" });
		const Mark = world.registerComponent({ m: "i32" }); // hash-relevant, NOT observed
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0 });
		world.addComponent(e, Mark, { m: 0 });
		// Per-entity onSet records via ctx.setField (an immediate column write — CONTEXT.md),
		// so writing Mark here lands AFTER the POST_UPDATE boundary. Mark is unobserved, so
		// the write doesn't re-trigger onSet.
		world.observe(Pos, {
			onSet: (_eid, ctx) => ctx.setField(e, Mark, "m", (ctx.ecsTick + 1) | 0),
			granularity: "entity",
			access: openAccess([Pos, Mark])
		});
		const mover = world.registerSystem({
			name: "mover",
			reads: [],
			writes: [Pos],
			fn: (ctx) => ctx.setField(e, Pos, "x", (ctx.ecsTick + 1) | 0) // dirties Pos → triggers onSet
		});
		world.addSystems(SCHEDULE.UPDATE, mover);
		world.startup();
		world.flush();

		const probe = new HashAtPost(world);
		world.setTrace(probe);
		world.update(1 / 60);
		// The boundary hash (Mark still 0) precedes the onSet tail write (Mark → 1).
		expect(probe.postHash, "boundary fires before the onSet tail mutation").not.toBe(
			world.snapshots.stateHash()
		);
	});

	it("is inert: the per-tick state_hash matches a world with no trace", () => {
		const build = (): ECS => {
			const world = new ECS({ deterministic: true });
			const Pos = world.registerComponent({ x: "i32" });
			const e = world.spawn();
			world.addComponent(e, Pos, { x: 0 });
			const sys = world.registerSystem({
				name: "mover",
				exclusive: true,
				reads: [],
				writes: [],
				fn: (ctx) => {
					if (ctx.ecsTick === 1) ctx.commands.spawn(Pos({ x: 9 }));
				}
			});
			world.addSystems(SCHEDULE.UPDATE, sys);
			world.startup();
			world.flush();
			return world;
		};
		const untraced = build();
		const traced = build();
		traced.setTrace(new FrameTraceRecorder());
		for (let i = 0; i < 4; i++) {
			untraced.update(1 / 60);
			traced.update(1 / 60);
			expect(traced.snapshots.stateHash()).toBe(untraced.snapshots.stateHash());
		}
	});
});
