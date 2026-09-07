/**
 * What a world says when a plugin is missing, and when one arrives twice.
 *
 * A plugin is a construction-time choice, so every failure here has the
 * same remedy: edit the `ECS.create` call. These tests hold the world to
 * saying so. They cover the reserved slots of a bare world. They also cover the
 * seams a system body and a query reach, and the second install of one
 * plugin.
 */

import { describe, expect, it, vi } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../phase";
import { ECSError, ECS_ERROR } from "../../utils/error";
import { eventKey } from "../../event";
import { relations } from "../../../../plugins/relations";
import { events } from "../../../../plugins/events";
import { observers } from "../../../../plugins/observers";
import { snapshots } from "../../../../plugins/snapshots";
import { workers } from "../../../../plugins/workers";

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

function expectMissing(err: ECSError, api: string, plugin: string): void {
	expect(err.category).toBe(ECS_ERROR.PLUGIN_NOT_INSTALLED);
	expect(err.message).toContain(api);
	expect(err.message).toContain(`@oasys/oecs/${plugin}`);
}

describe("ECSOptions typo tripwire", () => {
	it("accepts plugins and still warns on an unknown key", () => {
		const onWarn = vi.fn();
		ECS.create({ plugins: [relations()], onWarn });
		expect(onWarn).not.toHaveBeenCalled();

		ECS.create({ plugins: [relations()], onWarn, ...({ initialCapacity: 8 } as object) });
		expect(onWarn).toHaveBeenCalledTimes(1);
		expect(onWarn.mock.calls[0][0]).toContain("initialCapacity");
	});
});

describe("a bare world names the missing plugin", () => {
	it("relations, events and observe answer with the import that fixes them", () => {
		const world = new ECS();
		const slots = world as unknown as {
			relations: { add(): void };
			events: { register(): void };
			observe: () => void;
		};

		expectMissing(thrown(() => slots.relations.add), "ecs.relations.add", "relations");
		expectMissing(thrown(() => slots.events.register), "ecs.events.register", "events");
		expectMissing(thrown(() => slots.observe()), "ecs.observe", "observers");
		expectMissing(
			thrown(() => (world.snapshots as unknown as { capture(): void }).capture()),
			"ecs.snapshots.capture",
			"snapshots"
		);
	});

	it("workers answers with the import that fixes it", () => {
		// The pool ships in a plugin, so a JavaScript caller reaching for
		// `world.workers.attach` on a bare world used to meet a TypeError about a
		// property of undefined. The slot names the plugin and the import instead.
		const world = new ECS();
		const slot = world as unknown as { workers: { attach(): void } };
		expectMissing(thrown(() => slot.workers.attach), "ecs.workers.attach", "workers");
	});

	it("registers a parallel system and runs its fn", () => {
		// The plan builder ships with the plugin. Without it the world builds no
		// plan, so `routePlan` stays undefined and the schedule runs the body.
		const world = new ECS({ memory: { maxBytes: 4 * 1024 * 1024 } });
		const Pos = world.registerComponent({ x: "i32" }, { name: "Pos" });
		let ran = 0;
		const system = world.registerSystem({
			reads: [],
			writes: [Pos],
			queries: [[Pos]],
			parallel: {
				kernel: { js: "file:///nowhere.mjs", export: "step" },
				columns: [[Pos, "x"]],
				minRows: 1
			},
			fn: () => {
				ran++;
			}
		});
		expect(system.routePlan).toBeUndefined();
		world.addSystems(SCHEDULE.UPDATE, system);
		world.startup();
		world.update(1 / 60);
		expect(ran).toBe(1);
	});

	it("inspection and coercion of a reserved slot answer instead of throwing", () => {
		// A logger reads `Symbol.toStringTag` and `toString`, `JSON.stringify` reads
		// `toJSON`, and an `await` reads `then`. Each answers as a plain object does.
		// Only a member read reaches the fault.
		const world = new ECS();
		const slot = (world as unknown as Record<string, object>).relations;
		expect((slot as { [Symbol.toStringTag]?: string })[Symbol.toStringTag]).toBeUndefined();
		expect(() => String(Object.keys(slot))).not.toThrow();
		expect(JSON.stringify({ slot })).toBe('{"slot":{}}');
		expect(String(slot)).toBe("[object Object]");
		expect((slot as { then?: unknown }).then).toBeUndefined();
		expect(slot.constructor).toBe(Object);
		expect(Object.prototype.hasOwnProperty.call(slot, "add")).toBe(false);
		expect(() => (slot as { add(): void }).add).toThrow(ECSError);
	});
});

describe("a seam names itself, not the facade", () => {
	it("query.forEachRelatedTo names the query verb", () => {
		const world = new ECS();
		const target = world.spawn();
		const q = world.query();
		expectMissing(
			thrown(() => q.forEachRelatedTo(target, () => {})),
			"query.forEachRelatedTo",
			"relations"
		);
	});

	it("ctx.emit names the system-context verb", () => {
		const world = new ECS();
		const Damage = eventKey<{ amount: number }>("Damage");
		let err: ECSError | null = null;
		const sys = world.registerSystem({
			reads: [],
			writes: [],
			fn(ctx) {
				try {
					ctx.emit(Damage, { amount: 1 });
				} catch (e) {
					err = e as ECSError;
				}
			}
		});
		world.addSystems(SCHEDULE.UPDATE, sys);
		world.startup();
		world.update(0);
		expect(err).not.toBeNull();
		expectMissing(err as unknown as ECSError, "ctx.emit", "events");
	});
});

describe("one plugin installs once", () => {
	it("a repeated plugin faults instead of replacing the service", () => {
		const err = thrown(() => ECS.create({ plugins: [relations(), relations()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("relations is already installed");
		expect(err.message).toContain("ECS.create");
	});

	it("the events plugin faults the same way", () => {
		const err = thrown(() => ECS.create({ plugins: [events(), events()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("events is already installed");
	});

	it("observers faults on the world seam, not the store seam", () => {
		// The observer registry is the one service the world holds, so its
		// install guard lives on the world's plugin host.
		const err = thrown(() => ECS.create({ plugins: [observers(), observers()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("observers is already installed");
	});

	it("the snapshots plugin faults the same way", () => {
		const err = thrown(() => ECS.create({ plugins: [snapshots(), snapshots()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("snapshots is already installed");
	});

	it("workers faults on the world seam, which holds the one pool", () => {
		const err = thrown(() => ECS.create({ plugins: [workers(), workers()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("workers is already installed");
	});
});

describe("a plugin fills a slot the constructor already reserved", () => {
	it("workers adds no own property to the world", () => {
		// Two shapes at one call site make `spawn` polymorphic, and a measurement
		// of a bare world showed the cost once a plugin world existed beside it.
		// The constructor reserves every slot this package ships, so `ECS.create`
		// assigns into an existing property and never adds one.
		const bare = Object.keys(new ECS());
		const pooled = Object.keys(ECS.create({ plugins: [workers()] }));
		expect(pooled).toEqual(bare);
		expect(bare).toContain("workers");
	});
});
