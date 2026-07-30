# Extensions

oecs keeps the core package small, and the core does not depend on a framework. The `@oasys/oecs`
entry point is sufficient for a simulation, a server, a test harness, or a game loop with no
display. The extensions are separate import paths for UI reads, host writes, editor work, framework
adapters, shared memory, and primitives that you can use again.

Use an extension when code outside the ECS schedule must observe or change the state of the world.
Import only the subpath that you need, because the core bundle does not contain an extension that
you do not use.

## The map of the extensions

| Import | Use it for | It depends on |
| --- | --- | --- |
| `@oasys/oecs/reactive` | signals, computed values, effects, and reactive collections, with no framework | no third-party package |
| `@oasys/oecs/reactive-sync` | how to publish the changes of an ECS component into a reactive collection | the observers in `@oasys/oecs`, and `@oasys/oecs/reactive` |
| `@oasys/oecs/editor` | undo, redo, and field handles for an inspector | the host write path in `@oasys/oecs` |
| `@oasys/oecs/solid` | how to read the reactive values of oecs from a SolidJS component | the optional peer `solid-js` |
| `@oasys/oecs/shared` | `SharedArrayBuffer` storage for a worker or a WASM backend | cross-origin isolation, in a browser |
| `@oasys/oecs/primitives` | the data structures of oecs, which operate alone | no third-party package |

You usually connect the UI extension and the editor extension as two channels, each in one
direction:

```txt
ECS -> reactive-sync -> reactive collections -> framework adapter -> UI
UI  -> editor/host command queue -> ECS schedule head
```

The read side publishes only the rows that changed. The write side puts typed commands in a queue,
and it applies them at a safe point in the schedule.

## How to select the correct extension

Use `@oasys/oecs/reactive` alone when you want a small kernel for signals, or reactive collections,
outside the ECS. It has no link to an entity or to a component.

Use `@oasys/oecs/reactive-sync` when a UI, a renderer, an overlay for debugging, or a panel for
telemetry must follow the state of the ECS without a scan of each entity in each frame.

Use `@oasys/oecs/editor` when a change must be reversible, or must operate as an inspector control
that binds in two directions. It is built on the host write path, so the ECS applies each edit,
instead of an event handler that writes directly.

Use `@oasys/oecs/solid` at the boundary of a Solid component alone. The kernel and Solid are
separate reactive graphs. So a plain read of the kernel inside Solid does not subscribe, until
you bridge it through `fromKernel`, `fromKernelMap`, `fromKernelStruct`, or `fromKernelArray`.

Use `@oasys/oecs/shared` when you need shared memory for a worker or for a WASM compute backend.
The default `ECS` uses a plain `ArrayBuffer`, and it does not need COOP/COEP.

Use `@oasys/oecs/primitives` when a different package wants the same low-level structures, and does
not want a dependency on the ECS.

## Reactive reads

`reactive-sync` makes the state of a component into reactive channels. Each sync function gives you
the channel and a `dispose()` function, and by default it sets the initial values from each entity
that already agrees with it.

```ts
import { ECS } from "@oasys/oecs";
import { batchedUpdate, shallow, syncComponentToMap, syncFieldsToMap } from "@oasys/oecs/reactive-sync";

const ecs = new ECS();
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Health = ecs.registerComponent({ hp: "i32", max: "i32" });
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });
ecs.addComponent(player, Health, { hp: 100, max: 100 });

const positions = syncComponentToMap(
  ecs,
  Pos,
  (row) => ({ x: row.field("x"), y: row.field("y") }),
  { eq: shallow },
);

const health = syncFieldsToMap(ecs, Health, ["hp", "max"] as const);

// In your frame loop, put the publications of the ECS observers into one reactive flush.
batchedUpdate(ecs, 1 / 60);

const p = positions.map.get(player);
const hp = health.map.get(player)?.hp;

positions.dispose();
health.dispose();
```

Use `syncComponentToMap` for one component. Use `syncFieldsToMap` for the frequent case of "make a
copy of these fields", because it uses shallow equality for the object that it builds. Use
`syncJoinToMap` when the projection reads more than one component, because it subscribes to each
component in the join, and so no row becomes out of date.

> [!WARNING]
> The sync bridges remove a row through an `onRemove` observer, and an observer runs only for a
> **deferred** operation. An immediate `ecs.despawn(e)` call on the host, which is the behavior
> since 0.5.0, is invisible to them. So the copied `Map` keeps the row of the dead entity without
> a limit, because the bridges set their values one time at registration and there is no periodic
> synchronization. When a reactive bridge is attached, destroy each entity through
> `ctx.commands.despawn` or through the host command path.

For a component that changes frequently, consider
`syncComponentToMap(..., { grain: "column" })`. It examines the dirty archetype columns in sequence,
and it keeps no list of the changed rows. Select it when most rows of a component change.

For UI state that is a single value, put that state on an entity that you keep for the purpose, and
use `syncSingletonToStruct` or `syncSingletonToArray`:

```ts
import { syncSingletonToStruct } from "@oasys/oecs/reactive-sync";

const NetStats = ecs.registerComponent({ connected: "u8", latencyMs: "f64" });
const netEntity = ecs.spawn();
ecs.addComponent(netEntity, NetStats, { connected: 0, latencyMs: -1 });

const net = syncSingletonToStruct(ecs, NetStats, netEntity, ["connected", "latencyMs"] as const);

net.struct.connected; // a reactive read of one field
net.dispose();
```

The rules for `reactive-sync`:

- Give `eq: shallow`, or your own comparator, when a projection gives a new object. The default
  equality is `Object.is`. So a new object reference starts each subscriber, also when the fields
  did not change.
