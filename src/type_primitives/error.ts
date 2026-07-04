/***
 * Type errors — Validation and assertion failure errors.
 *
 * Separate from ECSError so type-primitive assertions don't depend
 * on the ECS error hierarchy.
 *
 ***/

import { AppError } from "../utils/error";

export enum TYPE_ERROR {
	ASSERTION_FAIL_CONDITION = "ASSERTION_FAIL_CONDITION",
	VALIDATION_FAIL_CONDITION = "VALIDATION_FAIL_CONDITION",
	ASSERTION_FAIL_NON_NULLABLE = "ASSERTION_FAIL_NON_NULLABLE"
}

/**
 * Error class thrown by std's runtime assertions. Non-operational.
 *
 */
export class AssertionError extends AppError {
	constructor(
		public readonly category: TYPE_ERROR,
		message: string,
		context?: Record<string, unknown>
	) {
		super(message, false, context);
	}
}
