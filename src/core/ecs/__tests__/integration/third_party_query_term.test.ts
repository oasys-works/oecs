/**
 * A query term written outside this package.
 *
 * The three mask terms cover what a bit mask answers: hold these, hold none of
 * these, hold one of these. `where` opens a fourth question to anyone, over
 * the same mask. The term here is `or(and(A, B), C)`, which no mask term
 * expresses.
 *
 * What this file locks: the term narrows the matched set, it composes with
 * `and`, `not` and `optional` in either order, a new archetype is judged
 * by it too, and the three readers that answer from the unfiltered dense list
 * refuse a term-carrying query rather than answering too wide.
 *
 * `query_terms.test.ts` covers the terms the core builds. This one proves the
 * seam holds from outside, the way `third_party_plugin.test.ts` does for the
 * plugin seam.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, ECSError } from "../../utils/error";
import type { ArchetypeTerm } from "../../query_terms";
import type { BitSet } from "../../../../type_primitives";

/** `or(and(a, b), c)` over an archetype's component mask, hand-built. */
function orAndTerm(a: number, b: number, c: number): ArchetypeTerm {
	return {
		name: "orAndTerm",
		matches(mask: BitSet): boolean {
			return (mask.has(a) && mask.has(b)) || mask.has(c);
		}
	};
}

function world(): ReturnType<typeof ECS.create> {
	return ECS.create();
}

describe("an archetype term written outside this package", () => {
	it("narrows the matched set the way no mask term can", () => {
		const w = world();
		const A = w.registerComponent({ v: "i32" }, { name: "A" });
		const B = w.registerComponent({ v: "i32" }, { name: "B" });
		const C = w.registerComponent({ v: "i32" }, { name: "C" });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });

		// Four shapes, one per branch of the term.
		const ab = w.spawnBundle(Tag, A, B);
		const justA = w.spawnBundle(Tag, A);
		const justC = w.spawnBundle(Tag, C);
		const none = w.spawnBundle(Tag);
		w.flush();

		const q = w.query(Tag).where(orAndTerm(A.id, B.id, C.id));
		const seen: number[] = [];
		q.forEachEntity((e) => seen.push(e));
		expect(seen.sort()).toEqual([ab, justC].sort());
		expect(seen).not.toContain(justA);
		expect(seen).not.toContain(none);

		// The plain query still sees every shape, so the term narrowed one
		// query and not the archetype list they share.
		const plain: number[] = [];
		w.query(Tag).forEachEntity((e) => plain.push(e));
		expect(plain.length).toBe(4);
	});

	it("composes with and, not and optional, in either order", () => {
		const w = world();
		const A = w.registerComponent({ v: "i32" }, { name: "A" });
		const B = w.registerComponent({ v: "i32" }, { name: "B" });
		const C = w.registerComponent({ v: "i32" }, { name: "C" });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const Dead = w.registerComponent({ v: "i32" }, { name: "Dead" });

		const live = w.spawnBundle(Tag, A, B);
		w.spawnBundle(Tag, A, B, Dead);
		w.spawnBundle(Tag, C, Dead);
		const liveC = w.spawnBundle(Tag, C);
		// The term rejects this one and `not(Dead)` keeps it, so each half
		// of the composition removes something the other does not.
		const justA = w.spawnBundle(Tag, A);
		w.flush();

		const term = orAndTerm(A.id, B.id, C.id);
		const collect = (q: { forEachEntity(cb: (e: number) => void): void }): number[] => {
			const out: number[] = [];
			q.forEachEntity((e) => out.push(e));
			return out.sort();
		};

		const first = collect(w.query(Tag).where(term).not(Dead));
		const second = collect(w.query(Tag).not(Dead).where(term));
		expect(first).toEqual([live, liveC].sort());
		expect(second).toEqual(first);
		// Each term does its own work: dropping either one widens the set.
		// Without the term, `Dead` alone keeps the three live shapes.
		expect(collect(w.query(Tag).not(Dead))).toEqual([live, liveC, justA].sort());
		// Without `Dead`, the term alone keeps the four shapes that hold both A
		// and B, or hold C.
		expect(collect(w.query(Tag).where(term)).length).toBe(4);

		// `optional` does not narrow, so it leaves the term's set alone.
		expect(collect(w.query(Tag).where(term).optional(A))).toEqual(
			collect(w.query(Tag).optional(A).where(term))
		);
	});

	it("gives one instance back for one term and one parent", () => {
		const w = world();
		const A = w.registerComponent({ v: "i32" }, { name: "A" });
		const B = w.registerComponent({ v: "i32" }, { name: "B" });
		const C = w.registerComponent({ v: "i32" }, { name: "C" });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const term = orAndTerm(A.id, B.id, C.id);
		const base = w.query(Tag);
		// Compared as a boolean, because a failure would otherwise ask the
		// matcher to serialise two live queries and the world behind them.
		expect(base.where(term) === base.where(term)).toBe(true);
	});

	it("judges an archetype that appears after the query was built", () => {
		const w = world();
		const A = w.registerComponent({ v: "i32" }, { name: "A" });
		const B = w.registerComponent({ v: "i32" }, { name: "B" });
		const C = w.registerComponent({ v: "i32" }, { name: "C" });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });

		const q = w.query(Tag).where(orAndTerm(A.id, B.id, C.id));
		expect(q.entityCount).toBe(0);

		// A matching shape the query has never seen.
		const later = w.spawnBundle(Tag, C);
		w.flush();
		const seen: number[] = [];
		q.forEachEntity((e) => seen.push(e));
		expect(seen).toEqual([later]);

		// And one the term rejects.
		w.spawnBundle(Tag, A);
		w.flush();
		const again: number[] = [];
		q.forEachEntity((e) => again.push(e));
		expect(again).toEqual([later]);
	});

	it("refuses the three readers that answer from the unfiltered list", () => {
		const w = world();
		const A = w.registerComponent({ v: "i32" }, { name: "A" });
		const B = w.registerComponent({ v: "i32" }, { name: "B" });
		const C = w.registerComponent({ v: "i32" }, { name: "C" });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const q = w.query(Tag).where(orAndTerm(A.id, B.id, C.id));

		for (const read of [
			(): unknown => q.archetypeCount,
			(): unknown => q.archetypes,
			(): unknown => q.excludeWords
		]) {
			let caught: unknown;
			try {
				read();
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ECSError);
			// The category is its own claim. An archetype term is not a sparse term,
			// so the refusal must not borrow the sparse code.
			expect((caught as ECSError).category).toBe(ECS_ERROR.QUERY_TERM_DENSE_PATH);
			expect((caught as ECSError).message).toContain("orAndTerm");
		}
	});
});
