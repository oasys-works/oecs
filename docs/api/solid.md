# The Solid plugin

`solid()` is the one path from ECS state into a UI. It projects the store's
[change feed](./plugins.md#the-change-feed) into Solid signals, with nothing in between. This
release ships no other framework path, and no React path.

> **Optional.** The `ECS` does not depend on a framework, and it never imports a UI library.
> `solid-js` is an **optional** peer dependency, and only `@oasys/oecs/solid` imports it.

```txt
ECS -> change feed -> solid() -> Solid signals -> UI
```

## Install it

```ts
import { ECS } from "@oasys/oecs";
import { solid } from "@oasys/oecs/solid";

const world = ECS.create({ plugins: [solid()] });
const Pos = world.registerComponent({ x: "f64", y: "f64" }, { name: "Pos" });
const player = world.spawn();
```

`solid()` requires no other plugin, and observers are not involved.

A world that installs it carries `ecs.solid`. A world that does not carries no member of that
name. So `ecs.solid` is a compile error, and not a fault at run time. A bare world reserves no
`solid` slot. So a JavaScript caller reads `undefined` there, and no fault names the missing
import.

## The three entry points

`ecs.solid` has three entry points, and each one returns a view with a `dispose()`.

```ts
const xs = world.solid.component(Pos, (row) => row.field("x"));  // a scalar for each entity
const points = world.solid.fields(Pos, ["x", "y"]);              // {x, y} for each entity
const hud = world.solid.singleton(Pos, player, ["x", "y"]);      // one entity, no key
```

- **`component`** runs `project` once for each published entity. The reader it passes is one reused
  instance. Read what you need and return. Never capture it.
- **`fields`** is sugar over `component`. It builds one record for each published entity, and it
  supplies an `eq` that compares the listed fields. Prefer a scalar projection for a component that
  changes often.
- **`singleton`** publishes one entity's fields into a keyless Solid store. A remove or a disable of
  the target resets the fields to the values the store held at creation. One entity carries a fixed
  key set. So a store earns its cost there, and a reader tracks the field it reads.

## `cell` and `keys`

`cell(id)` is the row's value, as one Solid signal. The first call for an id makes that signal, and
every later call returns the same accessor. Bind it once for each row, in the row's own scope, and
never inside a jsx expression that re-evaluates. It reads `undefined` while the view does not hold
the id. A cell outlives a delete, so the same accessor reports the row leaving and returning.

`keys()` is a signal of the ids the view holds, and it gives a new array only when membership
changed. Key a `<For>` on the entity id.

```tsx
<For each={points.keys()}>{(id) => {
  const cell = points.cell(id);           // once for the row, never inside the jsx
  return <circle cx={cell()?.x} cy={cell()?.y} />;
}}</For>
```

## The options

`eq` is the value equality of every cell, handed to Solid as the signal's `equals`. An equal publish
wakes nobody. The default is Solid's own `===`. So a projection that returns a fresh object each
tick wakes its reader, unless it passes one. `fields` supplies its own.

```ts
world.solid.component(Pos, (row) => ({ x: row.field("x") }), { eq: (a, b) => a.x === b.x });
```

`grain` picks how the set half finds its rows.

```ts
world.solid.component(Pos, (row) => row.field("x"), { grain: "column" });
```

- **`"entity"`**, the default, publishes the rows the by-id write paths recorded. It turns on the
  row grain of that component, so every by-id write to it pays.
- **`"column"`** republishes every enabled row of an archetype whose column changed. It costs the
  write path nothing. Take it for a component that a chunk loop rewrites in each frame.

`seedExisting` publishes the current enabled members at creation, and it defaults to `true`.
`dispose()` drops the view and recomputes what the plugin asks of the feed. Once the last view of a
component goes, the write path stops paying for it.

## When it publishes

Everything publishes at the settle point, the tail of `update()`. A structural event arrives
mid-tick and records an entity id. Nothing reaches Solid inside the flush. The whole plugin then
publishes inside one Solid `batch`. One `update()` is one Solid flush, whatever the number of views.
An entity spawned and despawned in one tick never appears. A published value is the final value of
the tick.

> [!WARNING]
> **Only a deferred structural operation in the schedule reaches a view.** An immediate call on the
> host reaches none, and that covers `ecs.addComponent`, `ecs.disable` and `ecs.despawn`. This
> plugin records structural events from the flush the [observers](./observers.md) read. A host
> `ecs.setField` between two frames does reach the view, at the next `update()`.

This plugin and the observers plugin are two consumers of one feed. Install both, in either order,
and each one sees the same by-id write. `src/plugins/solid/__tests__/solid.test.ts` locks that, the
seed, the spawn and the despawn, and the disable and the enable. It locks the column grain, one
batch for each update, the singleton reset and the sparse refusal.

## What it refuses and what is untested

- **Dense components only.** A sparse definition throws a `TypeError` that names the call.
- **No join.** A view subscribes to one component. A projection that reads a second component goes
  stale, because no change of that second component republishes the row. Take one view per
  component, and combine them where you read.
- **An entity listed twice in one tick projects twice.** It happens when the entity leaves the
  component and rejoins. The value is the final one.
- **One signal per row, so a field read does not track the field alone.** A cell carries the whole
  projected value, so any change to the row wakes every reader of it. Project only the fields a view
  reads, or take one view per field.
- **A projection must not return a function.** A Solid setter reads a function argument as an
  updater. The publish passes the value straight through, which keeps a closure off the per-row
  path.
- **A cell is kept for the life of the view.** `cell(id)` makes a signal on the first call and never
  drops it. So a view over a world that churns entity ids grows.
- **The browser claims are untested.** Under the test runner, `solid-js` resolves to its server
  build. There a signal holds a value, consults no comparator and schedules no effect. The tests
  assert the value, and they assert that `eq` reaches the signal and then run it by hand. The suite
  renders no component, so it proves nothing about a `<For>` re-render.
- **Measured against the path it replaced.** `bench/foundations/p23-solid.mjs` times a whole tick on
  both paths, with one effect per entity. Once warm, this design is the cheaper of the two at every
  dense density the probe measures. The gap widens with density. Its publish alone, with no
  subscriber, costs less as well. On a tick that moves one row or no row the older path measures
  lower. The first design here wrote a Solid store keyed by entity id. It lost at every density,
  which is why a row is a signal.

## See also

- [plugins](./plugins.md), the change feed this plugin drains, and the host it installs against
- [observers](./observers.md), the per-entity callback that reads the same feed
- [change detection](./change-detection.md), the dirty tracking behind the row grain
- [the host write path](./host-write-seam.md), the write side (UI to ECS) that pairs with this
  read side
- [editor](./editor.md), undo, redo, and field handles, which use both sides
