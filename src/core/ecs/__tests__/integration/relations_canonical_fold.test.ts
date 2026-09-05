/**
 * Relations, canonical fold is the single source of truth.
 *
 * After the polymorphic `RelationStore` refactor, the canonical multi traversal
 * (sources ascending by index, each source's targets ascending by id, empty
 * sets skipped) lives in exactly one place, `RelationStore.for_each_canonical_-
 * target_set`, and `stateHash`, `snapshotRelations`, and `pairsOf` all fold
 * through it. These tests lock in that they can no longer disagree:
 *
 *  - the digest + the `(R,*)` enumeration are insertion-order-independent (the
 *    determinism property the canonical ordering exists to give);
 *  - snapshot → restore round-trips the multi forward sets so `stateHash` and
 *    `pairsOf` are preserved across the wire-shaped buffer
 *  - `compactRelations` is pure reverse-index reclaim. It
 *    perturbs neither `stateHash` (reverse index isn't folded) nor `pairsOf`
 *    (forward links are left dangling), which is the cardinality-free shape the
 *    refactor rides.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import type { EntityID } from "../../entity";
import { snapshots } from "../../../../plugins/snapshots";
import { relations } from "../../../../plugins/relations";
import { storeOnlyHost } from "../../../../core/ecs/plugin";

/** A store with the plugins these cases drive installed.
 * `ECS.create({ plugins: [relations(), snapshots()] })` is the same
 * wiring one layer up. */
function capStore(...args: ConstructorParameters<typeof Store>): Store {
	const built = new Store(...args);
	relations().install(storeOnlyHost(built));
	snapshots().install(storeOnlyHost(built));
	return built;
}



const pairNums = (pairs: readonly (readonly [EntityID, EntityID])[]): [number, number][] =>
	pairs.map(([s, t]) => [s as number, t as number]);

