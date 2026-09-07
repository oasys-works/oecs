# Change detection

Change detection lets a system process only what changed since its last run, and not everything.
The engine keeps a **change tick**, a counter that advances before each system run. When you write
a component, the engine finds the slot of that component on its archetype. It sets that slot to the
current change tick. A `changed()` query then gives each archetype whose slot is above one tick.
That tick is the change tick of the previous run of the system that queries.

```ts
const moved = ecs.query(Pos).changed(Pos);   // archetypes whose Pos changed since the last run

const syncTransforms = ecs.registerSystem({
  reads: [Pos], writes: [],
  fn: () => {
    moved.forEach((arch) => {
      const x = arch.getColumnRead(Pos, "x");
      for (let i = 0; i < arch.entityCount; i++) pushToRenderer(arch.entityIds[i], x[i]);
    });
  },
});
```

## What sets the tick

A write sets the change tick of the component. A read does not.

| Sets the tick | Does **not** set the tick |
| --- | --- |
| `cols.mut(def)` (in `forEachChunk`) | `cols.read(def)` |
| `ctx.ref(def, e)` | `ctx.refRead(def, e)` |
| `ctx.cursor(def).at(e)` | `ctx.cursorRead(def).at(e)` |
| `ctx.setField` and `ctx.updateField` | `ctx.getField` |

`cols.mut`, `ctx.ref` and a mutable cursor set the tick **immediately**. They set it at the moment
that you get the mutable accessor. They set it before an actual write, and also if you never write.
This keeps
change detection conservative: it never misses a change. The cost is an occasional incorrect
report of a change.

The change tick is not `ctx.ecsTick`. `ctx.ecsTick` counts frames. The change tick advances before
each system run. So the engine can order a write against the last run of each reader inside one
frame. The engine reports one write one time:

- on the frame it happens, when the reader runs after the writer
- on the next frame, when the reader runs first

A system sees its own writes inside the run that made them, and not again on its next run. A write
on the host between two frames is reported on the next frame.

## `changed()`

```ts
changed(...defs: ComponentDef[]): ChangedQuery<Defs>;
```

This gives you a `ChangedQuery`. The query gives each non-empty archetype in which **one or more**
of the listed components has a fresh stamp. A fresh stamp is above the last-run tick of the system.
Each `def` must already be in the include mask of the query.

> [!WARNING]
> **The level of detail is the archetype, and not the row.** If one entity in an archetype of 1000
> rows writes `Pos`, the *full* archetype becomes "changed" in the next tick. The `changed()` query
> then gives you all 1000 rows, and not the one row. Change detection tells you *which archetypes
> to examine*, and not *which rows changed*. For exact information about each entity, use an
> [`onSet` observer](./observers.md) with entity granularity instead.

## A `ChangedQuery` composes

A `ChangedQuery` carries four of the dense verbs, so you can continue to make the query more exact
after `changed()`:

```ts
and<D>(...comps): ChangedQuery<[...Defs, ...D]>;
not(...comps): ChangedQuery<Defs>;
or(...comps): ChangedQuery<Defs>;
optional(...defs): ChangedQuery<Defs>;
forEach(cb: (arch: ArchetypeView) => void): void;   // the terminal, read-only like Query.forEach
```

```ts
ecs.query(Pos).changed(Pos).not(Dead);   // Pos changed, and the dead entities are removed
```

The order is not important. `q.changed(Pos).not(Dead)` and `q.not(Dead).changed(Pos)` give
the same set. A `ChangedQuery` has no count getter and no second `changed`. Iterate it with `forEach`,
or with `forEachChunk` for the row grain below.

## The row grain

The archetype grain tells you which archetypes to examine. The row grain tells you which rows. Turn
it on for a component with `ecs.trackRows(def)`. From then on every archetype that holds `def` keeps
one change tick for each row. Every write path stamps it: `setField`, `updateField`, `ref`, a
mutable cursor, `markChanged`, and a store into `cols.ticks(def)` in a chunk loop. An
[`onSet` observer](./observers.md) with entity granularity turns it on as well. It costs one word
for each row, and one store on each by-id write. It is never turned off.

```ts
ecs.trackRows(Pos);
const moved = ecs.query(Pos).changed(Pos);

const syncTransforms = ecs.registerSystem({
  reads: [Pos], writes: [],
  fn: () => {
    moved.forEachChunk((cols, count) => {
      const { x } = cols.read(Pos);
      const t = cols.ticksRead(Pos);
      const ids = cols.arch.entityIds;
      for (let i = 0; i < count; i++) if (t[i] > cols.since) pushToRenderer(ids[i], x[i]);
    });
  },
});
```

`cols.since` is the change tick of the previous run of the system, and 0 on its first run. A row
whose tick is above it changed since that run. `changed(def).forEachChunk` visits the archetypes
that `forEach` visits. So the loop runs over the rows of the archetypes a writer stamped. The
compare picks the rows out. A raw column write in a chunk loop records nothing on its own. A
writer that wants its rows seen at this grain stores `cols.tick` into `cols.ticks(def)` beside
each write. `cols.ticksRead` and `cols.ticks` throw `ROW_TICKS_NOT_TRACKED` for a component with no
row ticks.

## `lastRunTick` and the ticks that a system skips

The comparison uses the last-run tick of *that system*, which is the change tick of its previous
run. So each system sees the changes since *it* last ran.

> [!NOTE]
> When a [run condition](./schedule.md#run-conditions) gives `false` and the system does not run,
> its last-run tick does **not** increase. So, the next time that the system runs, it still sees
> each change that happened while it did not run. It misses nothing across a period in which a gate
> stopped it.

## `onSet`, change detection as a callback

Instead of a `changed()` query, the ECS can **call** you when a component changes. Use an
[`onSet` observer](./observers.md):

- **Archetype granularity** (`granularity: "archetype"`, the default) uses the same change tick,
  which costs nothing more. You receive `(arch, ctx)` for each archetype column that changed, and
  you iterate the rows yourself.
- **Entity granularity** (`granularity: "entity"`) gives you `(entityId, ctx)` for each entity that
  changed. But registration of this observer turns on a dirty list for each row of that component.
  That list has a cost on the write path. Select the granularity by the density of the changes.

> [!TIP]
> If you write a component through the **raw** mutable column from `cols.mut`, an `onSet` observer
> with entity granularity does not see the write. To make it visible, store the change tick into
> the row of `cols.ticks(def)`: `t[i] = cols.tick`. That is one store per row. `ctx.markChanged`
> does the same by entity id, at the cost of a call and a list push. `setField` and `updateField`
> record the entity. `ref` records it when you create the ref, and a mutable cursor records it on
> each `at`, whether or not you write. A sparse component has the row grain alone, through
> `ctx.sparseChanged` and the entity-level `onSet`. See [sparse storage](./sparse-storage.md).

## See also

- [queries](./queries.md), `changed()` in the list of verbs, and `forEach` and `forEachChunk`
- [observers](./observers.md), `onSet` and the compromise between the two granularities
- [refs](./refs.md), why `ref` sets the tick and `refRead` does not
