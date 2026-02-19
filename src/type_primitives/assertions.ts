/***
 * Assertions — Dev-only runtime validation and branded casting.
 *
 * All checks are guarded by __DEV__ and tree-shaken in production builds.
 * validate_and_cast is the primary tool for creating branded IDs:
 * it validates the input in dev and returns the value as the branded type.
 * unsafe_cast bypasses all checks (used when the caller guarantees validity).
 *
 ***/

import { TYPE_ERROR, TypeError } from "./error";

export const is_non_negative_integer = (v: number): boolean =>
  Number.isInteger(v) && v >= 0;

export function assert<T, Result extends T = T>(
  value: T,
  condition: (v: T) => v is Result,
  err_message: string,
): asserts value is Result {
  if (__DEV__ && !condition(value)) {
    throw new TypeError(
      TYPE_ERROR.ASSERTION_FAIL_CONDITION,
      `Expected value to meet condition: ${err_message}`,
    );
  }
}

export function validate_and_cast<T, Result extends T = T>(
  value: T,
  validator: (v: T) => boolean,
  err_message: string,
): Result {
  if (__DEV__ && !validator(value)) {
    throw new TypeError(
      TYPE_ERROR.VALIDATION_FAIL_CONDITION,
      `Expected value to meet validation: ${err_message}`,
    );
  }
  return value as Result;
}

export function unsafe_cast<T>(value: unknown): T {
  return value as T;
}
