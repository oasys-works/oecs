/***
 * Component — Schema definition and phantom-typed handles.
 *
 * Components are defined as records mapping field names to typed array tags:
 *
 *   const Pos = world.register_component({ x: "f64", y: "f64" });
 *   const Health = world.register_component({ current: "i32", max: "i32" });
 *
 * Or via array shorthand (defaults to "f64"):
 *
 *   const Vel = world.register_component(["vx", "vy"] as const);
 *
 * At runtime, a ComponentDef<S> is just a ComponentID (branded number).
 * The generic S is erased but carried at compile-time, enabling
 * type-safe column access: arch.get_column(Pos, "x") returns Float64Array,
 * arch.get_column(Health, "current") returns Int32Array.
 *
 * Tag components (empty schema) participate in archetype matching
 * but store no data:
 *
 *   const IsEnemy = world.register_tag();
 *   world.add_component(e, IsEnemy);    // no values needed
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
  type TypedArrayTag,
} from "type_primitives";

export type ComponentID = Brand<number, "component_id">;
export const as_component_id = (value: number) =>
  validate_and_cast<number, ComponentID>(
    value,
    is_non_negative_integer,
    "ComponentID must be a non-negative integer",
  );

/** Core schema type: maps field names to typed array tags. */
export type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;

/** Compile-time tag → TypedArray mapping. */
export type TagToTypedArray = {
  f32: Float32Array;
  f64: Float64Array;
  i8: Int8Array;
  i16: Int16Array;
  i32: Int32Array;
  u8: Uint8Array;
  u16: Uint16Array;
  u32: Uint32Array;
};

/** Maps schema fields to their value object: { x: number, y: number }. */
export type FieldValues<S extends ComponentSchema> = {
  readonly [K in keyof S]: number;
};

/** Maps schema fields to their specific typed array columns. */
export type ColumnsForSchema<S extends ComponentSchema> = {
  readonly [K in keyof S]: TagToTypedArray[S[K]];
};

// Keep ComponentFields as a backwards-compatible alias used by event.ts / resource.ts
export type ComponentFields = readonly string[];

/** Maps component fields to column arrays (used by events — always Float64Array). */
export type ColumnsForFields<F extends ComponentFields> = {
  readonly [K in F[number]]: Float64Array;
};

// Phantom symbol — never exists at runtime, only provides a type-level slot
// for the field schema S so that ComponentDef<{x:"f64",y:"f64"}> and
// ComponentDef<{vx:"f64",vy:"f64"}> are distinct types even though both
// are just branded numbers.
declare const __schema: unique symbol;

export type ComponentDef<S extends ComponentSchema = ComponentSchema> =
  ComponentID & { readonly [__schema]: S };
