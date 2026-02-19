import { describe, expect, it } from "vitest";
import {
  // GrowableTypedArray,
  GrowableFloat32Array,
  GrowableFloat64Array,
  GrowableInt32Array,
  GrowableUint32Array,
  TypedArrayFor,
  type TypedArrayTag,
} from "../typed_arrays";

describe("GrowableTypedArray", () => {
  //=========================================================
  // push / pop / length
  //=========================================================

  it("starts empty", () => {
    const a = new GrowableFloat32Array();
    expect(a.length).toBe(0);
  });

  it("push increments length and stores values", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.push(3.0);
    expect(a.length).toBe(3);
    expect(a.get(0)).toBeCloseTo(1.0);
    expect(a.get(1)).toBeCloseTo(2.0);
    expect(a.get(2)).toBeCloseTo(3.0);
  });

  it("pop removes and returns last value", () => {
    const a = new GrowableFloat32Array();
    a.push(10.0);
    a.push(20.0);
    const v = a.pop();
    expect(v).toBeCloseTo(20.0);
    expect(a.length).toBe(1);
    expect(a.get(0)).toBeCloseTo(10.0);
  });

  //=========================================================
  // get / set_at
  //=========================================================

  it("set_at overwrites value at index", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.set_at(0, 99.0);
    expect(a.get(0)).toBeCloseTo(99.0);
    expect(a.get(1)).toBeCloseTo(2.0);
  });

  //=========================================================
  // swap_remove
  //=========================================================

  it("swap_remove on last element just decrements length", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.push(3.0);
    const removed = a.swap_remove(2);
    expect(removed).toBeCloseTo(3.0);
    expect(a.length).toBe(2);
    expect(a.get(0)).toBeCloseTo(1.0);
    expect(a.get(1)).toBeCloseTo(2.0);
  });

  it("swap_remove on middle element moves last to that slot", () => {
    const a = new GrowableFloat32Array();
    a.push(10.0);
    a.push(20.0);
    a.push(30.0);
    const removed = a.swap_remove(0);
    expect(removed).toBeCloseTo(10.0);
    expect(a.length).toBe(2);
    // 30 moved to slot 0
    expect(a.get(0)).toBeCloseTo(30.0);
    expect(a.get(1)).toBeCloseTo(20.0);
  });

  it("swap_remove on sole element leaves array empty", () => {
    const a = new GrowableFloat32Array();
    a.push(5.0);
    a.swap_remove(0);
    expect(a.length).toBe(0);
  });

  //=========================================================
  // clear
  //=========================================================

  it("clear resets length to zero", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.clear();
    expect(a.length).toBe(0);
  });

  it("can push after clear", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.clear();
    a.push(42.0);
    expect(a.length).toBe(1);
    expect(a.get(0)).toBeCloseTo(42.0);
  });

  //=========================================================
  // growth
  //=========================================================

  it("grows when pushing past initial capacity", () => {
    const a = new GrowableFloat32Array(4); // tiny initial capacity
    for (let i = 0; i < 20; i++) a.push(i);
    expect(a.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(a.get(i)).toBeCloseTo(i);
    }
  });

  it("values are preserved across growth boundary", () => {
    const a = new GrowableFloat32Array(2);
    a.push(1.0);
    a.push(2.0);
    // This push triggers a growth
    a.push(3.0);
    expect(a.get(0)).toBeCloseTo(1.0);
    expect(a.get(1)).toBeCloseTo(2.0);
    expect(a.get(2)).toBeCloseTo(3.0);
  });

  //=========================================================
  // view
  //=========================================================

  it("view returns a typed slice of valid data", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.push(3.0);
    const v = a.view();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(3);
    expect(v[0]).toBeCloseTo(1.0);
    expect(v[1]).toBeCloseTo(2.0);
    expect(v[2]).toBeCloseTo(3.0);
  });

  it("view length matches current length after pop", () => {
    const a = new GrowableFloat32Array();
    a.push(1.0);
    a.push(2.0);
    a.pop();
    const v = a.view();
    expect(v.length).toBe(1);
  });

  //=========================================================
  // Symbol.iterator
  //=========================================================

  it("spread iterates valid elements only", () => {
    const a = new GrowableFloat32Array();
    a.push(10.0);
    a.push(20.0);
    a.push(30.0);
    expect([...a].map(Math.round)).toEqual([10, 20, 30]);
  });

  //=========================================================
  // Int32 / Uint32 — integer precision
  //=========================================================

  it("GrowableInt32Array stores signed integers exactly", () => {
    const a = new GrowableInt32Array();
    a.push(-1);
    a.push(0);
    a.push(2147483647); // INT32_MAX
    expect(a.get(0)).toBe(-1);
    expect(a.get(1)).toBe(0);
    expect(a.get(2)).toBe(2147483647);
  });

  it("GrowableUint32Array stores unsigned integers exactly", () => {
    const a = new GrowableUint32Array();
    a.push(0);
    a.push(4294967295); // UINT32_MAX
    expect(a.get(0)).toBe(0);
    expect(a.get(1)).toBe(4294967295);
  });

  it("GrowableFloat64Array preserves double precision", () => {
    const a = new GrowableFloat64Array();
    const v = 1.23456789012345678;
    a.push(v);
    expect(a.get(0)).toBe(v);
  });
});

//=========================================================
// TypedArrayFor — tag → class mapping
//=========================================================

describe("TypedArrayFor", () => {
  const tags: TypedArrayTag[] = [
    "f32",
    "f64",
    "i8",
    "i16",
    "i32",
    "u8",
    "u16",
    "u32",
  ];

  for (const tag of tags) {
    it(`TypedArrayFor["${tag}"] constructs and pushes correctly`, () => {
      const col = new TypedArrayFor[tag]();
      col.push(1);
      col.push(2);
      col.push(3);
      expect(col.length).toBe(3);
      expect(col.get(0)).toBe(1);
      expect(col.get(2)).toBe(3);
    });
  }

  it('TypedArrayFor["f32"] produces Float32Array views', () => {
    const col = new TypedArrayFor["f32"]();
    col.push(1.5);
    expect(col.view()).toBeInstanceOf(Float32Array);
  });

  it('TypedArrayFor["i32"] produces Int32Array views', () => {
    const col = new TypedArrayFor["i32"]();
    col.push(-100);
    expect(col.view()).toBeInstanceOf(Int32Array);
  });

  it('TypedArrayFor["u32"] produces Uint32Array views', () => {
    const col = new TypedArrayFor["u32"]();
    col.push(9999);
    expect(col.view()).toBeInstanceOf(Uint32Array);
  });
});
