import { describe, expect, it } from "vitest";
import { logger, LOG_CATEGORY } from "../../../../log";
import { Schedule, SCHEDULE } from "../../schedule";
import { SystemContext } from "../../query";
import { Store } from "../../store";
import {
	asSystemId,
	_normalizeAccess,
	type SystemConfig,
	type SystemDescriptor,
	type SystemFn
} from "../../system";

const noop: SystemFn = () => {};

function makeCtx(): SystemContext {
	return new SystemContext(new Store());
}

let _scheduleIntegNextId = 0;
function makeSystem(overrides?: Partial<SystemConfig>): SystemDescriptor {
	// Hand-built descriptor (no ECS here) — run the authored fields through the
	// same normalization registerSystem applies (Template expansion + absent =
	// frozen empty), so the descriptor shape matches production.
	return Object.freeze({
		..._normalizeAccess({
			reads: overrides?.reads ?? [],
			writes: overrides?.writes ?? [],
			spawns: overrides?.spawns,
			despawns: overrides?.despawns,
			transitions: overrides?.transitions,
			resourceReads: overrides?.resourceReads,
			resourceWrites: overrides?.resourceWrites
		}),
		id: asSystemId(_scheduleIntegNextId++),
		fn: overrides?.fn ?? noop,
		onAdded: overrides?.onAdded,
		onRemoved: overrides?.onRemoved,
		dispose: overrides?.dispose
	});
}

