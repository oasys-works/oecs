/**
 * Relationship wildcard QUERY TERMS (#579) — `(R, *)` / `(*, T)` as composable
 * query terms, distinct from the cold materializing helpers `pairsOf(R)` /
 * `sourcesOfAny(T)` (#472).
 *
 *  - `withRelation(R)` / `withoutRelation(R)` — `(R, *)`: match sources that
 *    hold (or don't hold) any target under `R`. Membership semantics (each source
 *    once), iterated via `forEachEntity`, reusing the sparse-match path
 *    (insertion order; canonical sorting reserved for `stateHash`/snapshot).
 *  - `forEachRelatedTo(T)` — `(*, T)`: every source related to `T` under any
 *    relation, dedup'd, ascending-EntityID order, composing with the receiver's
 *    dense / sparse / `(R, *)` predicate.
 *  - Access: `withRelation` needs `relationReads: [R]`; `forEachRelatedTo`
 *    needs `relationReads: [ANY_RELATION]`.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ANY_RELATION } from "../../relation";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";
import type { SystemContext } from "../../query";
import type { SystemConfig } from "../../system";

const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;

/** Collect a sparse/wildcard query's yielded entities as a sorted number array
 * (membership order is insertion order, not canonical — so sort for set-equality
 * assertions; determinism of the raw order is asserted separately). */
function collect(q: { forEachEntity(cb: (e: EntityID) => void): void }): number[] {
	const out: number[] = [];
	q.forEachEntity((e) => out.push(e as number));
	return out.sort((a, b) => a - b);
}

const sorted = (ids: EntityID[]): number[] => ids.map((e) => e as number).sort((a, b) => a - b);

// ─────────────────────────── (R, *) withRelation ───────────────────────
describe("(R, *) require_relation — membership", () => {
	it("matches every source holding a target (exclusive), spanning archetypes", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Targets = world.registerRelation();

		// Sources in different archetypes; some related, some not.
		const a = world.createEntity();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		const b = world.createEntity();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });
		const c = world.createEntity(); // empty archetype
		const target = world.createEntity();
		const unrelated = world.createEntity();
		world.addComponent(unrelated, Pos, { x: 9, y: 9 });

		world.addRelation(a, Targets, target);
		world.addRelation(b, Targets, target);
		world.addRelation(c, Targets, target);

		expect(collect(world.query().withRelation(Targets))).toEqual(sorted([a, b, c]));
	});

	it("matches a multi source once regardless of how many targets it holds", () => {
		const world = new ECS();
		const Likes = world.registerRelation({ multi: true });
		const a = world.createEntity();
		const t1 = world.createEntity();
		const t2 = world.createEntity();
		const t3 = world.createEntity();
		const b = world.createEntity();
		world.addRelation(a, Likes, t1);
		world.addRelation(a, Likes, t2);
		world.addRelation(a, Likes, t3);
		world.addRelation(b, Likes, t1);

		// Membership: a appears ONCE despite three targets (not pair-expansion).
		expect(collect(world.query().withRelation(Likes))).toEqual(sorted([a, b]));
	});

	it("drops a source once its relation is removed", () => {
		const world = new ECS();
		const Targets = world.registerRelation();
		const a = world.createEntity();
		const b = world.createEntity();
		const t = world.createEntity();
		world.addRelation(a, Targets, t);
		world.addRelation(b, Targets, t);
		world.removeRelation(a, Targets);
		expect(collect(world.query().withRelation(Targets))).toEqual(sorted([b]));
	});

	it("equals the distinct sources of pairs_of(R)", () => {
		const world = new ECS();
		const Likes = world.registerRelation({ multi: true });
		const ents = Array.from({ length: 6 }, () => world.createEntity());
		world.addRelation(ents[0], Likes, ents[4]);
		world.addRelation(ents[0], Likes, ents[5]);
		world.addRelation(ents[2], Likes, ents[4]);
		world.addRelation(ents[3], Likes, ents[5]);
		const distinct = [...new Set(world.pairsOf(Likes).map(([src]) => src as number))].sort(
			(a, b) => a - b
		);
		expect(collect(world.query().withRelation(Likes))).toEqual(distinct);
	});

	it("still matches an orphan-dangling source (membership row persists, like pairs_of)", () => {
		const world = new ECS();
		const Targets = world.registerRelation(); // default orphan
		const a = world.createEntity();
		const t = world.createEntity();
		world.addRelation(a, Targets, t);
		world.destroyEntity(t); // deferred...
		world.flush(); // ...apply: a now dangles at a dead handle, but still "has a pair"
		expect(collect(world.query().withRelation(Targets))).toEqual(sorted([a]));
		// Consistent with the materializing helper.
		expect(world.pairsOf(Targets).map(([src]) => src as number)).toEqual([a as number]);
	});
});

