/**
 * Four accessors the suite named but never called, and one loop behind
 * `ChangedQuery.forEachArchetype`.
 *
 * `regionOffset` and `entityIdAtRow` are the WASM-facing half of the store.
 * A consumer builds a typed view from the first and converts an event-ring
 * `(archetype, row)` payload with the second, and neither had a caller here.
 *
 * `FrameStepper.fixedDt` and `maxDt` have a setter that validates and a getter
 * that reads back. One test asserted a bad write throws. None read the value,
 * so a setter that stored nothing would have passed.
 *
 * `includeDisabled().changed(T)` runs a separate loop from the default one,
 * behind a flag that must be restored on the way out. The oracle reached it.
 * No unit test did.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { FrameStepper } from "../../frame_stepper";
import { SCHEDULE } from "../../phase";
import { ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";

describe("ECS.regionOffset", () => {
	it("gives the declared region's byte offset, and 0 for an absent id", () => {
		const world = new ECS({
			regions: [
				{ id: 11, name: "alpha", bytes: 16, init: () => {} },
				{ id: 12, name: "beta", bytes: 16, init: () => {} }
			]
		});

		const alpha = world.regionHandle(11);
		expect(alpha).not.toBeNull();
		// The offset is the same number the handle carries. The two accessors
		// exist so a consumer can skip building a handle it does not need.
		expect(world.regionOffset(11)).toBe(alpha?.offset);
		expect(world.regionOffset(12)).toBe(world.regionHandle(12)?.offset);
		// Two regions of nonzero size cannot share a start.
		expect(world.regionOffset(11)).not.toBe(world.regionOffset(12));
		// An id nobody declared is absent, not an error.
		expect(world.regionOffset(99)).toBe(0);
	});
});

describe("ECS.entityIdAtRow", () => {
	it("converts an (archetype, row) pair back to the entity, and refuses a row past the end", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const spawned = [world.spawn(), world.spawn(), world.spawn()];
		for (const e of spawned) world.addComponent(e, Pos, { x: 0 });

		const archs = world.query(Pos).nonEmptyArchs();
		expect(archs.length).toBe(1);
		const arch = archs[0];

		const roundTripped: number[] = [];
		for (let row = 0; row < arch.entityCount; row++) {
			roundTripped.push(Number(world.entityIdAtRow(arch.id, row)));
		}
		expect(roundTripped.sort((l, r) => l - r)).toEqual(spawned.map(Number).sort((l, r) => l - r));

		expect(() => world.entityIdAtRow(arch.id, arch.entityCount)).toThrow(ECSError);
		expect(() => world.entityIdAtRow(arch.id, -1)).toThrow(ECSError);
	});
});

describe("FrameStepper.fixedDt and maxDt", () => {
	it("read back the constructed value, and read back a later write", () => {
		const world = new ECS();
		const stepper = new FrameStepper(world, { fixedDt: 1 / 30, maxDt: 0.5 });
		expect(stepper.fixedDt).toBe(1 / 30);
		expect(stepper.maxDt).toBe(0.5);

		stepper.fixedDt = 1 / 120;
		stepper.maxDt = 0.1;
		expect(stepper.fixedDt).toBe(1 / 120);
		expect(stepper.maxDt).toBe(0.1);

		// A rejected write leaves the previous value in place. Zero is accepted
		// here, unlike `ECS.fixedTimestep`: this value is only the default `dt`
		// of `step()`, it never divides an accumulator.
		expect(() => (stepper.fixedDt = -1)).toThrow(ECSError);
		expect(() => (stepper.maxDt = Number.NaN)).toThrow(ECSError);
		expect(stepper.fixedDt).toBe(1 / 120);
		expect(stepper.maxDt).toBe(0.1);
		stepper.fixedDt = 0;
		expect(stepper.fixedDt).toBe(0);
	});

	it("defaults are readable without an options object", () => {
		const stepper = new FrameStepper(new ECS());
		expect(stepper.fixedDt).toBe(1 / 60);
		expect(stepper.maxDt).toBe(0.25);
	});
});

describe("ChangedQuery.forEachArchetype under includeDisabled", () => {
	it("spans the disabled rows, and restores the flag for the next query", () => {
		const world = new ECS();
		const Pos = world.registerComponent({ x: "f64" });
		const live = world.spawn();
		world.addComponent(live, Pos, { x: 1 });
		const off = world.spawn();
		world.addComponent(off, Pos, { x: 2 });
		world.disable(off);

		const plain = world.query(Pos);
		const all = world.query(Pos).includeDisabled();

		let enabledRows = 0;
		let allRows = 0;
		let afterCount = 0;
		const writer = world.registerSystem({
			...openAccess([Pos]),
			fn() {
				for (const arch of all.nonEmptyArchs()) arch.getColumnMut(Pos, "x", world.getChangeTick());
			}
		});
		const reader = world.registerSystem({
			...openAccess([Pos]),
			fn() {
				enabledRows = 0;
				allRows = 0;
				plain.changed(Pos).forEachArchetype((arch) => {
					enabledRows += arch.entityCount;
				});
				all.changed(Pos).forEachArchetype((arch) => {
					allRows += arch.entityCount;
				});
				// The all-rows flag is restored on the way out, so a plain query
				// read after the include-disabled loop still hides the disabled row.
				afterCount = plain.entityCount;
			}
		});

		world.addSystems(SCHEDULE.UPDATE, writer, { system: reader, ordering: { after: [writer] } });
		world.startup();
		for (let i = 0; i < 3; i++) world.update(1 / 60);

		expect(enabledRows).toBe(1);
		expect(allRows).toBe(2);
		expect(afterCount).toBe(1);
	});
});
