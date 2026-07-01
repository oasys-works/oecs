/**
 * Relations — `OnDeleteTarget` cleanup policies (#473 / ADR-0011).
 *
 * When a relation **target** is destroyed, the per-relation cleanup policy
 * chosen at registration runs at destroy-flush (and the immediate-destroy
 * path), driven off the reverse index:
 *
 *   - `delete` — cascade-destroy every source (iteratively for chains/trees);
 *   - `clear`  — drop the relation from every source; sources survive;
 *   - `orphan` — leave it dangling (the default; reads stay safe).
 *
 * Covers the issue's acceptance criteria across both cardinalities, both
 * destroy paths (immediate + deferred flush), a multi-level `delete` cascade,
 * cycle termination, recycled-slot cleanliness, and the deep-chain stack-safety
 * guarantee both paths now share (#492 — the immediate path drains a work-list
 * instead of recursing, so a pathologically deep chain cannot overflow the stack).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { Store } from "../../store";
import type { EntityID } from "../../entity";

const sorted = (ids: EntityID[]): number[] => ids.map((e) => e as number).sort((a, b) => a - b);

describe("OnDeleteTarget = delete — cascade (#473)", () => {
	it("destroying a target destroys its sources (exclusive, immediate)", () => {
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const c1 = store.createEntity();
		const c2 = store.createEntity();
		store.addRelation(c1, ChildOf, parent);
		store.addRelation(c2, ChildOf, parent);

		store.destroyEntity(parent);

		expect(store.isAlive(parent)).toBe(false);
		expect(store.isAlive(c1)).toBe(false);
		expect(store.isAlive(c2)).toBe(false);
		expect(sorted(store.sourcesOf(ChildOf, parent))).toEqual([]);
	});

	it("destroying a target destroys its sources (exclusive, deferred flush)", () => {
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const child = store.createEntity();
		store.addRelation(child, ChildOf, parent);

		store.destroyEntityDeferred(parent);
		store.flushDestroyed();

		expect(store.isAlive(parent)).toBe(false);
		expect(store.isAlive(child)).toBe(false);
	});

	it("cascades through a multi-level chain (grandparent → parent → child)", () => {
		// child --ChildOf--> parent --ChildOf--> grandparent. Destroying the
		// grandparent must take out the whole chain in one flush.
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const gp = store.createEntity();
		const p = store.createEntity();
		const c = store.createEntity();
		store.addRelation(p, ChildOf, gp);
		store.addRelation(c, ChildOf, p);

		store.destroyEntityDeferred(gp);
		store.flushDestroyed();

		expect(store.isAlive(gp)).toBe(false);
		expect(store.isAlive(p)).toBe(false);
		expect(store.isAlive(c)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("cascades through a multi-level chain (immediate path)", () => {
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const gp = store.createEntity();
		const p = store.createEntity();
		const c = store.createEntity();
		store.addRelation(p, ChildOf, gp);
		store.addRelation(c, ChildOf, p);

		store.destroyEntity(gp);

		expect(store.isAlive(gp)).toBe(false);
		expect(store.isAlive(p)).toBe(false);
		expect(store.isAlive(c)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("survives a pathologically deep chain without overflowing the stack (immediate, #492)", () => {
		// A long exclusive ancestry: chain[i+1] --ChildOf--> chain[i], so destroying
		// the root (chain[0]) must cascade the entire chain. The pre-#492 immediate
		// path recursed one `destroyEntity` frame per level and blew the call stack
		// at this depth; the work-list drain is depth-independent, like the deferred
		// path has always been.
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const DEPTH = 50_000;
		const chain: EntityID[] = new Array(DEPTH);
		for (let i = 0; i < DEPTH; i++) chain[i] = store.createEntity();
		for (let i = 1; i < DEPTH; i++) store.addRelation(chain[i], ChildOf, chain[i - 1]);

		expect(store.entityCount).toBe(DEPTH);
		expect(() => store.destroyEntity(chain[0])).not.toThrow();

		expect(store.entityCount).toBe(0);
		expect(store.isAlive(chain[0])).toBe(false);
		expect(store.isAlive(chain[DEPTH - 1])).toBe(false);
		expect(sorted(store.sourcesOf(ChildOf, chain[0]))).toEqual([]);
	});

	it("cascades a fan-out tree, leaving unrelated entities alive", () => {
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const root = store.createEntity();
		const kids = [store.createEntity(), store.createEntity(), store.createEntity()];
		const grandkids = [store.createEntity(), store.createEntity()];
		const bystander = store.createEntity();
		for (const k of kids) store.addRelation(k, ChildOf, root);
		store.addRelation(grandkids[0], ChildOf, kids[0]);
		store.addRelation(grandkids[1], ChildOf, kids[0]);

		store.destroyEntityDeferred(root);
		store.flushDestroyed();

		for (const k of kids) expect(store.isAlive(k)).toBe(false);
		for (const g of grandkids) expect(store.isAlive(g)).toBe(false);
		expect(store.isAlive(bystander)).toBe(true);
		expect(store.entityCount).toBe(1);
	});

	it("terminates on a delete cycle instead of looping forever", () => {
		// a --R--> b and b --R--> a, both delete. Destroying a must take out b
		// and stop (b's cascade reaches the already-dead a).
		const store = new Store();
		const R = store.registerRelation({ onDeleteTarget: "delete" });
		const a = store.createEntity();
		const b = store.createEntity();
		store.addRelation(a, R, b);
		store.addRelation(b, R, a);

		store.destroyEntity(a);

		expect(store.isAlive(a)).toBe(false);
		expect(store.isAlive(b)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("destroys every source of a multi-target relation's dead target", () => {
		const store = new Store();
		const Likes = store.registerRelation({ multi: true, onDeleteTarget: "delete" });
		const tgt = store.createEntity();
		const other = store.createEntity();
		const s1 = store.createEntity();
		const s2 = store.createEntity();
		// s1 and s2 both like tgt; s1 also likes `other` (which is NOT destroyed).
		store.addRelation(s1, Likes, tgt);
		store.addRelation(s1, Likes, other);
		store.addRelation(s2, Likes, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroyed();

		expect(store.isAlive(tgt)).toBe(false);
		expect(store.isAlive(s1)).toBe(false);
		expect(store.isAlive(s2)).toBe(false);
		// `other` had no relation TO the dead target, so it survives — and its
		// reverse set no longer lists the (now destroyed) s1.
		expect(store.isAlive(other)).toBe(true);
		expect(sorted(store.sourcesOf(Likes, other))).toEqual([]);
	});
});

describe("OnDeleteTarget = clear — sources survive, link dropped (#473)", () => {
	it("removes the relation from every source (exclusive)", () => {
		const store = new Store();
		const Targets = store.registerRelation({ onDeleteTarget: "clear" });
		const tgt = store.createEntity();
		const s1 = store.createEntity();
		const s2 = store.createEntity();
		store.addRelation(s1, Targets, tgt);
		store.addRelation(s2, Targets, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroyed();

		expect(store.isAlive(s1)).toBe(true);
		expect(store.isAlive(s2)).toBe(true);
		expect(store.targetOf(s1, Targets)).toBeUndefined();
		expect(store.targetOf(s2, Targets)).toBeUndefined();
		expect(store.hasRelation(s1, Targets)).toBe(false);
		expect(sorted(store.sourcesOf(Targets, tgt))).toEqual([]);
	});

	it("removes only the dead target from a multi-target set; others remain", () => {
		const store = new Store();
		const Likes = store.registerRelation({ multi: true, onDeleteTarget: "clear" });
		const dead = store.createEntity();
		const keep = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Likes, dead);
		store.addRelation(src, Likes, keep);

		store.destroyEntityDeferred(dead);
		store.flushDestroyed();

		expect(store.isAlive(src)).toBe(true);
		expect(sorted(store.targetsOf(src, Likes))).toEqual([keep as number]);
		expect(store.hasRelation(src, Likes)).toBe(true);
		expect(sorted(store.sourcesOf(Likes, dead))).toEqual([]);
	});

	it("drops membership when the dead target was the source's only multi target", () => {
		const store = new Store();
		const Likes = store.registerRelation({ multi: true, onDeleteTarget: "clear" });
		const dead = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Likes, dead);

		store.destroyEntityDeferred(dead);
		store.flushDestroyed();

		expect(store.isAlive(src)).toBe(true);
		expect(store.hasRelation(src, Likes)).toBe(false);
		expect(sorted(store.targetsOf(src, Likes))).toEqual([]);
	});

	it("clears via the immediate destroy path too", () => {
		const store = new Store();
		const Targets = store.registerRelation({ onDeleteTarget: "clear" });
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		expect(store.isAlive(src)).toBe(true);
		expect(store.targetOf(src, Targets)).toBeUndefined();
	});
});

describe("OnDeleteTarget = orphan — default dangling behaviour (#473)", () => {
	it("leaves the source alive with a dangling, safe-to-read link", () => {
		const store = new Store();
		const Targets = store.registerRelation(); // default: orphan
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroyed();

		expect(store.isAlive(src)).toBe(true);
		// The forward link still resolves to the dead handle — reading it doesn't
		// crash, and `isAlive` detects it as dead (no aliasing).
		const dangling = store.targetOf(src, Targets);
		expect(dangling).toBe(tgt);
		expect(store.isAlive(dangling!)).toBe(false);
	});

	it("is the explicit-orphan equivalent of the default", () => {
		const store = new Store();
		const Targets = store.registerRelation({ onDeleteTarget: "orphan" });
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		expect(store.isAlive(src)).toBe(true);
		expect(store.targetOf(src, Targets)).toBe(tgt);
	});
});

describe("OnDeleteTarget — recycled slot cleanliness + mixed policies (#473)", () => {
	it("a slot freed by a delete cascade comes back clean", () => {
		const store = new Store();
		const ChildOf = store.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const child = store.createEntity();
		store.addRelation(child, ChildOf, parent);

		store.destroyEntity(parent);
		expect(store.isAlive(child)).toBe(false);

		// Recycle a slot — it must not inherit any relation state.
		const reused = store.createEntity();
		expect(store.hasRelation(reused, ChildOf)).toBe(false);
		expect(store.targetOf(reused, ChildOf)).toBeUndefined();
	});

	it("applies each relation's own policy when one entity is a target of several", () => {
		const store = new Store();
		const Del = store.registerRelation({ onDeleteTarget: "delete" });
		const Clr = store.registerRelation({ onDeleteTarget: "clear" });
		const Orf = store.registerRelation({ onDeleteTarget: "orphan" });
		const tgt = store.createEntity();
		const sDel = store.createEntity();
		const sClr = store.createEntity();
		const sOrf = store.createEntity();
		store.addRelation(sDel, Del, tgt);
		store.addRelation(sClr, Clr, tgt);
		store.addRelation(sOrf, Orf, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroyed();

		expect(store.isAlive(sDel)).toBe(false); // delete → gone
		expect(store.isAlive(sClr)).toBe(true); // clear → survives, link dropped
		expect(store.targetOf(sClr, Clr)).toBeUndefined();
		expect(store.isAlive(sOrf)).toBe(true); // orphan → survives, dangling
		expect(store.targetOf(sOrf, Orf)).toBe(tgt);
	});
});

describe("OnDeleteTarget — ECS surface (#473)", () => {
	it("registers a delete-policy relation and cascades through the ECS wrapper", () => {
		const world = new ECS();
		const ChildOf = world.registerRelation({ onDeleteTarget: "delete" });
		const parent = world.createEntity();
		const child = world.createEntity();
		world.addRelation(child, ChildOf, parent);

		// `ECS.destroyEntity` is the deferred surface — the cascade runs at flush.
		world.destroyEntity(parent);
		world.flush();

		expect(world.isAlive(parent)).toBe(false);
		expect(world.isAlive(child)).toBe(false);
	});
});

describe("compact_relations — reverse-index reclaim under orphan churn (#491)", () => {
	it("drops an exclusive orphan relation's dead-target reverse entry", () => {
		const store = new Store();
		const Targets = store.registerRelation(); // default: orphan
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		// Orphan leaves the reverse entry intact (the dangling-source leak #491).
		expect(sorted(store.sourcesOf(Targets, tgt))).toEqual([src as number]);

		expect(store.compactRelations()).toBe(1);

		// Reverse entry reclaimed…
		expect(store.sourcesOf(Targets, tgt)).toEqual([]);
		// …but the forward link is untouched: orphan still resolves the dead handle.
		expect(store.isAlive(src)).toBe(true);
		expect(store.targetOf(src, Targets)).toBe(tgt);
		expect(store.isAlive(store.targetOf(src, Targets)!)).toBe(false);
	});

	it("drops a multi orphan relation's dead-target reverse entry, leaving the forward set", () => {
		const store = new Store();
		const Likes = store.registerRelation({ multi: true }); // orphan default
		const tgt = store.createEntity();
		const src = store.createEntity();
		const live = store.createEntity();
		store.addRelation(src, Likes, tgt);
		store.addRelation(src, Likes, live);

		store.destroyEntity(tgt);
		expect(sorted(store.sourcesOf(Likes, tgt))).toEqual([src as number]);

		expect(store.compactRelations()).toBe(1);

		expect(store.sourcesOf(Likes, tgt)).toEqual([]);
		// Live target's reverse entry is untouched.
		expect(sorted(store.sourcesOf(Likes, live))).toEqual([src as number]);
		// Forward set still carries both handles (the dead one dangles, per orphan).
		expect(sorted(store.targetsOf(src, Likes))).toEqual(sorted([tgt, live]));
	});

	it("leaves live-target entries alone", () => {
		const store = new Store();
		const Targets = store.registerRelation();
		const live = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, live);

		expect(store.compactRelations()).toBe(0);
		expect(sorted(store.sourcesOf(Targets, live))).toEqual([src as number]);
	});

	it("is generation-precise — reclaims the dead key, keeps a recycled slot's live key", () => {
		const store = new Store();
		const Targets = store.registerRelation();
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt); // frees tgt's slot; src dangles at the dead handle

		// A fresh entity may recycle tgt's index with a bumped generation — the
		// reverse key carries the generation, so the two never alias.
		const reused = store.createEntity();
		const src2 = store.createEntity();
		store.addRelation(src2, Targets, reused);

		expect(store.compactRelations()).toBe(1); // only the dead-target key

		expect(store.sourcesOf(Targets, tgt)).toEqual([]); // dead key gone
		expect(sorted(store.sourcesOf(Targets, reused))).toEqual([src2 as number]); // live key kept
	});

	it("aggregates across relations and is idempotent", () => {
		const store = new Store();
		const A = store.registerRelation();
		const B = store.registerRelation({ multi: true });
		const ta = store.createEntity();
		const tb = store.createEntity();
		const sa = store.createEntity();
		const sb = store.createEntity();
		store.addRelation(sa, A, ta);
		store.addRelation(sb, B, tb);

		store.destroyEntity(ta);
		store.destroyEntity(tb);

		expect(store.compactRelations()).toBe(2); // one dead key per relation
		expect(store.compactRelations()).toBe(0); // nothing left to reclaim
	});

	it("returns 0 when no relations are registered", () => {
		const store = new Store();
		expect(store.compactRelations()).toBe(0);
	});

	it("is reachable through the ECS surface", () => {
		const world = new ECS();
		const Targets = world.registerRelation();
		const tgt = world.createEntity();
		const src = world.createEntity();
		world.addRelation(src, Targets, tgt);

		// `ECS.destroyEntity` is deferred — flush so the orphan link goes dangling.
		world.destroyEntity(tgt);
		world.flush();
		expect(sorted(world.sourcesOf(Targets, tgt))).toEqual([src as number]);

		expect(world.compactRelations()).toBe(1);
		expect(world.sourcesOf(Targets, tgt)).toEqual([]);
		expect(world.targetOf(src, Targets)).toBe(tgt); // forward link preserved
	});
});
