# Change detection

Change detection lets a system process only what changed since its last run, and not everything. It
uses a **tick** that the `ECS` increases in each frame. When you write a component, the engine sets
the slot of that component on its archetype to the current tick. A `changed()` query then agrees
with each archetype that has a tick at or after the previous run of the system that queries.

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
| `cols.mut(def)` (in `eachChunk`) | `cols.read(def)` |
| `ctx.ref(def, e)` | `ctx.refRead(def, e)` |
| `ctx.setField` / `ctx.updateField` | `ctx.getField` |

Note that `cols.mut` and `ctx.ref` set the tick **immediately**. They set it at the moment that you
get the mutable accessor, before an actual write, and also if you never write. This keeps change
detection conservative: it never misses a change. The cost is an occasional incorrect report of a
change.

## `changed()`

```ts
changed(...defs: ComponentDef[]): ChangedQuery<Defs>;
```

This gives you a `ChangedQuery`. The query gives each non-empty archetype in which **one or more**
of the listed components has a tick at or after the last-run tick of the system. Each `def` must
already be in the include mask of the query.

> [!WARNING]
> **The level of detail is the archetype, and not the row.** If one entity in an archetype of 1000
> rows writes `Pos`, the *full* archetype becomes "changed" in the next tick. The `changed()` query
> then gives you all 1000 rows, and not the one row. Change detection tells you *which archetypes
> to examine*, and not *which rows changed*. For exact information about each entity, use an
> [`onSet` observer](./observers.md) with entity granularity instead.

## A `ChangedQuery` composes

The `ChangedQuery` has the same dense verbs, so you can continue to make the query more exact after
`changed()`:

```ts
and<D>(...comps): ChangedQuery<[...Defs, ...D]>;
without(...comps): ChangedQuery<Defs>;
anyOf(...comps): ChangedQuery<Defs>;
optional(...defs): ChangedQuery<Defs>;
forEach(cb: (arch: ArchetypeView) => void): void;   // the terminal — read-only, as Query.forEach is
```

```ts
ecs.query(Pos).changed(Pos).without(Dead);   // Pos changed, and the dead entities are removed
```

The order is not important. `q.changed(Pos).without(Dead)` and `q.without(Dead).changed(Pos)` give
the same set. A `ChangedQuery` has no `eachChunk`, no `count`, and no second `changed`. It has only
the five verbs above. Iterate it with `forEach`.

## `lastRunTick` and the ticks that a system skips

The comparison uses the last-run tick of *that system*. So each system sees the changes since
*it* last ran.

> [!NOTE]
> When a [run condition](./schedule.md#run-conditions) gives `false` and the system does not run,
> its last-run tick does **not** increase. So, the next time that the system runs, it still sees
> each change that happened while it did not run. It misses nothing across a period in which a gate
> stopped it.

## `onSet` — change detection as a callback

Instead of a `changed()` query, the ECS can **call** you when a component changes. Use an
[`onSet` observer](./observers.md):

- **Archetype granularity** (`granularity: "archetype"`, the default) uses the same change tick,
  which costs nothing more. You receive `(arch, ctx)` for each archetype column that changed, and
  you iterate the rows yourself.
- **Entity granularity** (`granularity: "entity"`) gives you `(entityId, ctx)` for each entity that
  changed. But registration of this observer turns on a dirty list for each row of that component,
  and that list has a cost on the write path. Select the granularity by the density of the changes.

> [!TIP]
> If you write a component through the **raw** mutable column, and not through `setField` or `ref`,
> an `onSet` observer with entity granularity does not see the write. To make it visible, call
> `ctx.markChanged(entity, def)` in the loop. `setField` and `updateField` record it
> automatically.

## See also

- [queries](./queries.md) — `changed()` in the list of verbs, and `forEach` and `eachChunk`
- [observers](./observers.md) — `onSet` and the compromise between the two granularities
- [refs](./refs.md) — why `ref` sets the tick and `refRead` does not
