# The optional entry points

oecs keeps the core package small, and the core does not depend on a framework. The `@oasys/oecs`
entry point serves a simulation, a server, a test harness, or a game loop with no display. The
other import paths cover UI reads, host writes, editor work, shared memory, and primitives that you
can use again.

Take one of them when code outside the ECS schedule must observe or change the state of the world.
Import only the subpath that you need, because the core bundle carries no path you do not use.

## The map

| Import | Use it for | It depends on |
| --- | --- | --- |
| `@oasys/oecs/solid` | how to read ECS state from a SolidJS component | the optional peer `solid-js` |
| `@oasys/oecs/editor` | undo, redo, and field handles for an inspector | the host write path in `@oasys/oecs` |
| `@oasys/oecs/shared` | `SharedArrayBuffer` storage for a worker or a WASM backend | cross-origin isolation, in a browser |
| `@oasys/oecs/primitives` | the data structures of oecs, which operate alone | no third-party package |

The UI connects as two channels, each in one direction:

```txt
ECS -> change feed -> solid() -> Solid signals -> UI
UI  -> editor and the host command queue -> ECS schedule head
```

The read side publishes only the rows that changed. The write side puts typed commands in a queue,
and it applies them at a safe point in the schedule.

## How to select the path

Take `@oasys/oecs/solid` when code outside the schedule must follow the state of the ECS. That
covers a UI, a renderer, an overlay for debugging, and a panel for telemetry. No consumer scans
each entity in each frame. It is the one path into a UI, and this release ships no other framework
path. A React consumer has no supported path here.

Take `@oasys/oecs/editor` when a change must be reversible, or must drive an inspector control that
binds in two directions. It sits on the host write path, so the ECS applies each edit. An event
handler never writes directly.

Take `@oasys/oecs/shared` when you need shared memory for a worker or for a WASM compute backend.
The default `ECS` uses a plain `ArrayBuffer`, and it needs neither COOP nor COEP.

Take `@oasys/oecs/primitives` when a different package wants the same low-level structures, and does
not want a dependency on the ECS.

## Reads into Solid

`solid()` is a plugin, so the world installs it at construction. Each entry point on `ecs.solid`
returns a view with a `dispose()`, and it seeds the current members by default.

```tsx
import { ECS } from "@oasys/oecs";
import { solid } from "@oasys/oecs/solid";
import { For } from "solid-js";

const ecs = ECS.create({ plugins: [solid()] });
const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const Health = ecs.registerComponent({ hp: "i32", max: "i32" });
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });
ecs.addComponent(player, Health, { hp: 100, max: 100 });

const points = ecs.solid.fields(Pos, ["x", "y"] as const);
const hud = ecs.solid.singleton(Health, player, ["hp", "max"] as const);

function Dots() {
  return (
    <svg>
      <For each={points.keys()}>
        {(id) => {
          const cell = points.cell(id);      // once for the row, never inside the jsx
          return <circle cx={cell()?.x ?? 0} cy={cell()?.y ?? 0} r={3} />;
        }}
      </For>
    </svg>
  );
}

hud.value.hp;    // a tracked read of one field
points.dispose();
hud.dispose();
```

Take `component` for one component and a projection you write. Take `fields` for the frequent case
of "copy these fields", because it supplies an `eq` that compares the listed fields. Take
`singleton` for UI state that is one value, held on an entity you keep for the purpose.

> [!WARNING]
> **Only a deferred structural operation reaches a view.** An immediate `ecs.despawn(e)` call on the
> host reaches none, which is the behaviour since 0.5.0. So the view keeps the row of a dead entity.
> Destroy an entity through `ctx.commands.despawn` or through the host command path while a view is
> live.

For a component that a chunk loop rewrites in each frame, take `{ grain: "column" }`. It republishes
every enabled row of an archetype whose column changed, and it costs the write path nothing.

