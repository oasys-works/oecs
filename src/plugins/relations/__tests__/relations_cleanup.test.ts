/**
 * Relations, `OnDeleteTarget` cleanup policies.
 *
 * When a relation **target** is destroyed, the per-relation cleanup policy
 * chosen at registration runs at destroy-flush (and the immediate-destroy
 * path), driven off the reverse index:
 *
 *   - `delete`, cascade-destroy every source (iteratively for chains and trees)
 *   - `clear` , drop the relation from every source. Sources survive
 *   - `orphan`, leave it dangling (the default, reads stay safe).
 *
 * Covers the issue's acceptance criteria across both cardinalities, both
 * destroy paths (immediate + deferred flush), a multi-level `delete` cascade,
 * cycle termination, recycled-slot cleanliness, and the deep-chain stack-safety
 * guarantee both paths now share (the immediate path drains a work-list
 * instead of recursing, so a pathologically deep chain cannot overflow the stack).
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../../core/ecs/ecs";
import { Store } from "../../../core/ecs/store";
import type { EntityID } from "../../../core/ecs/entity";
import { relations } from "../../relations";
import { storeOnlyHost } from "../../../core/ecs/plugin";

/** A store with the plugins these cases drive installed.
 * `ECS.create({ plugins: [relations()] })` is the same
 * wiring one layer up. */
function capStore(...args: ConstructorParameters<typeof Store>): Store {
	const built = new Store(...args);
	relations().install(storeOnlyHost(built));
	return built;
}




const sorted = (ids: EntityID[]): number[] => ids.map((e) => e as number).sort((a, b) => a - b);

