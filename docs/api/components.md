# Components

A **component** is a named group of numeric fields that you attach to an entity. `registerComponent`
gives you a **handle**. You then use that handle everywhere: to attach data, to query, and to read
columns.

Internally, a component is a **struct-of-arrays**. Each field is its own packed typed-array column,
and the value of an entity for that field is at the row of that entity. There is no component
object for each entity. This is why iteration is a small loop over adjacent memory.

```ts
import { ECS } from "@oasys/oecs";
const ecs = new ECS();

// Record form — one type for each field.
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });

// Array shorthand — the same type in each field (the default is "f64").
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// Tag — no fields, only a marker.
const IsEnemy = ecs.registerTag();
```

## Field types

Each field is a number in a typed-array column. The type tag selects the type of the column.

| Tag | Column | Notes |
| --- | --- | --- |
| `"f64"` | `Float64Array` | double precision (the default) |
| `"f32"` | `Float32Array` | single precision |
| `"i8"` `"i16"` `"i32"` | `Int8/16/32Array` | signed integers |
| `"u8"` `"u16"` `"u32"` | `Uint8/16/32Array` | unsigned integers |

> [!NOTE]
> There is **no field type for a boolean, a string, or a 64-bit integer**. Each field is a JS
> `number`. Model a flag as a `u8`, or better, as a [tag](#tags) or a
> [sparse tag](./sparse-storage.md). Model an enumeration as a small integer. Keep a string in a
> [resource](./resources.md), or in a related table with an `EntityID` key.

## `registerComponent`

```ts
// Record form — an explicit type for each field.
registerComponent<S extends Record<string, TypedArrayTag>>(
  schema: S, opts?: ComponentRegisterOptions
): ComponentDef<S>;

// Array shorthand — the same type in each field, "f64" by default.
registerComponent<const F extends readonly string[], T extends TypedArrayTag = "f64">(
  fields: F, type?: T, opts?: ComponentRegisterOptions
): ComponentDef<{ readonly [K in F[number]]: T }>;

interface ComponentRegisterOptions { readonly name?: string; }   // a label for diagnostics
```

Use the record form when the fields have different types (`{ hp: "i32", regen: "f32" }`). Use the
array shorthand when the fields have one type (`["x", "y", "z"]`). To change the type of the
shorthand, give a second argument: `ecs.registerComponent(["hp", "max"], "i32")`.

The last argument, `opts.name`, attaches a **label for diagnostics**. Development diagnostics then
show `'Pos' (component 5)` instead of `component 5`. The label does not change behavior, layout, or
the hash. [`registerSparseComponent`](./sparse-storage.md) accepts the same last argument. The tag
functions (`registerTag` and `registerSparseTag`) take no arguments.

> [!TIP]
> Add `as const` to the array shorthand (`["vx", "vy"] as const`). Without it, TypeScript makes the
> field names as general as `string[]`, and the handle loses the type of each field.

The order of registration sets the column index of each field for the life of the `ECS`. The index
is stable, and you can use it as a key for WASM FFI (see [`ecs.fieldId`](./memory.md)).

> [!WARNING]
> **Dense components use a budget of 128 identity slots.** Each `registerComponent` or
> `registerTag` call uses one bit in the archetype signature. So you can register a maximum of
> 128 dense components and tags. Put data in [sparse storage](./sparse-storage.md) if it is rarely
> present, if it changes constantly, or if it would exceed the budget. Sparse storage is outside
> the identity, and it has no limit.

> [!WARNING]
> On a **deterministic** `ECS` (`new ECS({ deterministic: true })`), registration **rejects** float
> columns (`NON_DETERMINISTIC_COLUMN_TYPE`), because IEEE-754 rounding is different in different
> engines. The array shorthand uses `"f64"` by default. So a deterministic `ECS` **must** give an
> explicit integer type: `ecs.registerComponent(["x", "y"], "i32")`. Use fixed-point numbers for
> fractions. See [determinism](./determinism.md).

## Tags

```ts
registerTag(): ComponentDef<Record<string, never>>;
```

A tag is a component with no fields. It is part of the archetype match, so you can write
`query(IsEnemy)` or `.without(Dead)`, but it stores nothing. To attach it, give no values:

```ts
const Frozen = ecs.registerTag();
ecs.addComponent(e, Frozen);          // no values argument
ecs.query(Pos).without(Frozen);       // remove the frozen entities
```

<a id="the-handle-is-callable--bundles"></a>

## The handle is callable — bundles

`registerComponent` gives you a `ComponentDef<S>`, which is a **callable handle**:

```ts
interface ComponentDef<S> {
  (values?: Partial<FieldValues<S>>): Bundle<S>;  // call it to pair values with the def (tag defs take no argument)
  readonly id: ComponentID;                        // the raw numeric id
}
```

A call gives you a **bundle**, which is a `(def, values)` pair. The spawn and add functions that
take a variable number of arguments accept a bundle. This is the direct way to build an entity from
several components at the same time:

```ts
import { bundle } from "@oasys/oecs";

// These two bundle constructors are equivalent:
Pos({ x: 10, y: 20 });          // call the def
bundle(Pos, { x: 10, y: 20 });  // the free function (an identical result)

// Spawn with a variable number of arguments — immediate, on the host:
const e = ecs.spawnBundle(Pos({ x: 10, y: 20 }), Vel({ vx: 1 }), IsEnemy);
```

A definition that you do **not** call (`IsEnemy` above, or `Pos`) is also a bundle of zeros, or a
tag, at each position that accepts a bundle. The same shapes go through `ctx.commands.spawn(...)`
and `ctx.commands.add(...)` in a system (see [systems](./systems.md)).

> [!TIP]
> **Absent values become zero.** When you build a bundle — `Pos({ x: 10 })` or
> `bundle(Pos, { x: 10 })` — the ECS writes `0` in each field that you did not give. This is the
> typed path to attach a subset of the values. The typed overload
> `ecs.addComponent(e, Pos, values)` demands **all** values (`CompleteFieldValues<S>`, which is
> each field). There you must give `0` explicitly, or use a bundle.

<a id="attach--detach"></a>

## Attach and detach (the host facade)

This is the immediate attach and detach surface on the host. In a system, use the deferred
`ctx.commands.add` and `ctx.commands.remove` instead. See
[immediate and deferred](./entities.md#immediate-vs-deferred--the-one-thing-to-internalize).

```ts
addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): this;   // tag
addComponent<S>(entityId: EntityID, bundle: Bundle<S>): this;                       // bundle — absent fields become zero
addComponent<S>(entityId: EntityID, def: ComponentDef<S>, values: CompleteFieldValues<S>): this;  // all values
removeComponent(entityId: EntityID, def: ComponentDef): this;
```

There are three attach shapes. A definition alone attaches a tag. A bundle (`Pos({ x: 1 })`) writes
`0` in each field that you did not give. The explicit `(e, def, values)` form demands each field,
so a field name that is absent or has a spelling error is a compile error.

### Several components, one transition

```ts
addComponents<Items extends readonly BundleOrDef[]>(entityId: EntityID, ...items: StrictBundles<Items>): this;
removeComponents(entityId: EntityID, ...defs: ComponentDef[]): this;
```

`addComponents` attaches several components in **one archetype transition**. It finds the final
archetype one time and moves the entity one time. It does not step through an intermediate
archetype for each component. It takes the same callable bundles as
[`spawnBundle`](./entities.md) and [`ECS.template`](./entities.md#templates), as in
`ecs.addComponents(e, Pos({ x, y }), Vel({ vx }), Frozen)`. TypeScript checks each item against the
schema of its own definition. A field name with a spelling error, or a field from a different
component, is a compile error, and a tag rejects values. The ECS writes `0` in each field that you
did not give. `spawnBundle` only creates a **new** entity, but `addComponents` extends an entity
that exists. `removeComponents` is the equivalent function for detachment: one transition for the
full set.

### Batch operations on a full archetype

```ts
batchAddComponent(src: ArchetypeID, def: ComponentDef<Record<string, never>>): this;   // tag
batchAddComponent<S>(src: ArchetypeID, def: ComponentDef<S>, values: CompleteFieldValues<S>): this;
batchRemoveComponent(src: ArchetypeID, def: ComponentDef): this;
```

These functions add or remove one component on **all** the entities of an archetype. The cost is
`O(columns)`, through `TypedArray.set()`, and not `O(entities × columns)`. They take an
`ArchetypeID` from `ArchetypeView.id`, because the concrete archetype type is internal. To get the
view, use [query iteration](./queries.md).

## How to read fields (the host facade)

```ts
getField<S>(entityId: EntityID, def: ComponentDef<S>, field: string & keyof S): number;
tryGetField<S>(entityId: EntityID, def: ComponentDef<S>, field: string & keyof S): number | undefined;
```

`getField` reads one field of one entity. In development it throws for an entity that is not alive.
`tryGetField` is the **total** equivalent: it gives `undefined` when the entity is not alive, or
when the entity does not hold the component. It does not throw in development, and it does not read
incorrect data in production. So it is the safe way to test and read in one call:

```ts
const hp = ecs.tryGetField(e, Health, "current") ?? 0;
```

To read a full component, `ecs.refRead(def, e)` gives you a read-only view (see [refs](./refs.md)).
In a system, use `ctx.getField`, `ctx.tryGetField`, or `ctx.ref`.

## Types that you can refer to

```ts
type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;    // field → type map
type FieldValues<S>  = { readonly [K in keyof S]: number };         // all fields required
type CompleteFieldValues<S> = S extends Record<string, never> ? Record<string, never> : FieldValues<S>;
                                                                    // FieldValues, but a tag accepts only {}
type Bundle<S>       = { readonly def: ComponentDef<S>; readonly values: Partial<FieldValues<S>> };
type BundleOrDef<S>  = Bundle<S> | ComponentDef<S>;
type ComponentHandle = { readonly id: ComponentID };                // a view with the schema removed
```

> [!NOTE]
> **`ComponentDef<S>` is invariant in `S`.** You **cannot** assign a specific
> `ComponentDef<{ x: "f64" }>` to the general `ComponentDef`. Code that must accept a component of
> any schema must take a **`ComponentHandle`** (`{ id }`), because you can assign each
> `ComponentDef<S>` to it. This is why some engine signatures ask for a `ComponentHandle`.

> [!NOTE]
> `.id` is not enumerable. So a spread operation and `JSON.stringify` do not see a
> `ComponentDef`. Never build a `ComponentDef` yourself. Only `registerComponent` and `registerTag`
> make a valid one.

## See also

- [entities](./entities.md) — how to attach components, and templates for bulk spawns
- [queries](./queries.md) — how to match on components and read columns
- [sparse storage](./sparse-storage.md) — components outside the identity (no limit, and good for
  data that changes frequently)
- [determinism](./determinism.md) — why a deterministic `ECS` rejects floats