- Do not read a second component from a projection of one component. Use `syncJoinToMap`.
- Drive the world with `batchedUpdate(ecs, dt)`, or put `ecs.update(dt)` inside `batch(...)` from
  `@oasys/oecs/reactive`.
- Keep the dispose function that you receive, and call it when the UI, the world, or the test
  fixture ends.

See [reactive](./api/reactive.md) for the full API.

## Rendering with Solid

The Solid adapter copies the values of the kernel into Solid signals, and it disposes of each
subscription with the Solid owner that contains it.

```tsx
import { For } from "solid-js";
import { fromKernelMap } from "@oasys/oecs/solid";

const positionView = fromKernelMap(positions.map);

function Dots() {
  return (
    <svg>
      <For each={positionView.keys()}>
        {(id) => {
          const pos = positionView.cell(id);
          return <circle cx={pos()?.x ?? 0} cy={pos()?.y ?? 0} r={3} />;
        }}
      </For>
    </svg>
  );
}
```

Use the keyed Solid `<For>` for a map of entities, with the stable `EntityID` as the key. Use
`fromKernelArray` with the Solid `<Index>` for an ordered array of one entity. Call each
`fromKernel*` function inside a component, or inside a Solid `root`, so that the adapter has an
owner for the cleanup.

## Host writes

The core entry point exports the host write path, because it is the usual write path for a UI, an
editor, a network, and a worker. It holds each write as a typed command, and it applies each one
through an exclusive system at the head of a phase.

```ts
import { installHostCommandSeam, spawnEntry } from "@oasys/oecs";
import { batchedUpdate } from "@oasys/oecs/reactive-sync";

const queue = installHostCommandSeam(ecs); // install it before startup()
const player = ecs.spawn();
ecs.addComponent(player, Health, { hp: 100, max: 100 });

queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (entityId) => {
  console.log("spawned", entityId);
});
queue.setField(player, Health, "hp", 75);

batchedUpdate(ecs, 1 / 60); // drains the commands in the queue, then publishes the reactive reads
```

Each method of the queue adds a command to the queue. Nothing reaches the world until the apply
system drains, at the next `startup()` or `update()` call.

Important rules about timing:

- Install the path before you add the systems that must run after a host write, and before
  `startup()`.
- Carry the initial values in `spawnEntry` or in `add`. Do not put `add(e, C, ...)` and
  `setField(e, C, ...)` for the same component in the queue in the same frame, because a structural
  write flushes after the immediate drain of `setField`.
- Use `onSpawned` to learn the id of an entity that a queued spawn created.

See [the host write path](./api/host-write-seam.md) for the command log, the replay, and the ring
transport between threads.

## How to use the editor

`@oasys/oecs/editor` puts undo and redo transactions above the host command queue. Each edit
records a list of forward commands and a list of inverse commands. `undo()` puts the inverse list
in the queue, and `redo()` puts the forward list in the queue. Both apply in the next tick, as each
other host write does.

```ts
import { Editor, fieldHandle } from "@oasys/oecs/editor";
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);
const editor = new Editor(queue, (entityId, def, field) => ecs.getField(entityId, def, field));
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });

editor.transaction((tx) => {
  tx.setField(player, Pos, "x", 10)
    .setField(player, Pos, "y", 20);
});

editor.undo();
batchedUpdate(ecs, 1 / 60); // applies the undo
```

A field handle gives a reactive read together with a write that you can undo:

```ts
const hpHandle = fieldHandle(
  editor,
  player,
  Health,
  "hp",
  () => health.map.get(player)?.hp,
);

hpHandle.value;      // the committed reactive value
hpHandle.pending;    // an optional optimistic copy, before the next tick
hpHandle.set(50);    // adds a setField that you can undo
```

The rules for the editor:

- The `FieldReader` that you give to `new Editor(...)` must read the committed state. Use
  `ecs.getField` for a simple tool, or your reactive read channel for UI code.
- `pending` is not reactive. It is only an optimistic copy, until the read side is current.
- An undo of a despawn returns the data, but it creates the entity with a new `EntityID`.

See [editor](./api/editor.md) for the full transaction API.

## A complete UI loop

This is the usual shape for a browser or an editor:

```ts
import { ECS, installHostCommandSeam } from "@oasys/oecs";
import { Editor } from "@oasys/oecs/editor";
import { batchedUpdate, shallow, syncComponentToMap } from "@oasys/oecs/reactive-sync";

const ecs = new ECS();
const queue = installHostCommandSeam(ecs);
const editor = new Editor(queue, (entityId, def, field) => ecs.getField(entityId, def, field));

const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });

const positions = syncComponentToMap(
  ecs,
  Pos,
  (row) => ({ x: row.field("x"), y: row.field("y") }),
  { eq: shallow },
);

ecs.startup();

let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  batchedUpdate(ecs, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

editor.setField(player, Pos, "x", 128);
```

If you use Solid, bridge `positions.map` with `fromKernelMap`. If you use React, bridge the
accessors of the kernel with `toExternalStore` from `@oasys/oecs/reactive`.

## Shared memory and the primitives

`@oasys/oecs/shared` is for advanced integration, where the store of the ECS must be in shared
memory. A browser application needs cross-origin isolation before it can use a
`SharedArrayBuffer`. The default heap world does not have that requirement.

`@oasys/oecs/primitives` exports the structures that operate alone, such as `BitSet`, `SparseSet`,
`SparseMap`, `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort`. Import them directly when
you need those tools and do not want to create an `ECS`.

## See also

- [API reference](./api/index.md)
- [reactive](./api/reactive.md)
- [the host write path](./api/host-write-seam.md)
- [editor](./api/editor.md)
- [memory](./api/memory.md)
- [primitives](./api/primitives.md)