describe("OnDeleteTarget = delete, cascade", () => {
	it("destroying a target destroys its sources (exclusive, immediate)", () => {
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const c1 = store.createEntity();
		const c2 = store.createEntity();
		store.relations.addRelation(c1, ChildOf, parent);
		store.relations.addRelation(c2, ChildOf, parent);

		store.destroyEntity(parent);

		expect(store.isAlive(parent)).toBe(false);
		expect(store.isAlive(c1)).toBe(false);
		expect(store.isAlive(c2)).toBe(false);
		expect(sorted(store.relations.sourcesOf(parent, ChildOf))).toEqual([]);
	});

	it("destroying a target destroys its sources (exclusive, deferred flush)", () => {
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const child = store.createEntity();
		store.relations.addRelation(child, ChildOf, parent);

		store.destroyEntityDeferred(parent);
		store.flushDestroys();

		expect(store.isAlive(parent)).toBe(false);
		expect(store.isAlive(child)).toBe(false);
	});

	it("cascades through a multi-level chain (grandparent → parent → child)", () => {
		// child --ChildOf--> parent --ChildOf--> grandparent. Destroying the
		// grandparent must take out the whole chain in one flush.
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const gp = store.createEntity();
		const p = store.createEntity();
		const c = store.createEntity();
		store.relations.addRelation(p, ChildOf, gp);
		store.relations.addRelation(c, ChildOf, p);

		store.destroyEntityDeferred(gp);
		store.flushDestroys();

		expect(store.isAlive(gp)).toBe(false);
		expect(store.isAlive(p)).toBe(false);
		expect(store.isAlive(c)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("cascades through a multi-level chain (immediate path)", () => {
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const gp = store.createEntity();
		const p = store.createEntity();
		const c = store.createEntity();
		store.relations.addRelation(p, ChildOf, gp);
		store.relations.addRelation(c, ChildOf, p);

		store.destroyEntity(gp);

		expect(store.isAlive(gp)).toBe(false);
		expect(store.isAlive(p)).toBe(false);
		expect(store.isAlive(c)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("survives a pathologically deep chain without overflowing the stack (immediate)", () => {
		// A long exclusive ancestry: chain[i+1] --ChildOf--> chain[i], so destroying
		// the root (chain[0]) must cascade the entire chain. The earlier immediate
		// path recursed one `destroyEntity` frame per level and blew the call stack
		// at this depth. The work-list drain is depth-independent, like the deferred
		// path has always been.
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const DEPTH = 50_000;
		const chain: EntityID[] = new Array(DEPTH);
		for (let i = 0; i < DEPTH; i++) chain[i] = store.createEntity();
		for (let i = 1; i < DEPTH; i++) store.relations.addRelation(chain[i], ChildOf, chain[i - 1]);

		expect(store.entityCount).toBe(DEPTH);
		expect(() => store.destroyEntity(chain[0])).not.toThrow();

		expect(store.entityCount).toBe(0);
		expect(store.isAlive(chain[0])).toBe(false);
		expect(store.isAlive(chain[DEPTH - 1])).toBe(false);
		expect(sorted(store.relations.sourcesOf(chain[0], ChildOf))).toEqual([]);
	});

	it("cascades a fan-out tree, leaving unrelated entities alive", () => {
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const root = store.createEntity();
		const kids = [store.createEntity(), store.createEntity(), store.createEntity()];
		const grandkids = [store.createEntity(), store.createEntity()];
		const bystander = store.createEntity();
		for (const k of kids) store.relations.addRelation(k, ChildOf, root);
		store.relations.addRelation(grandkids[0], ChildOf, kids[0]);
		store.relations.addRelation(grandkids[1], ChildOf, kids[0]);

		store.destroyEntityDeferred(root);
		store.flushDestroys();

		for (const k of kids) expect(store.isAlive(k)).toBe(false);
		for (const g of grandkids) expect(store.isAlive(g)).toBe(false);
		expect(store.isAlive(bystander)).toBe(true);
		expect(store.entityCount).toBe(1);
	});

	it("terminates on a delete cycle instead of looping forever", () => {
		// a --R--> b and b --R--> a, both delete. Destroying a must take out b
		// and stop (b's cascade reaches the already-dead a).
		const store = capStore();
		const R = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const a = store.createEntity();
		const b = store.createEntity();
		store.relations.addRelation(a, R, b);
		store.relations.addRelation(b, R, a);

		store.destroyEntity(a);

		expect(store.isAlive(a)).toBe(false);
		expect(store.isAlive(b)).toBe(false);
		expect(store.entityCount).toBe(0);
	});

	it("destroys every source of a multi-target relation's dead target", () => {
		const store = capStore();
		const Likes = store.relations.registerRelation({ multi: true, onDeleteTarget: "delete" });
		const tgt = store.createEntity();
		const other = store.createEntity();
		const s1 = store.createEntity();
		const s2 = store.createEntity();
		// s1 and s2 both like tgt. S1 also likes `other` (which is not destroyed).
		store.relations.addRelation(s1, Likes, tgt);
		store.relations.addRelation(s1, Likes, other);
		store.relations.addRelation(s2, Likes, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroys();

		expect(store.isAlive(tgt)).toBe(false);
		expect(store.isAlive(s1)).toBe(false);
		expect(store.isAlive(s2)).toBe(false);
		// `other` had no relation to the dead target, so it survives, and its
		// reverse set no longer lists the (now destroyed) s1.
		expect(store.isAlive(other)).toBe(true);
		expect(sorted(store.relations.sourcesOf(other, Likes))).toEqual([]);
	});
});

describe("OnDeleteTarget = clear, sources survive, link dropped", () => {
	it("removes the relation from every source (exclusive)", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation({ onDeleteTarget: "clear" });
		const tgt = store.createEntity();
		const s1 = store.createEntity();
		const s2 = store.createEntity();
		store.relations.addRelation(s1, Targets, tgt);
		store.relations.addRelation(s2, Targets, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroys();

		expect(store.isAlive(s1)).toBe(true);
		expect(store.isAlive(s2)).toBe(true);
		expect(store.relations.targetOf(s1, Targets)).toBeUndefined();
		expect(store.relations.targetOf(s2, Targets)).toBeUndefined();
		expect(store.relations.hasRelation(s1, Targets)).toBe(false);
		expect(sorted(store.relations.sourcesOf(tgt, Targets))).toEqual([]);
	});

	it("removes only the dead target from a multi-target set, the others remain", () => {
		const store = capStore();
		const Likes = store.relations.registerRelation({ multi: true, onDeleteTarget: "clear" });
		const dead = store.createEntity();
		const keep = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Likes, dead);
		store.relations.addRelation(src, Likes, keep);

		store.destroyEntityDeferred(dead);
		store.flushDestroys();

		expect(store.isAlive(src)).toBe(true);
		expect(sorted(store.relations.targetsOf(src, Likes))).toEqual([keep as number]);
		expect(store.relations.hasRelation(src, Likes)).toBe(true);
		expect(sorted(store.relations.sourcesOf(dead, Likes))).toEqual([]);
	});

	it("drops membership when the dead target was the source's only multi target", () => {
		const store = capStore();
		const Likes = store.relations.registerRelation({ multi: true, onDeleteTarget: "clear" });
		const dead = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Likes, dead);

		store.destroyEntityDeferred(dead);
		store.flushDestroys();

		expect(store.isAlive(src)).toBe(true);
		expect(store.relations.hasRelation(src, Likes)).toBe(false);
		expect(sorted(store.relations.targetsOf(src, Likes))).toEqual([]);
	});

	it("clears via the immediate destroy path too", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation({ onDeleteTarget: "clear" });
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		expect(store.isAlive(src)).toBe(true);
		expect(store.relations.targetOf(src, Targets)).toBeUndefined();
	});
});

describe("OnDeleteTarget = orphan, default dangling behaviour", () => {
	it("leaves the source alive with a dangling, safe-to-read link", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation(); // default: orphan
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroys();

		expect(store.isAlive(src)).toBe(true);
		// The forward link still resolves to the dead handle, reading it doesn't
		// crash, and `isAlive` detects it as dead (no aliasing).
		const dangling = store.relations.targetOf(src, Targets);
		expect(dangling).toBe(tgt);
		expect(store.isAlive(dangling!)).toBe(false);
	});

	it("is the explicit-orphan equivalent of the default", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation({ onDeleteTarget: "orphan" });
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		expect(store.isAlive(src)).toBe(true);
		expect(store.relations.targetOf(src, Targets)).toBe(tgt);
	});
});

describe("OnDeleteTarget, recycled slot cleanliness + mixed policies", () => {
	it("a slot freed by a delete cascade comes back clean", () => {
		const store = capStore();
		const ChildOf = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const parent = store.createEntity();
		const child = store.createEntity();
		store.relations.addRelation(child, ChildOf, parent);

		store.destroyEntity(parent);
		expect(store.isAlive(child)).toBe(false);

		// Recycle a slot. It must not inherit any relation state.
		const reused = store.createEntity();
		expect(store.relations.hasRelation(reused, ChildOf)).toBe(false);
		expect(store.relations.targetOf(reused, ChildOf)).toBeUndefined();
	});

	it("applies each relation's own policy when one entity is a target of several", () => {
		const store = capStore();
		const Del = store.relations.registerRelation({ onDeleteTarget: "delete" });
		const Clr = store.relations.registerRelation({ onDeleteTarget: "clear" });
		const Orf = store.relations.registerRelation({ onDeleteTarget: "orphan" });
		const tgt = store.createEntity();
		const sDel = store.createEntity();
		const sClr = store.createEntity();
		const sOrf = store.createEntity();
		store.relations.addRelation(sDel, Del, tgt);
		store.relations.addRelation(sClr, Clr, tgt);
		store.relations.addRelation(sOrf, Orf, tgt);

		store.destroyEntityDeferred(tgt);
		store.flushDestroys();

		expect(store.isAlive(sDel)).toBe(false); // delete → gone
		expect(store.isAlive(sClr)).toBe(true); // clear → survives, link dropped
		expect(store.relations.targetOf(sClr, Clr)).toBeUndefined();
		expect(store.isAlive(sOrf)).toBe(true); // orphan → survives, dangling
		expect(store.relations.targetOf(sOrf, Orf)).toBe(tgt);
	});
});

describe("OnDeleteTarget. ECS surface", () => {
	it("registers a delete-policy relation and cascades through the ECS wrapper", () => {
		const world = ECS.create({ plugins: [relations()] });
		const ChildOf = world.relations.register({ onDeleteTarget: "delete" });
		const parent = world.spawn();
		const child = world.spawn();
		world.relations.add(child, ChildOf, parent);

		// `ECS.destroyEntity` is the deferred surface, the cascade runs at flush.
		world.despawn(parent);
		world.flush();

		expect(world.isAlive(parent)).toBe(false);
		expect(world.isAlive(child)).toBe(false);
	});
});

describe("compact_relations, reverse-index reclaim under orphan churn", () => {
	it("drops an exclusive orphan relation's dead-target reverse entry", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation(); // default: orphan
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt);

		// Orphan leaves the reverse entry intact (the dangling-source leak).
		expect(sorted(store.relations.sourcesOf(tgt, Targets))).toEqual([src as number]);

		expect(store.relations.compactRelations()).toBe(1);

		// Reverse entry reclaimed…
		expect(store.relations.sourcesOf(tgt, Targets)).toEqual([]);
		// …but the forward link is untouched: orphan still resolves the dead handle.
		expect(store.isAlive(src)).toBe(true);
		expect(store.relations.targetOf(src, Targets)).toBe(tgt);
		expect(store.isAlive(store.relations.targetOf(src, Targets)!)).toBe(false);
	});

	it("drops a multi orphan relation's dead-target reverse entry, leaving the forward set", () => {
		const store = capStore();
		const Likes = store.relations.registerRelation({ multi: true }); // orphan default
		const tgt = store.createEntity();
		const src = store.createEntity();
		const live = store.createEntity();
		store.relations.addRelation(src, Likes, tgt);
		store.relations.addRelation(src, Likes, live);

		store.destroyEntity(tgt);
		expect(sorted(store.relations.sourcesOf(tgt, Likes))).toEqual([src as number]);

		expect(store.relations.compactRelations()).toBe(1);

		expect(store.relations.sourcesOf(tgt, Likes)).toEqual([]);
		// Live target's reverse entry is untouched.
		expect(sorted(store.relations.sourcesOf(live, Likes))).toEqual([src as number]);
		// Forward set still carries both handles (the dead one dangles, per orphan).
		expect(sorted(store.relations.targetsOf(src, Likes))).toEqual(sorted([tgt, live]));
	});

	it("leaves live-target entries alone", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation();
		const live = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, live);

		expect(store.relations.compactRelations()).toBe(0);
		expect(sorted(store.relations.sourcesOf(live, Targets))).toEqual([src as number]);
	});

	it("is generation-precise, reclaims the dead key, keeps a recycled slot's live key", () => {
		const store = capStore();
		const Targets = store.relations.registerRelation();
		const tgt = store.createEntity();
		const src = store.createEntity();
		store.relations.addRelation(src, Targets, tgt);

		store.destroyEntity(tgt); // frees tgt's slot; src dangles at the dead handle

		// A fresh entity may recycle tgt's index with a bumped generation, the
		// reverse key carries the generation, so the two never alias.
		const reused = store.createEntity();
		const src2 = store.createEntity();
		store.relations.addRelation(src2, Targets, reused);

		expect(store.relations.compactRelations()).toBe(1); // only the dead-target key

		expect(store.relations.sourcesOf(tgt, Targets)).toEqual([]); // dead key gone
		expect(sorted(store.relations.sourcesOf(reused, Targets))).toEqual([src2 as number]); // live key kept
	});

	it("aggregates across relations and is idempotent", () => {
		const store = capStore();
		const A = store.relations.registerRelation();
		const B = store.relations.registerRelation({ multi: true });
		const ta = store.createEntity();
		const tb = store.createEntity();
		const sa = store.createEntity();
		const sb = store.createEntity();
		store.relations.addRelation(sa, A, ta);
		store.relations.addRelation(sb, B, tb);

		store.destroyEntity(ta);
		store.destroyEntity(tb);

		expect(store.relations.compactRelations()).toBe(2); // one dead key per relation
		expect(store.relations.compactRelations()).toBe(0); // nothing left to reclaim
	});

	it("returns 0 when no relations are registered", () => {
		const store = capStore();
		expect(store.relations.compactRelations()).toBe(0);
	});

	it("is reachable through the ECS surface", () => {
		const world = ECS.create({ plugins: [relations()] });
		const Targets = world.relations.register();
		const tgt = world.spawn();
		const src = world.spawn();
		world.relations.add(src, Targets, tgt);

		// `ECS.destroyEntity` is deferred, flush so the orphan link goes dangling.
		world.despawn(tgt);
		world.flush();
		expect(sorted(world.relations.sourcesOf(tgt, Targets))).toEqual([src as number]);

		expect(world.relations.compact()).toBe(1);
		expect(world.relations.sourcesOf(tgt, Targets)).toEqual([]);
		expect(world.relations.targetOf(src, Targets)).toBe(tgt); // forward link preserved
	});
});
