/**
 * `ECSError` — the ECS-domain `AppError` subclass, tested next to its
 * definition. The base-class (`AppError`) behaviour is covered by
 * `src/utils/__tests__/error.test.ts`; this file exercises only the
 * ECS-specific surface: the `ECS_ERROR` category, its default-message
 * behaviour, the always-operational contract, the `name`, the enum's
 * distinctness, and the `isEcsError` guard.
 */

import { describe, expect, it } from "vitest";
import { ECSError, ECS_ERROR, isEcsError } from "../error";

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
		const err = new ECSError(ECS_ERROR.EID_MAX_INDEX_OVERFLOW, "index exceeded limit");
		expect(err.message).toBe("index exceeded limit");
	});

	it("is always operational", () => {
		const err = new ECSError(ECS_ERROR.ARCHETYPE_NOT_FOUND);
		expect(err.isOperational).toBe(true);
	});

	it("sets name to ECSError", () => {
		const err = new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		expect(err.name).toBe("ECSError");
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
	// isEcsError guard
	//=========================================================

	it("isEcsError returns true for ECSError instances", () => {
		const err = new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
		expect(isEcsError(err)).toBe(true);
	});

	it("isEcsError returns false for plain Error", () => {
		const err = new Error("plain");
		expect(isEcsError(err)).toBe(false);
	});

	it("isEcsError returns false for non-error values", () => {
		expect(isEcsError(null)).toBe(false);
		expect(isEcsError(undefined)).toBe(false);
		expect(isEcsError("string")).toBe(false);
		expect(isEcsError(42)).toBe(false);
		expect(isEcsError({})).toBe(false);
	});
});
