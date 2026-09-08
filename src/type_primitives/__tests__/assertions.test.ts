import { describe, expect, it } from "vitest";
import {
	assert,
	assertNonNull,
	isNonNegativeInteger,
	isNotNull,
	unsafeCast,
	validateAndCast
} from "../assertions";
import { AssertionError, TYPE_ERROR } from "../error";

describe("assertions", () => {
	//=========================================================
	// isNonNegativeInteger
	//=========================================================

	it("isNonNegativeInteger returns true for zero", () => {
		expect(isNonNegativeInteger(0)).toBe(true);
	});

	it("isNonNegativeInteger returns true for positive integers", () => {
		expect(isNonNegativeInteger(1)).toBe(true);
		expect(isNonNegativeInteger(42)).toBe(true);
		expect(isNonNegativeInteger(999_999)).toBe(true);
	});

	it("isNonNegativeInteger returns false for negative numbers", () => {
		expect(isNonNegativeInteger(-1)).toBe(false);
		expect(isNonNegativeInteger(-100)).toBe(false);
	});

	it("isNonNegativeInteger returns false for non-integer numbers", () => {
		expect(isNonNegativeInteger(1.5)).toBe(false);
		expect(isNonNegativeInteger(0.1)).toBe(false);
		expect(isNonNegativeInteger(NaN)).toBe(false);
		expect(isNonNegativeInteger(Infinity)).toBe(false);
	});

	//=========================================================
	// isNotNull
	//=========================================================

	it("isNotNull returns false for null", () => {
		expect(isNotNull(null)).toBe(false);
	});

	it("isNotNull returns true for undefined", () => {
		// isNotNull only checks !== null, not == null
		expect(isNotNull(undefined)).toBe(true);
	});

	it("isNotNull returns true for non-null values", () => {
		expect(isNotNull(0)).toBe(true);
		expect(isNotNull("")).toBe(true);
		expect(isNotNull(false)).toBe(true);
		expect(isNotNull({})).toBe(true);
	});

	//=========================================================
	// assertNonNull
	//=========================================================

	it("assertNonNull does not throw for a defined value", () => {
		expect(() => assertNonNull(42)).not.toThrow();
		expect(() => assertNonNull("hello")).not.toThrow();
		expect(() => assertNonNull(0)).not.toThrow();
		expect(() => assertNonNull(false)).not.toThrow();
		expect(() => assertNonNull("")).not.toThrow();
	});

	it("assertNonNull throws AssertionError for null", () => {
		expect(() => assertNonNull(null)).toThrow(AssertionError);
	});

	it("assertNonNull throws AssertionError for undefined", () => {
		expect(() => assertNonNull(undefined)).toThrow(AssertionError);
	});

	it("assertNonNull error has ASSERTION_FAIL_NON_NULLABLE category", () => {
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

	it("validateAndCast returns the value when validation passes", () => {
		const result = validateAndCast(42, (v) => Number.isInteger(v) && v > 0, "positive integer");
		expect(result).toBe(42);
	});

	it("validateAndCast throws AssertionError when validation fails", () => {
		expect(() => validateAndCast(-1, (v) => v > 0, "positive number")).toThrow(AssertionError);
	});

	it("validateAndCast error has VALIDATION_FAIL_CONDITION category", () => {
		try {
			validateAndCast(-1, (v) => v > 0, "positive number");
		} catch (e) {
			expect(e).toBeInstanceOf(AssertionError);
			expect((e as AssertionError).category).toBe(TYPE_ERROR.VALIDATION_FAIL_CONDITION);
		}
	});

	it("validateAndCast error message includes the provided description", () => {
		try {
			validateAndCast(-1, (v) => v > 0, "positive number");
		} catch (e) {
			expect((e as AssertionError).message).toContain("positive number");
		}
	});

	//=========================================================
	// unsafeCast
	//=========================================================

	it("unsafeCast returns the same value unchanged", () => {
		const value = 42;
		const result = unsafeCast<number>(value);
		expect(result).toBe(42);
	});

	it("unsafeCast returns the same reference for objects", () => {
		const obj = { x: 1 };
		const result = unsafeCast<{ x: number }>(obj);
		expect(result).toBe(obj);
	});

	it("unsafeCast passes through null and undefined", () => {
		expect(unsafeCast<string>(null)).toBeNull();
		expect(unsafeCast<string>(undefined)).toBeUndefined();
	});
});
