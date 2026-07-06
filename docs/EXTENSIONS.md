# Extensions

oecs keeps the core package small and framework-agnostic. The `@oasys/oecs` entry point is enough for a simulation, server, test harness, or headless game loop. Extensions are separate import paths for UI reads, host writes, editor workflows, framework adapters, shared memory, and reusable primitives.

Use extensions when code outside the ECS schedule needs to observe or change world state. Import only the subpath you need; unused extensions are not pulled into the core bundle.

## Extension map

| Import | Use it for | Depends on |
| --- | --- | --- |
| `@oasys/oecs/reactive` | framework-neutral signals, computed values, effects, and reactive collections | no third-party dependencies |
| `@oasys/oecs/reactive-sync` | publishing ECS component changes into reactive collections | `@oasys/oecs` observers + `@oasys/oecs/reactive` |
| `@oasys/oecs/editor` | undo/redo and inspector field handles | the host-write seam from `@oasys/oecs` |
| `@oasys/oecs/solid` | reading oecs reactive values from SolidJS components | optional peer `solid-js` |
| `@oasys/oecs/shared` | `SharedArrayBuffer` storage for workers or WASM backends | cross-origin isolation in browsers |
| `@oasys/oecs/primitives` | standalone data structures used by oecs | no third-party dependencies |

The UI and editor extensions are usually wired as two one-way channels:

```txt
ECS -> reactive-sync -> reactive collections -> framework adapter -> UI
UI  -> editor/host command queue -> ECS schedule head
```

The read side publishes only changed rows. The write side queues typed commands and applies them at a safe point in the schedule.

## Picking the right extension

Use `@oasys/oecs/reactive` by itself when you want a tiny signal kernel or reactive collections outside the ECS. It is not tied to entities or components.

Use `@oasys/oecs/reactive-sync` when a UI, renderer, debug overlay, or telemetry panel should track ECS state without scanning every entity each frame.

Use `@oasys/oecs/editor` when changes should be undoable or should feel like two-way bound inspector controls. It builds on the host-write seam, so edits are still applied by the ECS rather than directly from event handlers.

Use `@oasys/oecs/solid` only at the Solid component boundary. The kernel and Solid are separate reactive graphs; a bare kernel read inside Solid does not subscribe until it is bridged through `fromKernel`, `fromKernelMap`, `fromKernelStruct`, or `fromKernelArray`.

Use `@oasys/oecs/shared` when you need shared memory for workers or a WASM compute backend. The default `ECS` uses a plain `ArrayBuffer` and does not require COOP/COEP.

Use `@oasys/oecs/primitives` when another package wants the same low-level structures without taking a dependency on the ECS.

## Reactive reads

`reactive-sync` turns component state into reactive channels. Each sync returns the channel plus a `dispose()` function, and seeds existing matching entities by default.

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

// In your frame loop, batch ECS observer publishes into one reactive flush.
batchedUpdate(ecs, 1 / 60);

const p = positions.map.get(player);
const hp = health.map.get(player)?.hp;

positions.dispose();
health.dispose();
```

Use `syncComponentToMap` for one component. Use `syncFieldsToMap` for the common "mirror these fields" case; it automatically uses shallow equality for the projected object. Use `syncJoinToMap` when the projection reads more than one component, because it subscribes to all joined components and avoids stale rows.

> [!WARNING]
> The sync bridges remove rows via `onRemove` observers, and observers only fire for **deferred** ops. An immediate host `ecs.despawn(e)` (0.5.0 semantics) is invisible to them — the mirrored `Map` keeps the dead entity's row indefinitely (the bridges seed once at registration; there is no periodic resync). Despawn through `ctx.commands.despawn` or the host-command seam when a reactive bridge is attached.

For high-churn components, consider `syncComponentToMap(..., { grain: "column" })`. It sweeps dirty archetype columns sequentially, which can be faster when most rows in a component change.

For singleton-style UI state, put the state on a reserved entity and use `syncSingletonToStruct` or `syncSingletonToArray`:

```ts
import { syncSingletonToStruct } from "@oasys/oecs/reactive-sync";

const NetStats = ecs.registerComponent({ connected: "u8", latencyMs: "f64" });
const netEntity = ecs.spawn();
ecs.addComponent(netEntity, NetStats, { connected: 0, latencyMs: -1 });

const net = syncSingletonToStruct(ecs, NetStats, netEntity, ["connected", "latencyMs"] as const);

