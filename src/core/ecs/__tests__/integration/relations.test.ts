/**
 * Relations — (relation, target) pairs on the sparse storage class (#471 / ADR-0011).
 *
 * Covers the issue's acceptance criteria:
 *  - register exclusive + multi-target relations; add/remove pairs; query
 *    forward (`targetOf` / `targetsOf`) and reverse (`sourcesOf`);
 *  - exclusive: adding a second target replaces the first (one per source);
 *  - the reverse index stays consistent through add, remove, and re-target;
 *  - add/remove of a pair causes no archetype transition (`archetype_count`
 *    and the source's `archetype_id` stay put);
 *  - consistency after churn (random add/remove/re-target), incl. destroy purge.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { RelationDef } from "../../relation";
import { Store } from "../../store";
import { type EntityID, MAX_ENTITY_ID, MAX_INDEX } from "../../entity";
import { SparseRestoreError } from "../../sparse_store";

const sorted = (ids: EntityID[]): number[] => ids.map((e) => e as number).sort((a, b) => a - b);

describe("ECS relations — exclusive (#471)", () => {
	it("registers, adds, queries forward + reverse, and removes", () => {
		const world = new ECS({ deterministic: true });
		const Targets = world.relations.register(); // exclusive by default
		const src = world.spawn();
		const tgt = world.spawn();

		expect(world.relations.has(src, Targets)).toBe(false);
		expect(world.relations.targetOf(src, Targets)).toBeUndefined();
		expect(sorted(world.relations.sourcesOf(tgt, Targets))).toEqual([]);

		world.relations.add(src, Targets, tgt);
		expect(world.relations.has(src, Targets)).toBe(true);
		expect(world.relations.targetOf(src, Targets)).toBe(tgt);
		expect(sorted(world.relations.targetsOf(src, Targets))).toEqual([tgt as number]);
		expect(sorted(world.relations.sourcesOf(tgt, Targets))).toEqual([src as number]);

		world.relations.remove(src, Targets, tgt);
		expect(world.relations.has(src, Targets)).toBe(false);
		expect(world.relations.targetOf(src, Targets)).toBeUndefined();
		expect(sorted(world.relations.sourcesOf(tgt, Targets))).toEqual([]);
	});

	it("adding a second target replaces the first, fixing the reverse index", () => {
		const world = new ECS({ deterministic: true });
		const Targets = world.relations.register({ exclusive: true });
		const src = world.spawn();
		const a = world.spawn();
		const b = world.spawn();

		world.relations.add(src, Targets, a);
		expect(world.relations.targetOf(src, Targets)).toBe(a);
		expect(sorted(world.relations.sourcesOf(a, Targets))).toEqual([src as number]);

		// Re-target: a is replaced by b (engine-enforced one-per-source).
		world.relations.add(src, Targets, b);
		expect(world.relations.targetOf(src, Targets)).toBe(b);
		// Reverse index moved off a and onto b.
		expect(sorted(world.relations.sourcesOf(a, Targets))).toEqual([]);
		expect(sorted(world.relations.sourcesOf(b, Targets))).toEqual([src as number]);
	});

	it("re-adding the same target is idempotent (no duplicate reverse entry)", () => {
		const world = new ECS({ deterministic: true });
		const R = world.relations.register();
		const src = world.spawn();
		const tgt = world.spawn();

		world.relations.add(src, R, tgt);
		world.relations.add(src, R, tgt);
		expect(sorted(world.relations.sourcesOf(tgt, R))).toEqual([src as number]);

		// removeRelation with a non-matching target is a no-op.
		const other = world.spawn();
		world.relations.remove(src, R, other);
		expect(world.relations.targetOf(src, R)).toBe(tgt);
	});

	it("many sources can point at one target (reverse fan-in)", () => {
		const world = new ECS({ deterministic: true });
		const R = world.relations.register();
		const tgt = world.spawn();
		const srcs = [world.spawn(), world.spawn(), world.spawn()];
		for (const s of srcs) world.relations.add(s, R, tgt);

		expect(sorted(world.relations.sourcesOf(tgt, R))).toEqual(sorted(srcs));

		// Remove the middle one — reverse index drops only it.
		world.relations.remove(srcs[1], R);
		expect(sorted(world.relations.sourcesOf(tgt, R))).toEqual(sorted([srcs[0], srcs[2]]));
	});

	// Dev-build contract: a dead src/tgt is caller error and throws here. The
	// production no-op + no-leak branch is covered separately, against a
	// `__DEV__: false` bundle, in relations_prod_guard.test.ts (#495). Uses the
	// Store directly for an *immediate* destroy (ECS.destroyEntity is deferred,
	// so the handle would still be alive until flush).
	it("throws on a dead source or target, leaving the reverse index clean", () => {
		const store = new Store({ deterministic: true });
		const R = store.registerRelation();
		const src = store.createEntity();
		const tgt = store.createEntity();

		const deadTgt = store.createEntity();
		store.destroyEntity(deadTgt);
		expect(() => store.addRelation(src, R, deadTgt)).toThrow(/addRelation.*not alive.*target/);
		expect(store.sourcesOf(deadTgt, R)).toEqual([]);

		const deadSrc = store.createEntity();
		store.destroyEntity(deadSrc);
		expect(() => store.addRelation(deadSrc, R, tgt)).toThrow(/addRelation.*not alive.*source/);
		expect(store.sourcesOf(tgt, R)).toEqual([]);
	});
});

describe("ECS relations — multi-target (#471)", () => {
	it("adds, removes individual pairs, and queries the set both ways", () => {
		const world = new ECS({ deterministic: true });
		const Likes = world.relations.register({ multi: true });
		const src = world.spawn();
		const a = world.spawn();
		const b = world.spawn();
		const c = world.spawn();

		world.relations.add(src, Likes, a);
		world.relations.add(src, Likes, b);
		world.relations.add(src, Likes, c);
		expect(world.relations.has(src, Likes)).toBe(true);
		expect(sorted(world.relations.targetsOf(src, Likes))).toEqual(sorted([a, b, c]));
		expect(sorted(world.relations.sourcesOf(b, Likes))).toEqual([src as number]);

		// Adding a duplicate is a no-op.
		world.relations.add(src, Likes, b);
		expect(sorted(world.relations.targetsOf(src, Likes))).toEqual(sorted([a, b, c]));

		// Remove one pair → set + reverse both shrink, membership stays.
		world.relations.remove(src, Likes, b);
		expect(sorted(world.relations.targetsOf(src, Likes))).toEqual(sorted([a, c]));
		expect(sorted(world.relations.sourcesOf(b, Likes))).toEqual([]);
		expect(world.relations.has(src, Likes)).toBe(true);
	});

	it("removing the last target drops membership; remove-all clears everything", () => {
		const world = new ECS({ deterministic: true });
		const Likes = world.relations.register({ multi: true });
		const src = world.spawn();
		const a = world.spawn();
		const b = world.spawn();

		world.relations.add(src, Likes, a);
		world.relations.remove(src, Likes, a);
		expect(world.relations.has(src, Likes)).toBe(false);
		expect(sorted(world.relations.targetsOf(src, Likes))).toEqual([]);

		// Re-populate, then remove ALL (tgt omitted).
		world.relations.add(src, Likes, a);
		world.relations.add(src, Likes, b);
		world.relations.remove(src, Likes);
		expect(world.relations.has(src, Likes)).toBe(false);
		expect(sorted(world.relations.sourcesOf(a, Likes))).toEqual([]);
		expect(sorted(world.relations.sourcesOf(b, Likes))).toEqual([]);
	});

	it("shares a target across sources and keeps the reverse fan-in consistent", () => {
		const world = new ECS({ deterministic: true });
		const Likes = world.relations.register({ multi: true });
		const t = world.spawn();
		const s1 = world.spawn();
		const s2 = world.spawn();

		world.relations.add(s1, Likes, t);
		world.relations.add(s2, Likes, t);
		expect(sorted(world.relations.sourcesOf(t, Likes))).toEqual(sorted([s1, s2]));

		world.relations.remove(s1, Likes, t);
		expect(sorted(world.relations.sourcesOf(t, Likes))).toEqual([s2 as number]);
	});
});

describe("relations registration + validation (#471)", () => {
	it("rejects a relation declared both exclusive and multi-target", () => {
		const world = new ECS({ deterministic: true });
		// Now a compile error too (RelationOptions is a union) — the cast covers
		// the JS-caller path the runtime throw still guards.
		expect(() =>
			world.relations.register({ exclusive: true, multi: true } as never)
		).toThrow();
	});

	it("target_of throws on a multi-target relation (use targets_of)", () => {
		const world = new ECS({ deterministic: true });
		const Likes = world.relations.register({ multi: true });
		const src = world.spawn();
		// cast (§10c): deliberately defeat the cardinality brand to assert the
		// runtime RELATION_MODE_MISMATCH backstop (POLISH_AUDIT #7)
		expect(() => world.relations.targetOf(src, Likes as unknown as RelationDef<"exclusive">)).toThrow();
	});
});

describe("relations cause no archetype transition (#471)", () => {
	it("add / re-target / remove leave archetype_count and archetype_id stable", () => {
		const store = new Store({ deterministic: true });
		const Pos = store.registerComponent({ x: "i32", y: "i32" });
		const Targets = store.registerRelation();
		const Likes = store.registerRelation({ multi: true });

		const src = store.createEntity();
		store.addComponent(src, Pos, { x: 1, y: 2 });
		const a = store.createEntity();
		const b = store.createEntity();

		const archCountBefore = store.archetypeCount;
		const archIdBefore = store.getEntityArchetype(src).id;

		store.addRelation(src, Targets, a);
		store.addRelation(src, Targets, b); // re-target
		store.addRelation(src, Likes, a);
		store.addRelation(src, Likes, b);
		store.removeRelation(src, Likes, a);
		store.removeRelation(src, Targets);

		expect(store.archetypeCount).toBe(archCountBefore);
		expect(store.getEntityArchetype(src).id).toBe(archIdBefore);
	});
});

describe("relations stay consistent through churn + destroy (#471)", () => {
	it("destroying a SOURCE purges it from the reverse index (immediate)", () => {
		const store = new Store({ deterministic: true });
		const R = store.registerRelation();
		const Likes = store.registerRelation({ multi: true });
		const src = store.createEntity();
		const a = store.createEntity();
		const b = store.createEntity();

		store.addRelation(src, R, a);
		store.addRelation(src, Likes, a);
		store.addRelation(src, Likes, b);
		expect(sorted(store.sourcesOf(a, R))).toEqual([src as number]);
		expect(sorted(store.sourcesOf(a, Likes))).toEqual([src as number]);

		store.destroyEntity(src);

		expect(sorted(store.sourcesOf(a, R))).toEqual([]);
		expect(sorted(store.sourcesOf(a, Likes))).toEqual([]);
		expect(sorted(store.sourcesOf(b, Likes))).toEqual([]);
		// Recycled slot starts clean — no inherited membership.
		const reused = store.createEntity();
		expect(store.hasRelation(reused, R)).toBe(false);
		expect(store.hasRelation(reused, Likes)).toBe(false);
	});

	it("destroying a SOURCE purges it via the deferred flush path too", () => {
		const store = new Store({ deterministic: true });
		const R = store.registerRelation();
		const src = store.createEntity();
		const tgt = store.createEntity();
		store.addRelation(src, R, tgt);

		store.destroyEntityDeferred(src);
		store.flushDestroyed();

		expect(sorted(store.sourcesOf(tgt, R))).toEqual([]);
	});

	it("a re-target chain leaves exactly one reverse edge at every step", () => {
		const world = new ECS({ deterministic: true });
		const R = world.relations.register();
		const src = world.spawn();
		const targets = [
			world.spawn(),
			world.spawn(),
			world.spawn(),
			world.spawn()
		];

		let prev: EntityID | null = null;
		for (const t of targets) {
			world.relations.add(src, R, t);
			expect(world.relations.targetOf(src, R)).toBe(t);
			expect(sorted(world.relations.sourcesOf(t, R))).toEqual([src as number]);
			if (prev !== null) expect(sorted(world.relations.sourcesOf(prev, R))).toEqual([]);
			prev = t;
		}
	});

	it("exclusive relations fold into state_hash + snapshot for free (#470 inherited)", () => {
		// Exclusive targets live in the sparse field, so they ride the sparse
		// determinism surface with no extra wiring — two worlds with identical
		// pairs reached by different add/re-target histories hash equal, and the
		// pairs round-trip through snapshot/restore.
		const make = () => {
			const world = new ECS({ deterministic: true });
			const R = world.relations.register(); // exclusive
			const src = world.spawn();
			const a = world.spawn();
			const b = world.spawn();
			return { world, R, src, a, b };
		};

		const w1 = make();
		w1.world.relations.add(w1.src, w1.R, w1.b);

		const w2 = make();
		// Different history, same end state: point at a first, then re-target b.
		w2.world.relations.add(w2.src, w2.R, w2.a);
		w2.world.relations.add(w2.src, w2.R, w2.b);

		expect(w2.world.snapshots.stateHash()).toBe(w1.world.snapshots.stateHash());

		// Snapshot/restore round-trips the exclusive target *and* rebuilds the
		// derived reverse index (which is never serialized).
		const bytes = w1.world.snapshots.captureSparse();
		const w3 = make();
		w3.world.snapshots.restoreSparse(bytes);
		expect(w3.world.relations.targetOf(w3.src, w3.R)).toBe(w1.b);
		expect(sorted(w3.world.relations.sourcesOf(w3.b, w3.R))).toEqual([w3.src as number]);
		expect(w3.world.relations.sourcesOf(w3.a, w3.R)).toEqual([]);
		expect(w3.world.snapshots.stateHash()).toBe(w1.world.snapshots.stateHash());
	});

	it("survives mixed add/remove/re-target churn with a consistent reverse index", () => {
		const world = new ECS({ deterministic: true });
		const Likes = world.relations.register({ multi: true });
		const srcs = Array.from({ length: 6 }, () => world.spawn());
		const tgts = Array.from({ length: 4 }, () => world.spawn());

		// Deterministic LCG so the churn pattern is reproducible.
		let s = 12345 >>> 0;
		const rand = (n: number): number => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s % n;
		};

		// Mirror the expected forward sets in plain JS to cross-check the engine.
		const expected = new Map<number, Set<number>>(srcs.map((e) => [e as number, new Set()]));

		for (let i = 0; i < 500; i++) {
			const src = srcs[rand(srcs.length)];
			const tgt = tgts[rand(tgts.length)];
			const set = expected.get(src as number)!;
			if (rand(2) === 0) {
				world.relations.add(src, Likes, tgt);
				set.add(tgt as number);
			} else {
				world.relations.remove(src, Likes, tgt);
				set.delete(tgt as number);
			}
		}

		// Forward index matches the mirror.
		for (const src of srcs) {
			expect(sorted(world.relations.targetsOf(src, Likes))).toEqual(
				[...expected.get(src as number)!].sort((a, b) => a - b)
			);
		}
		// Reverse index is the exact transpose of the forward index.
		for (const tgt of tgts) {
			const want: number[] = [];
			for (const src of srcs) {
				if (expected.get(src as number)!.has(tgt as number)) want.push(src as number);
			}
			expect(sorted(world.relations.sourcesOf(tgt, Likes))).toEqual(want.sort((a, b) => a - b));
		}
	});
});

describe("ECS relations — snapshot/restore rebuilds the derived indices", () => {
	// The reverse index and the multi forward target sets are *not* in the
	// sparse store, so `restoreSparse` must rebuild them: exclusive reverse
	// from the restored sparse target field, multi forward sets + reverse from
	// the relation section of the snapshot. Before the rebuild landed, a
	// restored world hashed equal to the original but `sourcesOf` / multi
	// `targetsOf` returned empty — silent determinism divergence.

	it("multi: forward sets, reverse index, and state_hash all round-trip", () => {
		const make = () => {
			const w = new ECS({ deterministic: true });
			const Likes = w.relations.register({ multi: true });
			const a = w.spawn();
			const b = w.spawn();
			const t1 = w.spawn();
			const t2 = w.spawn();
			const t3 = w.spawn();
			return { w, Likes, a, b, t1, t2, t3 };
		};

		const src = make();
		src.w.relations.add(src.a, src.Likes, src.t1);
		src.w.relations.add(src.a, src.Likes, src.t2);
		src.w.relations.add(src.b, src.Likes, src.t2);
		src.w.relations.add(src.b, src.Likes, src.t3);

		const dst = make();
		dst.w.snapshots.restoreSparse(src.w.snapshots.captureSparse());

		// Membership (the sparse tag) survives, and the forward sets are rebuilt.
		expect(dst.w.relations.has(dst.a, dst.Likes)).toBe(true);
		expect(sorted(dst.w.relations.targetsOf(dst.a, dst.Likes))).toEqual(sorted([dst.t1, dst.t2]));
		expect(sorted(dst.w.relations.targetsOf(dst.b, dst.Likes))).toEqual(sorted([dst.t2, dst.t3]));
		// Reverse index is rebuilt as the exact transpose.
		expect(sorted(dst.w.relations.sourcesOf(dst.t2, dst.Likes))).toEqual(sorted([dst.a, dst.b]));
		expect(sorted(dst.w.relations.sourcesOf(dst.t1, dst.Likes))).toEqual([dst.a as number]);
		expect(dst.w.snapshots.stateHash()).toBe(src.w.snapshots.stateHash());
	});

	it("state_hash distinguishes different multi target sets (folded, not ignored)", () => {
		const make = () => {
			const w = new ECS({ deterministic: true });
			const R = w.relations.register({ multi: true });
			const a = w.spawn();
			const t1 = w.spawn();
			const t2 = w.spawn();
			return { w, R, a, t1, t2 };
		};
		const w1 = make();
		w1.w.relations.add(w1.a, w1.R, w1.t1);
		const w2 = make();
		w2.w.relations.add(w2.a, w2.R, w2.t2); // same membership, different target
		expect(w2.w.snapshots.stateHash()).not.toBe(w1.w.snapshots.stateHash());

		// Same end state reached by a different add/remove history hashes equal.
		const w3 = make();
		w3.w.relations.add(w3.a, w3.R, w3.t2);
		w3.w.relations.add(w3.a, w3.R, w3.t1);
		w3.w.relations.remove(w3.a, w3.R, w3.t2);
		w3.w.relations.add(w3.a, w3.R, w3.t2);
		w3.w.relations.remove(w3.a, w3.R, w3.t2);
		expect(w3.w.snapshots.stateHash()).toBe(w1.w.snapshots.stateHash());
	});

	it("restore into a dirty multi world replaces the prior contents", () => {
		const make = () => {
			const w = new ECS({ deterministic: true });
			const R = w.relations.register({ multi: true });
			const a = w.spawn();
			const t1 = w.spawn();
			const t2 = w.spawn();
			return { w, R, a, t1, t2 };
		};
		const src = make();
		src.w.relations.add(src.a, src.R, src.t1);
		const bytes = src.w.snapshots.captureSparse();

		const dst = make();
		// Pre-existing stale state that must be wiped by restore.
		dst.w.relations.add(dst.a, dst.R, dst.t2);
		dst.w.snapshots.restoreSparse(bytes);
		expect(sorted(dst.w.relations.targetsOf(dst.a, dst.R))).toEqual([dst.t1 as number]);
		expect(dst.w.relations.sourcesOf(dst.t2, dst.R)).toEqual([]);
		expect(sorted(dst.w.relations.sourcesOf(dst.t1, dst.R))).toEqual([dst.a as number]);
		expect(dst.w.snapshots.stateHash()).toBe(src.w.snapshots.stateHash());
	});

	it("a destroyed-target cascade works on a restored world (reverse index live)", () => {
		// Down-traversal (`cascadeOf`) and `delete`/`clear` cleanup both ride the
		// reverse index. If restore didn't rebuild it, a restored tree would not
		// cascade — the behavioural symptom of the silent-divergence bug.
		const make = () => {
			const w = new ECS({ deterministic: true });
			const ChildOf = w.relations.register({ onDeleteTarget: "delete" });
			const root = w.spawn();
			const c1 = w.spawn();
			const c2 = w.spawn();
			const gc = w.spawn();
			return { w, ChildOf, root, c1, c2, gc };
		};
		const src = make();
		src.w.relations.add(src.c1, src.ChildOf, src.root);
		src.w.relations.add(src.c2, src.ChildOf, src.root);
		src.w.relations.add(src.gc, src.ChildOf, src.c1);

		const dst = make();
		dst.w.snapshots.restoreSparse(src.w.snapshots.captureSparse());

		// Reverse index is live: down-traversal sees the whole subtree.
		expect(sorted(dst.w.relations.cascadeOf(dst.root, dst.ChildOf))).toEqual(
			sorted([dst.root, dst.c1, dst.c2, dst.gc])
		);
		// `delete` cascade off the restored reverse index destroys the subtree.
		dst.w.despawn(dst.root);
		dst.w.flush();
		expect(dst.w.isAlive(dst.c1)).toBe(false);
		expect(dst.w.isAlive(dst.c2)).toBe(false);
		expect(dst.w.isAlive(dst.gc)).toBe(false);
	});
});

describe("relation restore validation — defensive hardening (#494)", () => {
	it("rejects a multi relation source index past MAX_INDEX", () => {
		// The multi forward set is keyed by source entity index and that index is
		// fed to createEntityId(idx, gens[idx]); an unvalidated wild u32 reads
		// gens out of bounds and grows the side Map unboundedly. Patch a valid
		// one-source multi snapshot's source index to MAX_INDEX + 1.
		const make = () => {
			const w = new ECS({ deterministic: true });
			const Likes = w.relations.register({ multi: true });
			const a = w.spawn();
			const t = w.spawn();
			return { w, Likes, a, t };
		};
		const src = make();
		src.w.relations.add(src.a, src.Likes, src.t);
		const bytes = src.w.snapshots.captureSparse();

		// Relation section begins after the outer frame(8) + sparseLen. Within it:
		// relationCount(4) + isMulti(4) + sourceCount(4) = +12 → sourceIndex u32.
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const sparseLen = view.getUint32(0, true);
		view.setUint32(8 + sparseLen + 12, MAX_INDEX + 1, true);

		const dst = make();
		expect(() => dst.w.snapshots.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("rejects a decoded multi-relation target that is not a well-formed packed EntityID (#723)", () => {
		// Symmetric with the source-index guard above: a crafted / truncated snapshot
		// can decode a multi target whose bits fall outside the 31-bit packed layout.
		// `getEntityIndex` would then mask it onto an unrelated live slot (the ABA
		// mis-binding the guard prevents). Patch a valid one-target multi snapshot's
		// first target f64 to an out-of-range value.
		const make = () => {
			const w = new ECS({ deterministic: true });
			const Likes = w.relations.register({ multi: true });
			const a = w.spawn();
			const t = w.spawn();
			return { w, Likes, a, t };
		};
		const src = make();
		src.w.relations.add(src.a, src.Likes, src.t);
		const baseBytes = src.w.snapshots.captureSparse();

		// Relation section begins after the outer frame(8) + sparseLen. Within it:
		// relationCount(4) + isMulti(4) + sourceCount(4) + sourceIndex(4) +
		// targetCount(4) = +20 → the first target f64.
		const frame = new DataView(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength);
		const sparseLen = frame.getUint32(0, true);
		const targetOff = 8 + sparseLen + 20;

		// Each corruption is an exactly-representable f64 that round-trips through
		// setFloat64/getFloat64 but fails the [0, MAX_ENTITY_ID] integer check.
		for (const bad of [2 ** 40, -1, 1.5, MAX_ENTITY_ID + 1]) {
			const bytes = baseBytes.slice(); // fresh copy per case
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			view.setFloat64(targetOff, bad, true);

			const dst = make();
			expect(() => dst.w.snapshots.restoreSparse(bytes)).toThrow(SparseRestoreError);
		}
	});
});
