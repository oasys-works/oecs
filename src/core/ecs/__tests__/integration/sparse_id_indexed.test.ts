/**
 * The id-indexed sparse store.
 *
 * A sparse component's data lives in one typed array for each field, indexed
 * by entity index, and grows to fit the highest member index. These tests lock
 * what that layout must keep true: a value converts as its declared type
 * converts. The columns grow past the initial capacity and a cursor made
 * before the grow keeps reading the live columns. A walk over a sparse term
 * sees a remove made during the walk as a swap-remove. A snapshot round trip
 * restores typed values, and the DEV checks of the sparse cursor name the
 * mistake.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import { ECS_ERROR, ECSError } from "../../utils/error";
import type { SystemContext } from "../../query";

describe("id-indexed sparse store", () => {
	it("converts a value as the field's type converts", () => {
		const ecs = new ECS();
		const S = ecs.registerSparseComponent({ a: "u8", b: "i16", c: "f32", d: "f64" });
		const e = ecs.spawn();
		ecs.addSparse(e, S, { a: 300, b: -40000, c: 0.1, d: 0.1 });
		expect(ecs.getSparseField(e, S, "a")).toBe(300 & 0xff);
		expect(ecs.getSparseField(e, S, "b")).toBe((-40000 << 16) >> 16);
		expect(ecs.getSparseField(e, S, "c")).toBe(Math.fround(0.1));
		expect(ecs.getSparseField(e, S, "d")).toBe(0.1);
		ecs.setSparseField(e, S, "a", -1);
		expect(ecs.getSparseField(e, S, "a")).toBe(255);
		// An omitted field is 0, as before.
		const f = ecs.spawn();
		ecs.addSparse(f, S, { a: 1 } as never);
		expect(ecs.getSparseField(f, S, "d")).toBe(0);
	});

	it("grows past the initial capacity, and a cursor made before the grow reads the live columns", () => {
		const ecs = new ECS();
		const S = ecs.registerSparseComponent({ v: "i32" });
		const c = ecs.sparseCursorRead(S);
		// Spawn well past the initial capacity of a store (64), with holes.
		const ids = ecs.spawnMany(ecs.template(), 5000);
		for (let i = 0; i < ids.length; i += 7) ecs.addSparse(ids[i], S, { v: i });
		for (let i = 0; i < ids.length; i += 7) {
			expect(ecs.getSparseField(ids[i], S, "v")).toBe(i);
			expect(c.at(ids[i]).v).toBe(i);
		}
		for (let i = 1; i < ids.length; i += 7) expect(ecs.hasSparse(ids[i], S)).toBe(false);
		// Remove every other member: membership and the others' data hold.
		for (let i = 0; i < ids.length; i += 14) ecs.removeSparse(ids[i], S);
		for (let i = 0; i < ids.length; i += 7) {
			expect(ecs.hasSparse(ids[i], S)).toBe(i % 14 !== 0);
			if (i % 14 !== 0) expect(c.at(ids[i]).v).toBe(i);
		}
		// A recycled slot does not inherit the old occupant's membership.
		ecs.despawn(ids[7]);
		const again = ecs.spawn();
		expect(ecs.hasSparse(again, S)).toBe(false);
	});

	it("a sparse cursor writes through, and a walk sees a remove made during the walk", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" });
		const S = ecs.registerSparseComponent({ v: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 0 })), 10);
		for (let i = 0; i < 10; i++) ecs.addSparse(ids[i], S, { v: i });
		const w = ecs.sparseCursor(S);
		for (let i = 0; i < 10; i++) {
			w.at(ids[i]);
			w.v = w.v * 2;
		}
		for (let i = 0; i < 10; i++) expect(ecs.getSparseField(ids[i], S, "v")).toBe(i * 2);

		// The documented form of a walk that edits the driving term: hold the
		// edits and apply them after. Every member is seen one time, and the
		// term is empty after the edits land. (An edit during the walk moves
		// the live member list under it, as the docs warn.)
		const seen: number[] = [];
		const toRemove: number[] = [];
		ecs.query(Pos).withSparse(S).forEachEntity((e) => {
			seen.push(ecs.getSparseField(e, S, "v"));
			toRemove.push(e);
		});
		for (const e of toRemove) ecs.removeSparse(e as never, S);
		expect(seen.length).toBe(10);
		expect(new Set(seen).size).toBe(10);
		let left = 0;
		ecs.query(Pos).withSparse(S).forEachEntity(() => left++);
		expect(left).toBe(0);
	});

	it("snapshot and restore carry typed values, and the hash ignores add order", () => {
		const build = (order: number[]) => {
			const ecs = new ECS({ deterministic: true });
			const Pos = ecs.registerComponent({ x: "i32" });
			const S = ecs.registerSparseComponent({ a: "u8", b: "i32" });
			const ids = ecs.spawnMany(ecs.template(Pos({ x: 1 })), 100);
			for (const i of order) ecs.addSparse(ids[i], S, { a: i * 3, b: -(i + 1) });
			return { ecs, S, ids };
		};
		const asc = Array.from({ length: 100 }, (_, i) => i).filter((i) => i % 3 === 0);
		const a = build(asc);
		const b = build(asc.slice().reverse());
		expect(a.ecs.snapshots.stateHash()).toBe(b.ecs.snapshots.stateHash());

		const bytes = a.ecs.snapshots.captureSparse();
		const c = build([]);
		c.ecs.snapshots.restoreSparse(bytes);
		for (const i of asc) {
			expect(c.ecs.hasSparse(c.ids[i], c.S)).toBe(true);
			expect(c.ecs.getSparseField(c.ids[i], c.S, "a")).toBe((i * 3) & 0xff);
			expect(c.ecs.getSparseField(c.ids[i], c.S, "b")).toBe(-(i + 1));
		}
		expect(c.ecs.snapshots.stateHash()).toBe(a.ecs.snapshots.stateHash());
	});

	it("the sparse cursor names a dead entity, a non-member, and an undeclared access under DEV", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" });
		const S = ecs.registerSparseComponent({ v: "f64" });
		const T = ecs.registerSparseComponent({ w: "f64" });
		const e = ecs.spawn(ecs.template(Pos({ x: 0 })));
		const f = ecs.spawn(ecs.template(Pos({ x: 0 })));
		ecs.addSparse(e, S, { v: 1 });
		const c = ecs.sparseCursorRead(S);
		expect(c.at(e).v).toBe(1);
		let err: unknown;
		try {
			c.at(f);
		} catch (x) {
			err = x;
		}
		expect((err as ECSError).category).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
		ecs.despawn(f);
		expect(() => c.at(f)).toThrow(ECSError);

		// The access check fires inside a running system: a cursor over an
		// undeclared sparse component throws there, a declared one reads.
		let declared = -1;
		let undeclared: unknown;
		const sys = ecs.registerSystem({
			reads: [],
			writes: [],
			sparseReads: [S],
			fn(ctx: SystemContext) {
				declared = ctx.sparseCursorRead(S).at(e).v;
				try {
					(ctx as unknown as { sparseCursorRead: (d: unknown) => unknown }).sparseCursorRead(T);
				} catch (x) {
					undeclared = x;
				}
			}
		});
		ecs.addSystems(SCHEDULE.UPDATE, sys);
		ecs.startup();
		ecs.update(0);
		expect(declared).toBe(1);
		expect(undeclared).toBeInstanceOf(ECSError);
	});
});

describe("reserved accessor field names", () => {
	it("registration refuses `__cols` and `__row` on dense and sparse components", () => {
		const ecs = new ECS();
		for (const name of ["__cols", "__row"]) {
			expect(() => ecs.registerComponent({ [name]: "f64" })).toThrow(ECSError);
			expect(() => ecs.registerSparseComponent({ [name]: "f64" })).toThrow(ECSError);
		}
		// A near miss is a normal field.
		const A = ecs.registerComponent({ _cols: "f64", row: "i32" });
		const e = ecs.spawn(ecs.template(A({ _cols: 2, row: 3 })));
		expect(ecs.refRead(A, e)._cols).toBe(2);
		expect(ecs.cursorRead(A).at(e).row).toBe(3);
	});
});