net.struct.connected; // per-field reactive read
net.dispose();
```

Common reactive-sync rules:

- Pass `eq: shallow` or a custom comparator when a projection returns a fresh object. The default equality is `Object.is`, so a new object reference wakes subscribers even when its fields did not change.
- Do not read another component from a single-component projection. Use `syncJoinToMap`.
- Drive the world with `batchedUpdate(ecs, dt)` or wrap `ecs.update(dt)` in `batch(...)` from `@oasys/oecs/reactive`.
- Keep the returned disposer and call it when the UI surface, world, or test fixture is torn down.

See [reactive](./api/reactive.md) for the full API.

## Solid rendering

The Solid adapter mirrors kernel values into Solid signals and disposes subscriptions with the surrounding Solid owner.

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

Use keyed Solid `<For>` for entity maps, keyed by stable `EntityID`s. Use `fromKernelArray` with Solid `<Index>` for ordered singleton arrays. Call `fromKernel*` inside a component or Solid `root` so the adapter has an owner for cleanup.

## Host writes

The host-write seam is exported from the core entry point because it is the common write path for UI, editor, network, and worker input. It buffers writes as typed commands and applies them through an exclusive system at the schedule head.

```ts
import { installHostCommandSeam, spawnEntry } from "@oasys/oecs";
import { batchedUpdate } from "@oasys/oecs/reactive-sync";

const queue = installHostCommandSeam(ecs); // install before startup()
const player = ecs.spawn();
ecs.addComponent(player, Health, { hp: 100, max: 100 });

queue.spawn([spawnEntry(Pos, { x: 0, y: 0 })], (entityId) => {
  console.log("spawned", entityId);
});
queue.setField(player, Health, "hp", 75);

batchedUpdate(ecs, 1 / 60); // drains queued commands, then publishes reactive reads
```

Every queue method enqueues. Nothing reaches the world until the apply system drains on the next `startup()` or `update()`.

Important timing rules:

- Install the seam before adding systems that should run after host writes, and before `startup()`.
- Carry initial values in `spawnEntry` or `addComponent`. Do not enqueue `addComponent(e, C, ...)` and `setField(e, C, ...)` for the same component in the same frame; structural writes flush after the immediate `setField` drain.
- Use `onSpawned` to learn ids created by queued spawns.

See [host-write seam](./api/host-write-seam.md) for command logging, replay, and cross-thread ring transport.

## Editor usage

`@oasys/oecs/editor` wraps the host command queue with undo/redo transactions. Each edit records forward commands and inverse commands. `undo()` enqueues the inverse, and `redo()` enqueues the forward; both apply on the next tick like any other host write.

```ts
import { Editor, fieldHandle } from "@oasys/oecs/editor";
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);
const editor = new Editor(queue, (eid, def, field) => ecs.getField(eid, def, field));
const player = ecs.spawn();
ecs.addComponent(player, Pos, { x: 0, y: 0 });

editor.transaction((tx) => {
  tx.setField(player, Pos, "x", 10)
    .setField(player, Pos, "y", 20);
});

editor.undo();
batchedUpdate(ecs, 1 / 60); // applies the undo
```

A field handle pairs a reactive read with an undoable write:

```ts
const hpHandle = fieldHandle(
  editor,
  player,
  Health,
  "hp",
  () => health.map.get(player)?.hp,
);

hpHandle.value;      // committed reactive value
hpHandle.pending;    // optional optimistic echo before the next tick
hpHandle.set(50);    // enqueues an undoable setField
```

Editor rules:

- The `FieldReader` passed to `new Editor(...)` should read the committed state. Use `ecs.getField` for simple tools or your reactive read channel for UI code.
- `pending` is not reactive. It is only an optimistic echo until the read side catches up.
- Undoing a despawn restores the data but creates a fresh `EntityID`.

See [editor](./api/editor.md) for the full transaction API.

## A complete UI loop

This is the common browser/editor shape:

```ts
import { ECS, installHostCommandSeam } from "@oasys/oecs";
import { Editor } from "@oasys/oecs/editor";
import { batchedUpdate, shallow, syncComponentToMap } from "@oasys/oecs/reactive-sync";

const ecs = new ECS();
const queue = installHostCommandSeam(ecs);
const editor = new Editor(queue, (eid, def, field) => ecs.getField(eid, def, field));

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

If you use Solid, bridge `positions.map` with `fromKernelMap`. If you use React, bridge kernel accessors with `toExternalStore` from `@oasys/oecs/reactive`.

## Shared memory and primitives

`@oasys/oecs/shared` is for advanced integration where the ECS store must live in shared memory. Browser apps need cross-origin isolation before using `SharedArrayBuffer`; the default heap world avoids that requirement.

`@oasys/oecs/primitives` exports standalone structures such as `BitSet`, `SparseSet`, `SparseMap`, `GrowableTypedArray`, `BinaryHeap`, and `topologicalSort`. Import them directly when you need those utilities without creating an `ECS`.

## See also

- [API reference](./api/index.md)
- [reactive](./api/reactive.md)
- [host-write seam](./api/host-write-seam.md)
- [editor](./api/editor.md)
- [memory](./api/memory.md)
- [primitives](./api/primitives.md)
