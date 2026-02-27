import { describe, expect, it } from "vitest";
import { AppError } from "utils/error";
import { ECSError, ECS_ERROR, is_ecs_error } from "../error";

describe("ECSError", () => {
  //=========================================================
  // Construction & properties
  //=========================================================

  it("stores the category", () => {
    const err = new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    expect(err.category).toBe(ECS_ERROR.ENTITY_NOT_ALIVE);
  });

  it("uses category as default message when message is omitted", () => {
    const err = new ECSError(ECS_ERROR.COMPONENT_NOT_REGISTERED);
    expect(err.message).toBe(ECS_ERROR.COMPONENT_NOT_REGISTERED);
  });

  it("uses provided message when given", () => {
    const err = new ECSError(
      ECS_ERROR.EID_MAX_INDEX_OVERFLOW,
      "index exceeded limit",
    );
    expect(err.message).toBe("index exceeded limit");
  });

  it("is always operational", () => {
    const err = new ECSError(ECS_ERROR.ARCHETYPE_NOT_FOUND);
    expect(err.is_operational).toBe(true);
  });

  it("context is undefined when not provided", () => {
    const err = new ECSError(ECS_ERROR.DUPLICATE_SYSTEM);
    expect(err.context).toBeUndefined();
  });

  it("stores provided context", () => {
    const ctx = { system: "physics", phase: "init" };
    const err = new ECSError(ECS_ERROR.DUPLICATE_SYSTEM, "dup", ctx);
    expect(err.context).toEqual({ system: "physics", phase: "init" });
  });

  it("sets name to ECSError", () => {
    const err = new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    expect(err.name).toBe("ECSError");
  });

  //=========================================================
  // Inheritance
  //=========================================================

  it("is an instance of AppError", () => {
    const err = new ECSError(ECS_ERROR.RESOURCE_NOT_REGISTERED);
    expect(err).toBeInstanceOf(AppError);
  });

  it("is an instance of Error", () => {
    const err = new ECSError(ECS_ERROR.RESOURCE_NOT_REGISTERED);
    expect(err).toBeInstanceOf(Error);
  });

  //=========================================================
  // ECS_ERROR enum values
  //=========================================================

  it("all ECS_ERROR enum members are distinct strings", () => {
    const values = Object.values(ECS_ERROR);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  //=========================================================
  // is_ecs_error guard
  //=========================================================

  it("is_ecs_error returns true for ECSError instances", () => {
    const err = new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    expect(is_ecs_error(err)).toBe(true);
  });

  it("is_ecs_error returns false for plain Error", () => {
    const err = new Error("plain");
    expect(is_ecs_error(err)).toBe(false);
  });

  it("is_ecs_error returns false for non-error values", () => {
    expect(is_ecs_error(null)).toBe(false);
    expect(is_ecs_error(undefined)).toBe(false);
    expect(is_ecs_error("string")).toBe(false);
    expect(is_ecs_error(42)).toBe(false);
    expect(is_ecs_error({})).toBe(false);
  });
});