Everything publishes at the settle point, the tail of `update()`. One `update()` is one Solid flush,
whatever the number of views, so no extra wrapper is needed around the frame.

The rules for a view:

- Give an `eq`, or a scalar projection, when a projection returns an object. Solid compares with
  `===`, so a fresh object wakes each reader in each frame. `fields` supplies its own.
- Do not read a second component from the projection of one component. Take one view for each
  component, and combine them where you read.
- Key a Solid `<For>` on the stable `EntityID`, and bind `cell(id)` once for each row.
- Keep the dispose function you receive, and call it when the UI, the world, or the test fixture
  ends.

See [solid](./api/solid.md) for the full API.

## Host writes

The core entry point exports the host write path. It is the usual write path for a UI, an editor,
a network, and a worker. It holds each write as a typed command. It applies each one through an
exclusive system at the head of a phase.

```ts
import { installHostCommandSeam, spawnEntry } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs); // install it before startup()
const player = ecs.spawn();
ecs.addComponent(player, Health, { hp: 100, max: 100 });

queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (entityId) => {
  console.log("spawned", entityId);
});
queue.setField(player, Health, "hp", 75);

ecs.update(1 / 60); // drains the commands in the queue, then publishes the reads
```

Each method of the queue adds a command to the queue. Nothing reaches the world until the apply
system drains, at the next `startup()` or `update()` call.

Important rules about timing:

- Install the path before you add the systems that must run after a host write, and before
  `startup()`.
- Carry the initial values in `spawnEntry` or in `add`. Do not put `add(e, C, ...)` and
  `setField(e, C, ...)` for the same component in the queue in the same frame. A structural write
  flushes after the immediate drain of `setField`.
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
ecs.update(1 / 60); // applies the undo
```

A field handle gives a tracked read together with a write that you can undo:

```ts
const hpHandle = fieldHandle(editor, player, Health, "hp", () => hud.value.hp);

hpHandle.value;      // the committed value, read through the channel you gave
hpHandle.pending;    // an optional optimistic copy, before the next tick
hpHandle.set(50);    // adds a setField that you can undo
```

The rules for the editor:

- The `FieldReader` that you give to `new Editor(...)` must read the committed state. Use
  `ecs.getField` for a simple tool, or your Solid view for UI code.
- `pending` is not tracked. It is an optimistic copy alone, until the read side is current.
- An undo of a despawn returns the data, but it creates the entity with a new `EntityID`.

See [editor](./api/editor.md) for the full transaction API.

## A complete UI loop

This is the usual shape for a browser or an editor:

```ts
import { ECS, installHostCommandSeam } from "@oasys/oecs";
import { solid } from "@oasys/oecs/solid";
import { Editor } from "@oasys/oecs/editor";

const ecs = ECS.create({ plugins: [solid()] });
const queue = installHostCommandSeam(ecs);
const editor = new Editor(queue, (entityId, def, field) => ecs.getField(entityId, def, field));

const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });

const points = ecs.solid.fields(Pos, ["x", "y"] as const);

ecs.startup();

let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  ecs.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

editor.setField(player, Pos, "x", 128);
```

Read `points` from a Solid component. A consumer that is not a Solid app has no read path in this
release. Poll the world with `ecs.getField` or with a cursor instead.

## Shared memory and the primitives

`@oasys/oecs/shared` is for advanced integration, where the store of the ECS must be in shared
memory. A browser application needs cross-origin isolation before it can use a
`SharedArrayBuffer`. The default heap world does not have that requirement.

`@oasys/oecs/primitives` exports the structures that operate alone, such as `BitSet`, `SparseSet`,
`SparseMap`, `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort`. Import them directly when
you need those tools and do not want to create an `ECS`.

## See also

- [API reference](./api/index.md)
- [solid](./api/solid.md)
- [plugins](./api/plugins.md)
- [the host write path](./api/host-write-seam.md)
- [editor](./api/editor.md)
- [memory](./api/memory.md)
- [primitives](./api/primitives.md)
