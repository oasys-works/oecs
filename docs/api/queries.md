# Queries

A **query** is a live, cached view over every archetype that matches a set of components. You build it once and reuse it every frame — the store keeps pushing newly-matching archetypes into it as they appear, so it never goes stale.

```ts
const movers = ecs.query(Pos, Vel);   // every archetype with (at least) Pos AND Vel
```

`ecs.query(A, B, C)` matches entities that have **all** of `A`, `B`, and `C` (and possibly more). Order doesn't matter, and repeated calls with the same set return the **same cached instance**.

## Reading vs writing — pick your terminal

The single most important decision in a query is how you iterate it, because that decides whether you can mutate:

| Terminal | Callback gets | Mutate? | Use for |
| --- | --- | --- | --- |
| [`forEach`](#foreach--read-only) | a read-only `ArchetypeView` | no | reading columns |
| [`eachChunk`](#eachchunk--mutable-hot-path) | mutable `cols` + `count` | **yes** | the mutating hot loop |
| [`forEachEntity`](#foreachentity--non-dense-terms) | one `EntityID` at a time | via `ctx` | queries with sparse/relation/hierarchy terms |

```ts
// Read-only pass:
movers.forEach((arch) => {
  const x = arch.getColumnRead(Pos, "x");           // read-only column
  for (let i = 0; i < arch.entityCount; i++) sum += x[i];
});

// Mutating pass — the recommended default when you write:
movers.eachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);                   // mutable columns; stamps Pos's change tick
  const { vx, vy } = cols.read(Vel);                // read-only columns; no tick bump
  for (let i = 0; i < count; i++) {
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
});
```

## Building queries

Two entry points, same result:

```ts
// Host side / stored on the ECS:
query<T extends ComponentDef[]>(...defs: T): Query<T>;
const movers = ecs.query(Pos, Vel);

// Inside a system via the query-builder overload of registerSystem:
const move = ecs.registerSystem(
  (q, ctx, dt) => { q.eachChunk(/* ... */); },
  (qb) => qb.with(Pos, Vel),   // resolved ONCE at registration
);
```

`QueryBuilder.with(...)` is identical to `ecs.query(...)`; it's just the form handed to systems. Most code declares queries with `ecs.query(...)` and closes over them — see [systems](./systems.md) for why that's usually cleaner than the builder overload.

## Refine verbs

Each verb returns a **new cached query**; the receiver is never mutated. Composition is memoized, so `q.and(A).and(B)` and `q.and(A, B)` are the same instance.

```ts
and<D>(...comps: D): Query<[...Defs, ...D]>;   // also require these  (narrows the set)
without(...comps): Query<Defs>;                 // exclude archetypes holding ANY of these
anyOf(...comps): Query<Defs>;                   // require AT LEAST ONE of these
optional(...defs): Query<Defs>;                 // fetch-if-present (does NOT narrow the set)
changed(...defs): ChangedQuery<Defs>;           // only archetypes changed since last run
includeDisabled(): Query<Defs>;                 // opt disabled entities back in
```

```ts
ecs.query(Pos)
  .and(Vel)              // require Vel too
  .without(Frozen)       // drop frozen entities
  .anyOf(Player, NPC);   // and be a Player OR an NPC
```

- **`without`** excludes an archetype if it holds *any* listed component. **`anyOf`** requires *at least one*; successive `anyOf` calls union into one "≥1 of these" set.
- **`optional(T)`** widens what you can *read*, not what you *match* — iteration still spans archetypes with and without `T`. Read it with `arch.getOptionalColumnRead(T, field)`, which returns the column when present and `undefined` when absent. `.optional(T)` is also the **authorization** to fetch `T` optionally; you still need `T` in the system's `reads` (both checks fire).
- **`changed(...)`** returns a [`ChangedQuery`](./change-detection.md) — see that page; note the granularity is *archetype*, not row.
- **`includeDisabled()`** widens iteration to cover [disabled](./entities.md#enable--disable) entities, which are excluded by default.

## `forEach` — read-only

```ts
forEach(cb: (arch: ArchetypeView) => void): void;
forEachUntil(cb: (arch: ArchetypeView) => boolean): boolean;   // stop when cb returns true
```

`forEach` calls back once per **non-empty** matching archetype with a read-only `ArchetypeView`:

```ts
interface ArchetypeView {
  readonly id: ArchetypeID;
  readonly entityCount: number;   // ← your loop bound (enabled rows)
  readonly totalCount: number;    // includes disabled rows
  readonly disabledCount: number;
  readonly entityIds: ReadonlyEntityIdArray;
  hasComponent(id): boolean;
  getColumnRead(def, field): ReadonlyColumn;                 // read-only column
  getColumnsRead(def, ...fields): [ReadonlyColumn, ...];      // several at once
  getOptionalColumnRead(def, field): ReadonlyColumn | undefined;  // for .optional(def)
}
```

> [!WARNING]
> **Always loop to `arch.entityCount`, never a column's `.length`.** A column's raw buffer includes capacity and disabled slots past the live count; iterating `.length` reads stale/garbage rows. `entityCount` is the enabled-row count (or all rows under `includeDisabled`). The [`eachChunk`](#eachchunk--mutable-hot-path) `count` parameter exists precisely to remove this trap.

> [!NOTE]
> The `ArchetypeView` deliberately **omits any mutable column accessor** — you cannot write through `forEach`. To mutate, either use [`eachChunk`](#eachchunk--mutable-hot-path), or write per entity with [`ctx.ref`](./refs.md) / `ctx.setField` (both bump the change tick). `ReadonlyColumn` is a compile-time barrier only; a cast can write through it, but doing so skips change detection and corrupts it — don't.

## `eachChunk` — mutable hot path

```ts
eachChunk(cb: (cols: ChunkColumns, count: number) => void): void;
```

The recommended default for **mutating** systems. `cols` resolves whole components into destructurable column groups; `count` is the enabled-row count.

```ts
interface ChunkColumns {
  mut<S>(def: ComponentDef<S>): MutableColumnsForSchema<S>;   // writable; stamps the change tick
  read<S>(def: ComponentDef<S>): ColumnsForSchema<S>;         // read-only; no tick bump
}

movers.eachChunk((cols, count) => {
  const { x, y } = cols.mut(Pos);     // { x: Float64Array, y: Float64Array }, writable
  const { vx, vy } = cols.read(Vel);
  for (let i = 0; i < count; i++) { x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
});
```

> [!IMPORTANT]
> `cols.mut(def)` stamps `def`'s change tick for this archetype **once, when you call it** — before you've written anything. That's what makes [`changed(def)`](./change-detection.md) queries see this archetype next tick. If you only read, call `cols.read(def)` so you don't trip false positives. The tick value is captured once per `eachChunk` pass and reused across archetypes.

> [!WARNING]
> **Destructure the group immediately; don't retain it.** The object `cols.mut(Pos)` returns is cached per `(archetype, component)` and refreshed **in place** on the next call — grab `{ x, y }` and use the arrays, don't stash the group object across iterations.

## `forEachEntity` — non-dense terms

```ts
forEachEntity(cb: (entityId: EntityID) => void): void;
```

Yields matching entities one id at a time. This is **required** for any query carrying a [sparse](./sparse-storage.md), [relation](./relations.md), or hierarchy term — those members scatter across archetypes, so there's no column span to hand you. Read fields on the yielded entity with `ctx.getField` (dense) or `ctx.getSparseField` (sparse).

> [!WARNING]
> Iteration walks the store's **live** key array. Mutating the driving sparse/relation membership *during* the walk (which applies immediately) shifts the array under you. Buffer such edits and apply them after the loop.

## Dense-only restriction

`forEach`, `eachChunk`, `count`, and `archetypeCount` operate on the archetype column layout and therefore **reject** queries carrying sparse/relation/hierarchy terms (they throw `SPARSE_QUERY_DENSE_PATH` in dev). Use `forEachEntity` (or [`forEachRelatedTo`](./relations.md)) for those.

## Introspection

```ts
count(): number;                            // enabled rows (or all, under includeDisabled)
get archetypeCount(): number;               // matching archetypes, including empty ones
get archetypes(): readonly ArchetypeView[]; // the raw list (not filtered to non-empty)
```

## Non-dense query terms (summary)

These carry a term that isn't part of the dense archetype mask. They compose with `and`/`without`/`anyOf` but must be iterated with `forEachEntity`/`forEachRelatedTo`. Full detail on their own pages:

```ts
withSparse(...defs): Query<Defs>;     withoutSparse(...defs): Query<Defs>;      // → sparse storage
withRelation(...defs): Query<Defs>;   withoutRelation(...defs): Query<Defs>;    // (R, *) → relations
forEachRelatedTo(target, cb): void;                                             // (*, T) → relations
hierarchy(relation, maxDepth?): Query<Defs>;                                    // depth-order → relations
```

> [!NOTE]
> Iterating a `(R, *)` / `(*, T)` query requires the system to authorize it: list the relation in `relationReads` (or `ANY_RELATION` for the `(*, T)` `forEachRelatedTo`). See [relations](./relations.md).

## See also

- [systems](./systems.md) — running queries, `ctx`, and the mutable write surface
- [change detection](./change-detection.md) — `changed()` and how the tick works
- [relations](./relations.md) · [sparse storage](./sparse-storage.md) — the non-dense terms
- [entities](./entities.md) — enable/disable and `includeDisabled`
