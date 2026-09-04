/**
 * Element kinds and accessor shapes.
 *
 * Two invariants that exist for performance, locked here for correctness:
 *
 *  1. **The structural row operations move bits through width-canonical
 *     views** (`Archetype._rowBufs`, `widthView` in row_kinds.ts). A copy, a
 *     move, a swap and a zero fill each go through a view whose class depends
 *     on the element width alone, so one access site sees at most four
 *     typed-array classes. The bits must survive every row operation, for
 *     every one of the eight column types, in one archetype.
 *
 *  2. **Every ref and cursor shares one prototype** (ref.ts), and each field
 *     name resolves its column through the component's name table. A value
 *     written through a typed accessor must convert as the column's type
 *     converts, a name that two components give different types must read
 *     correctly on both, and a field the component lacks must throw under DEV
 *     instead of reading another column.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, ECSError } from "../../utils/error";
import { widthView } from "../../row_kinds";
import { TYPE_TAG } from "../../../store/descriptor";

// One field of each column type. The values are chosen so that each type
// converts them differently: a negative for the signed types, a wrap for the
// unsigned types, a rounding for f32, a truncation for the integers.
const AllKinds = {
	a: "f64",
	b: "f32",
	c: "i32",
	d: "u32",
	e: "i16",
	f: "u16",
	g: "i8",
	h: "u8"
} as const;

const input = { a: 1.5, b: 0.1, c: -7.9, d: 4294967295, e: -300, f: 70000, g: -129, h: 300 };
// What each column stores for `input`, by the conversion of its type.
const stored = {
	a: 1.5,
	b: Math.fround(0.1),
	c: -7,
	d: 4294967295,
	e: -300,
	f: 70000 & 0xffff,
	g: (-129 << 24) >> 24,
	h: 300 & 0xff
};

function readAll(ecs: ECS, def: ReturnType<ECS["registerComponent"]>, e: number) {
	const out: Record<string, number> = {};
	for (const k of Object.keys(AllKinds)) out[k] = ecs.getField(e as never, def as never, k as never);
	return out;
}

describe("eight element kinds in one archetype", () => {
	it("keeps every column's bits across add, remove, swap-remove, disable and enable", () => {
		const ecs = new ECS();
		const K = ecs.registerComponent(AllKinds);
		const Tag = ecs.registerTag();
		const Other = ecs.registerComponent({ q: "i16" });

		// Three entities so a swap-remove has a last row to move into the hole.
		const ids = ecs.spawnMany(ecs.template(K(input)), 3);
		const alt = { a: -2.25, b: 1.7, c: 123456789, d: 1, e: 32767, f: 65535, g: 127, h: 255 };
		ecs.setField(ids[1], K, "a", alt.a);
		for (const k of Object.keys(alt) as (keyof typeof alt)[]) ecs.setField(ids[1], K, k, alt[k]);

		// Transition through a tag (copy row into a new archetype, swap-remove in the old).
		ecs.addComponent(ids[0], Tag);
		expect(readAll(ecs, K, ids[0])).toEqual(stored);
		expect(readAll(ecs, K, ids[1])).toEqual({
			...alt,
			b: Math.fround(alt.b)
		});
		ecs.removeComponent(ids[0], Tag);
		expect(readAll(ecs, K, ids[0])).toEqual(stored);

		// Transition through a valued component: the copy goes through `map`,
		// the new column gets the value through the true view.
		ecs.addComponent(ids[2], Other, { q: -5.5 });
		expect(readAll(ecs, K, ids[2])).toEqual(stored);
		expect(ecs.getField(ids[2], Other, "q")).toBe(-5);
		ecs.removeComponent(ids[2], Other);

		// Disable and enable swap rows inside the partition.
		ecs.disable(ids[0]);
		expect(readAll(ecs, K, ids[0])).toEqual(stored);
		expect(readAll(ecs, K, ids[1])).toEqual({ ...alt, b: Math.fround(alt.b) });
		ecs.enable(ids[0]);
		expect(readAll(ecs, K, ids[0])).toEqual(stored);

		// Despawn the middle entity: the last row fills its hole.
		ecs.despawn(ids[1]);
		expect(readAll(ecs, K, ids[0])).toEqual(stored);
		expect(readAll(ecs, K, ids[2])).toEqual(stored);
	});

	it("zero-fills a column the source archetype lacks", () => {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64" });
		const K = ecs.registerComponent(AllKinds);
		const e = ecs.spawn(ecs.template(Pos({ x: 3 })));
		ecs.addComponent(e, K as never);
		const zeros = Object.fromEntries(Object.keys(AllKinds).map((k) => [k, 0]));
		expect(readAll(ecs, K, e)).toEqual(zeros);
		expect(ecs.getField(e, Pos, "x")).toBe(3);
	});

	it("the width view shares the bytes and keeps an explicit length", () => {
		const buffer = new ArrayBuffer(64);
		const i32 = new Int32Array(buffer, 8, 4);
		const f32 = new Float32Array(buffer, 24, 2);
		const i16 = new Int16Array(buffer, 32, 3);
		const i8 = new Int8Array(buffer, 40, 5);
		const f64 = new Float64Array(buffer, 48, 2);
		const u8 = new Uint8Array(buffer, 0, 8);

		const vi32 = widthView(TYPE_TAG.i32, i32);
		expect(vi32).toBeInstanceOf(Uint32Array);
		expect(vi32.byteOffset).toBe(8);
		expect(vi32.length).toBe(4);
		i32[1] = -1;
		expect(vi32[1]).toBe(0xffffffff);

		const vf32 = widthView(TYPE_TAG.f32, f32);
		expect(vf32).toBeInstanceOf(Uint32Array);
		f32[0] = 1;
		expect(vf32[0]).toBe(0x3f800000);

		expect(widthView(TYPE_TAG.i16, i16)).toBeInstanceOf(Uint16Array);
		expect(widthView(TYPE_TAG.i8, i8)).toBeInstanceOf(Uint8Array);
		expect(widthView(TYPE_TAG.f64, f64)).toBe(f64);
		expect(widthView(TYPE_TAG.u8, u8)).toBe(u8);
	});
});

describe("accessors share one prototype", () => {
	it("refs and cursors of different components have the same prototype", () => {
		const ecs = new ECS();
		const A = ecs.registerComponent({ ax: "f64" });
		const B = ecs.registerComponent({ bx: "i32" });
		const e = ecs.spawn(ecs.template(A({ ax: 1 }), B({ bx: 2 })));
		const ra = ecs.refRead(A, e);
		const rb = ecs.refRead(B, e);
		const ca = ecs.cursorRead(A);
		const cb = ecs.cursor(B);
		const proto = Object.getPrototypeOf(ra);
		expect(Object.getPrototypeOf(rb)).toBe(proto);
		expect(Object.getPrototypeOf(ca)).toBe(proto);
		expect(Object.getPrototypeOf(cb)).toBe(proto);
		expect(ra.ax).toBe(1);
		expect(rb.bx).toBe(2);
		expect(ca.at(e).ax).toBe(1);
		cb.at(e).bx = 9.9;
		expect(ecs.getField(e, B, "bx")).toBe(9);
	});

	it("a cursor converts a written value as the column's type converts", () => {
		const ecs = new ECS();
		const K = ecs.registerComponent(AllKinds);
		const e = ecs.spawn(ecs.template(K({})));
		const c = ecs.cursor(K);
		c.at(e);
		for (const k of Object.keys(input) as (keyof typeof input)[]) c[k] = input[k];
		for (const k of Object.keys(stored) as (keyof typeof stored)[]) expect(c[k]).toBe(stored[k]);
		expect(readAll(ecs, K, e)).toEqual(stored);
	});

	it("a name that two components give different types reads correctly on both", () => {
		const ecs = new ECS();
		// The same name with two types, and a third component that repeats the
		// first type after the name went mixed.
		const A = ecs.registerComponent({ shared_i: "i32", shared_f: "f32" });
		const B = ecs.registerComponent({ shared_i: "f64", shared_f: "u8" });
		const C = ecs.registerComponent({ shared_i: "i32" });
		const e = ecs.spawn(
			ecs.template(A({ shared_i: -1.5, shared_f: 0.1 }), B({ shared_i: -1.5, shared_f: 300 }), C({ shared_i: 7.7 }))
		);
		const ra = ecs.refRead(A, e);
		const rb = ecs.refRead(B, e);
		const rc = ecs.refRead(C, e);
		expect(ra.shared_i).toBe(-1);
		expect(ra.shared_f).toBe(Math.fround(0.1));
		expect(rb.shared_i).toBe(-1.5);
		expect(rb.shared_f).toBe(300 & 0xff);
		expect(rc.shared_i).toBe(7);

		const cb = ecs.cursor(B);
		cb.at(e).shared_i = 2.5;
		cb.shared_f = 257;
		expect(ecs.getField(e, B, "shared_i")).toBe(2.5);
		expect(ecs.getField(e, B, "shared_f")).toBe(1);
		const ca = ecs.cursor(A);
		ca.at(e).shared_i = 2.5;
		expect(ecs.getField(e, A, "shared_i")).toBe(2);
	});

	it("a field the component lacks throws under DEV instead of reading a neighbour", () => {
		const ecs = new ECS();
		const A = ecs.registerComponent({ ax: "f64" });
		const B = ecs.registerComponent({ bx: "f64" });
		const e = ecs.spawn(ecs.template(A({ ax: 1 }), B({ bx: 2 })));
		const ra = ecs.refRead(A, e) as unknown as Record<string, number>;
		expect(() => ra.bx).toThrow(ECSError);
		// A cursor that no `at()` has pointed yet names the mistake too.
		const unpointed = ecs.cursorRead(A) as unknown as Record<string, number>;
		expect(() => unpointed.ax).toThrow(ECSError);
		try {
			void ra.bx;
		} catch (err) {
			expect((err as ECSError).category).toBe(ECS_ERROR.FIELD_NOT_REGISTERED);
		}
		const ca = ecs.cursor(A).at(e) as unknown as Record<string, number>;
		expect(() => (ca.bx = 5)).toThrow(ECSError);
		expect(ecs.getField(e, B, "bx")).toBe(2);
	});
});
