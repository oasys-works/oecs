/**
 * What a world says when a capability is missing, and when one arrives twice.
 *
 * A capability is a construction-time choice, so every failure here has the
 * same remedy: edit the `ECS.create` call. These tests hold the world to
 * saying so. They cover the reserved slots of a bare world, the seams a system
 * body and a query reach, and the second install of one capability.
 */

import { describe, expect, it, vi } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { ECSError, ECS_ERROR } from "../../utils/error";
import { eventKey } from "../../event";
import { relations } from "../../../../capabilities/relations";
import { events } from "../../../../capabilities/events";
import { observers } from "../../../../capabilities/observers";
import { snapshots } from "../../../../capabilities/snapshots";

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

function expectMissing(err: ECSError, api: string, capability: string): void {
	expect(err.category).toBe(ECS_ERROR.CAPABILITY_NOT_INSTALLED);
	expect(err.message).toContain(api);
	expect(err.message).toContain(`@oasys/oecs/${capability}`);
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

describe("a bare world names the missing capability", () => {
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

	it("inspection and coercion of a reserved slot answer instead of throwing", () => {
		// A logger walking a world reads `Symbol.toStringTag` and `Symbol.toPrimitive`
		// off every member, `JSON.stringify` reads `toJSON`, an `await` reads `then`,
		// and a string coercion reads `toString`. Each must answer as a plain object
		// does, and only a member read may reach the fault.
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

describe("one capability installs once", () => {
	it("a repeated plugin faults instead of replacing the service", () => {
		const err = thrown(() => ECS.create({ plugins: [relations(), relations()] }));
		expect(err.category).toBe(ECS_ERROR.CAPABILITY_ALREADY_INSTALLED);
		expect(err.message).toContain("relations is already installed");
		expect(err.message).toContain("ECS.create");
	});

	it("the events capability faults the same way", () => {
		const err = thrown(() => ECS.create({ plugins: [events(), events()] }));
		expect(err.category).toBe(ECS_ERROR.CAPABILITY_ALREADY_INSTALLED);
		expect(err.message).toContain("events is already installed");
	});

	it("observers faults on the world seam, not the store seam", () => {
		// The observer registry is the one service the world holds, so its
		// install guard lives on the world's capability host.
		const err = thrown(() => ECS.create({ plugins: [observers(), observers()] }));
		expect(err.category).toBe(ECS_ERROR.CAPABILITY_ALREADY_INSTALLED);
		expect(err.message).toContain("observers is already installed");
	});

	it("the snapshots capability faults the same way", () => {
		const err = thrown(() => ECS.create({ plugins: [snapshots(), snapshots()] }));
		expect(err.category).toBe(ECS_ERROR.CAPABILITY_ALREADY_INSTALLED);
		expect(err.message).toContain("snapshots is already installed");
	});
});
