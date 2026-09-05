/**
 * The system-context twins of four host accessors: `ctx.cursorRead`,
 * `ctx.sparseCursor`, `ctx.targetsOf` and `ctx.sourcesOf`.
 *
 * The `ecs.*` forms of all four are covered elsewhere. The `ctx.*` forms are
 * not the same code: each one runs an access check against the system's
 * declaration before it reaches the store, and that check is the reason the
 * pair exists. A system that reads a relation it did not declare is the fault
 * this file locks, on the read side and on the reverse-index side.
 *
 * The declaration is erased in a production build, so every throw here is a
 * development guard. The value each accessor returns is not.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { SystemContext } from "../../system_context";
import { SCHEDULE } from "../../schedule";
import { ECSError } from "../../utils/error";
import { openAccess } from "../test_helpers";
import { relations } from "../../../../capabilities/relations";

/** Run `fn` once inside a system with the supplied declaration. */
function inSystem(ecs: ECS, access: ReturnType<typeof openAccess>, fn: (ctx: SystemContext) => void): void {
	ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({ ...access, fn: fn as never }));
	ecs.startup();
	ecs.update(0);
}

describe("ctx.cursorRead", () => {
	it("reads the entity it is pointed at, and refuses an undeclared component", () => {
		const ecs = ECS.create({ plugins: [relations()] });
		const Pos = ecs.registerComponent({ x: "f64" }, { name: "Pos" });
		const Vel = ecs.registerComponent({ v: "f64" }, { name: "Vel" });
		const a = ecs.spawn(ecs.template(Pos({ x: 1 })));
		const b = ecs.spawn(ecs.template(Pos({ x: 2 })));

		let seen: number[] = [];
		let undeclared: unknown;
		inSystem(ecs, openAccess([Pos]), (ctx) => {
			const c = ctx.cursorRead(Pos);
			seen = [c.at(a).x, c.at(b).x];
			try {
				(ctx as unknown as { cursorRead: (d: unknown) => unknown }).cursorRead(Vel);
			} catch (err) {
				undeclared = err;
			}
		});

		expect(seen).toEqual([1, 2]);
		expect(undeclared).toBeInstanceOf(ECSError);
	});
});

describe("ctx.sparseCursor", () => {
	it("writes through the cursor, and refuses a component declared read-only", () => {
		const ecs = ECS.create({ plugins: [relations()] });
		const S = ecs.registerSparseComponent({ v: "f64" }, { name: "S" });
		const T = ecs.registerSparseComponent({ v: "f64" }, { name: "T" });
		const e = ecs.spawn();
		ecs.addSparse(e, S, { v: 1 });

		let readOnly: unknown;
		// `T` sits in `sparseReads` only, so the write cursor must refuse it.
		const access = { ...openAccess([], [], [S]), sparseReads: [S, T], sparseWrites: [S] };
		inSystem(ecs, access, (ctx) => {
			ctx.sparseCursor(S).at(e).v = 9;
			try {
				(ctx as unknown as { sparseCursor: (d: unknown) => unknown }).sparseCursor(T);
			} catch (err) {
				readOnly = err;
			}
		});

		expect(ecs.getSparseField(e, S, "v")).toBe(9);
		expect(readOnly).toBeInstanceOf(ECSError);
	});
});

describe("ctx.targetsOf and ctx.sourcesOf", () => {
	it("agree with the host forms, and refuse an undeclared relation", () => {
		const ecs = ECS.create({ plugins: [relations()] });
		const Likes = ecs.relations.register({ multi: true });
		const Other = ecs.relations.register({ multi: true });
		const src = ecs.spawn();
		const t1 = ecs.spawn();
		const t2 = ecs.spawn();
		ecs.relations.add(src, Likes, t1);
		ecs.relations.add(src, Likes, t2);

		let targets: number[] = [];
		let sources: number[] = [];
		let undeclaredTargets: unknown;
		let undeclaredSources: unknown;
		type Erased = { targetsOf: (e: unknown, d: unknown) => unknown; sourcesOf: (e: unknown, d: unknown) => unknown };
		inSystem(ecs, openAccess([], [], [], [Likes]), (ctx) => {
			targets = ctx.targetsOf(src, Likes).map(Number);
			sources = ctx.sourcesOf(t1, Likes).map(Number);
			try {
				(ctx as unknown as Erased).targetsOf(src, Other);
			} catch (err) {
				undeclaredTargets = err;
			}
			try {
				(ctx as unknown as Erased).sourcesOf(t1, Other);
			} catch (err) {
				undeclaredSources = err;
			}
		});

		expect(targets).toEqual(ecs.relations.targetsOf(src, Likes).map(Number));
		expect(targets).toEqual([Number(t1), Number(t2)]);
		expect(sources).toEqual(ecs.relations.sourcesOf(t1, Likes).map(Number));
		expect(sources).toEqual([Number(src)]);
		expect(undeclaredTargets).toBeInstanceOf(ECSError);
		expect(undeclaredSources).toBeInstanceOf(ECSError);
	});
});
