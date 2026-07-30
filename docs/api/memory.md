# Memory and storage profiles

An `ECS` keeps each component column in **one backing buffer**. The `memory` option on the
constructor selects the kind of buffer and the limit on its size. The default needs no
configuration: it is a plain `ArrayBuffer`, fixed at a limit of 256 MiB. Pages that you do not
touch use no resident memory, and the columns grow inside that reservation when they must. So you
need the `memory` option only to set the size deliberately, or to change to shared or WASM storage.

```ts
new ECS();                                              // heap, a 256 MiB limit — the default
new ECS({ memory: { budget: { entities: 50_000 } } }); // set the size from an entity budget
new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });   // an explicit byte limit
new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer (workers / WASM)
```

## The arms

`memory` is a discriminated union. Select **exactly one** arm, or none. You can set
`columnCapacity`, which is the initial number of rows in each archetype column, on any arm.

| Arm | What it does | Select it when |
| --- | --- | --- |
| *(absent)* | a fixed heap `ArrayBuffer`, with a 256 MiB limit | you have no requirement yet |
| `{ heap: { maxBytes? } }` | a fixed heap `ArrayBuffer`, with an explicit limit | you want the default profile, with a size |
| `{ budget: { entities, … } }` | derives the column capacity, the reservation of the entity index, the byte limit, **and** the words of a limit error from a number of entities | you know your approximate peak number of entities |
| `{ maxBytes: N }` | a fixed heap with an explicit byte limit | you want a hard byte limit |
| `{ shared: { maxBytes? } }` | a growable `SharedArrayBuffer` | you offload to a worker or use a WASM backend |
| `{ wasm: {…} }` | the storage **is** a `WebAssembly.Memory` | you share bytes with a WASM simulation, with no copy |
| `{ allocator }` | your own in-place allocator | you are an expert and need an alternative |

```ts
interface EntityBudget {
  readonly entities: number;         // the expected peak of live entities (a maximum of 2^20)
  readonly archetypes?: number;      // default 8
  readonly bytesPerEntity?: number;  // default 64
}
```

> [!TIP]
> **`budget` is the arm to select.** Give it a number of entities. It then derives a good column
> capacity, a good reservation of the entity index, and a good byte limit. It also gives an error
> about a limit in your terms ("3× the declared budget — runaway entity creation upstream?"). A
> value of `entities` more than 2^20 (about 1 million) throws `INVALID_MEMORY_OPTIONS`.

## Storage profiles

There are three kinds of storage above one core. The archetypes are the same, and the
[`stateHash`](./determinism.md) is the same. Only the buffer is different.

- **Heap** (the default) — a plain **fixed** `ArrayBuffer`, which is not resizable, reserved at the
  limit. A fixed buffer keeps the TypedArray views on the fast element-access path of V8. A
  resizable buffer adds a cost to each `col[i]` operation. Pages that you do not touch use no
  resident memory, so the reservation is almost free. This profile needs **no `SharedArrayBuffer`,
  and no cross-origin isolation (COOP/COEP)**. The compromise: no offload to a worker, and no WASM
  compute backend. This is why oecs operates everywhere with no configuration.
- **Shared** (`@oasys/oecs/shared`) — a growable `SharedArrayBuffer`. It lets you share the columns
  with a worker or with a WASM simulation. In a browser it **requires cross-origin isolation**
  (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). Bun
  and Node give `SharedArrayBuffer` with no condition.
- **WASM** — a `WebAssembly.Memory` whose buffer *is* the store. So a WASM simulation and the ECS
  columns share the same bytes, with no copy.

```ts
// The optional shared and WASM allocators are behind a separate entry point:
import { growableSabAllocator, wasmMemoryAllocator, DEFAULT_SAB_ALLOCATOR, SabUnavailableError } from "@oasys/oecs/shared";

new ECS({ memory: { shared: {} } });
new ECS({ memory: { allocator: growableSabAllocator() } });         // equivalent, and explicit
new ECS({ memory: { wasm: { maximumPages: 4096 } } });              // the engine builds the Memory
new ECS({ memory: { wasm: { memory: myWasmMemory } } });            // supply your own (it must have shared: true)
```

