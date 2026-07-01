/**
 * Relations — canonical fold is the single source of truth (#498).
 *
 * After the polymorphic `RelationStore` refactor, the canonical multi traversal
 * (sources ascending by index, each source's targets ascending by id, empty
 * sets skipped) lives in exactly one place — `RelationStore.for_each_canonical_-
 * target_set` — and `stateHash`, `snapshotRelations`, and `pairsOf` all fold
 * through it. These tests lock in that they can no longer disagree:
 *
 *  - the digest + the `(R,*)` enumeration are insertion-order-independent (the
 *    #470 determinism property the canonical ordering exists to give);
 *  - snapshot → restore round-trips the multi forward sets so `stateHash` and
 *    `pairsOf` are preserved across the wire-shaped buffer;
 *  - `compactRelations` (#491 / #504) is pure reverse-index reclaim — it
 *    perturbs neither `stateHash` (reverse index isn't folded) nor `pairsOf`
 *    (forward links are left dangling), which is the cardinality-free shape the
 *    refactor rides.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import type { EntityID } from "../../entity";

const pairNums = (pairs: [EntityID, EntityID][]): [number, number][] =>
	pairs.map(([s, t]) => [s as number, t as number]);

describe("relations canonical fold — single source of truth (#498)", () => {
	it("state_hash + pairs_of are insertion-order-independent for a multi relation", () => {
		// World A and B hold identical logical content reached by DIFFERENT
		// add orders. The canonical fold must make them hash + enumerate the same.
		const build = (order: "forward" | "scrambled"): { store: Store; pairs: [number, number][] } => {
			const store = new Store({ deterministic: true });
			const Likes = store.registerRelation({ multi: true });
			const Targets = store.registerRelation({ exclusive: true });
			const s = [0, 1, 2, 3].map(() => store.createEntity());
			const t = [0, 1, 2, 3].map(() => store.createEntity());

			if (order === "forward") {
				store.addRelation(s[0], Likes, t[0]);
				store.addRelation(s[0], Likes, t[1]);
				store.addRelation(s[1], Likes, t[2]);
				store.addRelation(s[2], Likes, t[0]);
				store.addRelation(s[2], Likes, t[3]);
			} else {
				// Same five edges, scrambled source + target order.
				store.addRelation(s[2], Likes, t[3]);
				store.addRelation(s[0], Likes, t[1]);
				store.addRelation(s[2], Likes, t[0]);
				store.addRelation(s[1], Likes, t[2]);
				store.addRelation(s[0], Likes, t[0]);
			}
			// An exclusive relation alongside, also added in differing order.
			if (order === "forward") {
				store.addRelation(s[0], Targets, t[3]);
				store.addRelation(s[3], Targets, t[1]);
			} else {
				store.addRelation(s[3], Targets, t[1]);
				store.addRelation(s[0], Targets, t[3]);
			}
			return { store, pairs: pairNums(store.pairsOf(Likes)) };
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
		const src = new Store({ deterministic: true });
		const Likes = src.registerRelation({ multi: true });
		const Targets = src.registerRelation({ exclusive: true });
		const s = [0, 1, 2].map(() => src.createEntity());
		const t = [0, 1, 2].map(() => src.createEntity());
		src.addRelation(s[0], Likes, t[1]);
		src.addRelation(s[0], Likes, t[0]);
		src.addRelation(s[2], Likes, t[2]);
		src.addRelation(s[1], Targets, t[0]);

		const hashBefore = src.stateHash();
		const likesBefore = pairNums(src.pairsOf(Likes));
		const targetsBefore = pairNums(src.pairsOf(Targets));
		const bytes = src.snapshotSparse();

		// Restore into a fresh world with the SAME registration order.
		const dst = new Store({ deterministic: true });
		const Likes2 = dst.registerRelation({ multi: true });
		const Targets2 = dst.registerRelation({ exclusive: true });
		for (let i = 0; i < 6; i++) dst.createEntity(); // same index space as src
		dst.restoreSparse(bytes);

		expect(dst.stateHash()).toBe(hashBefore);
		expect(pairNums(dst.pairsOf(Likes2))).toEqual(likesBefore);
		expect(pairNums(dst.pairsOf(Targets2))).toEqual(targetsBefore);
		// Reverse index rebuilt too (multi from bytes, exclusive from sparse field).
		expect(
			dst
				.sourcesOf(Likes2, t[0])
				.map((e) => e as number)
				.sort((x, y) => x - y)
		).toEqual([s[0] as number]);
		expect(dst.sourcesOf(Targets2, t[0]).map((e) => e as number)).toEqual([s[1] as number]);
	});

	it("compact_relations reclaims dead-target reverse entries without changing state_hash or pairs_of", () => {
		const store = new Store({ deterministic: true });
		const Likes = store.registerRelation({ multi: true }); // default orphan policy
		const Targets = store.registerRelation({ exclusive: true }); // default orphan policy
		const s0 = store.createEntity();
		const s1 = store.createEntity();
		const victim = store.createEntity();
		const survivor = store.createEntity();

		store.addRelation(s0, Likes, victim);
		store.addRelation(s0, Likes, survivor);
		store.addRelation(s1, Targets, victim);

		// Destroy the shared target. Under `orphan` (the default), the forward
		// links + reverse entries are left dangling — this is the accumulation
		// `compactRelations` exists to reclaim.
		store.destroyEntity(victim);
		expect(store.isAlive(victim)).toBe(false);

		const hashAfterDestroy = store.stateHash();
		const likesAfterDestroy = pairNums(store.pairsOf(Likes));
		const targetsAfterDestroy = pairNums(store.pairsOf(Targets));

		const dropped = store.compactRelations();
		// Exactly victim's two reverse entries: one in Likes (from s0), one in
		// Targets (from s1). survivor is alive, so its Likes reverse entry stays.
		expect(dropped).toBe(2);

		// Pure reverse-index reclaim: the digest (reverse index is never folded)
		// and the forward enumeration (links stay dangling) are unchanged.
		expect(store.stateHash()).toBe(hashAfterDestroy);
		expect(pairNums(store.pairsOf(Likes))).toEqual(likesAfterDestroy);
		expect(pairNums(store.pairsOf(Targets))).toEqual(targetsAfterDestroy);
		// The only observable change: sourcesOf on the dead handle goes to [].
		expect(store.sourcesOf(Likes, victim)).toEqual([]);
		expect(store.sourcesOf(Targets, victim)).toEqual([]);
	});
});
