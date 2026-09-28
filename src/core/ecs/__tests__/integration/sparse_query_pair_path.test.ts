/**
 * The sparse fast path must give the same entities, in the same order, as the
 * general loop. An empty `notSparse` term sends a query to the general loop.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

type Walkable = { forEachEntity(cb: (e: EntityID) => void): void };

function walk(q: Walkable): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
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

function randomWorld(seed: number) {
	const r = rng(seed);
	const ecs = new ECS();
	const Pos = ecs.registerComponent({ x: "f64" });
	const Tag = ecs.registerTag();
	const Other = ecs.registerTag();
	const A = ecs.registerSparseComponent({ v: "f64" });
	const B = ecs.registerSparseTag();
	// No members. `notSparse(Never)` forces the general loop.
	const Never = ecs.registerSparseTag();

	const live: EntityID[] = [];
	for (let i = 0; i < 200; i++) {
		const e = ecs.spawn();
		const shape = r();
		// Some entities keep no dense component.
		if (shape > 0.1) ecs.addComponent(e, Pos, { x: i });
		if (shape > 0.4) ecs.addComponent(e, Tag);
		if (shape > 0.7) ecs.addComponent(e, Other);
		if (r() < 0.8) ecs.addSparse(e, A, { v: i });
		// `B` is rarer on even seeds, so both driver choices occur.
		if (r() < (seed % 2 === 0 ? 0.3 : 0.9)) ecs.addSparse(e, B);
		live.push(e);
	}
	for (const e of live) {
		const roll = r();
		if (roll < 0.1) ecs.despawn(e);
		else if (roll < 0.2 && ecs.hasComponent(e, Pos)) ecs.disable(e);
		else if (roll < 0.25) ecs.removeSparse(e, A);
	}
	return { ecs, Pos, Tag, Other, A, B, Never, live };
}

describe("sparse walk, one or two sparse requires", () => {
	it("yields the same entities in the same order as the general loop, across random worlds", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const { ecs, Pos, Tag, Other, A, B, Never } = randomWorld(seed);
			const queries = [
				ecs.query().andSparse(A),
				ecs.query().andSparse(A, B),
				ecs.query().andSparse(B, A),
				ecs.query(Pos).andSparse(A, B),
				ecs.query(Pos).not(Tag).andSparse(A, B),
				ecs.query(Pos).or(Tag, Other).andSparse(B),
				ecs.query().includeDisabled().andSparse(A, B),
				ecs.query(Pos).includeDisabled().andSparse(A)
			];
			for (const q of queries) {
				const fast = walk(q);
				const general = walk(q.notSparse(Never));
				expect(fast, `seed ${seed}`).toEqual(general);
			}
		}
	});

	it("matches a model of the terms", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const { ecs, Pos, Tag, A, B, live } = randomWorld(seed);
			const q = ecs.query(Pos).not(Tag).andSparse(A, B);
			const want: number[] = [];
			for (const e of live) {
				if (!ecs.isAlive(e) || ecs.isDisabled(e)) continue;
				if (!ecs.hasComponent(e, Pos) || ecs.hasComponent(e, Tag)) continue;
				if (!ecs.hasSparse(e, A) || !ecs.hasSparse(e, B)) continue;
				want.push(e as number);
			}
			want.sort((a, b) => a - b);
			expect(
				walk(q).sort((a, b) => a - b),
				`seed ${seed}`
			).toEqual(want);
		}
	});

	it("drives from the smaller store when the second require is smaller", () => {
		const ecs = new ECS();
		const Big = ecs.registerSparseTag();
		const Small = ecs.registerSparseTag();
		const ids = Array.from({ length: 6 }, () => ecs.spawn());
		for (const e of ids) ecs.addSparse(e, Big);
		// Reverse order, so the two member lists differ.
		ecs.addSparse(ids[4], Small);
		ecs.addSparse(ids[1], Small);
		expect(walk(ecs.query().andSparse(Big, Small))).toEqual([ids[4], ids[1]]);
		expect(walk(ecs.query().andSparse(Small, Big))).toEqual([ids[4], ids[1]]);
	});

	it("sees a remove made during the walk as the general loop sees it", () => {
		const run = (general: boolean): number[] => {
			const ecs = new ECS();
			const A = ecs.registerSparseTag();
			const B = ecs.registerSparseTag();
			const Never = ecs.registerSparseTag();
			const ids = Array.from({ length: 8 }, () => ecs.spawn());
			for (const e of ids) {
				ecs.addSparse(e, A);
				ecs.addSparse(e, B);
			}
			const base = ecs.query().andSparse(A, B);
			const q = general ? base.notSparse(Never) : base;
			const seen: number[] = [];
			q.forEachEntity((e) => {
				seen.push(e as number);
				// Unbuffered edits during the walk. Both loops must see them the same way.
				if (seen.length === 2) {
					ecs.removeSparse(ids[7], A);
					ecs.removeSparse(ids[5], B);
				}
			});
			return seen;
		};
		expect(run(false)).toEqual(run(true));
	});
});