describe("Schedule (integration)", () => {
	//=========================================================
	// Execution order
	//=========================================================

	it("run_startup executes PRE_STARTUP -> STARTUP -> POST_STARTUP", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const pre = makeSystem({ fn: () => order.push("pre") });
		const main = makeSystem({ fn: () => order.push("main") });
		const post = makeSystem({ fn: () => order.push("post") });

		schedule.addSystems(SCHEDULE.PRE_STARTUP, pre);
		schedule.addSystems(SCHEDULE.STARTUP, main);
		schedule.addSystems(SCHEDULE.POST_STARTUP, post);

		schedule.runStartup(ctx, 0);

		expect(order).toEqual(["pre", "main", "post"]);
	});

	it("run_update executes PRE_UPDATE -> UPDATE -> POST_UPDATE", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const pre = makeSystem({ fn: () => order.push("pre") });
		const main = makeSystem({ fn: () => order.push("main") });
		const post = makeSystem({ fn: () => order.push("post") });

		schedule.addSystems(SCHEDULE.PRE_UPDATE, pre);
		schedule.addSystems(SCHEDULE.UPDATE, main);
		schedule.addSystems(SCHEDULE.POST_UPDATE, post);

		schedule.runUpdate(ctx, 0.016, 0);

		expect(order).toEqual(["pre", "main", "post"]);
	});

	it("run_update passes delta_time to system fn", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		let receivedDt = 0;
		const sys = makeSystem({
			fn: (_ctx, dt) => {
				receivedDt = dt;
			}
		});

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		schedule.runUpdate(ctx, 0.016, 0);

		expect(receivedDt).toBeCloseTo(0.016);
	});

	//=========================================================
	// Ordering constraints
	//=========================================================

	it("before constraint orders systems correctly", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		// a runs before b
		schedule.addSystems(SCHEDULE.UPDATE, { system: a, ordering: { before: [b] } }, b);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b"]);
	});

	it("after constraint orders systems correctly", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		// b runs after a
		schedule.addSystems(SCHEDULE.UPDATE, a, {
			system: b,
			ordering: { after: [a] }
		});

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b"]);
	});

	it("insertion order is used as tiebreaker when no constraints", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });
		const c = makeSystem({ fn: () => order.push("c") });

		schedule.addSystems(SCHEDULE.UPDATE, a, b, c);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("complex ordering chain: a -> b -> c", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });
		const c = makeSystem({ fn: () => order.push("c") });

		// c registered first but must run last
		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: c, ordering: { after: [b] } },
			{ system: b, ordering: { after: [a] } },
			a
		);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("constraints referencing systems in different labels are ignored", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		// b is in a different label, so "after b" constraint is ignored
		schedule.addSystems(SCHEDULE.PRE_UPDATE, b);
		schedule.addSystems(SCHEDULE.UPDATE, {
			system: a,
			ordering: { after: [b] }
		});

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["b", "a"]);
	});

	//=========================================================
	// Dropped-edge dev warnings (issue #432)
	//=========================================================

	/** Capture ECS-category log entries emitted while `run` executes. */
	function captureEcsLogs(run: () => void): string[] {
		const captured: string[] = [];
		const unsubscribe = logger.subscribe((entry) => {
			if (entry.category === LOG_CATEGORY.ECS) captured.push(entry.message);
		});
		try {
			run();
		} finally {
			unsubscribe();
		}
		return captured;
	}

	it("warns when a before-target is registered in no phase", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const ghost = makeSystem(); // never added to any label — a typo stand-in

		schedule.addSystems(SCHEDULE.UPDATE, { system: a, ordering: { before: [ghost] } });

		const logs = captureEcsLogs(() => schedule.runUpdate(ctx, 0, 0));

		// Constraint dropped, sort still succeeds.
		expect(order).toEqual(["a"]);
		// Exactly one loud warning, naming the unknown target.
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("before");
		expect(logs[0]).toContain("not registered in any phase");
	});

	it("warns when an after-target is registered in no phase", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		const a = makeSystem();
		const ghost = makeSystem();

		schedule.addSystems(SCHEDULE.UPDATE, { system: a, ordering: { after: [ghost] } });

		const logs = captureEcsLogs(() => schedule.runUpdate(ctx, 0, 0));

		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("after");
	});

	it("does NOT warn when the target is registered in a different phase", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		// b lives in another label → quiet cross-label skip, no warning.
		schedule.addSystems(SCHEDULE.PRE_UPDATE, b);
		schedule.addSystems(SCHEDULE.UPDATE, { system: a, ordering: { after: [b] } });

		const logs = captureEcsLogs(() => schedule.runUpdate(ctx, 0, 0));

		expect(order).toEqual(["b", "a"]);
		expect(logs).toHaveLength(0);
	});

	it("does NOT warn for a valid within-label ordering edge", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		schedule.addSystems(SCHEDULE.UPDATE, { system: a, ordering: { before: [b] } }, b);

		const logs = captureEcsLogs(() => schedule.runUpdate(ctx, 0, 0));

		expect(order).toEqual(["a", "b"]);
		expect(logs).toHaveLength(0);
	});

	//=========================================================
	// Circular dependency detection
	//=========================================================

	it("throws on circular dependency", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		const a = makeSystem();
		const b = makeSystem();

		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: a, ordering: { before: [b] } },
			{ system: b, ordering: { before: [a] } }
		);

		expect(() => schedule.runUpdate(ctx, 0, 0)).toThrow(/Circular/);
	});

	it("throws on 3-way circular dependency", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		const a = makeSystem();
		const b = makeSystem();
		const c = makeSystem();

		schedule.addSystems(
			SCHEDULE.UPDATE,
			{ system: a, ordering: { before: [b] } },
			{ system: b, ordering: { before: [c] } },
			{ system: c, ordering: { before: [a] } }
		);

		expect(() => schedule.runUpdate(ctx, 0, 0)).toThrow(/Circular/);
	});

	//=========================================================
	// Cache invalidation
	//=========================================================

	it("sort cache invalidates on add", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		schedule.addSystems(SCHEDULE.UPDATE, a);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a"]);

		order.length = 0;

		const b = makeSystem({ fn: () => order.push("b") });
		schedule.addSystems(SCHEDULE.UPDATE, b);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b"]);
	});

	it("sort cache invalidates on remove", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });
		schedule.addSystems(SCHEDULE.UPDATE, a, b);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["a", "b"]);

		order.length = 0;
		schedule.removeSystem(a);

		schedule.runUpdate(ctx, 0, 0);
		expect(order).toEqual(["b"]);
	});

	//=========================================================
	// SystemContext integration
	//=========================================================

	it("systems receive SystemContext with working store access", () => {
		const schedule = new Schedule();
		const store = new Store();
		const ctx = new SystemContext(store);

		let createdEntity = false;
		const sys = makeSystem({
			fn: (ctxArg) => {
				const id = ctxArg.createEntity();
				createdEntity = store.isAlive(id);
			}
		});

		schedule.addSystems(SCHEDULE.UPDATE, sys);
		schedule.runUpdate(ctx, 0, 0);

		expect(createdEntity).toBe(true);
	});

	//=========================================================
	// Deferred destruction flush
	//=========================================================

	it("entities destroyed in a system are flushed before the next phase runs", () => {
		const schedule = new Schedule();
		const store = new Store();
		const ctx = new SystemContext(store);

		// Register a stand-in component so the destroyer system has something
		// to list in `despawns` — Phase B's `checkDestroy()` requires that
		// destroyEntity callers declare a non-empty despawn set, even when
		// the actual entity has no components attached.
		const Anything = store.registerComponent({} as Record<string, never>);
		const entity = store.createEntity();
		let aliveInUpdate: boolean | null = null;

		// PRE_UPDATE system defers destruction
		const destroyer = makeSystem({
			despawns: [Anything],
			fn: (c) => {
				c.destroyEntity(entity);
			}
		});

		// UPDATE system checks if entity is still alive
		const checker = makeSystem({
			fn: () => {
				aliveInUpdate = store.isAlive(entity);
			}
		});

		schedule.addSystems(SCHEDULE.PRE_UPDATE, destroyer);
		schedule.addSystems(SCHEDULE.UPDATE, checker);
		schedule.runUpdate(ctx, 0, 0);

		expect(aliveInUpdate).toBe(false);
	});

	//=========================================================
	// Fixed update
	//=========================================================

	it("run_fixed_update executes FIXED_UPDATE systems with fixed_dt", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();

		let receivedDt = 0;
		const sys = makeSystem({
			fn: (_ctx, dt) => {
				receivedDt = dt;
			}
		});

		schedule.addSystems(SCHEDULE.FIXED_UPDATE, sys);
		schedule.runFixedUpdate(ctx, 1 / 50, 0);

		expect(receivedDt).toBeCloseTo(1 / 50);
	});

	it("run_fixed_update respects ordering constraints", () => {
		const schedule = new Schedule();
		const ctx = makeCtx();
		const order: string[] = [];

		const a = makeSystem({ fn: () => order.push("a") });
		const b = makeSystem({ fn: () => order.push("b") });

		schedule.addSystems(SCHEDULE.FIXED_UPDATE, { system: b, ordering: { after: [a] } }, a);

		schedule.runFixedUpdate(ctx, 1 / 60, 0);
		expect(order).toEqual(["a", "b"]);
	});
});
