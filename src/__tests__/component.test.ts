import { describe, expect, it } from "vitest";
import { as_component_id } from "../component";

describe("ComponentID", () => {
  //=========================================================
  // Valid casts
  //=========================================================
  it("accepts zero", () => {
    expect(as_component_id(0)).toBe(0);
  });

  it("accepts positive integers", () => {
    expect(as_component_id(31)).toBe(31);
  });

  //=========================================================
  // Invalid casts
  //=========================================================
  it("rejects negative integer", () => {
    expect(() => as_component_id(-1)).toThrow();
  });

  it("rejects non-integer (float)", () => {
    expect(() => as_component_id(1.5)).toThrow();
  });

  it("rejects NaN", () => {
    expect(() => as_component_id(NaN)).toThrow();
  });

  it("rejects Infinity", () => {
    expect(() => as_component_id(Infinity)).toThrow();
  });
});
