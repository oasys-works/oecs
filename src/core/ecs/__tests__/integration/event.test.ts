import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { eventKey, signalKey, type EventReader } from "../../event";
import { ECS_ERROR, ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";

describe("Event system", () => {
	// ==== Event key registration and emit/read ====

	it("emit in one system, read in a later system within the same update", () => {
		const world = new ECS();
		const Damage = eventKey<{ target: number; amount: number }>("Damage");
		world.registerEvent(Damage, ["target", "amount"] as const);
		const received: { target: number; amount: number }[] = [];

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Damage, { target: 42, amount: 10 });
			}
		});
		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				const dmg = ctx.read(Damage);
				for (let i = 0; i < dmg.length; i++) {
					received.push({ target: dmg.target[i], amount: dmg.amount[i] });
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, emitter, {
			system: reader,
			ordering: { after: [emitter] }
		});
		world.startup();
		world.update(0);

		expect(received).toEqual([{ target: 42, amount: 10 }]);
	});

	it("events are cleared between frames", () => {
		const world = new ECS();
		const Hit = eventKey<{ damage: number }>("Hit");
		world.registerEvent(Hit, ["damage"] as const);

		let readLength = -1;
		let frame = 0;
		const sys = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				if (frame === 0) {
					ctx.emit(Hit, { damage: 99 });
				}
				readLength = ctx.read(Hit).length;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();

		frame = 0;
		world.update(0);
		expect(readLength).toBe(1);

		frame = 1;
		world.update(0);
		expect(readLength).toBe(0);
	});

	it("signal (zero-field) events work", () => {
		const world = new ECS();
		const GameOver = signalKey("GameOver");
		world.registerSignal(GameOver);
		let fired = false;

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(GameOver);
			}
		});
		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				if (ctx.read(GameOver).length > 0) {
					fired = true;
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, emitter, {
			system: reader,
			ordering: { after: [emitter] }
		});
		world.startup();
		world.update(0);

		expect(fired).toBe(true);
	});

	it("multiple emits accumulate within a frame", () => {
		const world = new ECS();
		const Score = eventKey<{ points: number }>("Score");
		world.registerEvent(Score, ["points"] as const);
		const totals: number[] = [];

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Score, { points: 10 });
				ctx.emit(Score, { points: 20 });
				ctx.emit(Score, { points: 30 });
			}
		});
		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				const s = ctx.read(Score);
				for (let i = 0; i < s.length; i++) {
					totals.push(s.points[i]);
				}
			}
		});

		world.addSystems(SCHEDULE.UPDATE, emitter, {
			system: reader,
			ordering: { after: [emitter] }
		});
		world.startup();
		world.update(0);

		expect(totals).toEqual([10, 20, 30]);
	});

	it("startup events are readable in POST_STARTUP", () => {
		const world = new ECS();
		const Ready = signalKey("Ready");
		world.registerSignal(Ready);
		let readCount = 0;

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Ready);
				ctx.emit(Ready);
			}
		});
		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				readCount = ctx.read(Ready).length;
			}
		});

		world.addSystems(SCHEDULE.STARTUP, emitter);
		world.addSystems(SCHEDULE.POST_STARTUP, reader);
		world.startup();

		expect(readCount).toBe(2);
	});

	// Regression for #379: startup() had no clearEvents() (only update() did),
	// so events emitted in a startup phase leaked into the first update() — a
	// frame-1 PRE_UPDATE/UPDATE reader saw them as if emitted this frame. They
	// must be drained at the end of startup, since events live one *update* tick
	// and startup is not an update tick.
	it("startup-emitted events do not leak into the first update", () => {
		const world = new ECS();
		const Boot = signalKey("Boot");
		world.registerSignal(Boot);

		const startupEmitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Boot);
			}
		});

		let preUpdateLen = -1;
		let updateLen = -1;
		const preUpdateReader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				preUpdateLen = ctx.read(Boot).length;
			}
		});
		const updateReader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				updateLen = ctx.read(Boot).length;
			}
		});

		world.addSystems(SCHEDULE.STARTUP, startupEmitter);
		world.addSystems(SCHEDULE.PRE_UPDATE, preUpdateReader);
		world.addSystems(SCHEDULE.UPDATE, updateReader);

		world.startup();
		world.update(0);

		expect(preUpdateLen).toBe(0);
		expect(updateLen).toBe(0);
	});

	it("reading an event with no emits returns length 0", () => {
		const world = new ECS();
		const Nothing = eventKey<{ value: number }>("Nothing");
		world.registerEvent(Nothing, ["value"] as const);
		let readLength = -1;

		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				readLength = ctx.read(Nothing).length;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, reader);
		world.startup();
		world.update(0);

		expect(readLength).toBe(0);
	});

	it("multiple signal emits accumulate", () => {
		const world = new ECS();
		const Tick = signalKey("Tick");
		world.registerSignal(Tick);
		let count = 0;

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Tick);
				ctx.emit(Tick);
				ctx.emit(Tick);
			}
		});
		const reader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				count = ctx.read(Tick).length;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, emitter, {
			system: reader,
			ordering: { after: [emitter] }
		});
		world.startup();
		world.update(0);

		expect(count).toBe(3);
	});

	it("events emitted in PRE_UPDATE are readable in UPDATE and POST_UPDATE", () => {
		const world = new ECS();
		const Input = eventKey<{ key: number }>("Input");
		world.registerEvent(Input, ["key"] as const);
		let updateLen = 0;
		let postUpdateLen = 0;

		const emitter = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				ctx.emit(Input, { key: 65 });
			}
		});
		const updateReader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				updateLen = ctx.read(Input).length;
			}
		});
		const postUpdateReader = world.registerSystem({
			...openAccess([]),
			fn(ctx: SystemContext) {
				postUpdateLen = ctx.read(Input).length;
			}
		});

		world.addSystems(SCHEDULE.PRE_UPDATE, emitter);
		world.addSystems(SCHEDULE.UPDATE, updateReader);
		world.addSystems(SCHEDULE.POST_UPDATE, postUpdateReader);
		world.startup();
		world.update(0);

		expect(updateLen).toBe(1);
		expect(postUpdateLen).toBe(1);
	});

	// ==== Error handling ====

	it("duplicate register_event throws EVENT_ALREADY_REGISTERED", () => {
		const world = new ECS();
		const Ev = eventKey<{ x: number }>("Ev");
		world.registerEvent(Ev, ["x"] as const);

		try {
			world.registerEvent(Ev, ["x"] as const);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_ALREADY_REGISTERED);
		}
	});

	it("emit on unregistered key throws EVENT_NOT_REGISTERED", () => {
		const world = new ECS();
		const Ev = eventKey<{ x: number }>("Unregistered");

		try {
			world.emit(Ev, { x: 1 });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_NOT_REGISTERED);
		}
	});

	it("read on unregistered key throws EVENT_NOT_REGISTERED", () => {
		const world = new ECS();
		const Ev = eventKey<{ x: number }>("Unregistered");

		try {
			world.read(Ev);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_NOT_REGISTERED);
		}
	});

	// Regression for #727: a `__DEV__` missing-field emit must not desync the
	// SoA columns. The old `emit` pushed per-field then threw mid-loop, so a
	// two-field event missing the second field left the first column one row
	// ahead of both `reader.length` and the un-pushed column — a permanent
	// desync if the throw is caught. `emit` now validates ALL fields before
	// mutating any column, so a caught throw leaves every column untouched and
	// the next valid emit lands at row 0.
	it("a thrown emit (missing field) does not desync the channel columns (#727)", () => {
		const world = new ECS();
		const Pair = eventKey<{ a: number; b: number }>("Pair");
		world.registerEvent(Pair, ["a", "b"] as const);

		// `b` is missing — must throw under __DEV__ before touching any column.
		try {
			world.emit(Pair, { a: 1 } as { a: number; b: number });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ECSError);
			expect((e as ECSError).category).toBe(ECS_ERROR.FIELD_NOT_REGISTERED);
		}

		// The throw must have rolled back cleanly: nothing buffered yet.
		expect(world.read(Pair).length).toBe(0);

		// A subsequent VALID emit lands at row 0 with consistent columns.
		world.emit(Pair, { a: 2, b: 3 });
		const reader = world.read(Pair);

		// reader.length agrees with EVERY column length — no column is one
		// element ahead from the half-applied emit.
		expect(reader.length).toBe(1);
		expect(reader.a.length).toBe(1);
		expect(reader.b.length).toBe(1);

		// The valid event reads back at row 0, not row 1 (which it would if the
		// thrown emit had pushed `a` and left a stale leading element).
		expect(reader.a[0]).toBe(2);
		expect(reader.b[0]).toBe(3);
	});

	// ==== ECS.read and ECS.emit (facade-level) ====

	it("ECS.read works for reading events outside systems", () => {
		const world = new ECS();
		const Score = eventKey<{ points: number }>("Score");
		world.registerEvent(Score, ["points"] as const);

		world.emit(Score, { points: 42 });
		const reader = world.read(Score);
		expect(reader.length).toBe(1);
		expect(reader.points[0]).toBe(42);
	});

	it("ECS.emit signal works at facade level", () => {
		const world = new ECS();
		const Ping = signalKey("Ping");
		world.registerSignal(Ping);

		world.emit(Ping);
		expect(world.read(Ping).length).toBe(1);
	});

	// ==== Reader type-soundness (issue #377) ====
	//
	// EventReader columns were declared Float64Array but backed by growable
	// number[]: a system trusting the declared type and calling .subarray/.set/
	// .byteLength got undefined/threw, and the reader aliased the live channel
	// so it could mutate it. The columns are now read-only numeric arrays whose
	// declared type matches the runtime backing.

	it("reader columns are growable numeric arrays, not typed arrays", () => {
		const world = new ECS();
		const Score = eventKey<{ points: number }>("Score");
		world.registerEvent(Score, ["points"] as const);

		world.emit(Score, { points: 1 });
		world.emit(Score, { points: 2 });
		const reader = world.read(Score);

		// Indexed reads + length are the supported access pattern.
		expect(reader.length).toBe(2);
		expect(reader.points[0]).toBe(1);
		expect(reader.points[1]).toBe(2);

		// Runtime backing is a plain Array — the old Float64Array typing was a
		// lie, so typed-array methods are absent. This documents why the
		// declared type must not advertise them.
		expect(Array.isArray(reader.points)).toBe(true);
		expect(reader.points).not.toBeInstanceOf(Float64Array);
	});

	it("declares columns as read-only numeric arrays, not Float64Array (compile-time)", () => {
		type Column = EventReader<{ points: number }>["points"];

		// These resolve to `never` (then fail to compile) if the column type
		// ever regresses to Float64Array or to a mutable array.
		type AssertNotTypedArray = Column extends Float64Array ? never : true;
		type AssertReadonlyNumberArray = Column extends ReadonlyArray<number> ? true : never;
		// ReadonlyArray<number> is not assignable to number[]; a regression to a
		// mutable column (writable reader) would make this `never`.
		type AssertNotMutableArray = Column extends number[] ? never : true;

		const notTypedArray: AssertNotTypedArray = true;
		const readonlyNumberArray: AssertReadonlyNumberArray = true;
		const notMutableArray: AssertNotMutableArray = true;

		expect(notTypedArray && readonlyNumberArray && notMutableArray).toBe(true);
	});
});
