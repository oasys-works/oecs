/**
 * Grouped ECS facades (H3 phase 2) — behavior of the four secondary surfaces.
 *
 * Each facade wraps the Store entry points the pre-0.5 flat forms used
 * (flat forms removed in 0.5.0), so these pin the facade surfaces directly:
 * relations, events, resources, snapshots.
 */

import { describe, expect, it } from "vitest";
import { ECS, eventKey, resourceKey, signalKey } from "../../index";

describe("ECS grouped facades (H3 phase 2)", () => {
	it("relations: register/add/has/targetOf/traversal/compact", () => {
		const ecs = new ECS();
		const ChildOf = ecs.relations.register();
		const parent = ecs.spawn();
		const mid = ecs.spawn();
		const leaf = ecs.spawn();

		ecs.relations.add(mid, ChildOf, parent).add(leaf, ChildOf, mid);

		expect(ecs.relations.count).toBe(1);
		expect(ecs.relations.has(mid, ChildOf)).toBe(true);
		expect(ecs.relations.targetOf(mid, ChildOf)).toBe(parent);
		expect(ecs.relations.targetsOf(leaf, ChildOf)).toEqual([mid]);
		expect(ecs.relations.sourcesOf(parent, ChildOf)).toEqual([mid]);
		expect(ecs.relations.ancestorsOf(leaf, ChildOf)).toEqual([leaf, mid, parent]);
		expect(ecs.relations.rootOf(leaf, ChildOf)).toBe(parent);
		expect(ecs.relations.cascadeOf(parent, ChildOf)).toEqual([parent, mid, leaf]);
		expect(ecs.relations.pairsOf(ChildOf)).toEqual([
			[mid, parent],
			[leaf, mid]
		]);
		expect(ecs.relations.sourcesOfAny(parent)).toEqual([[ChildOf, mid]]);

		ecs.relations.remove(mid, ChildOf);
		expect(ecs.relations.has(mid, ChildOf)).toBe(false);
		expect(ecs.relations.compact()).toBeGreaterThanOrEqual(0);
	});

	it("events: register/emit/read and signals", () => {
		const ecs = new ECS();
		const Damage = eventKey<{ amount: number }>("Damage");
		const Ping = signalKey("Ping");
		ecs.events.register(Damage, ["amount"]);
		ecs.events.registerSignal(Ping);

		ecs.events.emit(Damage, { amount: 7 });
		ecs.events.emit(Ping);

		const reader = ecs.events.read(Damage);
		expect(reader.length).toBe(1);
		expect(reader.amount[0]).toBe(7);
	});

	it("resources: register/get/set/remove/has", () => {
		const ecs = new ECS();
		const Gold = resourceKey<number>("Gold");
		ecs.resources.register(Gold, 10);
		expect(ecs.resources.has(Gold)).toBe(true);
		expect(ecs.resources.get(Gold)).toBe(10);

		ecs.resources.set(Gold, 25);
		expect(ecs.resources.get(Gold)).toBe(25);

		ecs.resources.remove(Gold);
		expect(ecs.resources.has(Gold)).toBe(false);
	});

	it("snapshots: deterministic flag + capture/restore round-trip", () => {
		const ecs = new ECS({ deterministic: true });
		expect(ecs.snapshots.deterministic).toBe(true);

		const Pos = ecs.registerComponent({ x: "i32", y: "i32" });
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: 3, y: 4 });

		const hashBefore = ecs.snapshots.stateHash();

		const bytes = ecs.snapshots.capture();
		ecs.setField(e, Pos, "x", 99);
		expect(ecs.snapshots.stateHash()).not.toBe(hashBefore);

		ecs.snapshots.restore(bytes);
		expect(ecs.snapshots.stateHash()).toBe(hashBefore);
		expect(ecs.getField(e, Pos, "x")).toBe(3);

		// Sparse half round-trips through the facade too.
		const sparseBytes = ecs.snapshots.captureSparse();
		ecs.snapshots.restoreSparse(sparseBytes);
		expect(ecs.snapshots.stateHash()).toBe(hashBefore);
	});

	it("snapshots facade stays gated on non-deterministic worlds", () => {
		const ecs = new ECS();
		expect(ecs.snapshots.deterministic).toBe(false);
		expect(() => ecs.snapshots.stateHash()).toThrow();
		expect(() => ecs.snapshots.capture()).toThrow();
	});
});
