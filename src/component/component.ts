/***
 *
 * Component - Schema-defined components backed by plain arrays
 *
 * Components are defined as schemas: plain objects mapping field names to
 * string labels. The actual data lives in flat number[] arrays indexed by
 * entity index, giving us cache-friendly, allocation-free access on hot paths.
 *
 * A ComponentDef<S> is a phantom-typed handle: at runtime it's just a
 * ComponentID (number), but at compile-time it carries the schema S so
 * that get/set calls are fully type-checked without any casts.
 *
 ***/

import { Brand, validate_and_cast, is_non_negative_integer } from "type_primitives";

//=========================================================
// ComponentID
//=========================================================
export type ComponentID = Brand<number, "component_id">;
export const as_component_id = (value: number) =>
  validate_and_cast<number, ComponentID>(
    value,
    is_non_negative_integer,
    "ComponentID must be a non-negative integer",
  );

//=========================================================
// Schema types
//=========================================================

/** A component schema: field names mapped to string labels (e.g. { x: "f32", y: "f32" }). */
export type ComponentSchema = Record<string, string>;

/** Maps a schema to its JS-side value object. All values are numbers. */
export type SchemaValues<S extends ComponentSchema> = {
  [K in keyof S]: number;
};

/** Maps a schema to a record of plain number arrays — one per field. */
export type ColumnsForSchema<S extends ComponentSchema> = {
  readonly [K in keyof S & string]: number[]
};

//=========================================================
// ComponentDef<S> - phantom-typed component handle
//=========================================================

declare const __schema: unique symbol;

/**
 * A phantom-typed component handle.
 *
 * At runtime this is just a ComponentID (branded number).
 * The generic S is erased but carries schema info at compile-time,
 * so registry.get(Position, entity) returns { x: number, y: number, z: number }
 * and registry.set enforces all required fields.
 */
export type ComponentDef<S extends ComponentSchema = ComponentSchema> =
  ComponentID & { readonly [__schema]: S };
