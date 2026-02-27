import { describe, expect, it } from "vitest";
import {
  assert,
  is_non_negative_integer,
  is_non_null,
  unsafe_cast,
  validate_and_cast,
} from "../assertions";
import { TypeError, TYPE_ERROR } from "../error";

describe("assertions", () => {
  //=========================================================
  // is_non_negative_integer
  //=========================================================

  it("is_non_negative_integer returns true for zero", () => {
    expect(is_non_negative_integer(0)).toBe(true);
  });

  it("is_non_negative_integer returns true for positive integers", () => {
    expect(is_non_negative_integer(1)).toBe(true);
    expect(is_non_negative_integer(42)).toBe(true);
    expect(is_non_negative_integer(999_999)).toBe(true);
  });

  it("is_non_negative_integer returns false for negative numbers", () => {
    expect(is_non_negative_integer(-1)).toBe(false);
    expect(is_non_negative_integer(-100)).toBe(false);
  });

  it("is_non_negative_integer returns false for non-integer numbers", () => {
    expect(is_non_negative_integer(1.5)).toBe(false);
    expect(is_non_negative_integer(0.1)).toBe(false);
    expect(is_non_negative_integer(NaN)).toBe(false);
    expect(is_non_negative_integer(Infinity)).toBe(false);
  });

  //=========================================================
  // is_non_null
  //=========================================================

  it("is_non_null returns false for null", () => {
    expect(is_non_null(null)).toBe(false);
  });

  it("is_non_null returns true for undefined", () => {
    // is_non_null only checks !== null, not == null
    expect(is_non_null(undefined)).toBe(true);
  });

  it("is_non_null returns true for non-null values", () => {
    expect(is_non_null(0)).toBe(true);
    expect(is_non_null("")).toBe(true);
    expect(is_non_null(false)).toBe(true);
    expect(is_non_null({})).toBe(true);
  });

  //=========================================================
  // assert
  //=========================================================

  it("assert does not throw when condition passes", () => {
    const is_positive = (v: number): v is number => v > 0;
    expect(() => assert(5, is_positive, "must be positive")).not.toThrow();
  });

  it("assert throws TypeError when condition fails", () => {
    const is_positive = (v: number): v is number => v > 0;
    expect(() => assert(-1, is_positive, "must be positive")).toThrow(
      TypeError,
    );
  });

  it("assert error has ASSERTION_FAIL_CONDITION category", () => {
    const is_positive = (v: number): v is number => v > 0;
    try {
      assert(-1, is_positive, "must be positive");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as TypeError).category).toBe(
        TYPE_ERROR.ASSERTION_FAIL_CONDITION,
      );
    }
  });

  it("assert error message includes the provided description", () => {
    const is_positive = (v: number): v is number => v > 0;
    try {
      assert(-1, is_positive, "must be positive");
    } catch (e) {
      expect((e as TypeError).message).toContain("must be positive");
    }
  });

  //=========================================================
  // validate_and_cast
  //=========================================================

  it("validate_and_cast returns the value when validation passes", () => {
    const result = validate_and_cast(
      42,
      (v) => Number.isInteger(v) && v > 0,
      "positive integer",
    );
    expect(result).toBe(42);
  });

  it("validate_and_cast throws TypeError when validation fails", () => {
    expect(() =>
      validate_and_cast(-1, (v) => v > 0, "positive number"),
    ).toThrow(TypeError);
  });

  it("validate_and_cast error has VALIDATION_FAIL_CONDITION category", () => {
    try {
      validate_and_cast(-1, (v) => v > 0, "positive number");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as TypeError).category).toBe(
        TYPE_ERROR.VALIDATION_FAIL_CONDITION,
      );
    }
  });

  it("validate_and_cast error message includes the provided description", () => {
    try {
      validate_and_cast(-1, (v) => v > 0, "positive number");
    } catch (e) {
      expect((e as TypeError).message).toContain("positive number");
    }
  });

  //=========================================================
  // unsafe_cast
  //=========================================================

  it("unsafe_cast returns the same value unchanged", () => {
    const value = 42;
    const result = unsafe_cast<number>(value);
    expect(result).toBe(42);
  });

  it("unsafe_cast returns the same reference for objects", () => {
    const obj = { x: 1 };
    const result = unsafe_cast<{ x: number }>(obj);
    expect(result).toBe(obj);
  });

  it("unsafe_cast passes through null and undefined", () => {
    expect(unsafe_cast<string>(null)).toBeNull();
    expect(unsafe_cast<string>(undefined)).toBeUndefined();
  });
});
