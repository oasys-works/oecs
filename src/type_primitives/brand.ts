/***
 * Brand — Nominal typing for TypeScript.
 *
 * Brand<T, Name> intersects T with a phantom readonly symbol property
 * tagged with Name. The symbol never exists at runtime — it only prevents
 * accidental assignment between structurally identical types.
 *
 * Example: EntityID and ComponentID are both numbers at runtime, but
 * Brand<number, "entity_id"> and Brand<number, "component_id"> are
 * incompatible at compile time.
 *
 ***/

declare const brand: unique symbol;

export type Brand<T, BrandName extends string> = T & {
  readonly [brand]: BrandName;
};