> [!WARNING]
> A shared or WASM allocator throws `SabUnavailableError` at construction when `SharedArrayBuffer`
> is absent, which means that there is no cross-origin isolation. Either serve the page with
> isolation, or use the heap profile, which needs neither header.

## How to examine the plan

```ts
get memoryPlan(): ResolvedECSMemory;   // what `memory` resolved to
get wasmMemory(): WebAssembly.Memory | null;
```

`memoryPlan` reports:

- the allocator that the engine selected;
- the column capacity;
- the reservation of the entity index;
- the byte limit;
- a `derivation` trace that a person can read, with one line for each decision about the size.

It is useful when an error about a limit surprises you.

## The limit is absolute

The byte limit is an **absolute limit, and there is no alternative that grows past it**. If you
exceed it, it throws `STORE_CAP_EXCEEDED`, in the words of your `budget` or `intentLabel`, and not
in raw bytes.

> [!WARNING]
> **A limit that is too small fails at construction, and not later.** The engine reserves the
> region of the entity index immediately when it builds the store, which is about 12 MiB at
> the default limit. So a `maxBytes`, `heap.maxBytes`, or `wasm.maximumPages` value that is too
> small throws `STORE_CAP_EXCEEDED` *before the `ECS` exists*. Set the limit to your actual peak.

## Protection during migration

> [!NOTE]
> The pre-release options `initial_capacity` and `buffer_allocator` are **removed**, and there is no
> alias for them. If you give them, it throws `INVALID_MEMORY_OPTIONS` clearly. Replace them with
> an arm of `memory`.

## WASM interoperation and the compute backend

The shared and WASM profile exists so that a WASM simulation can run the bodies of systems directly
against the shared columns. The connection is part of the core. You must supply the WASM module and
the worker entry point.

```ts
get wasmMemory(): WebAssembly.Memory | null;                     // give this to your WASM module
fieldId<S>(def: ComponentDef<S>, fieldName: keyof S): number;    // a stable (componentId, fieldId) for FFI
attachBackend(backend: ComputeBackend): () => void;              // gives a function that detaches it
onStoreLayoutPublished(listener: StoreLayoutListener): () => void; // called on each growth of the SAB
```

<a id="compute-backend"></a>

### Compute backend

```ts
interface ComputeBackend extends StoreLayoutListener { run(handle: BackendSystemHandle): void; }
type BackendSystemHandle = /* an opaque branded number that the backend makes */;
```

`ecs.attachBackend(backend)` selects the backend to run the body of a system, in place of its
TypeScript closure. A system that carries a `backendHandle` on its
[`SystemConfig`](./systems.md#systemconfig) runs as `backend.run(handle)`. A system with no handle
is not affected. `run` executes inside the access span of the system, so its declared `writes`
authorize the shared columns that the backend mutates. There is no backend by default: a plain
`ECS` is pure TypeScript, and it costs nothing.

> [!NOTE]
> There is one backend for each `ECS`. If you attach a second one, it throws
> `BACKEND_ALREADY_ATTACHED` in development builds. The function that `attachBackend` gives you
> detaches the backend, and the systems return to the pure-TypeScript path. The handle is opaque to
> the engine, and the backend owns its id space.

## See also

- [determinism](./determinism.md) — the heap and shared storage agree on `stateHash`; how to size
  two instances for a restore
- [WASM backends](./wasm.md) — how to connect `WebAssembly.Memory`, `ComputeBackend`, and the FFI
  ids
- [parallel execution](./parallel.md) — what shared memory and worker support give you today
- [systems](./systems.md) — `backendHandle` on a system config
- [components](./components.md) — `columnCapacity`, and the field ids that `fieldId` gives
