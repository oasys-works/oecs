# Queries

A **query** is a live, cached view of each archetype that agrees with a set of components. Build the
query one time and use it again in each frame. The store continues to add newly matching archetypes
to it, so it never becomes out of date.

```ts
const movers = ecs.query(Pos, Vel);   // each archetype that has (a minimum of) Pos and Vel
```

`ecs.query(A, B, C)` agrees with each entity that has **all** of `A`, `B`, and `C`, and possibly
more components. The order is not important. Repeated calls with the same set give you the **same
cached instance**.

## Read or write, select the terminal function

The most important decision in a query is how you iterate it, because that decision controls
whether you can mutate.

| Terminal | The callback receives | Can it mutate? | Use it for |
| --- | --- | --- | --- |
| [`forEach`](#foreach--read-only) | a read-only `ArchetypeView` | no | how to read columns |
| [`forEachChunk`](#foreachchunk--mutable-hot-path) | a mutable `cols` and a `count` | **yes** | the high-frequency loop that writes |
| [`forEachEntity`](#foreachentity--non-dense-terms) | one `EntityID` at a time | through `ctx` | a query with a sparse, relation, or hierarchy term |

```ts
// A read-only pass:
movers.forEach((arch) => {
  const x = arch.getColumnRead(Pos, "x");           // a read-only column
  for (let i = 0; i < arch.entityCount; i++) sum += x[i];
});

// A pass that mutates, the recommended default when you write:
movers.forEachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);                   // mutable columns. Sets the change tick of Pos
  const { vx, vy } = cols.read(Vel);                // read-only columns. No change to the tick
  for (let i = 0; i < count; i++) {
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
});
```

The terms of the query give the types of the cursor and of the `forEach` view. In the
`query(Pos, Vel)` example above, `cols.mut(Health)` is a **compile error**
(`"component is not a term of this query, add it with .and(...)"`). `arch.getColumnRead(Health, "hp")`
is also a compile error. To get more components, add them to the set of terms with `.and(...)`. A
fetch after `.optional(T)` stays permissive at compile time, because the development check on the
optional scope controls those fetches.

## How to build a query

There are two entry points, with the same result:

```ts
// On the host, or stored on the ECS:
query<T extends ComponentDef[]>(...defs: T): Query<T>;
const movers = ecs.query(Pos, Vel);

// In a system, through the query-builder form of registerSystem:
const move = ecs.registerSystem(
  (q, ctx, dt) => { q.forEachChunk(/* ... */); },
  (qb) => qb.and(Pos, Vel),   // resolved one time, at registration
);
```

`QueryBuilder.and(...)` is identical to `ecs.query(...)`. It is only the form that a system
receives. Most code declares its queries with `ecs.query(...)` and holds them in a closure. See
[systems](./systems.md) for the reason that this form is usually better than the builder form.

## The verbs that make a query more exact

Each verb gives you a **new cached query**. It never mutates the receiver. The engine remembers
each composition, so `q.and(A).and(B)` and `q.and(A, B)` are the same instance.

Three words name every connective. `and` requires, `not` excludes, `or` requires one of a set.

```ts
and<D>(...comps: D): Query<[...Defs, ...D]>;   // also require these  (makes the set smaller)
not(...comps): Query<Defs>;                    // remove archetypes that hold any of these
or(...comps): Query<Defs>;                     // require a minimum of one of these
where(term: ArchetypeTerm): Query<Defs>;       // narrow by a nested expression
optional(...defs): Query<Defs>;                // fetch if present (does not make the set smaller)
changed(...defs): ChangedQuery<Defs>;          // only archetypes changed since the last run
includeDisabled(): Query<Defs>;                // include the disabled entities again
```

```ts
ecs.query(Pos)
  .and(Vel)            // require Vel also
  .not(Frozen)         // remove the frozen entities
  .or(Player, NPC);    // and be a Player or an NPC
```

- **`not`** removes an archetype if it holds *any* component in the list. **`or`** requires
  *a minimum of one*. Two or more `or` calls join into one "one or more of these" set.
- **`optional(T)`** increases what you can *read*. It does not change what the query *matches*.
  Iteration still covers the archetypes with `T` and the archetypes without `T`. To read the
  column, use `arch.getOptionalColumnRead(T, field)`, which gives the column when `T` is present
  and `undefined` when `T` is absent. `.optional(T)` is also the **authorization** for an optional
  fetch of `T`. You must still list `T` in the `reads` of the system, because both checks apply.
- **`changed(...)`** gives you a [`ChangedQuery`](./change-detection.md). Read that page. The
  level of detail is the archetype, and not the row.
- **`includeDisabled()`** makes iteration cover the [disabled](./entities.md#enable--disable)
  entities, which the query removes by default.

## A nested expression: `where`

A chain asks one flat question of each archetype. `where` asks a nested one. Build the expression
from the free `and`, `or` and `not`, which take a component definition as a leaf and take each
other as a node.

```ts
import { and, or, not } from "@oasys/oecs";

// hold Pos and Vel, or hold Frozen
const q = ecs.query(Tag).where(or(and(Pos, Vel), Frozen));

// the chain and the expression compose, in either order
ecs.query(Tag).where(or(Pos, Vel)).not(Dead);
ecs.query(Tag).not(Dead).where(or(Pos, Vel));
```

`and`, `or` and `not` are functionally complete over archetype membership. Every predicate over a
component mask is one of their compositions, so there is no fourth connective.

An expression judges the **dense component mask alone**. Sparse membership and relation membership
are per entity, outside the archetype, so they stay on `andSparse`, `notSparse`, `andRelation` and
`notRelation`.

`not(A, B)` matches an archetype that holds neither, exactly as `Query.not(A, B)` does. `and()`
over nothing matches every archetype, `or()` over nothing matches none.

The term is evaluated one time per archetype, per query, when the store's archetype set changes.
`forEach`, `forEachChunk` and `forEachEntity` walk the list that the evaluation produced, so the
iteration path pays nothing.

> [!WARNING]
> `where` caches on the identity of the term, so build the expression one time and hold it. A fresh
> expression on each call mints a fresh query on each call.

> [!WARNING]
> Three readers answer from the unfiltered archetype list: `archetypeCount`, `archetypes` and
> `excludeWords`. A query that carries a `where` term refuses all three in development, with
> `QUERY_TERM_DENSE_PATH`. Read the matched archetypes with `forEach` instead. `excludeWords` is
> what a [parallel](./parallel.md) route reads, so a route cannot take a `where` query.

A plugin can supply its own term instead of an expression. `ArchetypeTerm` is `{ name, matches }`,
where `matches` takes the archetype's component `BitSet`. It must be pure and stable: one archetype
gives one answer for the life of the world.

<a id="foreach--read-only"></a>

## `forEach`, read only

```ts
forEach(cb: (arch: ArchetypeView) => void): void;
some(cb: (arch: ArchetypeView) => boolean): boolean;   // stop when cb gives true
```

`forEach` calls the callback one time for each matching archetype that is **not empty**, and gives
it a read-only `ArchetypeView`:

```ts
interface ArchetypeView {
  readonly id: ArchetypeID;
  readonly entityCount: number;   // ← the limit of your loop (the enabled rows)
  readonly totalCount: number;    // includes the disabled rows
  readonly disabledCount: number;
  readonly entityIds: ReadonlyEntityIDArray;
  hasComponent(id): boolean;
  getColumnRead(def, field): ReadonlyColumn;                 // a read-only column
  getColumnsRead(def, ...fields): [ReadonlyColumn, ...];      // several columns at the same time
  getOptionalColumnRead(def, field): ReadonlyColumn | undefined;  // for .optional(def)
}
```

> [!WARNING]
> **Always loop to `arch.entityCount`. Never loop to the `.length` of a column.** The raw buffer of
> a column includes the free capacity and the disabled rows after the live count. A loop to
> `.length` reads incorrect data. `entityCount` is the number of enabled rows, or all the rows
> under `includeDisabled`. The `count` parameter of
> [`forEachChunk`](#foreachchunk--mutable-hot-path) exists to remove this risk.

> [!NOTE]
> The `ArchetypeView` **has no accessor for a mutable column**, by design. You cannot write through
> `forEach`. To mutate, use [`forEachChunk`](#foreachchunk--mutable-hot-path), or write one entity at a
> time with [`ctx.ref`](./refs.md) or `ctx.setField`. Both of those set the change tick.
> `ReadonlyColumn` is a compile-time limit only. A type cast can write through it, but a write of
> that type stops change detection from working correctly. Do not do it.

<a id="foreachchunk--mutable-hot-path"></a>

## `forEachChunk`, the high-frequency loop that writes

```ts
forEachChunk(cb: (cols: ChunkColumns, count: number) => void): void;
```

This is the recommended default for a system that **mutates**. `cols` resolves a full component
into a group of columns that you can destructure. `count` is the number of enabled rows.

```ts
interface ChunkColumns {
  mut<S>(def: ComponentDef<S>): MutableColumnsForSchema<S>;   // writable. Sets the change tick
  read<S>(def: ComponentDef<S>): ColumnsForSchema<S>;         // read-only. No change to the tick
  ticks<S>(def: ComponentDef<S>): Uint32Array;                // the row ticks, writable: the record a raw loop makes
  ticksRead<S>(def: ComponentDef<S>): Readonly<Uint32Array>;  // the row ticks, read-only: the row grain of changed()
  readonly tick: number;                                      // the change tick this pass stamps
  readonly since: number;                                     // the change tick of the previous run of this system
}

movers.forEachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);     // { x: Float64Array, y: Float64Array }, writable
  const { vx, vy } = cols.read(Vel);
  for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
});
```

> [!IMPORTANT]
> `cols.mut(def)` sets the change tick of `def` for this archetype **one time, when you call it**.
> It does this before you write anything. This is what makes a [`changed(def)`](./change-detection.md)
> query see this archetype in the next tick. If you only read, call `cols.read(def)`, so that you do
> not cause an incorrect result. The engine reads the tick value one time for each `forEachChunk` pass
> and uses it for each archetype.

> [!WARNING]
> **Destructure the group immediately. Do not keep it.** The object from `cols.mut(Pos)` is cached
> for each `(archetype, component)` pair, and the next call refreshes it **in place**. Take
> `{ x, y }` and use the arrays. Do not keep the group object between iterations.

`cols.ticks(def)` is the row record. A raw column write is invisible to the engine, so the loop
records each row it changes with one store: `t[i] = cols.tick`. That store costs about what the
write itself costs, where `ctx.markChanged` is a call and a list push for each row. The record
reaches an [`onSet` observer](./observers.md) with entity granularity and a
[`changed()`](./change-detection.md) reader at the row grain. The column exists only for a
component with row ticks, which `ecs.trackRows(def)` or an entity-level `onSet` observer turns
on, and the call throws `ROW_TICKS_NOT_TRACKED` otherwise. Taking it marks the archetype changed and
asks the drain of this frame to scan every archetype of `def` that a writer stamped, so take it
only in a loop that stores into it. `cols.ticksRead(def)` is the same column read-only, with no
stamp and no scan request, for a reader that compares each row with `cols.since`.

```ts
movers.forEachChunk((cols, count) => {
  const { x } = cols.mut(Pos);
  const t = cols.ticks(Pos);
  for (let i = 0; i < count; i++) {
    if (vx[i] === 0) continue;
    x[i] += vx[i] * dt;
    t[i] = cols.tick;                 // this row reaches the entity-level onSet
  }
});
```

> [!NOTE]
> `cols.mut`, `cols.read`, [`ctx.ref`, and `ctx.refRead`](./refs.md) are one family. The convention
> is that the mutable name has no suffix, the read-only name has the `Read` suffix, and the
> definition is the first argument. The `cols.*` pair is the form for use inside iteration (a full
> archetype, one pass). The `ctx.ref*` pair is the form for one entity outside iteration. Both put
> the component first, because a cursor has the name of the thing that it points to.

<a id="foreachentity--non-dense-terms"></a>

## `forEachEntity`, terms that are not dense

```ts
forEachEntity(cb: (entityId: EntityID) => void): void;
```

This function gives you the matching entities, one id at a time. It is **necessary** for each query
that carries a [sparse](./sparse-storage.md), [relation](./relations.md), or hierarchy term. Those
members are distributed across the archetypes, so there is no column span to give you. To read the
fields of an entity that you receive, use `ctx.getField` (dense) or `ctx.getSparseField` (sparse).

> [!WARNING]
> Iteration walks the **live** key array of the store. Sparse and relation operations apply
> immediately. So, if you mutate the sparse or relation membership that drives the walk, the
> array moves below you. Hold such changes in a buffer and apply them after the loop.

## The limit to dense queries

`forEach`, `forEachChunk`, `some`, `entityCount`, and `archetypeCount` operate on the column layout
of the archetype. So they **reject** a query that carries a sparse, relation, or hierarchy term, and
they throw `SPARSE_QUERY_DENSE_PATH` in development. For those queries, use `forEachEntity` or
[`forEachRelatedTo`](./relations.md).

## Introspection and reads of a single entity

```ts
get entityCount(): number;                  // enabled rows (or all rows, under includeDisabled)
get archetypeCount(): number;               // matching archetypes, including the empty ones
get archetypes(): readonly ArchetypeView[]; // the raw list (not filtered to the non-empty ones)

firstEntity(): EntityID | undefined;        // the first match, or undefined when there is none
singleEntity(): EntityID;                   // the one match, and in development it throws QUERY_NOT_SINGLETON on 0 or more than 1
```

`firstEntity` reads a single entity (`player` or `camera`) without a `forEach` and a closure that
you write yourself. "First" is the **order of iteration, and not the order of creation**. With more
than one match, the selection is arbitrary. To assert that there is only one match, use
`singleEntity`. In development, `singleEntity` throws `QUERY_NOT_SINGLETON` when the number of
matches is 0 or more than 1. In production the count check is absent, and it gives the first match,
or `undefined` when there is none.

The members above have a limit to dense queries, but these two functions operate on **any** query.
A dense query gets the answer from the first non-empty archetype, in `O(archetypes)`. A query with
a sparse, relation, or hierarchy term uses a full `forEachEntity` walk instead.

## Query terms that are not dense (a summary)

These terms are not part of the dense archetype mask. They compose with `and`, `not` and
`or`, but you must iterate them with `forEachEntity` or `forEachRelatedTo`. Each has full detail
on its own page.

```ts
andSparse(...defs): Query<Defs>;     notSparse(...defs): Query<Defs>;      // → sparse storage
andRelation(...defs): Query<Defs>;   notRelation(...defs): Query<Defs>;    // (R, *) → relations
forEachRelatedTo(target, cb): void;                                             // (*, T) → relations
hierarchy(relation, maxDepth?): Query<Defs>;                                    // depth order → relations
```

> [!NOTE]
> To iterate a `(R, *)` or `(*, T)` query, the system must authorize it. List the relation in
> `relationReads`, or list `ANY_RELATION` for the `(*, T)` function `forEachRelatedTo`. See
> [relations](./relations.md).

## See also

- [systems](./systems.md), how to run queries, the `ctx` object, and the write surface
- [change detection](./change-detection.md), `changed()` and how the tick operates
- [relations](./relations.md), [sparse storage](./sparse-storage.md), the terms that are not dense
- [entities](./entities.md), enable, disable, and `includeDisabled`
