# Sparse storage

A **sparse component** stores data *outside* the archetype identity, in **id-indexed** columns: one
typed array for each field, where the value for an entity sits at the entity's index. An add or a
remove causes **no archetype transition**: the entity does not move, the engine copies no row, and
it uses no bit of the dense identity. A read by id is **one load**, with no archetype and no row to
find first. So sparse storage is the correct place for data that is **rarely present**, that
**changes constantly**, that a system **looks up by id** more than it sweeps, or that would exceed
the dense budget of 128 components.

```ts
const Cooldown = ecs.registerSparseComponent({ ready: "u32" });

ecs.addSparse(e, Cooldown, { ready: 90 });   // immediate, no archetype change
ecs.hasSparse(e, Cooldown);                   // true
ecs.getSparseField(e, Cooldown, "ready");     // 90
ecs.removeSparse(e, Cooldown);                // immediate
```

## Why sparse, the compromise

A dense component keeps its values **packed** by archetype, which is what makes a column loop run
at the speed of the raw arrays. The same packing makes a read by id expensive: the engine must find
the archetype and the row of the entity first, through several dependent loads. A sparse component
keeps its values **addressable**. The value for an entity is at the entity's index, so a read by id
is one load. A cursor over a sparse component is the fastest read by id that the engine has.
The price is on the other side. A walk over a sparse component reads through the id list, which is
slower than a packed column. Its memory is proportional to the highest entity index that ever held
it, and not to the number of members.

Each dense archetype transition, which is an add or a remove of a usual component, also copies the
**full** payload row of the entity into the new archetype. So a component in the identity that
changes frequently costs more as the data of the entity becomes wider. A sparse add or remove is a
bit in a sparse set and a write at the index, and its cost is the same for each payload width. So:

| Use **sparse** for | Use **dense** for |
| --- | --- |
| data that a system reads **by id** (a target, a partner, a parent) | data that a system sweeps in a column loop |
| data that is present on a small part of the entities | data that is present on most matching entities |
| flags or values that change constantly | stable structural identity |
| relation targets, cooldowns, temporary markers | anything that you iterate in a high-frequency column loop |
| a way past the limit of 128 dense components | not applicable |

A component chooses one side at registration. The choice of one component does not change the
cost of the others: a dense column loop never touches a sparse store, and a sparse read never
touches an archetype.

The other cost: sparse membership is not in the archetype mask. So a plain dense query does **not
see it**, and it has no column span to loop over.

## Memory

Each field of a sparse component is one typed array of the field's declared type. The arrays start
small and double to fit the highest member index. So a sparse component that one entity holds,
near the end of a large world, costs as much as one that every entity holds. That is the cost of
the one-load read, and an id-indexed engine pays it for every component. The columns live on the
JavaScript heap, outside the arena of the dense columns, so they do not count against
`maxBytes`.

## Registration

```ts
registerSparseComponent<S>(schema: S, opts?: ComponentRegisterOptions): SparseComponentDef<S>;   // record form
registerSparseComponent<const F, T = "f64">(fields: F, type?: T, opts?: ComponentRegisterOptions): SparseComponentDef<…>;  // array shorthand
registerSparseTag(): SparseComponentDef<Record<string, never>>;                     // membership only
```

These functions are equivalent to [`registerComponent`](./components.md):

- a record form, for mixed types
- an array shorthand, for one type (the default is `"f64"`)
- a tag form, with no data
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

A value converts as the field's type converts: an `i32` field truncates, a `u8` field wraps, an
`f32` field rounds. This agrees with a dense field of the same type.

## Cursors, many entities by id

A sparse cursor is the sparse form of [`cursor`](./refs.md#cursors-many-entities-by-id). You make
it one time and move it to each entity in turn:

```ts
sparseCursor<S>(def: SparseComponentDef<S>): ComponentCursor<S>;              // mutable
sparseCursorRead<S>(def: SparseComponentDef<S>): ReadonlyComponentCursor<S>;  // read-only

const hp = ecs.sparseCursor(Health);
for (let i = 0; i < hits.length; i++) {
  hp.at(hits[i]);
  hp.current -= damage[i];
}
```

The same two functions are on `ctx`, where `sparseCursor` needs the component in `sparseWrites`
and `sparseCursorRead` needs it in `sparseReads`. Because the columns are id-indexed, `at` writes
one field and a field access is one load. A dense cursor must find the archetype and the row on
each `at`. A sparse cursor does not. So a sparse cursor is the read by id to use when a system
touches many entities from a list of ids.

A sparse component has no archetype, so it has no archetype-level change tick, no structural
observer, and no `changed()` term. It has the row grain: `ecs.trackRows(def)` keeps one change tick
for each entity index, `setSparseField` and `at` on the mutable cursor stamp it, and an add zeroes
it. Read it with `ctx.sparseChanged(def, entityId)`, which is true for the run after a write, or
through an [`onSet` observer](./observers.md) with entity granularity, which a sparse component
takes as its one observer shape.

```ts
ecs.trackRows(Cooldown);
const tick = ecs.registerSystem({
  reads: [], writes: [],
  sparseReads: [Cooldown], sparseWrites: [],
  fn: (ctx) => {
    ready.forEachEntity((e) => {
      if (ctx.sparseChanged(Cooldown, e)) refreshIcon(e);
    });
  },
});

// ecs.observe needs the observers plugin, from ECS.create({ plugins: [observers()] })
ecs.observe(Cooldown, {
  access: { sparseReads: [Cooldown] },
  granularity: "entity",
  onSet: (e, ctx) => refreshIcon(e),
});
```

> [!WARNING]
> in development, `at` throws when the entity is dead or when it does not hold the component. In
> production it does not test, and a read then gives whatever the column holds at that index. Test
> with `hasSparse` first when the component can be absent.

The field names `__cols` and `__row` are reserved for the state of a ref or cursor, and
registration refuses them on a dense or a sparse component.

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
> A sparse query **must** use `forEachEntity`. `forEach`, `forEachChunk`, and `count` reject it, and
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

Both need the snapshots plugin, from `ECS.create({ plugins: [snapshots()] })`, with `snapshots`
imported from `@oasys/oecs/snapshots`. Both also need `{ deterministic: true }`, or they throw
`DETERMINISM_DISABLED`. `restoreSparse` requires
that you already registered the sparse components in the **same order**. It throws
`SparseRestoreError` for a difference in the shape, in the identity of a field, in the bounds of an
index, or in the bytes at the end. The full-world functions
[`ecs.snapshots.capture()` and `restore()`](./determinism.md) include the sparse section
automatically.

## Types

```ts
type SparseComponentDef<S>;   // the handle. It is not compatible with the dense addComponent and getField surface
type SparseComponentID;       // a separate id space from ComponentID, it does not touch the archetype mask
```

## See also

- [relations](./relations.md), `(relation, target)` pairs, which are built on sparse storage
- [components](./components.md), dense components, and the budget of 128 slots that sparse storage
  avoids
- [queries](./queries.md), `withSparse` and the `forEachEntity` terminal
- [determinism](./determinism.md), `captureSparse` and the rule against floats
