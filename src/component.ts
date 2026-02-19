/***
 *
 * Component - Field-name array components
 *
 * Components are defined as readonly string arrays of field names.
 * Actual data lives in plain number[] columns inside each Archetype.
 *
 * A ComponentDef<F> is a phantom-typed handle: at runtime it's just a
 * ComponentID (number), but at compile-time it carries the field array F so
 * that get/set calls are fully type-checked without any casts.
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
} from "type_primitives";

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

/** A component definition: a readonly array of field names. */
export type ComponentFields = readonly string[];

/** Maps component fields to their JS-side value object. All values are plain numbers. */
export type FieldValues<F extends ComponentFields> = {
  readonly [K in F[number]]: number;
};

/** Maps component fields to plain number[] columns — one per field. */
export type ColumnsForSchema<F extends ComponentFields> = {
  readonly [K in F[number]]: number[];
};

//=========================================================
// ComponentDef<F> - phantom-typed component handle
//=========================================================

declare const __schema: unique symbol;

/**
 * A phantom-typed component handle.
 *
 * At runtime this is just a ComponentID (branded number).
 * The generic F is erased but carries field info at compile-time,
 * so get_column(Pos, "x") returns number[] and enforces that "x"
 * is a valid field name on Pos.
 */
export type ComponentDef<F extends ComponentFields = ComponentFields> =
  ComponentID & { readonly [__schema]: F };
