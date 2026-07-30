# WASM backends

> **Advanced and optional.** A plain `ECS` is pure TypeScript, and it runs over a heap
> `ArrayBuffer`. Use the WASM path only when you supply a compiled module or a worker that can read
> the store layout of oecs and run the bodies of systems against the shared columns.

oecs does **not** supply a compiled WASM simulation. It supplies the engine connections that a WASM
simulation needs:

- `memory.wasm` — make the backing buffer of the ECS a shared `WebAssembly.Memory`.
- `ecs.wasmMemory` — give that memory to your module.
- `ecs.fieldId(def, field)` — translate the fields of a component into stable numeric ids for FFI.
- `ecs.onStoreLayoutPublished(listener)` — read the column offsets again after each attach and each
  growth.
- `ecs.attachBackend(backend)` with `SystemConfig.backendHandle` — send the systems that you select
  to your backend, in place of their TypeScript closure.
- `HostCommandDispatcher` — an optional ring transport with fixed slots, for writes from a worker
  or from the wire back into the host ECS.

## Select a memory profile

For a WASM simulation with no copy, make the store itself a shared `WebAssembly.Memory`:

```ts
import { ECS } from "@oasys/oecs";

const ecs = new ECS({
  memory: { wasm: { maximumPages: 4096 } }, // 4096 * 64 KiB = 256 MiB limit
});

const memory = ecs.wasmMemory!; // a WebAssembly.Memory when you use memory.wasm
```

You can also supply your own shared memory:

```ts
const memory = new WebAssembly.Memory({
  initial: 32,
  maximum: 4096,
  shared: true,
});

const ecs = new ECS({ memory: { wasm: { memory } } });
```

> [!WARNING]
> You must construct `memory.wasm.memory` with `shared: true`. The engine rejects a memory that is
> not shared, at construction, because the WASM path depends on a `SharedArrayBuffer` backing.

If your backend does not need the storage to be a `WebAssembly.Memory`, but does need bytes that a
worker can see, use the shared profile instead:

```ts
const ecs = new ECS({ memory: { shared: { maxBytes: 256 * 1024 * 1024 } } });
```

In a browser, both shared paths require cross-origin isolation:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Attach a compute backend

A compute backend is small by design. The engine publishes the current store layout. It then calls
`run(handle)` when a scheduled system selected backend execution.

```ts
import type { BackendSystemHandle, ComputeBackend } from "@oasys/oecs";

class WasmBackend implements ComputeBackend {
  constructor(private readonly sim: {
    set_layout(headerOff: number): void;
    run_system(handle: number): void;
  }) {}

  setLayout(headerOff: number): void {
    this.sim.set_layout(headerOff);
  }

  run(handle: BackendSystemHandle): void {
    this.sim.run_system(handle as number);
  }
}

const detach = ecs.attachBackend(new WasmBackend(simExports));
```

The engine calls `setLayout(0)` immediately when you attach the backend. It calls it again after
each growth of the storage, and after each new publication of the layout. If your WASM side caches
the offsets of the descriptors, the pointers to the columns, or typed views, make them invalid in
`setLayout`.

You can attach one backend to an `ECS` at a time. The function that `attachBackend` gives you
detaches the backend, and the matching systems return to their TypeScript alternative.

## Send systems to the backend

A system selects backend execution when it carries a `backendHandle` that the backend made. With a
backend attached, the schedule calls `backend.run(handle)` in place of `fn`. With no backend
attached, `fn` runs as usual.

```ts
const moveHandle = 1 as BackendSystemHandle;

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  backendHandle: moveHandle,
  fn: (ctx, dt) => {
    // The pure-TS alternative, for tests, for browsers that do not support WASM, or when no backend is attached.
    movers.eachChunk((cols, count) => {
      const { x, y } = cols.mut(Pos);
      const { vx, vy } = cols.read(Vel);
      for (let i = 0; i < count; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    });
  },
});
```

Keep `reads`, `writes`, `resourceReads`, and each other access declaration correct. The call to the
backend runs inside the same access span as a TypeScript body. So those declarations authorize
the shared columns that the backend mutates, and they document the order constraints that the
schedule must respect.

## Send ids across FFI

Component ids are stable for the life of an `ECS`. Field ids come from the order of registration.
Give numeric `(componentId, fieldId)` pairs to your module, and not strings:

```ts
const posX = ecs.fieldId(Pos, "x");
const posY = ecs.fieldId(Pos, "y");

simExports.register_pos_fields(Pos.id, posX, posY);
```

When a backend must turn a row of an archetype back into a handle to an entity, use:

```ts
const eid = ecs.entityIdAtRow(archetypeId, row);
```

## Writes from WASM or from a worker

For mutations that the host must see, and that start outside the schedule, do not write to the
`ECS` directly during a frame. Use the [host write path](./host-write-seam.md). For writes from a
worker or from the wire, connect a ring dispatcher, and let the host write path drain it at the
head of the schedule:

```ts
import { installHostCommandSeam } from "@oasys/oecs";
// The ring transport is a wire and ABI surface — @oasys/oecs/internal (no semver guarantees):
import { HostCommandDispatcher, ringDespawnCodec, ringSetFieldCodec } from "@oasys/oecs/internal";

const ring = new HostCommandDispatcher()
  .onCommand(1, ringSetFieldCodec(Pos, "x"))
  .onCommand(2, ringDespawnCodec());

installHostCommandSeam(ecs, { ring });
```

The ring codecs use fixed slots. They are good for small commands such as `set_field`, `despawn`,
`disable`, `enable`, and `remove_component`. The variable-width commands `spawn` and
`add_component` stay on the typed queue.

## Checklist

1. Construct the world with `memory.wasm` for WASM with no copy, or with `memory.shared` for shared
   columns that a worker can see.
2. Serve browser builds with COOP and COEP, so that `SharedArrayBuffer` exists.
3. Register the components in the order that the backend expects.
4. Give `ecs.wasmMemory!`, the component ids, and the results of `fieldId(...)` to the module.
5. Implement `ComputeBackend.setLayout` so that it reads the header and the offsets of the
   descriptors again.
6. Put `backendHandle` on the systems that your backend can run, and on no others. Keep `fn` as the
   alternative.
7. Send each write that starts outside the schedule through the host write path. Do not mutate the
   ECS directly.

## See also

- [memory](./memory.md) — the storage profiles, the limits, and `memoryPlan`
- [systems](./systems.md) — `backendHandle` and the access declarations of a system
- [the host write path](./host-write-seam.md) — the typed queue and the ring transport between
  threads
- [determinism](./determinism.md) — how to keep the heap, shared, and WASM runs comparable
