import { describe, expect, it } from "vitest";
import type { Brand } from "../brand";

type EntityID = Brand<number, "entity_id">;
type ComponentID = Brand<number, "component_id">;

describe("Brand", () => {
  //=========================================================
  // Runtime value preservation
  //=========================================================

  it("branded value equals its underlying primitive at runtime", () => {
    const id = 42 as EntityID;
    expect(id).toBe(42);
  });

  it("branded values with same underlying value are equal at runtime", () => {
    const entity_id = 7 as EntityID;
    const component_id = 7 as ComponentID;
    // At runtime these are the same number, branding is compile-time only
    expect(entity_id === (component_id as unknown as EntityID)).toBe(true);
  });

  it("branded value can be used in arithmetic like a plain number", () => {
    const id = 10 as EntityID;
    expect(id + 1).toBe(11);
    expect(id * 2).toBe(20);
  });

  it("branded value works with typeof", () => {
    const id = 5 as EntityID;
    expect(typeof id).toBe("number");
  });
});
