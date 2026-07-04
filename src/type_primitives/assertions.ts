/***
 * Assertions — Dev-only runtime validation and branded casting.
 *
 * All checks are guarded by __DEV__ and tree-shaken in production builds.
 * validateAndCast is the primary tool for creating branded IDs:
 * it validates the input in dev and returns the value as the branded type.
 * unsafeCast bypasses all checks (used when the caller guarantees validity).
 *
 ***/

import { TYPE_ERROR, AssertionError } from "./error";

export const isNonNegativeInteger = (v: number): boolean => Number.isInteger(v) && v >= 0;

export const isNonNull = (v: unknown): boolean => v !== null;

/**
 * Dev-only assertion that value is not null/undefined.
 *
 */
export function assertNonNull<T>(value: T): asserts value is NonNullable<T> {
	//
	// Checks if value is not null or undefined
	// value == null is true for both value == null and value == undefined
	//
	if (__DEV__ && value == null)
		throw new AssertionError(
			TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE,
			"Expected type to be not NULL or UNDEFINED"
		);
}

export function assert<T, Result extends T = T>(
	value: T,
	condition: (v: T) => v is Result,
	errMessage: string
): asserts value is Result {
	if (__DEV__ && !condition(value)) {
		throw new AssertionError(
			TYPE_ERROR.ASSERTION_FAIL_CONDITION,
			`Expected value to meet condition: ${errMessage}`
		);
	}
}

export function validateAndCast<T, Result extends T = T>(
	value: T,
	validator: (v: T) => boolean,
	errMessage: string
): Result {
	if (__DEV__ && !validator(value)) {
		throw new AssertionError(
			TYPE_ERROR.VALIDATION_FAIL_CONDITION,
			`Expected value to meet validation: ${errMessage}`
		);
	}
	return value as Result;
}

export function unsafeCast<T>(value: unknown): T {
	return value as T;
}
