import { describe, expect, it } from "vitest";
import { SparseMap } from "../sparse_map";

describe("SparseMap", () => {
  //=========================================================
  // has / get / set
  //=========================================================

  it("empty map has nothing", () => {
    const m = new SparseMap<string>();
    expect(m.has(0)).toBe(false);
    expect(m.get(0)).toBeUndefined();
  });

  it("set and get round-trip", () => {
    const m = new SparseMap<number>();
    m.set(3, 100);
    m.set(7, 200);
    m.set(42, 300);
    expect(m.get(3)).toBe(100);
    expect(m.get(7)).toBe(200);
    expect(m.get(42)).toBe(300);
    expect(m.get(1)).toBeUndefined();
  });

  it("set overwrites existing value", () => {
    const m = new SparseMap<string>();
    m.set(5, "first");
    m.set(5, "second");
    expect(m.get(5)).toBe("second");
    expect(m.size).toBe(1);
  });

  it("has returns true only for inserted keys", () => {
    const m = new SparseMap<number>();
    m.set(10, 1);
    expect(m.has(10)).toBe(true);
    expect(m.has(11)).toBe(false);
  });

  it("size reflects entry count", () => {
    const m = new SparseMap<number>();
    expect(m.size).toBe(0);
    m.set(0, 1);
    expect(m.size).toBe(1);
    m.set(1, 2);
    expect(m.size).toBe(2);
    m.set(0, 99); // overwrite — no size change
    expect(m.size).toBe(2);
  });

  //=========================================================
  // delete
  //=========================================================

  it("delete removes the entry", () => {
    const m = new SparseMap<string>();
    m.set(10, "hello");
    expect(m.delete(10)).toBe(true);
    expect(m.has(10)).toBe(false);
    expect(m.get(10)).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it("delete returns false for absent key", () => {
    const m = new SparseMap<number>();
    expect(m.delete(99)).toBe(false);
  });

  it("delete preserves other entries", () => {
    const m = new SparseMap<number>();
    m.set(1, 10);
    m.set(2, 20);
    m.set(3, 30);
    m.delete(2);
    expect(m.get(1)).toBe(10);
    expect(m.has(2)).toBe(false);
    expect(m.get(3)).toBe(30);
    expect(m.size).toBe(2);
  });

  it("delete last entry leaves map empty", () => {
    const m = new SparseMap<number>();
    m.set(5, 55);
    m.delete(5);
    expect(m.size).toBe(0);
    expect(m.has(5)).toBe(false);
  });

  it("can set the same key again after delete", () => {
    const m = new SparseMap<string>();
    m.set(7, "a");
    m.delete(7);
    m.set(7, "b");
    expect(m.get(7)).toBe("b");
    expect(m.size).toBe(1);
  });

  //=========================================================
  // swap-and-pop correctness
  //=========================================================

  it("internal state stays consistent after deleting from the middle", () => {
    const m = new SparseMap<number>();
    for (let i = 0; i < 5; i++) m.set(i, i * 10);
    m.delete(2);
    expect(m.get(0)).toBe(0);
    expect(m.get(1)).toBe(10);
    expect(m.has(2)).toBe(false);
    expect(m.get(3)).toBe(30);
    expect(m.get(4)).toBe(40);
    expect(m.size).toBe(4);
  });

  it("deleting the element swapped in from the last slot", () => {
    const m = new SparseMap<string>();
    m.set(10, "a");
    m.set(20, "b");
    m.set(30, "c");
    // Delete first — 30 swaps into slot 0
    m.delete(10);
    // Now delete 30 (now at slot 0)
    m.delete(30);
    expect(m.has(10)).toBe(false);
    expect(m.get(20)).toBe("b");
    expect(m.has(30)).toBe(false);
    expect(m.size).toBe(1);
  });

  //=========================================================
  // clear
  //=========================================================

  it("clear empties the map", () => {
    const m = new SparseMap<number>();
    m.set(1, 1);
    m.set(2, 2);
    m.set(3, 3);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(false);
    expect(m.has(3)).toBe(false);
  });

  it("can insert after clear", () => {
    const m = new SparseMap<number>();
    m.set(5, 50);
    m.clear();
    m.set(5, 99);
    expect(m.get(5)).toBe(99);
    expect(m.size).toBe(1);
  });

  //=========================================================
  // growth
  //=========================================================

  it("auto-grows when key exceeds initial capacity", () => {
    const m = new SparseMap<number>();
    m.set(1000, 42);
    expect(m.get(1000)).toBe(42);
    expect(m.has(1000)).toBe(true);
  });

  it("existing entries survive a growth", () => {
    const m = new SparseMap<string>();
    m.set(3, "three");
    m.set(5, "five");
    m.set(500, "big"); // triggers growth
    expect(m.get(3)).toBe("three");
    expect(m.get(5)).toBe("five");
    expect(m.get(500)).toBe("big");
  });

  //=========================================================
  // keys / iteration
  //=========================================================

  it("keys exposes the dense key array", () => {
    const m = new SparseMap<number>();
    m.set(1, 10);
    m.set(2, 20);
    m.set(3, 30);
    expect(new Set(m.keys)).toEqual(new Set([1, 2, 3]));
  });

  it("for_each visits all entries", () => {
    const m = new SparseMap<number>();
    m.set(1, 10);
    m.set(2, 20);
    m.set(3, 30);
    const seen = new Map<number, number>();
    m.for_each((k, v) => seen.set(k, v));
    expect(seen.size).toBe(3);
    expect(seen.get(1)).toBe(10);
    expect(seen.get(2)).toBe(20);
    expect(seen.get(3)).toBe(30);
  });

  it("Symbol.iterator yields all [key, value] pairs", () => {
    const m = new SparseMap<string>();
    m.set(10, "x");
    m.set(20, "y");
    const entries = [...m];
    expect(entries.length).toBe(2);
    const map = new Map(entries);
    expect(map.get(10)).toBe("x");
    expect(map.get(20)).toBe("y");
  });

  it("for..of works", () => {
    const m = new SparseMap<number>();
    m.set(7, 70);
    const seen: [number, number][] = [];
    for (const entry of m) seen.push(entry);
    expect(seen).toEqual([[7, 70]]);
  });

  //=========================================================
  // value types
  //=========================================================

  it("stores object values", () => {
    const m = new SparseMap<{ x: number; y: number }>();
    m.set(0, { x: 1, y: 2 });
    m.set(1, { x: 3, y: 4 });
    expect(m.get(0)).toEqual({ x: 1, y: 2 });
    expect(m.get(1)).toEqual({ x: 3, y: 4 });
  });
});
