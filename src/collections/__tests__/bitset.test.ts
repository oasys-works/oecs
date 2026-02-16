import { describe, expect, it } from "vitest";
import { BitSet } from "../bitset";

describe("BitSet", () => {
  //=========================================================
  // has / set / clear
  //=========================================================

  it("has returns false on empty bitset", () => {
    const bs = new BitSet();
    expect(bs.has(0)).toBe(false);
    expect(bs.has(31)).toBe(false);
    expect(bs.has(32)).toBe(false);
    expect(bs.has(127)).toBe(false);
  });

  it("set and has round-trip", () => {
    const bs = new BitSet();
    bs.set(0);
    bs.set(5);
    bs.set(31);
    bs.set(32);
    bs.set(63);

    expect(bs.has(0)).toBe(true);
    expect(bs.has(5)).toBe(true);
    expect(bs.has(31)).toBe(true);
    expect(bs.has(32)).toBe(true);
    expect(bs.has(63)).toBe(true);

    expect(bs.has(1)).toBe(false);
    expect(bs.has(6)).toBe(false);
    expect(bs.has(30)).toBe(false);
    expect(bs.has(33)).toBe(false);
  });

  it("clear removes a bit", () => {
    const bs = new BitSet();
    bs.set(10);
    expect(bs.has(10)).toBe(true);

    bs.clear(10);
    expect(bs.has(10)).toBe(false);
  });

  it("clear on unset bit is a no-op", () => {
    const bs = new BitSet();
    bs.clear(42);
    expect(bs.has(42)).toBe(false);
  });

  //=========================================================
  // Auto-grow
  //=========================================================

  it("auto-grows when setting bits beyond initial capacity", () => {
    const bs = new BitSet();
    bs.set(200);
    expect(bs.has(200)).toBe(true);
    expect(bs.has(199)).toBe(false);
  });

  it("has returns false for out-of-range bits without growing", () => {
    const bs = new BitSet();
    expect(bs.has(9999)).toBe(false);
  });

  //=========================================================
  // contains (superset check)
  //=========================================================

  it("empty contains empty", () => {
    const a = new BitSet();
    const b = new BitSet();
    expect(a.contains(b)).toBe(true);
  });

  it("non-empty contains empty", () => {
    const a = new BitSet();
    a.set(1);
    const b = new BitSet();
    expect(a.contains(b)).toBe(true);
  });

  it("superset contains subset", () => {
    const a = new BitSet();
    a.set(1);
    a.set(2);
    a.set(3);

    const b = new BitSet();
    b.set(1);
    b.set(3);

    expect(a.contains(b)).toBe(true);
  });

  it("subset does not contain superset", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(1);
    b.set(2);

    expect(a.contains(b)).toBe(false);
  });

  it("disjoint sets do not contain each other", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(2);

    expect(a.contains(b)).toBe(false);
    expect(b.contains(a)).toBe(false);
  });

  it("contains works across word boundaries", () => {
    const a = new BitSet();
    a.set(0);
    a.set(33);
    a.set(65);

    const b = new BitSet();
    b.set(0);
    b.set(65);

    expect(a.contains(b)).toBe(true);
  });

  it("contains returns false when other has bits in higher words", () => {
    const a = new BitSet();
    a.set(0);

    const b = new BitSet();
    b.set(0);
    b.set(200);

    expect(a.contains(b)).toBe(false);
  });

  //=========================================================
  // equals
  //=========================================================

  it("two empty bitsets are equal", () => {
    expect(new BitSet().equals(new BitSet())).toBe(true);
  });

  it("same bits are equal", () => {
    const a = new BitSet();
    a.set(1);
    a.set(5);

    const b = new BitSet();
    b.set(1);
    b.set(5);

    expect(a.equals(b)).toBe(true);
  });

  it("different bits are not equal", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(2);

    expect(a.equals(b)).toBe(false);
  });

  it("equals handles different-sized backing arrays", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(1);
    b.set(200); // forces grow
    b.clear(200);

    // Same logical bits despite different _words lengths
    expect(a.equals(b)).toBe(true);
  });

  //=========================================================
  // copy / copy_with_set / copy_with_clear
  //=========================================================

  it("copy creates an independent clone", () => {
    const a = new BitSet();
    a.set(3);
    a.set(7);

    const b = a.copy();
    expect(b.has(3)).toBe(true);
    expect(b.has(7)).toBe(true);

    b.set(10);
    expect(a.has(10)).toBe(false);
  });

  it("copy_with_set returns a new bitset with the bit added", () => {
    const a = new BitSet();
    a.set(1);

    const b = a.copy_with_set(5);
    expect(b.has(1)).toBe(true);
    expect(b.has(5)).toBe(true);
    expect(a.has(5)).toBe(false);
  });

  it("copy_with_set auto-grows the copy if needed", () => {
    const a = new BitSet();
    a.set(0);

    const b = a.copy_with_set(200);
    expect(b.has(0)).toBe(true);
    expect(b.has(200)).toBe(true);
  });

  it("copy_with_clear returns a new bitset with the bit removed", () => {
    const a = new BitSet();
    a.set(1);
    a.set(5);

    const b = a.copy_with_clear(5);
    expect(b.has(1)).toBe(true);
    expect(b.has(5)).toBe(false);
    expect(a.has(5)).toBe(true);
  });

  //=========================================================
  // hash
  //=========================================================

  it("equal bitsets produce equal hashes", () => {
    const a = new BitSet();
    a.set(1);
    a.set(33);

    const b = new BitSet();
    b.set(1);
    b.set(33);

    expect(a.hash()).toBe(b.hash());
  });

  it("different bitsets usually produce different hashes", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(2);

    expect(a.hash()).not.toBe(b.hash());
  });

  it("hash is consistent regardless of trailing zeros from different-length arrays", () => {
    const a = new BitSet();
    a.set(1);

    const b = new BitSet();
    b.set(1);
    b.set(200);
    b.clear(200);

    expect(a.hash()).toBe(b.hash());
  });

  //=========================================================
  // for_each
  //=========================================================

  it("for_each iterates no bits on empty bitset", () => {
    const bs = new BitSet();
    const bits: number[] = [];
    bs.for_each((b) => bits.push(b));
    expect(bits).toEqual([]);
  });

  it("for_each iterates all set bits in order", () => {
    const bs = new BitSet();
    bs.set(0);
    bs.set(3);
    bs.set(31);
    bs.set(32);
    bs.set(64);

    const bits: number[] = [];
    bs.for_each((b) => bits.push(b));
    expect(bits).toEqual([0, 3, 31, 32, 64]);
  });

  it("for_each handles bits across multiple words", () => {
    const bs = new BitSet();
    bs.set(1);
    bs.set(33);
    bs.set(65);
    bs.set(97);

    const bits: number[] = [];
    bs.for_each((b) => bits.push(b));
    expect(bits).toEqual([1, 33, 65, 97]);
  });
});