describe("relations canonical fold, single source of truth", () => {
	it("state_hash + pairs_of are insertion-order-independent for a multi relation", () => {
		// World A and B hold identical logical content reached by different
		// add orders. The canonical fold must make them hash + enumerate the same.
		const build = (order: "forward" | "scrambled"): { store: Store; pairs: [number, number][] } => {
			const store = capStore({ deterministic: true });
			const Likes = store.relations.registerRelation({ multi: true });
			const Targets = store.relations.registerRelation({ exclusive: true });
			const s = [0, 1, 2, 3].map(() => store.createEntity());
			const t = [0, 1, 2, 3].map(() => store.createEntity());

			if (order === "forward") {
				store.relations.addRelation(s[0], Likes, t[0]);
				store.relations.addRelation(s[0], Likes, t[1]);
				store.relations.addRelation(s[1], Likes, t[2]);
				store.relations.addRelation(s[2], Likes, t[0]);
				store.relations.addRelation(s[2], Likes, t[3]);
			} else {
				// Same five edges, scrambled source + target order.
				store.relations.addRelation(s[2], Likes, t[3]);
				store.relations.addRelation(s[0], Likes, t[1]);
				store.relations.addRelation(s[2], Likes, t[0]);
				store.relations.addRelation(s[1], Likes, t[2]);
				store.relations.addRelation(s[0], Likes, t[0]);
			}
			// An exclusive relation alongside, also added in differing order.
			if (order === "forward") {
				store.relations.addRelation(s[0], Targets, t[3]);
				store.relations.addRelation(s[3], Targets, t[1]);
			} else {
				store.relations.addRelation(s[3], Targets, t[1]);
				store.relations.addRelation(s[0], Targets, t[3]);
			}
			return { store, pairs: pairNums(store.relations.pairsOf(Likes)) };
		};

		const a = build("forward");
		const b = build("scrambled");

		expect(a.store.stateHash()).toBe(b.store.stateHash());
		expect(a.pairs).toEqual(b.pairs);

		// And the enumeration really is canonical: sources ascending, each
		// source's targets ascending.
		const flat = a.pairs.map(([sx, tx]) => sx * 1000 + tx);
		expect(flat).toEqual([...flat].sort((x, y) => x - y));
	});

	it("snapshot → restore preserves state_hash and pairs_of (multi forward sets round-trip)", () => {
		const src = capStore({ deterministic: true });
		const Likes = src.relations.registerRelation({ multi: true });
		const Targets = src.relations.registerRelation({ exclusive: true });
		const s = [0, 1, 2].map(() => src.createEntity());
		const t = [0, 1, 2].map(() => src.createEntity());
		src.relations.addRelation(s[0], Likes, t[1]);
		src.relations.addRelation(s[0], Likes, t[0]);
		src.relations.addRelation(s[2], Likes, t[2]);
		src.relations.addRelation(s[1], Targets, t[0]);

		const hashBefore = src.stateHash();
		const likesBefore = pairNums(src.relations.pairsOf(Likes));
		const targetsBefore = pairNums(src.relations.pairsOf(Targets));
		const bytes = src.snapshotSparse();

		// Restore into a fresh world with the same registration order.
		const dst = capStore({ deterministic: true });
		const Likes2 = dst.relations.registerRelation({ multi: true });
		const Targets2 = dst.relations.registerRelation({ exclusive: true });
		for (let i = 0; i < 6; i++) dst.createEntity(); // same index space as src
		dst.restoreSparse(bytes);

		expect(dst.stateHash()).toBe(hashBefore);
		expect(pairNums(dst.relations.pairsOf(Likes2))).toEqual(likesBefore);
		expect(pairNums(dst.relations.pairsOf(Targets2))).toEqual(targetsBefore);
		// Reverse index rebuilt too (multi from bytes, exclusive from sparse field).
		expect(
			dst
				.relations.sourcesOf(t[0], Likes2)
				.map((e) => e as number)
				.sort((x, y) => x - y)
		).toEqual([s[0] as number]);
		expect(dst.relations.sourcesOf(t[0], Targets2).map((e) => e as number)).toEqual([s[1] as number]);
	});

	it("compact_relations reclaims dead-target reverse entries without changing state_hash or pairs_of", () => {
		const store = capStore({ deterministic: true });
		const Likes = store.relations.registerRelation({ multi: true }); // default orphan policy
		const Targets = store.relations.registerRelation({ exclusive: true }); // default orphan policy
		const s0 = store.createEntity();
		const s1 = store.createEntity();
		const victim = store.createEntity();
		const survivor = store.createEntity();

		store.relations.addRelation(s0, Likes, victim);
		store.relations.addRelation(s0, Likes, survivor);
		store.relations.addRelation(s1, Targets, victim);

		// Destroy the shared target. Under `orphan` (the default), the forward
		// links + reverse entries are left dangling. This is the accumulation
		// `compactRelations` exists to reclaim.
		store.destroyEntity(victim);
		expect(store.isAlive(victim)).toBe(false);

		const hashAfterDestroy = store.stateHash();
		const likesAfterDestroy = pairNums(store.relations.pairsOf(Likes));
		const targetsAfterDestroy = pairNums(store.relations.pairsOf(Targets));

		const dropped = store.relations.compactRelations();
		// Exactly victim's two reverse entries: one in Likes (from s0), one in
		// Targets (from s1). survivor is alive, so its Likes reverse entry stays.
		expect(dropped).toBe(2);

		// Pure reverse-index reclaim: the digest (reverse index is never folded)
		// and the forward enumeration (links stay dangling) are unchanged.
		expect(store.stateHash()).toBe(hashAfterDestroy);
		expect(pairNums(store.relations.pairsOf(Likes))).toEqual(likesAfterDestroy);
		expect(pairNums(store.relations.pairsOf(Targets))).toEqual(targetsAfterDestroy);
		// The only observable change: sourcesOf on the dead handle goes to [].
		expect(store.relations.sourcesOf(victim, Likes)).toEqual([]);
		expect(store.relations.sourcesOf(victim, Targets)).toEqual([]);
	});
});
