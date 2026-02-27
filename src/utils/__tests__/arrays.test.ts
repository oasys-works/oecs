import { describe, expect, it } from "vitest";
import { bucket_push } from "../arrays";

describe("bucket_push", () => {
  //=========================================================
  // Creating new buckets
  //=========================================================

  it("creates a new bucket when key does not exist", () => {
    const map = new Map<number, number[]>();
    bucket_push(map, 1, 100);

    expect(map.get(1)).toEqual([100]);
  });

  it("creates separate buckets for different keys", () => {
    const map = new Map<number, number[]>();
    bucket_push(map, 1, 10);
    bucket_push(map, 2, 20);

    expect(map.get(1)).toEqual([10]);
    expect(map.get(2)).toEqual([20]);
  });

  //=========================================================
  // Pushing into existing buckets
  //=========================================================

  it("appends to an existing bucket", () => {
    const map = new Map<number, number[]>();
    bucket_push(map, 1, 10);
    bucket_push(map, 1, 20);
    bucket_push(map, 1, 30);

    expect(map.get(1)).toEqual([10, 20, 30]);
  });

  it("preserves insertion order within a bucket", () => {
    const map = new Map<number, string[]>();
    bucket_push(map, 0, "a");
    bucket_push(map, 0, "b");
    bucket_push(map, 0, "c");

    const bucket = map.get(0)!;
    expect(bucket[0]).toBe("a");
    expect(bucket[1]).toBe("b");
    expect(bucket[2]).toBe("c");
  });

  //=========================================================
  // Edge cases
  //=========================================================

  it("handles key 0", () => {
    const map = new Map<number, number[]>();
    bucket_push(map, 0, 42);

    expect(map.get(0)).toEqual([42]);
  });

  it("does not affect other buckets when pushing", () => {
    const map = new Map<number, number[]>();
    bucket_push(map, 1, 10);
    bucket_push(map, 2, 20);
    bucket_push(map, 1, 30);

    expect(map.get(1)).toEqual([10, 30]);
    expect(map.get(2)).toEqual([20]);
  });

  it("returns void", () => {
    const map = new Map<number, number[]>();
    const result = bucket_push(map, 1, 10);

    expect(result).toBeUndefined();
  });
});
