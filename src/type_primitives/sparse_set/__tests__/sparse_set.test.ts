import { describe, expect, it } from "vitest";
import { SparseSet } from "../sparse_set";

describe("SparseSet", () => {
  //=========================================================
  // has / add
  //=========================================================

  it("empty set has nothing", () => {
    const s = new SparseSet();
    expect(s.has(0)).toBe(false);
    expect(s.has(10)).toBe(false);
    expect(s.has(1000)).toBe(false);
  });

  it("add and has round-trip", () => {
    const s = new SparseSet();
    s.add(3);
    s.add(7);
    s.add(42);
    expect(s.has(3)).toBe(true);
    expect(s.has(7)).toBe(true);
    expect(s.has(42)).toBe(true);
    expect(s.has(1)).toBe(false);
    expect(s.has(6)).toBe(false);
  });

  it("add is idempotent — duplicate add does not change size", () => {
    const s = new SparseSet();
    s.add(5);
    s.add(5);
    expect(s.size).toBe(1);
    expect(s.has(5)).toBe(true);
  });

  it("size reflects element count", () => {
    const s = new SparseSet();
    expect(s.size).toBe(0);
    s.add(0);
    expect(s.size).toBe(1);
    s.add(1);
    expect(s.size).toBe(2);
  });

  //=========================================================
  // delete
  //=========================================================

  it("delete removes the key", () => {
    const s = new SparseSet();
    s.add(10);
    expect(s.delete(10)).toBe(true);
    expect(s.has(10)).toBe(false);
    expect(s.size).toBe(0);
  });

  it("delete returns false for absent key", () => {
    const s = new SparseSet();
    expect(s.delete(99)).toBe(false);
  });

  it("delete preserves other members", () => {
    const s = new SparseSet();
    s.add(1);
    s.add(2);
    s.add(3);
    s.delete(2);
    expect(s.has(1)).toBe(true);
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(true);
    expect(s.size).toBe(2);
  });

  it("delete last element leaves set empty", () => {
    const s = new SparseSet();
    s.add(5);
    s.delete(5);
    expect(s.size).toBe(0);
    expect(s.has(5)).toBe(false);
  });

  it("delete can be called again on same key after re-adding", () => {
    const s = new SparseSet();
    s.add(7);
    s.delete(7);
    s.add(7);
    expect(s.has(7)).toBe(true);
    expect(s.size).toBe(1);
  });

  //=========================================================
  // swap-and-pop correctness
  //=========================================================

  it("internal sparse map stays consistent after deletion", () => {
    const s = new SparseSet();
    // Add keys 0..4
    for (let i = 0; i < 5; i++) s.add(i);
    // Delete middle element
    s.delete(2);
    // All remaining keys should be reachable
    expect(s.has(0)).toBe(true);
    expect(s.has(1)).toBe(true);
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(true);
    expect(s.has(4)).toBe(true);
    expect(s.size).toBe(4);
  });

  it("delete the element that was swapped in from the last slot", () => {
    const s = new SparseSet();
    s.add(10);
    s.add(20);
    s.add(30);
    // Delete first — 30 swaps into slot 0
    s.delete(10);
    // Now delete 30 (now at slot 0)
    s.delete(30);
    expect(s.has(10)).toBe(false);
    expect(s.has(20)).toBe(true);
    expect(s.has(30)).toBe(false);
    expect(s.size).toBe(1);
  });

  //=========================================================
  // clear
  //=========================================================

  it("clear empties the set", () => {
    const s = new SparseSet();
    s.add(1);
    s.add(2);
    s.add(3);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(false);
  });

  it("can add elements after clear", () => {
    const s = new SparseSet();
    s.add(5);
    s.clear();
    s.add(5);
    expect(s.has(5)).toBe(true);
    expect(s.size).toBe(1);
  });

  //=========================================================
  // growth
  //=========================================================

  it("auto-grows when key exceeds initial capacity", () => {
    const s = new SparseSet();
    s.add(1000);
    expect(s.has(1000)).toBe(true);
    expect(s.size).toBe(1);
  });

  it("previous members survive a growth", () => {
    const s = new SparseSet();
    s.add(3);
    s.add(5);
    s.add(500); // triggers growth
    expect(s.has(3)).toBe(true);
    expect(s.has(5)).toBe(true);
    expect(s.has(500)).toBe(true);
  });

  it("has returns false for out-of-bounds key without growing", () => {
    const s = new SparseSet();
    expect(s.has(999)).toBe(false);
    expect(s.size).toBe(0);
  });

  //=========================================================
  // values / iteration
  //=========================================================

  it("values exposes the dense array", () => {
    const s = new SparseSet();
    s.add(1);
    s.add(2);
    s.add(3);
    expect(new Set(s.values)).toEqual(new Set([1, 2, 3]));
  });

  it("Symbol.iterator iterates all members", () => {
    const s = new SparseSet();
    s.add(10);
    s.add(20);
    s.add(30);
    expect(new Set([...s])).toEqual(new Set([10, 20, 30]));
  });

  it("for..of works", () => {
    const s = new SparseSet();
    s.add(7);
    s.add(14);
    const seen: number[] = [];
    for (const k of s) seen.push(k);
    expect(new Set(seen)).toEqual(new Set([7, 14]));
  });
});
