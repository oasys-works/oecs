# Sparse storage

A **sparse component** stores data *outside* the archetype identity. An add or a remove causes **no
archetype transition**: the entity does not move, the engine copies no row, and it uses no bit of
the dense identity. So sparse storage is the correct place for data that is **rarely present**,
that **changes constantly**, or that would exceed the dense budget of 128 components.

```ts
const Cooldown = ecs.registerSparseComponent({ ready: "u32" });

ecs.addSparse(e, Cooldown, { ready: 90 });   // immediate — no archetype change
ecs.hasSparse(e, Cooldown);                   // true
ecs.getSparseField(e, Cooldown, "ready");     // 90
ecs.removeSparse(e, Cooldown);                // immediate
```

## Why sparse — the compromise

Each dense archetype transition, which is an add or a remove of a usual component, copies the
**full** payload row of the entity into the new archetype. So a component in the identity that
changes frequently costs more as the data of the entity becomes wider. A sparse add or remove is a
flat insert or delete in a sparse set, and its cost is the same for each payload width. So:

| Use **sparse** for | Use **dense** for |
| --- | --- |
| data that is present on a small part of the entities | data that is present on most matching entities |
| flags or values that change constantly | stable structural identity |
| relation targets, cooldowns, temporary markers | anything that you iterate in a high-frequency column loop |
| a way past the limit of 128 dense components | — |

The cost: sparse membership is not in the archetype mask. So a plain dense query does **not see
it**, and it has no column span to loop over.

## Registration

```ts
registerSparseComponent<S>(schema: S, opts?: ComponentRegisterOptions): SparseComponentDef<S>;   // record form
registerSparseComponent<const F, T = "f64">(fields: F, type?: T, opts?: ComponentRegisterOptions): SparseComponentDef<…>;  // array shorthand
registerSparseTag(): SparseComponentDef<Record<string, never>>;                     // membership only
```

These functions are equivalent to [`registerComponent`](./components.md):

- a record form, for mixed types;
- an array shorthand, for one type (the default is `"f64"`);
- a tag form, with no data;
- the same last argument, [`ComponentRegisterOptions`](./components.md), for a debug label
  (`{ name?: string }`).

> [!WARNING]
> The same [rule against floats for determinism](./determinism.md) applies. On an `ECS` with
> `{ deterministic: true }`, the `"f64"` default of the array shorthand is not acceptable. Give an
> explicit integer type.

## How to read and write

Each of these functions is immediate, and each is safe during a tick, because no dense row moves:

```ts
addSparse(e, def): this;                        // tag form (no values)
addSparse<S>(e, def, values: CompleteFieldValues<S>): this;
removeSparse(e, def): this;
hasSparse(e, def): boolean;
getSparseField<S>(e, def, field): number;
setSparseField<S>(e, def, field, value): void;
```

The same set is on `ctx` in a system. There, the engine checks the access through `sparseReads` and
`sparseWrites`. The one exception is `hasSparse`, which the engine does not check, and which agrees
with `hasComponent`.

> [!WARNING]
> `getSparseField` on an entity that is not a member **throws `COMPONENT_NOT_REGISTERED` in
> development**, and it gives `0` in production. Test with `hasSparse` first when the component can
> be absent.

## How to query sparse membership

Filter on a sparse component with the query terms, then iterate by entity:

```ts
withSparse(...defs): Query<Defs>;      // require membership
withoutSparse(...defs): Query<Defs>;   // remove the members

ecs.query(Unit).withSparse(Cooldown).forEachEntity((e) => {
  const ready = ecs.getSparseField(e, Cooldown, "ready");
  // …
});
```

> [!WARNING]
> A sparse query **must** use `forEachEntity`. `forEach`, `eachChunk`, and `count` reject it, and
> they throw `SPARSE_QUERY_DENSE_PATH` in development, because there is no column span. Also,
> sparse operations apply **immediately**. So, if you mutate the membership of the sparse
> component that drives a `forEachEntity` walk, the live key array moves below you. Hold such
> changes in a buffer and apply them after the loop.

## Snapshot and restore

Sparse stores, and the [relations](./relations.md) that are built on them, are part of
[determinism](./determinism.md):

```ts
ecs.snapshots.captureSparse(): Uint8Array;         // serialization in a canonical order
ecs.snapshots.restoreSparse(bytes: Uint8Array): void;
class SparseRestoreError extends Error {}
```

Both need `{ deterministic: true }`, or they throw `DETERMINISM_DISABLED`. `restoreSparse` requires
that you already registered the sparse components in the **same order**. It throws
`SparseRestoreError` for a difference in the shape, in the identity of a field, in the bounds of an
index, or in the bytes at the end. The full-world functions
[`ecs.snapshots.capture()` and `restore()`](./determinism.md) include the sparse section
automatically.

## Types

```ts
type SparseComponentDef<S>;   // the handle; it is not compatible with the dense addComponent/getField surface
type SparseComponentID;       // a separate id space from ComponentID — it does not touch the archetype mask
```

## See also

- [relations](./relations.md) — `(relation, target)` pairs, which are built on sparse storage
- [components](./components.md) — dense components, and the budget of 128 slots that sparse storage
  avoids
- [queries](./queries.md) — `withSparse` and the `forEachEntity` terminal
- [determinism](./determinism.md) — `captureSparse` and the rule against floats
