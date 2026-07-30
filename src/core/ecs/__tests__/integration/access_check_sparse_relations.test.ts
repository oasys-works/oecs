// Sparse-component / relation access-declaration coverage.
//
// The dense `SystemContext` mutators have run an `accessCheck` guard under
// `__DEV__` since access declarations became mandatory. Sparse
// (`addSparse` / `removeSparse` /
// `setSparseField`) and relation (`addRelation` / `removeRelation`)
// mutators used to forward straight to the store with no check, because
// `SystemAccessDeclaration` had no vocabulary for the two new id spaces. These
// tests pin the closed hole: an undeclared sparse/relation access throws in
// `__DEV__`, mirroring the dense path, and the dense vs sparse vs relation id
// spaces never alias one another.

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import type { SystemConfig } from "../../system";

/** Empty dense access declaration; spread and override the sparse/relation
 * terms per test. */
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

/** Register `sys` into UPDATE, start the world, and return the thunk that runs
 * one update tick (where the system's `fn` — and its access checks — fire). */
function runOnce(world: ECS, cfg: SystemConfig): () => void {
	const sys = world.registerSystem(cfg);
	world.addSystems(SCHEDULE.UPDATE, sys);
	world.startup();
	return () => world.update(0);
}

describe("Sparse access validation", () => {
	it("throws when a system adds an undeclared sparse component", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();

		const tick = runOnce(
			world,
			base({
				name: "sparse_adder",
				fn(ctx) {
					ctx.addSparse(e, Cooldown, { ready_at: 5 });
				}
			})
		);

		expect(tick).toThrow(/system 'sparse_adder'.*sparse component.*didn't declare/);
	});

	it("permits a sparse add/remove/set when declared in sparse_writes", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();

		const tick = runOnce(
			world,
			base({
				name: "sparse_writer",
				sparseWrites: [Cooldown],
				fn(ctx) {
					ctx.addSparse(e, Cooldown, { ready_at: 5 });
					ctx.setSparseField(e, Cooldown, "ready_at", 9);
					ctx.removeSparse(e, Cooldown);
				}
			})
		);

		expect(tick).not.toThrow();
	});

	it("throws when a system removes an undeclared sparse component", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addSparse(e, Cooldown, { ready_at: 1 }); // host-side: not checked

		const tick = runOnce(
			world,
			base({
				name: "sparse_remover",
				fn(ctx) {
					ctx.removeSparse(e, Cooldown);
				}
			})
		);

		expect(tick).toThrow(/system 'sparse_remover'.*sparse component.*didn't declare/);
	});

	it("throws when a system writes an undeclared sparse field", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addSparse(e, Cooldown, { ready_at: 1 });

		const tick = runOnce(
			world,
			base({
				name: "sparse_field_writer",
				fn(ctx) {
					ctx.setSparseField(e, Cooldown, "ready_at", 9);
				}
			})
		);

		expect(tick).toThrow(/system 'sparse_field_writer'.*sparse component.*didn't declare/);
	});

	it("throws when a system reads an undeclared sparse field", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addSparse(e, Cooldown, { ready_at: 1 });

		const tick = runOnce(
			world,
			base({
				name: "sparse_reader",
				fn(ctx) {
					ctx.getSparseField(e, Cooldown, "ready_at");
				}
			})
		);

		expect(tick).toThrow(/system 'sparse_reader'.*sparse component.*didn't declare/);
	});

	it("a declared sparse_write implicitly authorises reads of the same component", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addSparse(e, Cooldown, { ready_at: 7 });

		let observed = -1;
		const tick = runOnce(
			world,
			base({
				// Only declares the write — must still be allowed to read it.
				name: "sparse_write_implies_read",
				sparseWrites: [Cooldown],
				fn(ctx) {
					observed = ctx.getSparseField(e, Cooldown, "ready_at");
				}
			})
		);

		expect(tick).not.toThrow();
		expect(observed).toBe(7);
	});

	it("a sparse_reads-only declaration permits reads but still blocks writes", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addSparse(e, Cooldown, { ready_at: 7 });

		const tick = runOnce(
			world,
			base({
				name: "sparse_read_only",
				sparseReads: [Cooldown],
				fn(ctx) {
					ctx.getSparseField(e, Cooldown, "ready_at"); // ok
					ctx.setSparseField(e, Cooldown, "ready_at", 9); // not declared as write
				}
			})
		);

		expect(tick).toThrow(/system 'sparse_read_only'.*write.*sparse component.*didn't declare/);
	});

	it("has_sparse is a membership probe and is not access-checked", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();

		let seen = true;
		const tick = runOnce(
			world,
			base({
				name: "sparse_prober",
				fn(ctx) {
					seen = ctx.hasSparse(e, Cooldown); // undeclared — must NOT throw
				}
			})
		);

		expect(tick).not.toThrow();
		expect(seen).toBe(false);
	});
});

