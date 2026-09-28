/**
 * `forEachIds` must give the entities of `forEachEntity`, in the same
 * order, for every query shape.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";
import type { Query } from "../../query";

function walk(q: Query<any>): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
	return out;
}

function walkBatch(q: Query<any>, counts: number[] = []): number[] {
	const out: number[] = [];
	q.forEachIds((ids, count) => {
		counts.push(count);
		for (let i = 0; i < count; i++) out.push(ids[i] as number);
	});
	return out;
}

// Seeded, so a failure names its seed.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomWorld(seed: number, n = 200) {
	const r = rng(seed);
	const ecs = new ECS();
	const Pos = ecs.registerComponent({ x: "f64" });
	const Tag = ecs.registerTag();
	const Other = ecs.registerTag();
	const A = ecs.registerSparseComponent({ v: "f64" });
	const B = ecs.registerSparseTag();
	const C = ecs.registerSparseTag();

	const live: EntityID[] = [];
	for (let i = 0; i < n; i++) {
		const e = ecs.spawn();
		const shape = r();
		if (shape > 0.1) ecs.addComponent(e, Pos, { x: i });
		if (shape > 0.4) ecs.addComponent(e, Tag);
		if (shape > 0.7) ecs.addComponent(e, Other);
		if (r() < 0.8) ecs.addSparse(e, A, { v: i });
		if (r() < (seed % 2 === 0 ? 0.3 : 0.9)) ecs.addSparse(e, B);
		if (r() < 0.5) ecs.addSparse(e, C);
		live.push(e);
	}
	for (const e of live) {
		const roll = r();
		if (roll < 0.1) ecs.despawn(e);
		else if (roll < 0.2 && ecs.hasComponent(e, Pos)) ecs.disable(e);
		else if (roll < 0.25) ecs.removeSparse(e, A);
	}
	return { ecs, Pos, Tag, Other, A, B, C };
}

describe("forEachIds", () => {
	it("gives the entities of forEachEntity in the same order, across random worlds", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const { ecs, Pos, Tag, Other, A, B, C } = randomWorld(seed);
			const queries = [
				ecs.query().andSparse(A),
				ecs.query().andSparse(A, B),
				ecs.query().andSparse(B, A),
				ecs.query().andSparse(A, B, C),
				ecs.query(Pos).andSparse(A).notSparse(B),
				ecs.query(Pos).andSparse(A, B).notSparse(C),
				ecs.query(Pos).not(Tag).andSparse(A, B),
				ecs.query(Pos).or(Tag, Other).andSparse(B),
				ecs.query(Pos).notSparse(A),
				ecs.query(Pos).notSparse(A, C),
				ecs.query(Pos),
				ecs.query(Pos).not(Tag),
				ecs.query().includeDisabled().andSparse(A, B),
				ecs.query(Pos).includeDisabled().notSparse(B),
				ecs.query(Pos).includeDisabled()
			];
			for (const q of queries) expect(walkBatch(q), `seed ${seed}`).toEqual(walk(q));
		}
	});

	it("splits a long match into runs and keeps the order", () => {
		const { ecs, Pos, A, B, C } = randomWorld(3, 6000);
		for (const q of [ecs.query().andSparse(A, B), ecs.query(Pos).notSparse(C)]) {
			const counts: number[] = [];
			const got = walkBatch(q, counts);
			expect(got).toEqual(walk(q));
			expect(counts.length).toBeGreaterThan(1);
			for (const c of counts) expect(c).toBeGreaterThan(0);
		}
	});

	it("drives from the first of two stores of one size", () => {
		const ecs = new ECS();
		const P = ecs.registerSparseTag();
		const Q = ecs.registerSparseTag();
		const R = ecs.registerSparseTag();
		const ids = Array.from({ length: 4 }, () => ecs.spawn());
		// The same members in different orders, so the driver sets the order.
		for (const i of [0, 1, 2, 3]) ecs.addSparse(ids[i], P);
		for (const i of [3, 2, 1, 0]) ecs.addSparse(ids[i], Q);
		for (const i of [2, 0, 3, 1]) ecs.addSparse(ids[i], R);
		for (const q of [
			ecs.query().andSparse(P, Q),
			ecs.query().andSparse(Q, P),
			ecs.query().andSparse(R, P, Q),
			ecs.query().andSparse(Q, R, P)
		])
			expect(walkBatch(q)).toEqual(walk(q));
	});

	it("gives no call for an empty match", () => {
		const ecs = new ECS();
		const A = ecs.registerSparseTag();
		const Pos = ecs.registerComponent({ x: "f64" });
		let calls = 0;
		ecs
			.query()
			.andSparse(A)
			.forEachIds(() => calls++);
		ecs
			.query(Pos)
			.notSparse(A)
			.forEachIds(() => calls++);
		ecs.query(Pos).forEachIds(() => calls++);
		expect(calls).toBe(0);
	});

	it("keeps the outer run intact through a nested walk", () => {
		const { ecs, Pos, A, B, C } = randomWorld(8, 3000);
		const outer = ecs.query().andSparse(A, B);
		const inner = ecs.query(Pos).andSparse(C);
		const innerWant = walk(inner);
		const got: number[] = [];
		outer.forEachIds((ids, count) => {
			const before = Array.from({ length: count }, (_, i) => ids[i] as number);
			expect(walkBatch(inner)).toEqual(innerWant);
			for (let i = 0; i < count; i++) got.push(ids[i] as number);
			expect(got.slice(got.length - count)).toEqual(before);
		});
		expect(got).toEqual(walk(outer));
	});

	it("releases its buffer when the callback throws", () => {
		const { ecs, A, B, C } = randomWorld(5, 3000);
		const q = ecs.query().andSparse(A, B);
		const want = walk(q);
		expect(() =>
			q.forEachIds(() => {
				throw new Error("boom");
			})
		).toThrow("boom");
		// The outer walk must own its buffer again, so a nested walk cannot refill it.
		const inner = ecs.query().andSparse(C);
		const got: number[] = [];
		q.forEachIds((ids, count) => {
			const before = Array.from({ length: count }, (_, i) => ids[i] as number);
			walkBatch(inner);
			for (let i = 0; i < count; i++) got.push(ids[i] as number);
			expect(got.slice(got.length - count)).toEqual(before);
		});
		expect(got).toEqual(want);
	});
});
