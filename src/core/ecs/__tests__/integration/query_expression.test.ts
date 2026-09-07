/**
 * The `and`, `or` and `not` combinators, and the expression they hand `where`.
 *
 * A chained term asks one flat question of the component mask. An expression
 * nests, so `or(and(Pos, Vel), Frozen)` says what no chain says.
 *
 * What this file locks: each connective alone, a nested expression, `not` over
 * several operands, composition of `where` with `and`, `not`, `or` and
 * `optional`, and an expression over a definition the query does not name.
 *
 * `third_party_query_term.test.ts` locks the same seam for a term a plugin
 * hand-builds, plus the three refusals.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { and, or, not } from "../../query_terms";

function world(): ReturnType<typeof ECS.create> {
	return ECS.create();
}

/** Three components and one tag every case here shares. */
function fixture() {
	const w = world();
	return {
		w,
		A: w.registerComponent({ v: "i32" }, { name: "A" }),
		B: w.registerComponent({ v: "i32" }, { name: "B" }),
		C: w.registerComponent({ v: "i32" }, { name: "C" }),
		Tag: w.registerComponent({ v: "i32" }, { name: "Tag" })
	};
}

function collect(q: { forEachEntity(cb: (e: number) => void): void }): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e));
	return out.sort((x, y) => x - y);
}

describe("archetype expression combinators", () => {
	it("and keeps only an archetype that holds every operand", () => {
		const { w, A, B, Tag } = fixture();
		const ab = w.spawnBundle(Tag, A, B);
		w.spawnBundle(Tag, A);
		w.spawnBundle(Tag, B);
		w.spawnBundle(Tag);
		w.flush();

		expect(collect(w.query(Tag).where(and(A, B)))).toEqual([ab]);
	});

	it("or keeps an archetype that holds one operand or more", () => {
		const { w, A, B, Tag } = fixture();
		const ab = w.spawnBundle(Tag, A, B);
		const justA = w.spawnBundle(Tag, A);
		const justB = w.spawnBundle(Tag, B);
		w.spawnBundle(Tag);
		w.flush();

		expect(collect(w.query(Tag).where(or(A, B)))).toEqual([ab, justA, justB].sort((x, y) => x - y));
	});

	it("not drops an archetype that holds any operand", () => {
		const { w, A, B, Tag } = fixture();
		w.spawnBundle(Tag, A, B);
		w.spawnBundle(Tag, A);
		w.spawnBundle(Tag, B);
		const none = w.spawnBundle(Tag);
		w.flush();

		// Several operands read as one negated disjunction, so this is the
		// archetype that holds neither, and not the one that misses either.
		expect(collect(w.query(Tag).where(not(A, B)))).toEqual([none]);
		// The same set as the chained form, which is what makes the two words
		// one word.
		expect(collect(w.query(Tag).not(A, B))).toEqual([none]);
	});

	it("nests, so or(and(A, B), C) says what no chain says", () => {
		const { w, A, B, C, Tag } = fixture();
		const ab = w.spawnBundle(Tag, A, B);
		const justC = w.spawnBundle(Tag, C);
		const abc = w.spawnBundle(Tag, A, B, C);
		const justA = w.spawnBundle(Tag, A);
		const justB = w.spawnBundle(Tag, B);
		w.spawnBundle(Tag);
		w.flush();

		const q = w.query(Tag).where(or(and(A, B), C));
		expect(collect(q)).toEqual([ab, justC, abc].sort((x, y) => x - y));
		expect(collect(q)).not.toContain(justA);
		expect(collect(q)).not.toContain(justB);
	});

	it("nests a not inside an or", () => {
		const { w, A, B, C, Tag } = fixture();
		const justC = w.spawnBundle(Tag, C);
		const ab = w.spawnBundle(Tag, A, B);
		const bare = w.spawnBundle(Tag);
		w.spawnBundle(Tag, A);
		w.flush();

		// Hold C, or hold neither A nor B. `ab` holds both, so the negation
		// drops it and the disjunction does not save it.
		expect(collect(w.query(Tag).where(or(C, not(A, B))))).toEqual(
			[justC, bare].sort((x, y) => x - y)
		);
		expect(collect(w.query(Tag).where(or(C, not(A, B))))).not.toContain(ab);
	});

	it("judges a definition the query does not otherwise name", () => {
		const { w, A, Tag } = fixture();
		// `Hidden` is a term of no query here. The expression still reads its
		// bit, because an expression judges the mask and not the term list.
		const Hidden = w.registerComponent({ v: "i32" }, { name: "Hidden" });
		const hidden = w.spawnBundle(Tag, A, Hidden);
		w.spawnBundle(Tag, A);
		w.flush();

		expect(collect(w.query(Tag).where(and(Hidden)))).toEqual([hidden]);
		expect(collect(w.query(Tag).where(not(Hidden))).length).toBe(1);
	});

	it("composes with and, not, or and optional, in either order", () => {
		const { w, A, B, C, Tag } = fixture();
		const Dead = w.registerComponent({ v: "i32" }, { name: "Dead" });

		const live = w.spawnBundle(Tag, A, B);
		w.spawnBundle(Tag, A, B, Dead);
		const liveC = w.spawnBundle(Tag, C);
		w.spawnBundle(Tag, A);
		w.flush();

		const expr = or(and(A, B), C);
		expect(collect(w.query(Tag).where(expr).not(Dead))).toEqual(
			collect(w.query(Tag).not(Dead).where(expr))
		);
		expect(collect(w.query(Tag).where(expr).not(Dead))).toEqual(
			[live, liveC].sort((x, y) => x - y)
		);

		// `and` narrows by the mask, the expression narrows at the rebuild, and
		// the pair holds in either order.
		expect(collect(w.query(Tag).where(expr).and(A))).toEqual(
			collect(w.query(Tag).and(A).where(expr))
		);
		// `or` widens the mask, so it must survive the expression too.
		expect(collect(w.query(Tag).where(expr).or(A, C))).toEqual(
			collect(w.query(Tag).or(A, C).where(expr))
		);
		// `optional` does not narrow, so it leaves the expression's set alone.
		expect(collect(w.query(Tag).where(expr).optional(A))).toEqual(
			collect(w.query(Tag).where(expr))
		);
	});

	it("names itself for a refusal, leaf and node alike", () => {
		const { A, B, C } = fixture();
		expect(and(A, B).name).toBe("and(A, B)");
		expect(or(and(A, B), C).name).toBe("or(and(A, B), C)");
		expect(not(A).name).toBe("not(A)");
	});

	it("takes the identity of its algebra on an empty operand list", () => {
		const { w, A, Tag } = fixture();
		const a = w.spawnBundle(Tag, A);
		const bare = w.spawnBundle(Tag);
		w.flush();

		// A fold over an empty list must not silently narrow.
		expect(collect(w.query(Tag).where(and()))).toEqual([a, bare].sort((x, y) => x - y));
		expect(collect(w.query(Tag).where(not()))).toEqual([a, bare].sort((x, y) => x - y));
		expect(collect(w.query(Tag).where(or()))).toEqual([]);
	});
});
