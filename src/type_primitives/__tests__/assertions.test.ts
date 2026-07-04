import { describe, expect, it } from "vitest";
import {
  assert,
  assertNonNull,
  isNonNegativeInteger,
  isNonNull,
  unsafeCast,
  validateAndCast,
} from "../assertions";
import { AssertionError, TYPE_ERROR } from "../error";

describe("assertions", () => {
  //=========================================================
  // isNonNegativeInteger
  //=========================================================

  it("is_non_negative_integer returns true for zero", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
  });

  it("is_non_negative_integer returns true for positive integers", () => {
    expect(isNonNegativeInteger(1)).toBe(true);
    expect(isNonNegativeInteger(42)).toBe(true);
    expect(isNonNegativeInteger(999_999)).toBe(true);
  });

  it("is_non_negative_integer returns false for negative numbers", () => {
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(-100)).toBe(false);
  });

  it("is_non_negative_integer returns false for non-integer numbers", () => {
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(0.1)).toBe(false);
    expect(isNonNegativeInteger(NaN)).toBe(false);
    expect(isNonNegativeInteger(Infinity)).toBe(false);
  });

  //=========================================================
  // isNonNull
  //=========================================================

  it("is_non_null returns false for null", () => {
    expect(isNonNull(null)).toBe(false);
  });

  it("is_non_null returns true for undefined", () => {
    // isNonNull only checks !== null, not == null
    expect(isNonNull(undefined)).toBe(true);
  });

  it("is_non_null returns true for non-null values", () => {
    expect(isNonNull(0)).toBe(true);
    expect(isNonNull("")).toBe(true);
    expect(isNonNull(false)).toBe(true);
    expect(isNonNull({})).toBe(true);
  });

  //=========================================================
  // assertNonNull
  //=========================================================

  it("assert_non_null does not throw for a defined value", () => {
    expect(() => assertNonNull(42)).not.toThrow();
    expect(() => assertNonNull("hello")).not.toThrow();
    expect(() => assertNonNull(0)).not.toThrow();
    expect(() => assertNonNull(false)).not.toThrow();
    expect(() => assertNonNull("")).not.toThrow();
  });

  it("assert_non_null throws AssertionError for null", () => {
    expect(() => assertNonNull(null)).toThrow(AssertionError);
  });

  it("assert_non_null throws AssertionError for undefined", () => {
    expect(() => assertNonNull(undefined)).toThrow(AssertionError);
  });

  it("assert_non_null error has ASSERTION_FAIL_NON_NULLABLE category", () => {
    try {
      assertNonNull(null);
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
      expect((e as AssertionError).category).toBe(TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE);
    }
  });

  //=========================================================
  // assert
  //=========================================================

  it("assert does not throw when condition passes", () => {
    const isPositive = (v: number): v is number => v > 0;
    expect(() => assert(5, isPositive, "must be positive")).not.toThrow();
  });

  it("assert throws AssertionError when condition fails", () => {
    const isPositive = (v: number): v is number => v > 0;
    expect(() => assert(-1, isPositive, "must be positive")).toThrow(AssertionError);
  });

  it("assert error has ASSERTION_FAIL_CONDITION category", () => {
    const isPositive = (v: number): v is number => v > 0;
    try {
      assert(-1, isPositive, "must be positive");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
      expect((e as AssertionError).category).toBe(TYPE_ERROR.ASSERTION_FAIL_CONDITION);
    }
  });

  it("assert error message includes the provided description", () => {
    const isPositive = (v: number): v is number => v > 0;
    try {
      assert(-1, isPositive, "must be positive");
    } catch (e) {
      expect((e as AssertionError).message).toContain("must be positive");
    }
  });

  //=========================================================
  // validateAndCast
  //=========================================================

  it("validate_and_cast returns the value when validation passes", () => {
    const result = validateAndCast(42, (v) => Number.isInteger(v) && v > 0, "positive integer");
    expect(result).toBe(42);
  });

  it("validate_and_cast throws AssertionError when validation fails", () => {
    expect(() => validateAndCast(-1, (v) => v > 0, "positive number")).toThrow(AssertionError);
  });

  it("validate_and_cast error has VALIDATION_FAIL_CONDITION category", () => {
    try {
      validateAndCast(-1, (v) => v > 0, "positive number");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
      expect((e as AssertionError).category).toBe(TYPE_ERROR.VALIDATION_FAIL_CONDITION);
    }
  });

  it("validate_and_cast error message includes the provided description", () => {
    try {
      validateAndCast(-1, (v) => v > 0, "positive number");
    } catch (e) {
      expect((e as AssertionError).message).toContain("positive number");
    }
  });

  //=========================================================
  // unsafeCast
  //=========================================================

  it("unsafe_cast returns the same value unchanged", () => {
    const value = 42;
    const result = unsafeCast<number>(value);
    expect(result).toBe(42);
  });

  it("unsafe_cast returns the same reference for objects", () => {
    const obj = { x: 1 };
    const result = unsafeCast<{ x: number }>(obj);
    expect(result).toBe(obj);
  });

  it("unsafe_cast passes through null and undefined", () => {
    expect(unsafeCast<string>(null)).toBeNull();
    expect(unsafeCast<string>(undefined)).toBeUndefined();
  });
});
