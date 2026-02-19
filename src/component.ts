/***
 * Component — Schema definition and phantom-typed handles.
 *
 * Components are defined as readonly string arrays of field names:
 *
 *   const Pos = world.register_component(["x", "y"] as const);
 *
 * At runtime, a ComponentDef<F> is just a ComponentID (branded number).
 * The generic F is erased but carried at compile-time, enabling
 * type-safe column access: arch.get_column(Pos, "x") returns number[]
 * and rejects invalid field names at compile time.
 *
 * Tag components (empty field array) participate in archetype matching
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
} from "type_primitives";

export type ComponentID = Brand<number, "component_id">;
export const as_component_id = (value: number) =>
  validate_and_cast<number, ComponentID>(
    value,
    is_non_negative_integer,
    "ComponentID must be a non-negative integer",
  );

export type ComponentFields = readonly string[];

/** Maps component fields to their value object: { x: number, y: number }. */
export type FieldValues<F extends ComponentFields> = {
  readonly [K in F[number]]: number;
};

/** Maps component fields to column arrays: { x: number[], y: number[] }. */
export type ColumnsForSchema<F extends ComponentFields> = {
  readonly [K in F[number]]: number[];
};

// Phantom symbol — never exists at runtime, only provides a type-level slot
// for the field schema F so that ComponentDef<["x","y"]> and ComponentDef<["vx","vy"]>
// are distinct types even though both are just branded numbers.
declare const __schema: unique symbol;

export type ComponentDef<F extends ComponentFields = ComponentFields> =
  ComponentID & { readonly [__schema]: F };