// ─────────────────────────── (R, *) composition ────────────────────────────
describe("(R, *) require_relation / exclude_relation — composition", () => {
	it("intersects with a dense require term", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const withPos = world.createEntity();
		world.addComponent(withPos, Pos, { x: 0, y: 0 });
		world.addRelation(withPos, Targets, t);
		const noPos = world.createEntity(); // related but no Pos
		world.addRelation(noPos, Targets, t);
		expect(collect(world.query(Pos).withRelation(Targets))).toEqual(sorted([withPos]));
	});

	it("intersects with a .not() dense exclude", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Vel = world.registerComponent(Velocity);
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const a = world.createEntity();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addRelation(a, Targets, t);
		const b = world.createEntity();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addComponent(b, Vel, { vx: 0, vy: 0 });
		world.addRelation(b, Targets, t);
		expect(collect(world.query(Pos).without(Vel).withRelation(Targets))).toEqual(sorted([a]));
	});

	it("exclude_relation drops sources that hold the relation", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const related = world.createEntity();
		world.addComponent(related, Pos, { x: 0, y: 0 });
		world.addRelation(related, Targets, t);
		const free = world.createEntity();
		world.addComponent(free, Pos, { x: 1, y: 1 });
		expect(collect(world.query(Pos).withoutRelation(Targets))).toEqual(sorted([free]));
	});

	it("composes (R, *) with require_sparse (both must hold)", () => {
		const world = new ECS();
		const Marked = world.registerSparseTag();
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const a = world.createEntity(); // related + marked
		world.addRelation(a, Targets, t);
		world.addSparse(a, Marked);
		const b = world.createEntity(); // related, not marked
		world.addRelation(b, Targets, t);
		expect(collect(world.query().withRelation(Targets).withSparse(Marked))).toEqual(
			sorted([a])
		);
	});

	it("excludes disabled sources by default, includes them with include_disabled()", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const a = world.createEntity();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addRelation(a, Targets, t);
		const b = world.createEntity();
		world.addComponent(b, Pos, { x: 1, y: 1 });
		world.addRelation(b, Targets, t);
		world.disable(b);

		expect(collect(world.query(Pos).withRelation(Targets))).toEqual(sorted([a]));
		expect(collect(world.query(Pos).withRelation(Targets).includeDisabled())).toEqual(
			sorted([a, b])
		);
	});
});

// ─────────────────────────── (R, *) cache stability ────────────────────────
describe("(R, *) require_relation — cached, stable instances (#497)", () => {
	it("repeated require_relation from the same parent returns the identical Query", () => {
		const world = new ECS();
		const R = world.registerRelation();
		const base = world.query();
		expect(base.withRelation(R)).toBe(base.withRelation(R));
	});

	it("multi-arg require_relation equals the chained form", () => {
		const world = new ECS();
		const A = world.registerRelation();
		const B = world.registerRelation();
		const base = world.query();
		expect(base.withRelation(A, B)).toBe(base.withRelation(A).withRelation(B));
	});

	it("dense composition keeps the (R, *) term regardless of order", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Targets = world.registerRelation();
		const t = world.createEntity();
		const a = world.createEntity();
		world.addComponent(a, Pos, { x: 0, y: 0 });
		world.addRelation(a, Targets, t);
		const b = world.createEntity();
		world.addRelation(b, Targets, t); // related, no Pos
		// withRelation(R).and(Pos) and query(Pos).withRelation(R) agree.
		expect(collect(world.query().withRelation(Targets).and(Pos))).toEqual(sorted([a]));
		expect(collect(world.query(Pos).withRelation(Targets))).toEqual(sorted([a]));
	});
});

