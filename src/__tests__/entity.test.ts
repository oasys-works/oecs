import { describe, expect, it } from "vitest";
import {
  INDEX_BITS,
  MAX_GENERATION,
  MAX_INDEX,
  get_entity_generation,
  create_entity_id,
  get_entity_index,
} from "../entity";

// X and Y chosen to be one bit off from power of 2s
const [x, y] = [31, 7];

describe("entity_id with generation", () => {
  //=========================================================
  // Pack & Unpack
  //=========================================================
  it("roundtrips: pack/unpack", () => {
    const id = create_entity_id(x, y);
    expect(get_entity_index(id)).toBe(x);
    expect(get_entity_generation(id)).toBe(y);
  });

  it("roundtrips: many random values", () => {
    for (let i = 0; i < 10_000; i++) {
      const index = Math.floor(Math.random() * MAX_INDEX);
      const generation = Math.floor(Math.random() * MAX_GENERATION);

      const id = create_entity_id(index, generation);

      expect(get_entity_index(id)).toBe(index);
      expect(get_entity_generation(id)).toBe(generation);
    }
  });

  //=========================================================
  // Boundaries
  //=========================================================
  it("roundtrips: min boundary", () => {
    const id = create_entity_id(0, 0);
    expect(get_entity_index(id)).toBe(0);
    expect(get_entity_generation(id)).toBe(0);
  });

  it("roundtrips: max boundary", () => {
    const id = create_entity_id(MAX_INDEX, MAX_GENERATION);
    expect(get_entity_index(id)).toBe(MAX_INDEX);
    expect(get_entity_generation(id)).toBe(MAX_GENERATION);
  });

  //=========================================================
  // Equality
  //=========================================================
  it("different id per generation", () => {
    const id_a = create_entity_id(x, 1);
    const id_b = create_entity_id(x, 2);

    expect(id_a).not.toBe(id_b);
  });

  it("different id per index", () => {
    const id_a = create_entity_id(1, y);
    const id_b = create_entity_id(2, y);

    expect(id_a).not.toBe(id_b);
  });

  it("always produces unsigned 32-bit IDs", () => {
    const id = create_entity_id(MAX_INDEX, MAX_GENERATION);

    expect(id).toBeGreaterThanOrEqual(0);
  });

  //=========================================================
  // Bit Leakage
  //=========================================================
  it("encodes generation in high bits", () => {
    const id = create_entity_id(0, 1);

    expect(id >>> 0).toBe(1 << INDEX_BITS);
  });

  it("MAX_INTEGER does not affect generation unpacking", () => {
    const id = create_entity_id(MAX_INDEX, y);

    expect(get_entity_generation(id)).toBe(y);
  });

  it("MAX_GENERATION does not affect index unpacking", () => {
    const id = create_entity_id(x, MAX_GENERATION);

    expect(get_entity_index(id)).toBe(x);
  });

  //=========================================================
  // Overflow
  //=========================================================
  it("overflow: max index", () => {
    expect(() => create_entity_id(MAX_INDEX + 1, y)).toThrow();
  });

  it("overflow: max gen", () => {
    expect(() => create_entity_id(x, MAX_GENERATION + 1)).toThrow();
  });
});
