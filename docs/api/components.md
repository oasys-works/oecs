# Components

A **component** is a named bag of numeric fields attached to entities. `registerComponent` returns a **handle** you use everywhere afterward — to attach data, to query, to read columns.

Under the hood a component is **struct-of-arrays**: each field is its own packed typed-array column, and every entity's value for that field sits at the entity's row. There are no per-entity component objects, which is what makes iteration a tight loop over contiguous memory.

```ts
import { ECS } from "@oasys/oecs";
const ecs = new ECS();

// Record form — one type per field.
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });

// Array shorthand — uniform type across fields (defaults to "f64").
const Vel = ecs.registerComponent(["vx", "vy"] as const);

// Tag — no fields, just a marker.
const IsEnemy = ecs.registerTag();
```

## Field types

Every field is a number stored in a typed-array column. The type tag picks the column type:

| Tag | Column | Notes |
| --- | --- | --- |
| `"f64"` | `Float64Array` | double precision (the default) |
| `"f32"` | `Float32Array` | single precision |
| `"i8"` `"i16"` `"i32"` | `Int8/16/32Array` | signed integers |
| `"u8"` `"u16"` `"u32"` | `Uint8/16/32Array` | unsigned integers |

> [!NOTE]
> There is **no boolean, string, or 64-bit-integer field type**. Every field is a JS `number`. Model a flag as a `u8` — or better, a [tag](#tags) or [sparse tag](./sparse-storage.md); model an enum as a small integer; keep strings in a [resource](./resources.md) or a side table keyed by `EntityID`.

## `registerComponent`

```ts
// Record form — explicit per-field type.
registerComponent<S extends Record<string, TypedArrayTag>>(
  schema: S, opts?: ComponentRegisterOptions
): ComponentDef<S>;

// Array shorthand — same type for every field, defaults to "f64".
registerComponent<const F extends readonly string[], T extends TypedArrayTag = "f64">(
  fields: F, type?: T, opts?: ComponentRegisterOptions
): ComponentDef<{ readonly [K in F[number]]: T }>;

interface ComponentRegisterOptions { readonly name?: string; }   // debug label
```

Use the record form when fields have different types (`{ hp: "i32", regen: "f32" }`); use the array shorthand when they share one (`["x", "y", "z"]`). Pass a second argument to change the shorthand's type: `ecs.registerComponent(["hp", "max"], "i32")`.

The trailing `opts.name` attaches a **debug label**: dev diagnostics then read `'Pos' (component 5)` instead of `component 5`. It never affects behaviour, layout, or hashing. [`registerSparseComponent`](./sparse-storage.md) accepts the same trailing options; the tag registrars (`registerTag` / `registerSparseTag`) take no arguments.

> [!TIP]
> Add `as const` to the array shorthand (`["vx", "vy"] as const`). Without it TypeScript widens the field names to `string[]` and you lose per-field typing on the resulting handle.

Registration order fixes each field's column index for the life of the `ECS` — stable enough to key WASM FFI against (see [`ecs.fieldId`](./memory.md)).

> [!WARNING]
> **Dense components consume a 128-slot identity budget.** Each `registerComponent`/`registerTag` claims one bit in the archetype signature, so you can register at most 128 dense components + tags. Data that is rarely present, churns constantly, or would blow the budget belongs in [sparse storage](./sparse-storage.md) — out-of-identity and uncapped.

> [!WARNING]
> On a **deterministic** `ECS` (`new ECS({ deterministic: true })`), float columns are **rejected at registration** (`NON_DETERMINISTIC_COLUMN_TYPE`) because IEEE-754 rounding diverges across engines. Since the array shorthand defaults to `"f64"`, a deterministic `ECS` **must** pass an explicit integer type: `ecs.registerComponent(["x", "y"], "i32")`. Represent fractions as fixed-point. See [determinism](./determinism.md).

## Tags

```ts
registerTag(): ComponentDef<Record<string, never>>;
```

A tag is a component with no fields. It participates in archetype matching (so you can `query(IsEnemy)` or `.without(Dead)`) but stores nothing. Attaching it takes no values:

```ts
const Frozen = ecs.registerTag();
ecs.addComponent(e, Frozen);          // no values argument
ecs.query(Pos).without(Frozen);       // exclude frozen entities
```

<a id="the-handle-is-callable--bundles"></a>

## The handle is callable — bundles

`registerComponent` returns a `ComponentDef<S>`, which is a **callable handle**:

```ts
interface ComponentDef<S> {
  (values?: Partial<FieldValues<S>>): Bundle<S>;  // call it to pair values with the def (tag defs take no argument)
  readonly id: ComponentID;                        // the raw numeric id
}
```

Calling it produces a **bundle** — a `(def, values)` pair — which the varargs spawn/add paths accept. This is the ergonomic way to build an entity from several components at once:

```ts
import { bundle } from "@oasys/oecs";

// These two are equivalent bundle constructors:
Pos({ x: 10, y: 20 });          // call the def
bundle(Pos, { x: 10, y: 20 });  // the free function (identical result)

// Varargs spawn — immediate, host-side:
const e = ecs.spawnBundle(Pos({ x: 10, y: 20 }), Vel({ vx: 1 }), IsEnemy);
```

A **bare, uncalled** def (`IsEnemy` above, or `Pos`) doubles as an all-zero bundle / tag wherever a bundle is expected. The same shapes flow through `ctx.commands.spawn(...)` and `ctx.commands.add(...)` inside systems (see [systems](./systems.md)).

> [!TIP]
> **Partial values zero-fill.** When you build a bundle — `Pos({ x: 10 })` or `bundle(Pos, { x: 10 })` — omitted fields are written as `0`. This is the typed attach path for partial values. The typed `ecs.addComponent(e, Pos, values)` overload demands **complete** values (`CompleteFieldValues<S>` — every field). Provide `0` explicitly there, or use a bundle.

<a id="attach--detach"></a>

## Attach & detach (host facade)

The immediate, host-side attach/detach surface. Inside a system, use the deferred `ctx.commands.add` / `ctx.commands.remove` instead — see [immediate vs deferred](./entities.md#immediate-vs-deferred--the-one-thing-to-internalize).

```ts
addComponent(entityId: EntityID, def: ComponentDef<Record<string, never>>): this;   // tag
addComponent<S>(entityId: EntityID, bundle: Bundle<S>): this;                       // bundle — omitted fields zero-fill
addComponent<S>(entityId: EntityID, def: ComponentDef<S>, values: CompleteFieldValues<S>): this;  // complete values
removeComponent(entityId: EntityID, def: ComponentDef): this;
```

Three attach shapes: a bare def attaches a tag; a bundle (`Pos({ x: 1 })`) zero-fills omitted fields; the explicit `(e, def, values)` form demands every field, so a typo'd or missing field is a compile error.

### Several components, one transition

```ts
addComponents<Defs extends readonly ComponentDef[]>(entityId: EntityID, entries: TemplateEntries<Defs>): this;
removeComponents(entityId: EntityID, defs: ComponentDef[]): this;
```

`addComponents` batch-attaches several components in **one archetype transition** (it resolves the final archetype once and moves once, instead of stepping through an intermediate archetype per component). Entries have the same `{ def, values }` typing as [`ECS.template`](./entities.md#templates): each entry's `values` is checked against its own def's schema (a misspelled field is a compile error; tags refuse `values`), and omitted fields zero-fill. Unlike `spawnBundle` — which only ever creates a **new** entity — `addComponents` extends an existing one. `removeComponents` is the detach mirror: one transition for the whole set.

### Whole-archetype batch ops

```ts
batchAddComponent(src: ArchetypeID, def: ComponentDef<Record<string, never>>): this;   // tag
batchAddComponent<S>(src: ArchetypeID, def: ComponentDef<S>, values: CompleteFieldValues<S>): this;
batchRemoveComponent(src: ArchetypeID, def: ComponentDef): this;
```

Bulk add/remove one component on **all** entities of an archetype — `O(columns)` via `TypedArray.set()` instead of `O(entities × columns)`. They key on an `ArchetypeID` taken from `ArchetypeView.id` (the concrete archetype type is internal); get the view from [query iteration](./queries.md).

## Reading fields (host facade)

```ts
getField<S>(entityId: EntityID, def: ComponentDef<S>, field: string & keyof S): number;
tryGetField<S>(entityId: EntityID, def: ComponentDef<S>, field: string & keyof S): number | undefined;
```

`getField` reads one field of one entity; in dev it throws on a dead entity. `tryGetField` is its **total** sibling: it returns `undefined` when the entity is dead *or* doesn't hold the component, instead of a dev throw / prod garbage read — the safe way to probe-and-read in one call:

```ts
const hp = ecs.tryGetField(e, Health, "current") ?? 0;
```

For whole-component access, `ecs.refRead(def, e)` returns a read-only view (see [refs](./refs.md)); inside a system, use `ctx.getField` / `ctx.tryGetField` / `ctx.ref`.

## Types you may reference

```ts
type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;    // field → type map
type FieldValues<S>  = { readonly [K in keyof S]: number };         // all fields required
type CompleteFieldValues<S> = S extends Record<string, never> ? Record<string, never> : FieldValues<S>;
                                                                    // FieldValues, but a tag accepts only {}
type Bundle<S>       = { readonly def: ComponentDef<S>; readonly values: Partial<FieldValues<S>> };
type BundleOrDef<S>  = Bundle<S> | ComponentDef<S>;
type ComponentHandle = { readonly id: ComponentID };                // schema-erased view
```

> [!NOTE]
> **`ComponentDef<S>` is invariant in `S`.** A specific `ComponentDef<{ x: "f64" }>` is **not** assignable to the generic `ComponentDef`. Code that must accept any component regardless of schema should take a **`ComponentHandle`** (`{ id }`) — every `ComponentDef<S>` is assignable to it. This is why some engine signatures ask for `ComponentHandle`.

> [!NOTE]
> `.id` is installed non-enumerable, so a `ComponentDef` is invisible to spreads and `JSON.stringify`. Never build a `ComponentDef` by hand — only `registerComponent`/`registerTag` mint valid ones.

## See also

- [entities](./entities.md) — attaching components, templates for bulk spawns
- [queries](./queries.md) — matching on components, reading columns
- [sparse storage](./sparse-storage.md) — out-of-identity components (uncapped, churn-friendly)
- [determinism](./determinism.md) — why floats are banned on a deterministic `ECS`
