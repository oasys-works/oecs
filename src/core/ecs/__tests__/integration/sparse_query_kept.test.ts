/**
 * `forEachIds` keeps the match of a query with a sparse require between passes,
 * keyed on the row epoch and the membership version of each sparse store the
 * query names. A missed key change gives a stale match. This file interleaves
 * every kind of change with passes, and compares each pass, in order, with
 * `forEachEntity`, which derives the match live at each pass and keeps nothing.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../phase";
import type { EntityID } from "../../entity";
import { relations } from "../../../../plugins/relations";
import { snapshots } from "../../../../plugins/snapshots";
import { openAccess } from "../test_helpers";

type Walkable = {
	forEachEntity(cb: (e: EntityID) => void): void;
	forEachIds(cb: (ids: ArrayLike<number>, count: number) => void): void;
};

function walk(q: Walkable): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
	return out;
}

function walkIds(q: Walkable, counts?: number[]): number[] {
	const out: number[] = [];
	q.forEachIds((ids, count) => {
		counts?.push(count);
		for (let i = 0; i < count; i++) out.push(ids[i]);
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

type Deferred = { kind: "add" | "remove" | "despawn" | "disable" | "enable"; e: EntityID };

function world(seed: number) {
	const r = rng(seed);
	const ecs = ECS.create({ deterministic: true, plugins: [relations(), snapshots()] });
	const Pos = ecs.registerComponent({ x: "i32" });
	const Tag = ecs.registerTag();
	const Other = ecs.registerTag();
	const A = ecs.registerSparseComponent({ v: "i32" });
	const B = ecs.registerSparseTag();
	const C = ecs.registerSparseTag();
	const R = ecs.relations.register();

	// Every dense shape exists before the first capture, so a restore finds the
	// archetype set it captured.
	const shapes = [[Pos], [Tag], [Other], [Pos, Tag], [Pos, Other], [Tag, Other], [Pos, Tag, Other]];
	for (const s of shapes) {
		const e = ecs.spawn();
		for (const d of s) ecs.addComponent(e, d as typeof Tag);
		ecs.despawn(e);
	}

	const deferred: Deferred[] = [];
	const sys = ecs.registerSystem({
		...openAccess([Pos, Tag, Other]),
		fn(ctx) {
			for (const d of deferred) {
				if (!ecs.isAlive(d.e)) continue;
				if (d.kind === "add") ctx.commands.add(d.e, Tag);
				else if (d.kind === "remove") ctx.commands.remove(d.e, Tag);
				else if (d.kind === "despawn") ctx.commands.despawn(d.e);
				else if (d.kind === "disable") ctx.commands.disable(d.e);
				else ctx.commands.enable(d.e);
			}
			deferred.length = 0;
		}
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();

	const ents: EntityID[] = [];
	const dress = (e: EntityID, i: number): void => {
		const shape = r();
		if (shape > 0.1) ecs.addComponent(e, Pos, { x: i });
		if (shape > 0.5) ecs.addComponent(e, Tag);
		if (shape > 0.75) ecs.addComponent(e, Other);
		if (r() < 0.7) ecs.addSparse(e, A, { v: i });
		if (r() < 0.6) ecs.addSparse(e, B);
		if (r() < 0.3) ecs.addSparse(e, C);
	};
	for (let i = 0; i < 120; i++) {
		const e = ecs.spawn();
		dress(e, i);
		ents.push(e);
	}

	const queries: Walkable[] = [
		ecs.query().andSparse(A),
		ecs.query().andSparse(A, B),
		ecs.query().andSparse(B, A),
		ecs.query().andSparse(A, B, C),
		ecs.query(Pos).andSparse(A),
		ecs.query(Pos).not(Tag).andSparse(A, B),
		ecs.query(Pos).or(Tag, Other).andSparse(B),
		ecs.query().includeDisabled().andSparse(A, B),
		ecs.query(Pos).andSparse(A).notSparse(C),
		ecs.query().andRelation(R),
		ecs.query(Pos).andSparse(B).notRelation(R),
		ecs.query().andSparse(C).andRelation(R)
	] as unknown as Walkable[];

	let step = 0;
	// The ids known at the capture. An id minted after it names nothing once
	// the world is restored: its slot may be free with the same generation,
	// and `isAlive` cannot tell. So a restore goes back to this list too.
	let saved: { bytes: Uint8Array; ents: EntityID[] } | null = null;
	const pick = (): EntityID => ents[Math.floor(r() * ents.length)];
	const alive = (): EntityID | null => {
		for (let k = 0; k < 8; k++) {
			const e = pick();
			if (ecs.isAlive(e)) return e;
		}
		return null;
	};

	const mutate = (): void => {
		const roll = Math.floor(r() * 15);
		const e = alive();
		if (e === null && roll < 12) return;
		switch (roll) {
			case 0:
				ecs.addSparse(e!, A, { v: ++step });
				break;
			case 1:
				ecs.removeSparse(e!, A);
				break;
			case 2:
				if (r() < 0.5) ecs.addSparse(e!, B);
				else ecs.removeSparse(e!, B);
				break;
			case 3:
				if (r() < 0.5) ecs.addSparse(e!, C);
				else ecs.removeSparse(e!, C);
				break;
			case 4:
				// A dense change that flips the mask test of `not(Tag)` and `or(Tag, Other)`.
				if (ecs.hasComponent(e!, Tag)) ecs.removeComponent(e!, Tag);
				else ecs.addComponent(e!, Tag);
				break;
			case 5:
				if (ecs.hasComponent(e!, Pos)) ecs.removeComponent(e!, Pos);
				else ecs.addComponent(e!, Pos, { x: 1 });
				break;
			case 6:
				if (ecs.hasComponent(e!, Pos) || ecs.hasComponent(e!, Tag) || ecs.hasComponent(e!, Other)) {
					if (ecs.isDisabled(e!)) ecs.enable(e!);
					else ecs.disable(e!);
				}
				break;
			case 7: {
				// Despawn, then respawn into the recycled slot.
				ecs.despawn(e!);
				const n = ecs.spawn();
				dress(n, ents.length);
				ents.push(n);
				break;
			}
			case 8: {
				const t = alive();
				if (t !== null && t !== e) ecs.relations.add(e!, R, t);
				break;
			}
			case 9:
				ecs.relations.remove(e!, R);
				break;
			case 10:
				// A field write leaves membership alone.
				if (ecs.hasSparse(e!, A)) ecs.setSparseField(e!, A, "v", ++step);
				break;
			case 11: {
				const kinds: Deferred["kind"][] = ["add", "remove", "despawn", "disable", "enable"];
				for (let k = 0; k < 3; k++) {
					const d = alive();
					if (d === null) continue;
					const kind = kinds[Math.floor(r() * kinds.length)];
					const placed =
						ecs.hasComponent(d, Pos) || ecs.hasComponent(d, Tag) || ecs.hasComponent(d, Other);
					if ((kind === "disable" || kind === "enable") && !placed) continue;
					deferred.push({ kind, e: d });
				}
				ecs.update(0);
				break;
			}
			case 12:
				if (saved === null || r() < 0.5)
					saved = { bytes: ecs.snapshots.capture(), ents: ents.slice() };
				else {
					ecs.snapshots.restore(saved.bytes);
					ents.length = 0;
					ents.push(...saved.ents);
				}
				break;
			case 13: {
				// The sparse half alone. It carries no liveness, so restore it before
				// any entity dies or is born: a member on a slot freed since the capture
				// would come back on that slot. The edits between are sparse only.
				const bytes = ecs.snapshots.captureSparse();
				for (let k = 0; k < 4; k++) {
					const s = alive();
					if (s === null) continue;
					if (r() < 0.5) ecs.removeSparse(s, A);
					else ecs.addSparse(s, B);
				}
				ecs.snapshots.restoreSparse(bytes);
				break;
			}
			default: {
				const n = ecs.spawn();
				dress(n, ents.length);
				ents.push(n);
			}
		}
	};

	return { ecs, r, queries, mutate, Pos, Tag, A, B };
}

describe("forEachIds, the kept sparse match", () => {
	it("gives the live match in order after every kind of change, across random worlds", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const { r, queries, mutate } = world(seed);
			for (let step = 0; step < 80; step++) {
				// About one pass in three follows no change, so the kept match is given.
				if (r() > 0.33) {
					const n = 1 + Math.floor(r() * 3);
					for (let k = 0; k < n; k++) mutate();
				}
				for (let qi = 0; qi < queries.length; qi++) {
					const q = queries[qi];
					const want = walk(q);
					expect(walkIds(q), `seed ${seed} step ${step} query ${qi}`).toEqual(want);
					if (r() < 0.3)
						expect(walkIds(q), `seed ${seed} step ${step} query ${qi}, again`).toEqual(want);
				}
			}
		}
	}, 60_000);

	it("matches a model of the terms after a change", () => {
		for (let seed = 1; seed <= 10; seed++) {
			const { ecs, r, mutate, Pos, Tag, A, B } = world(seed);
			const q = ecs.query(Pos).not(Tag).andSparse(A, B) as unknown as Walkable;
			for (let step = 0; step < 40; step++) {
				if (r() > 0.33) mutate();
				walkIds(q);
				const got = walkIds(q).sort((a, b) => a - b);
				const want: number[] = [];
				walk(ecs.query().andSparse(A) as unknown as Walkable).forEach((e) => {
					const id = e as EntityID;
					if (ecs.isDisabled(id)) return;
					if (!ecs.hasComponent(id, Pos) || ecs.hasComponent(id, Tag)) return;
					if (!ecs.hasSparse(id, B)) return;
					want.push(e);
				});
				want.sort((a, b) => a - b);
				expect(got, `seed ${seed} step ${step}`).toEqual(want);
			}
		}
	});

	it("gives a kept pass as a copy, and derives again on the next pass", () => {
		const ecs = new ECS();
		const A = ecs.registerSparseTag();
		const ids = Array.from({ length: 3000 }, () => ecs.spawn());
		for (const e of ids) ecs.addSparse(e, A);
		const q = ecs.query().andSparse(A);
		walkIds(q as unknown as Walkable);
		const kept = walkIds(q as unknown as Walkable);
		// Unbuffered removes during a pass that gives the kept match.
		const seen: number[] = [];
		const counts: number[] = [];
		q.forEachIds((run, count) => {
			counts.push(count);
			for (let i = 0; i < count; i++) seen.push(run[i]);
			if (counts.length === 1) for (let i = 0; i < 2000; i += 2) ecs.removeSparse(ids[i], A);
		});
		expect(seen).toEqual(kept);
		for (const c of counts) expect(c).toBeLessThanOrEqual(1024);
		expect(walkIds(q as unknown as Walkable)).toEqual(walk(q as unknown as Walkable));
		expect(walk(q as unknown as Walkable).length).toBe(2000);
	});

	it("keeps the outer pass intact through a nested pass of the same query that derives again", () => {
		const ecs = new ECS();
		const A = ecs.registerSparseTag();
		const ids = Array.from({ length: 3000 }, () => ecs.spawn());
		for (const e of ids) ecs.addSparse(e, A);
		const q = ecs.query().andSparse(A) as unknown as Walkable;
		walkIds(q);
		const kept = walkIds(q);
		const seen: number[] = [];
		let n = 0;
		q.forEachIds((run, count) => {
			const before = Array.from({ length: count }, (_, i) => run[i]);
			if (n++ === 0) {
				ecs.removeSparse(ids[5], A);
				// The nested pass must not refill a run the outer pass reads.
				expect(walkIds(q)).toEqual(walk(q));
			}
			for (let i = 0; i < count; i++) seen.push(run[i]);
			expect(seen.slice(seen.length - count)).toEqual(before);
		});
		expect(seen).toEqual(kept);
		expect(walkIds(q)).toEqual(walk(q));
	});

	it("derives again after a callback that throws", () => {
		const ecs = new ECS();
		const A = ecs.registerSparseTag();
		const ids = Array.from({ length: 50 }, () => ecs.spawn());
		for (const e of ids) ecs.addSparse(e, A);
		const q = ecs.query().andSparse(A) as unknown as Walkable;
		walkIds(q);
		expect(() =>
			q.forEachIds(() => {
				ecs.removeSparse(ids[0], A);
				throw new Error("boom");
			})
		).toThrow("boom");
		expect(walkIds(q)).toEqual(walk(q));
		expect(walkIds(q).length).toBe(49);
	});
});
