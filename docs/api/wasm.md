# WASM backends

> **Advanced / optional.** A plain `ECS` is pure TypeScript and runs over a heap `ArrayBuffer`. Use the WASM path only when you provide a compiled module or worker that can read the oecs store layout and run system bodies against shared columns.

oecs does **not** ship a compiled WASM sim. It ships the engine seams a WASM sim needs:

- `memory.wasm` — make the ECS backing buffer a shared `WebAssembly.Memory`.
- `ecs.wasmMemory` — hand that memory to your module.
- `ecs.fieldId(def, field)` — translate component fields into stable numeric ids for FFI.
- `ecs.onStoreLayoutPublished(listener)` — re-walk column offsets after attach and every grow.
- `ecs.attachBackend(backend)` + `SystemConfig.backendHandle` — route selected systems to your backend instead of their TypeScript closure.
- `HostCommandDispatcher` — optional fixed-slot ring transport for worker / wire writes back into the host ECS.

## Pick a memory profile

For a zero-copy WASM sim, make the store itself a shared `WebAssembly.Memory`:

```ts
import { ECS } from "@oasys/oecs";

const world = new ECS({
  memory: { wasm: { maximumPages: 4096 } }, // 4096 * 64 KiB = 256 MiB cap
});

const memory = world.wasmMemory!; // WebAssembly.Memory when memory.wasm is used
```

You can also bring your own shared memory:

```ts
const memory = new WebAssembly.Memory({
  initial: 32,
  maximum: 4096,
  shared: true,
});

const world = new ECS({ memory: { wasm: { memory } } });
```

> [!WARNING]
> `memory.wasm.memory` must be constructed with `shared: true`. A non-shared memory is rejected at construction because the WASM path relies on a `SharedArrayBuffer` backing.

If your backend does not need the backing to be a `WebAssembly.Memory`, but does need worker-visible bytes, use the shared profile instead:

```ts
const world = new ECS({ memory: { shared: { maxBytes: 256 * 1024 * 1024 } } });
```

In browsers, both shared paths require cross-origin isolation:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Attach a compute backend

A compute backend is deliberately tiny. The engine publishes the current store layout, then calls `run(handle)` when a scheduled system opted into backend execution.

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

const detach = world.attachBackend(new WasmBackend(simExports));
```

`setLayout(0)` is called immediately on attach and again after every backing grow / layout republish. If your WASM side caches descriptor offsets, column pointers, or typed views, invalidate them in `setLayout`.

Only one backend can be attached to an `ECS` at a time. The returned function detaches it and returns matching systems to their TypeScript fallback.

## Route systems to the backend

A system opts in by carrying a backend-minted `backendHandle`. With a backend attached, the schedule calls `backend.run(handle)` instead of `fn`. With no backend attached, `fn` runs normally.

```ts
const moveHandle = 1 as BackendSystemHandle;

const move = world.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  backendHandle: moveHandle,
  fn: (ctx, dt) => {
    // Pure-TS fallback for tests, unsupported browsers, or no backend attached.
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

Keep `reads`, `writes`, `resourceReads`, and other access declarations accurate. The backend call runs inside the same system access span as a TypeScript body, so those declarations authorize the shared columns the backend mutates and document the ordering constraints the schedule should respect.

## Pass ids across FFI

Component ids are stable for the lifetime of an `ECS`; field ids are assigned in registration order. Pass numeric `(componentId, fieldId)` pairs to your module instead of strings:

```ts
const posX = world.fieldId(Pos, "x");
const posY = world.fieldId(Pos, "y");

simExports.register_pos_fields(Pos.id, posX, posY);
```

When a backend needs to turn an archetype row back into an entity handle, use:

```ts
const eid = world.entityIdAtRow(archetypeId, row);
```

## Writes from WASM or a worker

For host-visible mutations that originate outside the schedule, do not write the `ECS` directly mid-frame. Use the [host-write seam](./host-write-seam.md). For worker / wire writes, bind a ring dispatcher and let the seam drain it at the schedule head:

```ts
import { installHostCommandSeam } from "@oasys/oecs";
// Ring transport = wire/ABI surface — @oasys/oecs/internal (no semver guarantees):
import { HostCommandDispatcher, ringDespawnCodec, ringSetFieldCodec } from "@oasys/oecs/internal";

const ring = new HostCommandDispatcher()
  .onCommand(1, ringSetFieldCodec(Pos, "x"))
  .onCommand(2, ringDespawnCodec());

installHostCommandSeam(world, { ring });
```

The ring codecs are fixed-slot. They are good for small commands such as `set_field`, `despawn`, `disable`, `enable`, and `remove_component`; variable-width `spawn` and `add_component` stay on the typed queue.

## Checklist

1. Construct the world with `memory.wasm` for zero-copy WASM, or `memory.shared` for worker-visible shared columns.
2. Serve browser builds with COOP/COEP so `SharedArrayBuffer` exists.
3. Register components in the same order the backend expects.
4. Pass `world.wasmMemory!`, component ids, and `fieldId(...)` results to the module.
5. Implement `ComputeBackend.setLayout` by re-reading the header / descriptor offsets.
6. Put `backendHandle` on only the systems your backend can run, and keep `fn` as a fallback.
7. Route off-schedule writes through the host-write seam, not direct ECS mutation.

## See also

- [memory](./memory.md) — storage profiles, caps, and `memoryPlan`
- [systems](./systems.md) — `backendHandle` and system access declarations
- [host-write seam](./host-write-seam.md) — typed queue and cross-thread ring transport
- [determinism](./determinism.md) — keeping heap/shared/WASM runs comparable
