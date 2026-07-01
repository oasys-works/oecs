# Change detection

Change detection lets a system process only what changed since it last ran, instead of everything. It's built on a **tick** the `ECS` advances each frame: whenever you write a component, that component's slot on its archetype is stamped with the current tick. A `changed()` query then matches archetypes stamped since the querying system's previous run.

```ts
const moved = ecs.query(Pos).changed(Pos);   // archetypes whose Pos changed since last run

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

## What bumps the tick

A write stamps the component's change tick; a read does not:

| Bumps the tick | Does **not** bump |
| --- | --- |
| `cols.mut(def)` (in `eachChunk`) | `cols.read(def)` |
| `ctx.ref(def, e)` | `ctx.refRead(def, e)` |
| `ctx.setField` / `ctx.updateField` | `ctx.getField` |

Note `cols.mut` and `ctx.ref` stamp **eagerly** — the moment you acquire the mutable accessor, before any actual write, and even if you never write. That keeps change detection conservative (it never misses a change) at the cost of the occasional false positive.

## `changed()`

```ts
changed(...defs: ComponentDef[]): ChangedQuery<Defs>;
```

Returns a `ChangedQuery` that yields each non-empty archetype where **any** listed component was stamped at or after the system's last-run tick. Every `def` must already be in the query's include mask.

> [!WARNING]
> **Granularity is archetype, not row.** If one entity in a 1000-row archetype writes `Pos`, the *whole* archetype trips as "changed" next tick — the `changed()` query hands you all 1000 rows, not the one. Change detection tells you *which archetypes to look at*, not *which rows changed*. For per-entity precision use an entity-granular [`onSet` observer](./observers.md) instead.

## `ChangedQuery` is composable

The returned `ChangedQuery` mirrors the dense refine verbs, so you can keep narrowing after `changed()`:

```ts
and<D>(...comps): ChangedQuery<[...Defs, ...D]>;
without(...comps): ChangedQuery<Defs>;
anyOf(...comps): ChangedQuery<Defs>;
optional(...defs): ChangedQuery<Defs>;
forEach(cb: (arch: ArchetypeView) => void): void;   // the terminal — read-only, like Query.forEach
```

```ts
ecs.query(Pos).changed(Pos).without(Dead);   // changed Pos, excluding dead entities
```

Order doesn't matter: `q.changed(Pos).without(Dead)` and `q.without(Dead).changed(Pos)` are the same set. A `ChangedQuery` has no `eachChunk`, `count`, or further `changed` — just the five verbs above; iterate it with `forEach`.

## `lastRunTick` and skipped ticks

The comparison is against the *system's* last-run tick, so each system sees changes since *it* last ran.

> [!NOTE]
> A system skipped by a `false` [run condition](./schedule.md#run-conditions) does **not** advance its last-run tick — so the next time it runs, it still sees everything that changed while it was skipped. Nothing is missed across a gated pause.

## `onSet` — change detection as a callback

Instead of polling with `changed()`, you can be **called** when a component changes, via an [`onSet` observer](./observers.md):

- **archetype-granular** (`granularity: "archetype"`, the default) reuses the same free change tick — you get `(arch, ctx)` per changed archetype-column and iterate its rows yourself.
- **entity-granular** (`granularity: "entity"`) gives you `(eid, ctx)` per changed entity, but registering it turns on per-row dirty tracking for that component (a write-path cost). Choose by how densely the component changes.

> [!TIP]
> When you write a component through the **raw** mutable column (not `setField`/`ref`), an entity-granular `onSet` observer won't see it unless you call `ctx.markChanged(entity, def)` in the loop. `setField`/`updateField` record it automatically.

## See also

- [queries](./queries.md) — `changed()` in the verb list; `forEach`/`eachChunk`
- [observers](./observers.md) — `onSet` and its granularity tradeoff
- [refs](./refs.md) — why `ref` bumps the tick and `refRead` doesn't
