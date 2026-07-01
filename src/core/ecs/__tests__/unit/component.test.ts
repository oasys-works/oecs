import { describe, expect, it } from "vitest";
import { asComponentId } from "../../component";

describe("ComponentID", () => {
	//=========================================================
	// Valid casts
	//=========================================================
	it("accepts zero", () => {
		expect(asComponentId(0)).toBe(0);
	});

	it("accepts positive integers", () => {
		expect(asComponentId(31)).toBe(31);
	});

	//=========================================================
	// Invalid casts
	//=========================================================
	it("rejects negative integer", () => {
		expect(() => asComponentId(-1)).toThrow();
	});

	it("rejects non-integer (float)", () => {
		expect(() => asComponentId(1.5)).toThrow();
	});

	it("rejects NaN", () => {
		expect(() => asComponentId(NaN)).toThrow();
	});

	it("rejects Infinity", () => {
		expect(() => asComponentId(Infinity)).toThrow();
	});
});