describe("Relation access validation", () => {
	it("throws when a system adds an undeclared relation", () => {
		const world = new ECS();
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();

		const tick = runOnce(
			world,
			base({
				name: "relation_adder",
				fn(ctx) {
					ctx.addRelation(a, Targets, b);
				}
			})
		);

		expect(tick).toThrow(/system 'relation_adder'.*relation.*didn't declare/);
	});

	it("permits relation add/remove when declared in relation_writes", () => {
		const world = new ECS();
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();

		const tick = runOnce(
			world,
			base({
				name: "relation_writer",
				relationWrites: [Targets],
				fn(ctx) {
					ctx.addRelation(a, Targets, b);
					ctx.removeRelation(a, Targets, b);
				}
			})
		);

		expect(tick).not.toThrow();
	});

	it("throws when a system reads an undeclared relation via target_of", () => {
		const world = new ECS();
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();
		world.relations.add(a, Targets, b); // host-side: not checked

		const tick = runOnce(
			world,
			base({
				name: "relation_reader",
				fn(ctx) {
					ctx.targetOf(a, Targets);
				}
			})
		);

		expect(tick).toThrow(/system 'relation_reader'.*relation.*didn't declare/);
	});

	it("a declared relation_write implicitly authorises reads of the same relation", () => {
		const world = new ECS();
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();
		world.relations.add(a, Targets, b);

		let observed: number | undefined = -1;
		const tick = runOnce(
			world,
			base({
				name: "relation_write_implies_read",
				relationWrites: [Targets],
				fn(ctx) {
					observed = ctx.targetOf(a, Targets) as number | undefined;
				}
			})
		);

		expect(tick).not.toThrow();
		expect(observed).toBe(b);
	});

	it("has_relation is a membership probe and is not access-checked", () => {
		const world = new ECS();
		const Targets = world.relations.register();
		const a = world.spawn();

		let seen = true;
		const tick = runOnce(
			world,
			base({
				name: "relation_prober",
				fn(ctx) {
					seen = ctx.hasRelation(a, Targets); // undeclared — must NOT throw
				}
			})
		);

		expect(tick).not.toThrow();
		expect(seen).toBe(false);
	});
});

describe("Access id spaces are disjoint", () => {
	it("a dense write declaration does not authorise a same-numbered sparse component", () => {
		const world = new ECS();
		// First dense component and first sparse component both erase to numeric
		// id 0 in their respective spaces. A single merged set would wrongly let
		// the declared dense write authorise the sparse add.
		const Pos = world.registerComponent(["x"] as const);
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const e = world.spawn();
		world.addComponent(e, Pos, { x: 1 });

		const tick = runOnce(
			world,
			base({
				name: "dense_writer_touching_sparse",
				writes: [Pos], // dense id 0 declared...
				fn(ctx) {
					ctx.addSparse(e, Cooldown, { ready_at: 1 }); // ...sparse id 0 must still throw
				}
			})
		);

		expect(tick).toThrow(/sparse component.*didn't declare/);
	});

	it("a sparse write declaration does not authorise a same-numbered relation", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();

		const tick = runOnce(
			world,
			base({
				name: "sparse_writer_touching_relation",
				sparseWrites: [Cooldown], // sparse id 0 declared...
				fn(ctx) {
					ctx.addRelation(a, Targets, b); // ...relation id 0 must still throw
				}
			})
		);

		expect(tick).toThrow(/relation.*didn't declare/);
	});
});

describe("Sparse/relation access outside any system", () => {
	it("host-side sparse + relation mutations are never access-checked", () => {
		const world = new ECS();
		const Cooldown = world.registerSparseComponent(["ready_at"] as const);
		const Targets = world.relations.register();
		const a = world.spawn();
		const b = world.spawn();

		// No active system → access_check is a no-op for all of these.
		expect(() => {
			world.addSparse(a, Cooldown, { ready_at: 3 });
			world.setSparseField(a, Cooldown, "ready_at", 4);
			world.getSparseField(a, Cooldown, "ready_at");
			world.removeSparse(a, Cooldown);
			world.relations.add(a, Targets, b);
			world.relations.targetOf(a, Targets);
			world.relations.remove(a, Targets, b);
		}).not.toThrow();
	});
});
