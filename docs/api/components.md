# Components

## Registering Components

### Record syntax (per-field type control)

Pass a record mapping field names to typed array tags. Each field's storage uses the specified typed array type.

```ts
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });
```

The return type is `ComponentDef<S>` where `S` is the schema record (e.g. `ComponentDef<{x:"f64",y:"f64"}>`).

Supported tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`.

### Array shorthand (uniform type)

Pass a `readonly` tuple of field names. All fields default to `"f64"`. An optional second argument overrides the type.

```ts
const Vel = world.register_component(["vx", "vy"] as const);           // f64
const Flags = world.register_component(["a", "b"] as const, "u8");     // u8
```

`as const` is required -- without it TypeScript widens the type to `string[]` and field-level type inference is lost.

## Tags

Tags are components with no fields. They participate in archetype matching and queries but store no data.

```ts
const IsEnemy = world.register_tag();
const Frozen = world.register_tag();
```

Return type: `ComponentDef<Record<string, never>>`.

Internally, tag-only archetypes skip all column operations (push, pop, copy, swap) during entity transitions -- only the entity ID list is maintained.

## Adding Components

Data components require a values object:

```ts
const e = world.create_entity();
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Vel, { vx: 1, vy: -1 });
```

Tags take no values argument:

```ts
world.add_component(e, IsEnemy);
```

If the entity already has the component, values are overwritten in-place with no archetype transition:

```ts
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Pos, { x: 99, y: 0 }); // overwrites, no transition
```

## Batch Add

`add_components` resolves the final archetype first, then performs a single entity move instead of intermediate transitions per component.

```ts
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: IsEnemy },
]);
```

This is cheaper than three separate `add_component` calls when the entity needs multiple new components at once.

## Removing Components

Single removal:

```ts
world.remove_component(e, Vel);
```

Both `add_component` and `remove_component` return `this`, so calls can be chained:

```ts
world.add_component(e, Pos, { x: 0, y: 0 }).add_component(e, Vel, { vx: 1, vy: 2 });
world.remove_component(e, Vel).remove_component(e, Frozen);
```

Batch removal avoids intermediate archetype transitions:

```ts
world.remove_components(e, Pos, Vel, IsEnemy);
```

Removing a component the entity does not have is a no-op.

## Checking Components

```ts
if (world.has_component(e, Pos)) {
  // entity has the Pos component
}

world.has_component(e, IsEnemy); // works for tags too
```

Returns `boolean`.

## Typed Array Columns

Column data is stored in typed arrays, not plain `number[]`. The `get_column()` method returns the specific typed array matching the field's tag:

```ts
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });

for (const arch of query) {
  const px = arch.get_column(Pos, "x");       // Float64Array
  const hp = arch.get_column(Health, "current"); // Int32Array
}
```

TypeScript infers the return type from the schema, so `get_column(Pos, "x")` is typed as `Float64Array` and `get_column(Health, "current")` is typed as `Int32Array`.

## Phantom Typing

`ComponentDef<S>` is a branded `number` at runtime (specifically a `ComponentID`). The generic parameter `S` exists only at compile time via a phantom symbol:

```ts
declare const __schema: unique symbol;
type ComponentDef<S extends ComponentSchema> = ComponentID & {
  readonly [__schema]: S;
};
```

Where `ComponentSchema = Readonly<Record<string, TypedArrayTag>>`.

At runtime `Pos` is just a number (the component's internal ID). At compile time it carries `{x:"f64",y:"f64"}`, which flows through the entire API:

- `add_component(e, Pos, ...)` requires `{ x: number, y: number }` -- missing or extra fields are compile errors.
- `archetype.get_column(Pos, "x")` accepts only `"x" | "y"` for the field argument and returns `Float64Array`.
- Array shorthand `["vx", "vy"] as const` is normalized to `{readonly vx: "f64", readonly vy: "f64"}` internally.

This gives full type safety with zero runtime overhead -- no wrapper objects, no maps, just a plain integer ID.