// ─────────────────────────── (*, T) forEachRelatedTo ────────────────────
function collectRelated(
	q: { forEachRelatedTo(t: EntityID, cb: (e: EntityID) => void): void },
	T: EntityID
): number[] {
	const out: number[] = [];
	q.forEachRelatedTo(T, (e) => out.push(e as number));
	return out;
}

describe("(*, T) for_each_related_to — any relation, fixed target", () => {
	it("collects every source related to T across relation kinds, dedup'd", () => {
		const world = new ECS();
		const Targets = world.registerRelation();
		const Likes = world.registerRelation({ multi: true });
		const T = world.createEntity();
		const a = world.createEntity();
		const b = world.createEntity();
		const c = world.createEntity();
		const other = world.createEntity();
		world.addRelation(a, Targets, T);
		world.addRelation(b, Likes, T);
		world.addRelation(c, Targets, T);
		world.addRelation(c, Likes, T); // c related to T via TWO relations → once
		world.addRelation(a, Targets, other); // re-target away is irrelevant; a→other now

		const got = collectRelated(world.query(), T).sort((x, y) => x - y);
		// a re-targeted to `other`, so a no longer points at T; b and c do.
		expect(got).toEqual(sorted([b, c]));
	});

	it("yields nothing when no source targets T", () => {
		const world = new ECS();
		world.registerRelation();
		const lonely = world.createEntity();
		expect(collectRelated(world.query(), lonely)).toEqual([]);
	});

	it("intersects with the receiver's dense predicate", () => {
		const world = new ECS();
		const Pos = world.registerComponent(Position);
		const Targets = world.registerRelation();
		const T = world.createEntity();
		const withPos = world.createEntity();
		world.addComponent(withPos, Pos, { x: 0, y: 0 });
		world.addRelation(withPos, Targets, T);
		const noPos = world.createEntity();
		world.addRelation(noPos, Targets, T);
		expect(collectRelated(world.query(Pos), T)).toEqual(sorted([withPos]));
	});

	it("composes with a (R, *) term on the receiver", () => {
		const world = new ECS();
		const Targets = world.registerRelation();
		const Likes = world.registerRelation({ multi: true });
		const T = world.createEntity();
		const a = world.createEntity(); // targets T and likes something
		const liked = world.createEntity();
		world.addRelation(a, Targets, T);
		world.addRelation(a, Likes, liked);
		const b = world.createEntity(); // targets T only
		world.addRelation(b, Targets, T);
		// sources related to T that ALSO have any Likes pair → just a.
		expect(collectRelated(world.query().withRelation(Likes), T)).toEqual(sorted([a]));
	});

	it("is consistent with sources_of on an orphan-dangling dead target", () => {
		const world = new ECS();
		const Targets = world.registerRelation(); // orphan
		const T = world.createEntity();
		const a = world.createEntity();
		world.addRelation(a, Targets, T);
		world.destroyEntity(T); // deferred...
		world.flush(); // ...a dangles; reverse entry persists keyed by dead T
		// sourcesOf returns the dangling source; forEachRelatedTo agrees.
		expect(world.sourcesOf(Targets, T).map((e) => e as number)).toEqual([a as number]);
		expect(collectRelated(world.query(), T)).toEqual([a as number]);
	});
});

// ─────────────────────────── determinism ───────────────────────────────────
describe("(R, *) determinism — identical histories yield identical order", () => {
	it("two worlds built by the same op sequence yield the same raw order", () => {
		const build = (): number[] => {
			const world = new ECS();
			const R = world.registerRelation();
			const ents = Array.from({ length: 8 }, () => world.createEntity());
			// Scrambled-but-fixed insertion order.
			for (const i of [5, 1, 7, 0, 3, 6]) world.addRelation(ents[i], R, ents[2]);
			const out: number[] = [];
			world
				.query()
				.withRelation(R)
				.forEachEntity((e) => out.push(e as number));
			return out;
		};
		expect(build()).toEqual(build());
	});
});

