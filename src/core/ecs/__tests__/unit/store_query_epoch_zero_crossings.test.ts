/**
 * `Store._queryDirtyEpoch` only bumps on 0-crossings (#328).
 *
 * After #327, the epoch made the mark O(1). #328 narrows _what_ counts as a
 * mark: only an archetype crossing the 0/non-zero boundary changes
 * `Query._nonEmptyArchetypes`. A mutation that takes an arch from 5 → 6
 * (or 6 → 5) leaves the non-empty set unchanged and must not invalidate
 * cached query results.
 *
 * Closes the latent #316 bug as a side-effect: immediate
 * `Store.destroyEntity` previously only flagged row counts, leaving
 * cached queries stale when the destroyed entity was the last in its
 * archetype. The shared `_onArchLenChange` helper now bumps the
 * query epoch on that 1→0 case.
 *
 * #812 widens the crossing test from `length` alone to `length` OR
 * `enabledCount` (#577 split the non-empty filter by partition). An enabled
 * row appended to an archetype that is non-empty but all-disabled
 * (`length > 0, enabledCount == 0`) crosses `enabledCount` 0→1 without
 * touching `length`, so the old length-only bump missed it and a cached
 * default query stayed stale. The final `describe` block covers that, for both
 * the immediate and the deferred-flush paths.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import type { EntityID } from "../../entity";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

function getStore(world: ECS): Store {
	return (world as unknown as { store: Store }).store;
}

describe("Store._query_dirty_epoch 0-crossings only (#328)", () => {
	it("same-side mutations (e.g. 5→6, 6→5) do not bump the epoch", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);

		// Prime: 5 entities in [Pos] archetype. This includes the initial
		// 0→1 crossing on the first add plus the install of [Pos] itself.
		const ids: EntityID[] = [];
		for (let i = 0; i < 5; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
			ids.push(e);
		}

		const epochAfterPrime = store._queryDirtyEpoch;

		// Add a 6th entity to the SAME archetype — 5→6, not a 0-crossing.
		const e6 = world.spawn();
		world.addComponent(e6, Pos, { x: 99, y: 99 });
		expect(store._queryDirtyEpoch).toBe(epochAfterPrime);

		// Remove one entity — 6→5, not a 0-crossing.
		store.destroyEntity(ids[0]);
		expect(store._queryDirtyEpoch).toBe(epochAfterPrime);

		// Sanity: query still returns the right count after the no-bump path.
		const q = world.query(Pos);
		let total = 0;
		q.forEach((a) => {
			total += a.entityCount;
		});
		expect(total).toBe(5);
	});

	it("0→non-zero bumps on the first add into a fresh archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const store = getStore(world);

		// Establish [Pos] archetype with one entity. The query caches.
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const q = world.query(Pos);
		expect(q.archetypeCount).toBe(1);
		q.forEach(() => {});

		const epochBefore = store._queryDirtyEpoch;

		// New archetype [Pos, Vel]. archInstall does NOT bump (still empty),
		// but the move into it crosses 0→1 and bumps once on the tgt side.
		// (The src side — the previously [Pos] arch — drops from 1→0, that's
		//  another 0-crossing, so two bumps total are expected.)
		const b = world.spawn();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });

		expect(store._queryDirtyEpoch).toBeGreaterThan(epochBefore);
		expect(q.archetypeCount).toBe(2);
	});

	it("a cached query sees a component-less entity move into a freshly-installed archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		// Establish + cache the [Pos] archetype so a query is already live
		// before the move below. (The empty/UNASSIGNED archetype is created
		// lazily at the first createEntity.)
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.query(Pos).forEach(() => {});

		// Cache a query over the NOT-YET-EXISTING [Vel] shape. No [Vel]
		// archetype has been installed, so it currently matches nothing.
		const qVel = world.query(Vel);
		expect(qVel.archetypeCount).toBe(0);
		qVel.forEach(() => {});

		// A component-less (UNASSIGNED) entity gains Vel. This installs the
		// brand-new [Vel] archetype AND crosses its entity count 0→1. The
		// observable contract is that the cached query now reports exactly this
		// entity. (Whether the install itself bumps the dirty epoch is an
		// internal optimisation — #328 — and is invisible here: bumps coalesce
		// into a single cache rebuild on the next read regardless of count.)
		const b = world.spawn();
		world.addComponent(b, Vel, { vx: 0, vy: 0 });

		expect(qVel.archetypeCount).toBe(1);
		let total = 0;
		let foundB = false;
		qVel.forEach((arch) => {
			total += arch.entityCount;
			for (let i = 0; i < arch.entityCount; i++) {
				if (arch.entityIds[i] === b) foundB = true;
			}
		});
		expect(total).toBe(1);
		expect(foundB).toBe(true);
	});

	it("destroying the last entity in an archetype invalidates query caches (#316)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);

		// One entity in [Pos]. Query caches the non-empty list as 1 arch.
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });
		const q = world.query(Pos);
		let count = 0;
		q.forEach((a) => {
			count += a.entityCount;
		});
		expect(count).toBe(1);

		// Immediate destroy — previously left _nonEmptyArchetypes stale
		// because the path only set _rowCountsDirty (#316). With the
		// epoch bumping on the 1→0 crossing, the query rebuilds.
		store.destroyEntity(e);

		count = 0;
		q.forEach((a) => {
			count += a.entityCount;
		});
		expect(count).toBe(0);
	});

	it("deferred destroy + flush bumps the epoch once when an archetype empties (#457)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);

		// 3 entities in [Pos]. Query caches the non-empty list.
		const ids: EntityID[] = [];
		for (let i = 0; i < 3; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
			ids.push(e);
		}
		const q = world.query(Pos);
		q.forEach(() => {});

		const epochBefore = store._queryDirtyEpoch;

		// Defer-destroy ALL three, then flush. The [Pos] arch crosses 3→0, so
		// `flushDestroyed`'s inline detector (#457) must bump the epoch exactly
		// once — replacing the old per-entity pre-length Map.
		for (const e of ids) store.destroyEntityDeferred(e);
		store.flushDestroyed();
		expect(store._queryDirtyEpoch - epochBefore).toBe(1);

		// And the cached query rebuilds: the emptied archetype is gone.
		let total = 0;
		q.forEach((a) => {
			total += a.entityCount;
		});
		expect(total).toBe(0);
	});

	it("deferred destroy + flush does NOT bump the epoch when no archetype empties (#457)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);

		const ids: EntityID[] = [];
		for (let i = 0; i < 5; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
			ids.push(e);
		}
		world.query(Pos).forEach(() => {});

		const epochBefore = store._queryDirtyEpoch;

		// Destroy 2 of 5 — the [Pos] arch goes 5→3, never reaching 0. No
		// 0-crossing, so the epoch must stay put (queries remain valid).
		store.destroyEntityDeferred(ids[0]);
		store.destroyEntityDeferred(ids[1]);
		store.flushDestroyed();
		expect(store._queryDirtyEpoch).toBe(epochBefore);

		let total = 0;
		world.query(Pos).forEach((a) => {
			total += a.entityCount;
		});
		expect(total).toBe(3);
	});

	it("batch_add_component bumps once per 0-crossing (src always; tgt iff was empty)", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const store = getStore(world);

		// 3 entities in [Pos], 1 entity in [Pos, Vel] — establishes both
		// archetypes with non-zero counts.
		const posOnly: EntityID[] = [];
		for (let i = 0; i < 3; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
			posOnly.push(e);
		}
		const seedPv = world.spawn();
		world.addComponent(seedPv, Pos, { x: 99, y: 99 });
		world.addComponent(seedPv, Vel, { vx: 1, vy: 1 });

		const posArch = store.getEntityArchetype(posOnly[0]);
		expect(posArch.length).toBe(3);

		const epochBefore = store._queryDirtyEpoch;

		// Bulk add Vel to ALL of [Pos] arch:
		//  - src [Pos] crosses 3→0 (bump)
		//  - tgt [Pos, Vel] is currently 1 (non-zero), goes to 4. No cross.
		// Total: exactly 1 bump.
		store.batchAddComponent(posArch.id, Vel, { vx: 0, vy: 0 });
		expect(store._queryDirtyEpoch - epochBefore).toBe(1);
	});

	it("preserves correctness over a stress sequence of mixed mutations", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const store = getStore(world);

		const qPos = world.query(Pos);

		// Random-ish sequence: adds, in-place writes (no bump), removes, destroys.
		const ids: EntityID[] = [];
		for (let i = 0; i < 100; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
			ids.push(e);
		}
		// Add Vel to half. Many will share the [Pos, Vel] arch — only the first
		// is a 0-crossing on the tgt side, but each src→tgt move also moves the
		// src count (the [Pos]-only arch shrinks). Only the 100→99 transition
		// is a "no-cross" — fine.
		for (let i = 0; i < 50; i++) {
			world.addComponent(ids[i], Vel, { vx: 0, vy: 0 });
		}
		// Remove Vel from a few. Those go back to [Pos]-only.
		for (let i = 0; i < 10; i++) {
			store.removeComponent(ids[i], Vel);
		}
		// Destroy a few.
		for (let i = 90; i < 100; i++) {
			store.destroyEntity(ids[i]);
		}

		let total = 0;
		qPos.forEach((a) => {
			total += a.entityCount;
		});
		expect(total).toBe(90); // 100 created - 10 destroyed
	});
});

/**
 * #812 — an enabled row added to an archetype that is non-empty but all-disabled
 * (`length > 0, enabledCount == 0`) crosses `enabledCount` 0→1 without crossing
 * `length`. The old length-only `_onArchLenChange` bump missed it, so a cached
 * default query kept its stale `_nonEmpty` list and the new entity was invisible.
 */
