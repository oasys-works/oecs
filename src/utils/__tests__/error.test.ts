import { describe, expect, it } from "vitest";
import { AppError } from "../error";

// `AppError` is abstract; exercise it through a minimal concrete subclass.
// (The ECS-specific `ECSError` is tested next to its definition in
// `core/ecs/utils/__tests__/error.test.ts`.)
class TestError extends AppError {
  constructor(message: string, isOperational = true, context?: Record<string, unknown>) {
    super(message, isOperational, context);
  }
}

describe("AppError", () => {
  //=========================================================
  // Construction & properties
  //=========================================================

  it("stores the message", () => {
    const err = new TestError("boom");
    expect(err.message).toBe("boom");
  });

  it("stores the operational flag", () => {
    expect(new TestError("a", true).isOperational).toBe(true);
    expect(new TestError("b", false).isOperational).toBe(false);
  });

  it("context is undefined when not provided", () => {
    const err = new TestError("a");
    expect(err.context).toBeUndefined();
  });

  it("stores provided context", () => {
    const ctx = { system: "physics", phase: "init" };
    const err = new TestError("dup", true, ctx);
    expect(err.context).toEqual({ system: "physics", phase: "init" });
  });

  it("sets name to the concrete subclass name", () => {
    const err = new TestError("a");
    expect(err.name).toBe("TestError");
  });

  //=========================================================
  // Inheritance
  //=========================================================

  it("is an instance of AppError", () => {
    expect(new TestError("a")).toBeInstanceOf(AppError);
  });

  it("is an instance of Error", () => {
    expect(new TestError("a")).toBeInstanceOf(Error);
  });
});
