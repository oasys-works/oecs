/**
 * Grouped ECS facades, behavior of the four secondary surfaces.
 *
 * Each facade wraps the Store entry points the pre-0.5 flat forms used
 * (flat forms removed in 0.5.0), so these pin the facade surfaces directly:
 * relations, events, resources, snapshots.
 */

import { describe, expect, it } from "vitest";
import { ECS, eventKey, resourceKey, signalKey } from "../../index";
import { ECSError, ECS_ERROR } from "../../utils/error";
import { Store } from "../../store";
import { snapshots } from "../../../../plugins/snapshots";
import { events } from "../../../../plugins/events";
import { relations } from "../../../../plugins/relations";
import { storeOnlyHost } from "../../plugin";



describe("ECS grouped facades", () => {
	it("relations: register, add, has, targetOf, traversal and compact", () => {
		const ecs = ECS.create({ plugins: [snapshots(), relations()] });
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

	it("events: register, emit and read and signals", () => {
		const ecs = ECS.create({ plugins: [events(), relations()] });
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

	it("resources: register, get, set, remove and has", () => {
		const ecs = ECS.create({ plugins: [snapshots(), relations()] });
		const Gold = resourceKey<number>("Gold");
		ecs.resources.register(Gold, 10);
		expect(ecs.resources.has(Gold)).toBe(true);
		expect(ecs.resources.get(Gold)).toBe(10);

		ecs.resources.set(Gold, 25);
		expect(ecs.resources.get(Gold)).toBe(25);

		ecs.resources.remove(Gold);
		expect(ecs.resources.has(Gold)).toBe(false);
	});

	it("snapshots: deterministic flag + capture and restore round-trip", () => {
		const ecs = ECS.create({ ...({ deterministic: true }), plugins: [snapshots(), relations()] });
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

	it("a world without the plugin fails closed, naming the remedy", () => {
		// Two distinct failures, and both matter.
		//
		// On the world, `capture` is absent from the type, which is the primary
		// guard, and present on the prototype, so a JavaScript caller meets the
		// fault instead of a `TypeError` about a missing method. The core half of
		// the facade still answers, because determinism is a property of the
		// world and not of the plugin.
		const bare = ECS.create({ ...({ deterministic: true }), plugins: [relations()] });
		expect(bare.snapshots.deterministic).toBe(true);
		expect(typeof bare.snapshots.stateHash()).toBe("number");
		const bareSnapshots = bare.snapshots as unknown as Record<string, () => unknown>;
		for (const method of ["capture", "restore", "captureSparse", "restoreSparse"]) {
			try {
				bareSnapshots[method]();
				expect.unreachable(`ecs.snapshots.${method} must throw without the plugin`);
			} catch (e) {
				const err = e as ECSError;
				expect(err).toBeInstanceOf(ECSError);
				expect(err.category).toBe(ECS_ERROR.PLUGIN_NOT_INSTALLED);
				expect(err.message).toContain(`ecs.snapshots.${method}`);
				expect(err.message).toContain("@oasys/oecs/snapshots");
			}
		}

		// Below the world, the store's own entry point is reachable, and that is
		// where the fault has to name the remedy: the fix is a construction-site
		// edit, so the message names the plugin and the import.
		const store = new Store({ deterministic: true });
		try {
			store.snapshot();
			expect.unreachable("Store.snapshot() must throw without the plugin");
		} catch (e) {
			const err = e as ECSError;
			expect(err).toBeInstanceOf(ECSError);
			expect(err.category).toBe(ECS_ERROR.PLUGIN_NOT_INSTALLED);
			expect(err.message).toContain("snapshots");
			expect(err.message).toContain("ECS.create");
		}
		// Installing it opens exactly that door.
		snapshots().install(storeOnlyHost(store));
		expect(store.snapshot()).toBeInstanceOf(Uint8Array);
	});

	it("snapshots facade stays gated on non-deterministic worlds", () => {
		const ecs = ECS.create({ plugins: [snapshots(), relations()] });
		expect(ecs.snapshots.deterministic).toBe(false);
		expect(() => ecs.snapshots.stateHash()).toThrow();
		expect(() => ecs.snapshots.capture()).toThrow();
	});
});
