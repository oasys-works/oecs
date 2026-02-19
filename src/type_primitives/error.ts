/***
 * Type errors — Validation and assertion failure errors.
 *
 * Separate from ECSError so type-primitive assertions don't depend
 * on the ECS error hierarchy.
 *
 ***/

import { AppError } from "utils/error";

export enum TYPE_ERROR {
  ASSERTION_FAIL_CONDITION = "ASSERTION_FAIL_CONDITION",
  VALIDATION_FAIL_CONDITION = "VALIDATION_FAIL_CONDITION",
}

export class TypeError extends AppError {
  constructor(
    public readonly category: TYPE_ERROR,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, false, context);
  }
}
