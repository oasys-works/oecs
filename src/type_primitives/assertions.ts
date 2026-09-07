/***
 * Assertions. Dev-only runtime validation and branded casting.
 *
 * Every check but `assertNever` is guarded by DEV and tree-shaken in a
 * production build. `validateAndCast` is the primary tool for creating branded
 * ids: it validates the input in dev and returns the value as the branded type.
 * `unsafeCast` bypasses every check, for a caller that guarantees validity.
 *
 ***/

import { TYPE_ERROR, AssertionError } from "./error";
import { DEV } from "../dev_flag";

export const isNonNegativeInteger = (v: number): boolean => Number.isInteger(v) && v >= 0;

export const isNotNull = (v: unknown): boolean => v !== null;

export function assertNonNull<T>(value: T): asserts value is NonNullable<T> {
	// Loose `==` on purpose. It is true for null and for undefined, and one
	// comparison covers both.
	if (DEV && value == null)
		throw new AssertionError(
			TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE,
			"value must not be null or undefined"
		);
}

export function assert<T, Result extends T = T>(
	value: T,
	condition: (v: T) => v is Result,
	errMessage: string
): asserts value is Result {
	if (DEV && !condition(value)) {
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
	if (DEV && !validator(value)) {
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

/**
 * Exhaustiveness backstop for tagged-union dispatches. Put it in the
 * `default` arm (or after the final `case`) of a switch over a closed union.
 * The `never` parameter makes "a union gained a variant but this dispatch
 * didn't" a compile error at the call site. The throw catches runtime values
 * that bypassed the type layer, such as deserialized and foreign data.
 *
 * Deliberately not `DEV`-gated, unlike the rest of this file: it marks a
 * can't-happen branch, so it costs nothing until the day it fires, and that
 * day it must fire in production too, not silently fall through.
 */
export function assertNever(value: never, label: string): never {
	throw new AssertionError(
		TYPE_ERROR.ASSERTION_FAIL_UNREACHABLE,
		`Unhandled ${label}: ${String(value)}`
	);
}
