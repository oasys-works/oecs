import { describe, expect, it } from "vitest";
import { ComponentRegistry } from "../component_registry";
import { as_component_id } from "../component";

describe("ComponentRegistry", () => {
  //=========================================================
  // Registration
  //=========================================================
  it("register increments count", () => {
    const reg = new ComponentRegistry();
    expect(reg.count).toBe(0);

    reg.register({ x: "f32", y: "f32" });
    expect(reg.count).toBe(1);

    reg.register({ hp: "i32" });
    expect(reg.count).toBe(2);
  });

  it("register returns sequential IDs", () => {
    const reg = new ComponentRegistry();
    const a = reg.register({ x: "f32" });
    const b = reg.register({ y: "f32" });
    const c = reg.register({ z: "f32" });

    // ComponentDef is a branded number, so we can compare directly
    expect((a as number) + 1).toBe(b as number);
    expect((b as number) + 1).toBe(c as number);
  });

  it("register tag component (empty schema)", () => {
    const reg = new ComponentRegistry();
    const Tag = reg.register({});

    expect(reg.count).toBe(1);
    expect(reg.get_schema(Tag)).toEqual({});
  });

  //=========================================================
  // get_schema
  //=========================================================
  it("get_schema returns the original schema", () => {
    const reg = new ComponentRegistry();
    const schema = { x: "f32", y: "f32", z: "f32" } as const;
    const def = reg.register(schema);

    expect(reg.get_schema(def)).toEqual(schema);
  });

  it("get_schema throws for unregistered ID", () => {
    const reg = new ComponentRegistry();
    expect(() => reg.get_schema(as_component_id(999))).toThrow();
  });

  //=========================================================
  // Schema metadata accessors
  //=========================================================
  it("get_field_names returns field names in order", () => {
    const reg = new ComponentRegistry();
    const def = reg.register({ x: "f32", y: "f32", z: "f32" });

    expect(reg.get_field_names(def)).toEqual(["x", "y", "z"]);
  });

  it("get_field_index returns name-to-index mapping", () => {
    const reg = new ComponentRegistry();
    const def = reg.register({ x: "f32", y: "f32", z: "f32" });

    const fi = reg.get_field_index(def);
    expect(fi["x"]).toBe(0);
    expect(fi["y"]).toBe(1);
    expect(fi["z"]).toBe(2);
  });

  it("tag component has empty field arrays", () => {
    const reg = new ComponentRegistry();
    const def = reg.register({});

    expect(reg.get_field_names(def)).toEqual([]);
    expect(reg.get_field_index(def)).toEqual({});
  });

  it("throws on get_field_names for unregistered ID", () => {
    const reg = new ComponentRegistry();
    expect(() => reg.get_field_names(as_component_id(999))).toThrow();
  });

  it("throws on get_field_index for unregistered ID", () => {
    const reg = new ComponentRegistry();
    expect(() => reg.get_field_index(as_component_id(999))).toThrow();
  });
});
