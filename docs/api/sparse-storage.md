# Sparse storage

A **sparse component** stores data *outside* the archetype identity. Adding or removing one causes **no archetype transition** — the entity doesn't move, no row is copied, and no dense-identity bit is consumed. This makes sparse storage the right home for data that is **rarely present**, **churns constantly**, or would blow the 128-component dense budget.

```ts
const Cooldown = ecs.registerSparseComponent({ ready: "u32" });

ecs.addSparse(e, Cooldown, { ready: 90 });   // immediate — no archetype change
ecs.hasSparse(e, Cooldown);                   // true
ecs.getSparseField(e, Cooldown, "ready");     // 90
ecs.removeSparse(e, Cooldown);                // immediate
```

## Why sparse — the tradeoff

Every dense archetype transition (add/remove a normal component) copies the entity's **entire** payload row into the new archetype, so churning an in-identity component costs more the wider the entity's data is. A sparse add/remove is a flat sparse-set insert/delete regardless of payload width. So:

| Use **sparse** for | Use **dense** for |
| --- | --- |
| data present on a small fraction of entities | data present on most matching entities |
| flags/values that flip on and off constantly | stable structural identity |
| relation targets, cooldowns, transient markers | anything you iterate in a hot column loop |
| escaping the 128 dense-component cap | — |

The cost: sparse membership isn't in the archetype mask, so it's **invisible to a plain dense query** and doesn't get an SoA column span to loop over.

## Registration

```ts
registerSparseComponent<S>(schema: S, opts?: ComponentRegisterOptions): SparseComponentDef<S>;   // record form
registerSparseComponent<const F, T = "f64">(fields: F, type?: T, opts?: ComponentRegisterOptions): SparseComponentDef<…>;  // array shorthand
registerSparseTag(): SparseComponentDef<Record<string, never>>;                     // membership only
```

Mirrors [`registerComponent`](./components.md) — record form for mixed types, array shorthand for uniform (defaults to `"f64"`), a tag variant with no data, and the same trailing [`ComponentRegisterOptions`](./components.md) debug-label bag (`{ name?: string }`).

> [!WARNING]
> The same [deterministic float ban](./determinism.md) applies: on a `{ deterministic: true }` `ECS`, the array shorthand's `"f64"` default is rejected — pass an explicit integer type.

## Reading & writing

All immediate, all safe mid-tick (no dense row ever moves):

```ts
addSparse(e, def): this;                        // tag form (no values)
addSparse<S>(e, def, values: FieldValues<S>): this;
removeSparse(e, def): this;
hasSparse(e, def): boolean;
getSparseField<S>(e, def, field): number;
setSparseField<S>(e, def, field, value): void;
```

The same six exist on `ctx` inside systems (and *are* access-checked there via `sparseReads`/`sparseWrites`).

> [!WARNING]
> `getSparseField` on a non-member **throws `COMPONENT_NOT_REGISTERED` in dev** (and returns `0` in production) — guard with `hasSparse` first if a component may be absent.

## Querying sparse membership

Filter on a sparse component with the query terms, then iterate by entity:

```ts
withSparse(...defs): Query<Defs>;      // require membership
withoutSparse(...defs): Query<Defs>;   // exclude members

ecs.query(Unit).withSparse(Cooldown).forEachEntity((e) => {
  const ready = ecs.getSparseField(e, Cooldown, "ready");
  // …
});
```

> [!WARNING]
> A sparse query **must** use `forEachEntity` — `forEach`/`eachChunk`/`count` reject it (`SPARSE_QUERY_DENSE_PATH` in dev) because there's no column span. And because sparse ops apply **immediately**, mutating the *driving* sparse component's membership during a `forEachEntity` walk shifts the live key array under you — buffer such edits and apply them after the loop.

## Snapshot & restore

Sparse stores (and the [relations](./relations.md) built on them) participate in [determinism](./determinism.md):

```ts
ecs.snapshots.captureSparse(): Uint8Array;         // canonical-order serialization
ecs.snapshots.restoreSparse(bytes: Uint8Array): void;
class SparseRestoreError extends Error {}
```

Both require `{ deterministic: true }` (else `DETERMINISM_DISABLED`). `restoreSparse` requires the sparse components already registered in the **same order**, and throws `SparseRestoreError` on any shape / field-identity / index-bounds / trailing-byte mismatch. The full-world [`ecs.snapshots.capture()` / `restore()`](./determinism.md) bundle the sparse section automatically.

## Types

```ts
type SparseComponentDef<S>;   // the handle; incompatible with the dense addComponent/getField surface
type SparseComponentID;       // separate id space from ComponentID — does not touch the archetype mask
```

## See also

- [relations](./relations.md) — `(relation, target)` pairs, built on sparse storage
- [components](./components.md) — dense components and the 128-slot budget sparse escapes
- [queries](./queries.md) — `withSparse` and the `forEachEntity` terminal
- [determinism](./determinism.md) — `captureSparse` and the float ban