describe("enabled_count 0-crossings on row add (#812)", () => {
	const Tag = ["v"] as const;

	it("cached query sees an enabled row added to an all-disabled archetype (the issue repro)", () => {
		const world = new ECS();
		const T = world.registerComponent(Tag);
		world.startup();

		const a = world.spawn();
		world.addComponent(a, T, { v: 1 });

		// Prime the cached query's _nonEmpty list with the [Tag] archetype.
		const q = world.query(T);
		expect(q.entityCount).toBe(1);

		// All of [Tag] goes disabled — enabledCount 1→0, epoch bumps, cache drops it.
		world.disable(a);
		expect(q.entityCount).toBe(0);

		// A fresh enabled entity joins the SAME archetype: length 1→2 (no cross),
		// enabledCount 0→1 (the missed cross). The new row must be visible.
		const b = world.spawn();
		world.addComponent(b, T, { v: 2 });

		// Ground truth from the issue.
		expect(world.isAlive(b)).toBe(true);
		expect(world.isDisabled(b)).toBe(false);
		expect(world.hasComponent(b, T)).toBe(true);

		expect(q.entityCount).toBe(1);
		// And via the entity-walking path, on a freshly-resolved (same cached) query.
		const seen: number[] = [];
		world.query(T).forEachEntity((e) => seen.push(Number(e)));
		expect(seen).toEqual([Number(b)]);
	});

	it("bumps the dirty epoch on the enabled_count 0→1 crossing (white-box)", () => {
		const world = new ECS();
		const T = world.registerComponent(Tag);
		const store = getStore(world);

		const a = world.spawn();
		world.addComponent(a, T, { v: 1 });
		world.query(T).forEach(() => {});
		world.disable(a);

		const epochBefore = store._queryDirtyEpoch;
		const b = world.spawn();
		world.addComponent(b, T, { v: 2 }); // enabledCount 0→1, length 1→2
		expect(store._queryDirtyEpoch).toBeGreaterThan(epochBefore);
	});

	it("cached query sees an entity transitioned INTO an all-disabled target archetype", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		world.startup();

		// A persistent [Pos]-only entity keeps the SOURCE archetype non-empty
		// across the transition below, so the source side never crosses `length`
		// 0 — isolating the bug to the TARGET side's enabledCount crossing (else
		// the incidental source-side bump would rebuild the cache and mask it).
		const keep = world.spawn();
		world.addComponent(keep, Pos, { x: 7, y: 7 });

		// Establish [Pos, Vel] with a single entity, then disable it so the
		// archetype is all-disabled (length 1, enabledCount 0).
		const x = world.spawn();
		world.addComponent(x, Pos, { x: 0, y: 0 });
		world.addComponent(x, Vel, { vx: 0, vy: 0 });

		const q = world.query(Vel);
		expect(q.entityCount).toBe(1);
		world.disable(x);
		expect(q.entityCount).toBe(0);

		// y transitions [Pos] → [Pos, Vel] via addComponent. Source [Pos] goes
		// 2→1 (keep remains, no length cross); target [Pos, Vel] is all-disabled,
		// so the enabled append crosses enabledCount 0→1 only.
		const y = world.spawn();
		world.addComponent(y, Pos, { x: 1, y: 1 });
		world.addComponent(y, Vel, { vx: 9, vy: 9 });

		expect(q.entityCount).toBe(1);
		const seen: number[] = [];
		q.forEachEntity((e) => seen.push(Number(e)));
		expect(seen).toEqual([Number(y)]);
	});

	it("deferred add + flush_structural sees an enabled row into an all-disabled archetype", () => {
		const world = new ECS();
		const T = world.registerComponent(Tag);
		const store = getStore(world);
		world.startup();

		const a = world.spawn();
		world.addComponent(a, T, { v: 1 });
		const q = world.query(T);
		expect(q.entityCount).toBe(1);
		store.disableEntity(a);
		expect(q.entityCount).toBe(0);

		// Deferred add into the all-disabled [Tag] archetype, settled by
		// flushStructural via `_flushAdds` → `_settleFlushDirty`.
		const b = world.spawn();
		const epochBefore = store._queryDirtyEpoch;
		store.addComponentDeferred(b, T, { v: 2 });
		store.flushStructural();

		expect(store._queryDirtyEpoch).toBeGreaterThan(epochBefore);
		expect(q.entityCount).toBe(1);
		const seen: number[] = [];
		q.forEachEntity((e) => seen.push(Number(e)));
		expect(seen).toEqual([Number(b)]);
	});

	it("spawn into an all-disabled archetype is visible to a cached query", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const store = getStore(world);
		world.startup();

		// Seed [Pos] with one entity, cache the query, then disable it.
		const a = world.spawn();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const q = world.query(Pos);
		expect(q.entityCount).toBe(1);
		store.disableEntity(a);
		expect(q.entityCount).toBe(0);

		// createEntity(template) appends a fresh enabled row into the same
		// (all-disabled) archetype.
		const arch = store.getEntityArchetype(a);
		const tmpl = world.template([{ def: Pos, values: { x: 5, y: 5 } }]);
		world.spawn(tmpl);
		expect(arch.enabledCount).toBe(1);
		expect(q.entityCount).toBe(1);
	});
});