// ─────────────────────────── dense-path guard ──────────────────────────────
describe("(R, *) — dense-path methods refuse the wildcard query (#556 shape)", () => {
	it("count() / for_each() throw, steering to for_each_entity", () => {
		const world = new ECS();
		const R = world.registerRelation();
		const q = world.query().withRelation(R);
		expect(() => q.count()).toThrow(/forEachEntity/);
		expect(() => q.forEach(() => {})).toThrow(/forEachEntity/);
	});
});

// ─────────────────────────── access checks (#579 / #496) ───────────────────
function base(overrides: Partial<SystemConfig>): SystemConfig {
	return {
		reads: [],
		writes: [],
		spawns: [],
		despawns: [],
		transitions: [],
		resourceReads: [],
		resourceWrites: [],
		fn: (_ctx: SystemContext, _dt: number) => {},
		...overrides
	};
}

function runOnce(world: ECS, cfg: SystemConfig): () => void {
	const sys = world.registerSystem(cfg);
	world.addSystems(SCHEDULE.UPDATE, sys);
	world.startup();
	return () => world.update(0);
}

describe("(R, *) / (*, T) access validation (#579)", () => {
	it("throws when a system iterates require_relation without declaring relation_reads", () => {
		const world = new ECS();
		const R = world.registerRelation();
		const a = world.createEntity();
		const t = world.createEntity();
		world.addRelation(a, R, t);
		const q = world.query().withRelation(R);

		const tick = runOnce(
			world,
			base({
				name: "wildcard_reader",
				fn() {
					q.forEachEntity(() => {});
				}
			})
		);
		expect(tick).toThrow(/system 'wildcard_reader'.*relation.*didn't declare/);
	});

	it("permits require_relation iteration when relation_reads is declared", () => {
		const world = new ECS();
		const R = world.registerRelation();
		const a = world.createEntity();
		const t = world.createEntity();
		world.addRelation(a, R, t);
		const q = world.query().withRelation(R);

		let n = -1;
		const tick = runOnce(
			world,
			base({
				name: "wildcard_reader_ok",
				relationReads: [R],
				fn() {
					n = 0;
					q.forEachEntity(() => n++);
				}
			})
		);
		expect(tick).not.toThrow();
		expect(n).toBe(1);
	});

	it("for_each_related_to throws without ANY_RELATION, passes with it", () => {
		const world = new ECS();
		const R = world.registerRelation();
		const a = world.createEntity();
		const T = world.createEntity();
		world.addRelation(a, R, T);
		const q = world.query();

		const undeclared = runOnce(
			world,
			base({
				name: "related_reader",
				fn() {
					q.forEachRelatedTo(T, () => {});
				}
			})
		);
		expect(undeclared).toThrow(/system 'related_reader'.*didn't declare/);

		const world2 = new ECS();
		const R2 = world2.registerRelation();
		const a2 = world2.createEntity();
		const T2 = world2.createEntity();
		world2.addRelation(a2, R2, T2);
		const q2 = world2.query();
		let n = -1;
		const declared = runOnce(
			world2,
			base({
				name: "related_reader_ok",
				relationReads: [ANY_RELATION],
				fn() {
					n = 0;
					q2.forEachRelatedTo(T2, () => n++);
				}
			})
		);
		expect(declared).not.toThrow();
		expect(n).toBe(1);
	});

	it("a dense write declaration does not authorise a (R, *) wildcard read", () => {
		const world = new ECS();
		const Pos = world.registerComponent(["x"] as const);
		const R = world.registerRelation(); // relation id 0, same number as Pos
		const a = world.createEntity();
		world.addComponent(a, Pos, { x: 1 });
		const t = world.createEntity();
		world.addRelation(a, R, t);
		const q = world.query(Pos).withRelation(R);

		const tick = runOnce(
			world,
			base({
				name: "dense_writer_touching_wildcard",
				writes: [Pos],
				fn() {
					q.forEachEntity(() => {});
				}
			})
		);
		expect(tick).toThrow(/relation.*didn't declare/);
	});
});
