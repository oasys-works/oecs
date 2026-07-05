/**
 * `Store._queryDirtyEpoch` — coalesced query-dirty signal (#327).
 *
 * Replaces the per-mutation walk over `registeredQueries` that wrote one
 * dirty bit per query. The epoch is a monotonic integer bumped by every
 * membership-changing path and read lazily by `Query._nonEmpty()`. Two
 * properties to lock in:
 *
 *   1. **Coalescing.** N back-to-back immediate-mode operations between
 *      two reads must produce at most one rebuild of the non-empty list.
 *      The previous implementation rebuilt zero times beyond the first
 *      read, because each operation only re-set an already-set dirty bit,
 *      but the *walk* over `registeredQueries` ran N×Q times. The epoch
 *      collapses both: N integer increments, one rebuild on next read.
 *
 *   2. **Correctness.** Membership changes between reads still invalidate
 *      the cache. A query that observed an archetype going non-empty,
 *      then saw it drained, then saw it refilled, must report the correct
 *      `_nonEmpty()` set every time.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

describe("Store._query_dirty_epoch (#327)", () => {
	it("coalesces N immediate add_component calls into zero epoch bumps once the target archetype is non-empty", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		// Seed one entity so the [Pos] archetype exists and is non-empty;
		// query and cache.
		const seed = world.spawn();
		world.addComponent(seed, Pos, { x: 0, y: 0 });
		const q = world.query(Pos);
		expect(q.archetypeCount).toBe(1);
		q.forEach(() => {});
		// Snapshot the cached non-empty list so we can prove coalescing
		// behaviourally below: a rebuild allocates a fresh array, so an
		// unchanged reference == no rebuild happened.
		const cachedNonEmpty = q._nonEmpty();

		const store = (world as unknown as { store: Store }).store;
		const epochBefore = store._queryDirtyEpoch;

		// All 1000 adds go into the existing [Pos] archetype (1→2, 2→3, …)
		// — every add stays on the non-zero side, so the non-empty membership
		// set never changes.
		const N = 1000;
		for (let i = 0; i < N; i++) {
			const e = world.spawn();
			world.addComponent(e, Pos, { x: i, y: i });
		}

		// Behaviour: the query still sees every new row + the seed, and it
		// served them WITHOUT rebuilding the non-empty list (same reference) —
		// the N adds coalesced into zero rebuilds.
		let seen = 0;
		q.forEach((a) => {
			seen += a.entityCount;
		});
		expect(seen).toBe(N + 1);
		expect(q._nonEmpty()).toBe(cachedNonEmpty);

		// Secondary internal probe: the dirty epoch is a semi-public
		// optimisation contract (#327/#328). The 0-crossing rule suppresses a
		// bump on every non-zero-side add, so the epoch must be untouched.
		expect(store._queryDirtyEpoch).toBe(epochBefore);
	});

	it("Query._non_empty cache survives reads when no mutation happened", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		const first: unknown[] = [];
		q.forEach((a) => first.push(a));

		// Re-read without any mutation: the archetype list returned must be
		// the same reference as before — proves the epoch-equality fast path
		// returned the cached array instead of rebuilding it.
		const second: unknown[] = [];
		q.forEach((a) => second.push(a));
		expect(second.length).toBe(first.length);
		for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
	});

	it("epoch invalidates the cache when an archetype goes empty then refills", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);

		const e = world.spawn();
		world.addComponent(e, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		let count = 0;
		q.forEach((a) => {
			count += a.entityCount;
		});
		expect(count).toBe(1);

		// Drain the archetype — _mark_queries_dirty fires via destroyEntity's
		// _rowCountsDirty path? It does (immediate destroyEntity sets the
		// flag and bumps the epoch through that path).
		const store = (world as unknown as { store: Store }).store;
		store.destroyEntity(e);

		count = 0;
		q.forEach((a) => {
			count += a.entityCount;
		});
		// Drained: nothing matches.
		expect(count).toBe(0);

		// Refill — same archetype, new entity.
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 1, y: 1 });

		count = 0;
		q.forEach((a) => {
			count += a.entityCount;
		});
		expect(count).toBe(1);
	});

	it("epoch bumps when a new matching archetype is installed mid-session", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);

		// First archetype: [Pos] only. Query and cache.
		const e1 = world.spawn();
		world.addComponent(e1, Pos, { x: 0, y: 0 });

		const q = world.query(Pos);
		expect(q.archetypeCount).toBe(1);
		q.forEach(() => {});

		const store = (world as unknown as { store: Store }).store;
		const epochBefore = store._queryDirtyEpoch;

		// Force creation of a second matching archetype [Pos, Vel]. archInstall
		// runs once for the new archetype; the epoch must bump so the cached
		// `_nonEmptyArchetypes` list rebuilds on next read.
		const e2 = world.spawn();
		world.addComponent(e2, Pos, { x: 1, y: 1 });
		world.addComponent(e2, Vel, { vx: 0, vy: 0 });

		expect(store._queryDirtyEpoch).toBeGreaterThan(epochBefore);
		expect(q.archetypeCount).toBe(2);
		let total = 0;
		q.forEach((a) => {
			total += a.entityCount;
		});
		expect(total).toBe(2);
	});
});
