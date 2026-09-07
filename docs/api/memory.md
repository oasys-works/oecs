# Memory and storage profiles

An `ECS` keeps each component column in **one backing buffer**. The `memory` option on the
constructor selects the kind of buffer and the limit on its size. The default needs no
configuration: it is a plain `ArrayBuffer`, fixed at a limit of 256 MiB. Pages that you do not
touch use no resident memory, and the columns grow inside that reservation when they must. So you
need the `memory` option only to set the size deliberately, or to change to shared or WASM storage.

```ts
new ECS();                                                  // heap, a 256 MiB limit, the default
new ECS({ memory: { entities: 50_000 } });                  // set the size from a number of entities
new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });        // an explicit byte limit
new ECS({ memory: { backing: "shared" } });                 // SharedArrayBuffer (workers and WASM)
new ECS({ memory: { entities: 50_000, backing: "shared" } }); // both, together
```

## Two questions, two fields

`memory` asks you two questions that do not depend on each other. **How big** is the world, and
**what holds** its bytes. Each question has its own field, so you can answer one, the other, or
both. There is no combination that the type refuses.

```ts
interface ECSMemoryOptions {
  // how big
  readonly entities?: number;        // the expected peak of live entities (a maximum of 2^20)
  readonly archetypes?: number;      // default 8. Shapes the derived column capacity
  readonly bytesPerEntity?: number;  // default 64. Shapes the derived byte limit
  readonly maxBytes?: number;        // an explicit byte limit. It wins over a derived one
  readonly columnCapacity?: number;  // the initial rows in each archetype column
  // what holds the bytes
  readonly backing?: MemoryBacking;  // default "heap"
  readonly storeBase?: number;       // the byte offset of the store header inside the backing
}

type MemoryBacking =
  | "heap"                              // a fixed ArrayBuffer, the default
  | "shared"                            // a growable SharedArrayBuffer
  | { wasm: { maximumPages } | { memory } }  // the buffer is a WebAssembly.Memory
  | { allocator: InPlaceBufferAllocator };   // your own, for experts
```

`InPlaceBufferAllocator` and `BufferAllocator` are type exports of the root and of `@oasys/oecs/shared`.

| Backing | What it does | Select it when |
| --- | --- | --- |
| `"heap"` *(default)* | a fixed `ArrayBuffer`, reserved at the limit | you have no requirement yet |
| `"shared"` | a growable `SharedArrayBuffer` | you offload to a worker or use a WASM backend |
| `{ wasm: {…} }` | the storage **is** a `WebAssembly.Memory` | you share bytes with a WASM simulation, with no copy |
| `{ allocator }` | your own in-place allocator | you are an expert and need an alternative |

> [!TIP]
> **Give `entities` if you know it.** It derives a good column capacity, a good reservation of the
> entity index, and a good byte limit. It also states a limit error as a multiple of the declared
> budget, and not as raw bytes. A value more than 2^20 (about 1 million)
> throws `INVALID_MEMORY_OPTIONS`. It works with every backing.

> [!TIP]
> **Give both `entities` and `maxBytes` when you know both.** The number of entities then sizes the
> columns and the entity index, and your byte limit is the ceiling. Without the count, the engine
> must size the entity index backwards from the limit, and it reserves more than a small world
> needs.

## Set the initial size of each column

A column starts at `columnCapacity` rows. It grows when it is full. To grow, the column doubles.

A doubled column takes new space in the buffer. **The engine does not give the old space back.**
The engine touched those pages. So they stay resident. The `memoryPlan` calls this
"double+holes headroom".

The result is simple. A column that grows many times holds more resident memory than the data
needs. A column that never grows does not.

So set `columnCapacity` to your peak number of rows in one archetype. Then no column doubles.

```ts
// A world that holds up to 1,000,000 entities in a few archetypes.
new ECS({
  memory: { entities: 1_000_000, columnCapacity: 1_048_576 }
});
```

### What this saves

A pinned `columnCapacity` lowers resident memory. No column doubles, so no abandoned block stays
resident. Giving `entities` alone lowers it less. The derived capacity assumes an even spread over
`archetypes`, so an uneven spread still doubles. The speed does not change either way. `bench/`
holds the measurement.

Resident memory sits above the row stride for two reasons. The first is the entity index. The
second is the spare rows in each column. The entity index reserves the full 2^20 slots of the id
space. That cost is fixed. So it is small for each entity in a large world. It is large for each
entity in a small world.

> [!TIP]
> Two costs pull in opposite directions. A large `columnCapacity` reserves rows that you may never
> use. A small `columnCapacity` leaves an abandoned block after each growth. Set the value to your
> peak, and you pay neither cost.

> [!NOTE]
> `bytesPerEntity` is 64 by default. The engine uses it with `entities` to derive the byte limit.
> Add the widths of the fields of your components. If the total is much less than 64, give the true
> value. The reservation then becomes smaller.

Use `ecs.memoryPlan` to see what the engine derived, and why. Refer to
[How to examine the plan](#how-to-examine-the-plan).

## Storage profiles

There are three kinds of storage above one core. The archetypes are the same, and the
[`stateHash`](./determinism.md) is the same. Only the buffer is different.

- **Heap** (the default), a plain **fixed** `ArrayBuffer`, which is not resizable, reserved at the
  limit. A fixed buffer keeps the TypedArray views on the fast element-access path of V8. A
  resizable buffer adds a cost to each `col[i]` operation. Pages that you do not touch use no
  resident memory, so the reservation is almost free. This profile needs **no `SharedArrayBuffer`,
  and no cross-origin isolation (COOP and COEP)**. The compromise: no offload to a worker, and no WASM
  compute backend. This is why oecs operates everywhere with no configuration.
- **Shared** (`@oasys/oecs/shared`), a growable `SharedArrayBuffer`. It lets you share the columns
  with a worker or with a WASM simulation. In a browser it **requires cross-origin isolation**
  (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). Bun
  and Node give `SharedArrayBuffer` with no condition.
- **WASM**, a `WebAssembly.Memory` whose buffer *is* the store. So a WASM simulation and the ECS
  columns share the same bytes, with no copy.

> [!WARNING]
> **JavaScriptCore pays for the growth of a shared buffer.** JavaScriptCore has no fast store path
> for a TypedArray view over a *growable* `SharedArrayBuffer`. A column read costs what the heap
> profile costs. Every column write is far slower, so a system that writes a column in a loop takes
> a slow path there. The cost is for each access and not for each byte, so a small
> world pays the same cost for each access as a large one. V8 shows no such difference. Safari and
> Bun are JavaScriptCore.
>
> Two profiles keep the fast store path on JavaScriptCore. `fixedSabAllocator` reserves the limit
> at construction and gives up growth. The WASM profile grows, and it pays no write cost either,
> because a `WebAssembly.Memory` replaces its buffer object on growth instead of resizing it in
> place, which is the shape JavaScriptCore keeps fast. So a worker world on Bun or Safari picks the
> WASM profile even with no module, and `bench/` holds the measurement.

```ts
// the optional shared and WASM allocators are behind a separate entry point:
import { growableSabAllocator, fixedSabAllocator, wasmMemoryAllocator, DEFAULT_SAB_ALLOCATOR, SabUnavailableError } from "@oasys/oecs/shared";

new ECS({ memory: { backing: "shared" } });
new ECS({ memory: { backing: { allocator: growableSabAllocator() } } });  // equivalent, and explicit
new ECS({ memory: { maxBytes: 64 * 1024 * 1024,                          // a shared buffer that does not grow
                    backing: { allocator: fixedSabAllocator(64 * 1024 * 1024) } } });
new ECS({ memory: { backing: { wasm: { maximumPages: 4096 } } } });       // the engine builds the Memory
new ECS({ memory: { backing: { wasm: { memory: myWasmMemory } } } });     // supply your own (it must have shared: true)
```

### `storeBase`, where the store starts inside the backing

`memory.storeBase` is the byte offset of the store header inside the backing. Every offset the
store writes is measured from it, and the store writes nothing below it. `ecs.memoryPlan.storeBase`
reports the resolved value, and the `derivation` trace names it.

```ts
import { ECS, storeBaseAbove } from "@oasys/oecs";

const ecs = new ECS({
  memory: {
    backing: { wasm: { memory: myWasmMemory } },
    storeBase: storeBaseAbove(instance.exports, 4 * 1024 * 1024),
  },
});

ecs.memoryPlan.storeBase; // the value the engine resolved
```

- The heap, shared and allocator backings default it to 0.
- The WASM backing defaults it to `WASM_STORE_BASE_BYTES`, one page, and **refuses 0**. A compiled
  module owns the low addresses of its own linear memory, and a safe Zig or Rust build cannot read
  address 0.
- It must be an integer and a multiple of the store base alignment, which keeps every column on its
  element boundary. Anything else throws `INVALID_MEMORY_OPTIONS`.
- **The default clears nothing on its own.** A default link places a module's data far above one
  page. Read `__heap_base` from the module with `storeBaseAbove(exports, extraBytes)`, which rounds
  up to a whole WASM page, or pass the base by hand.
- The base never reaches a digest. A heap world and a module-hosted world with the same history
  agree on `stateHash` and on a snapshot.

`WASM_STORE_BASE_BYTES` is on `@oasys/oecs/internal`. `storeBaseAbove` is on the package root.
[WASM backends](./wasm.md#the-store-base) has the full argument.

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

- the allocator that the engine selected
- the column capacity
- the reservation of the entity index
- the byte limit
- the store base, the byte offset the header sits at
- the WASM `Memory` when the wasm backing built one, or supplied one
- a `derivation` trace that a person can read, with one line for each decision about the size.

It is useful when an error about a limit surprises you.

## The limit is absolute

The byte limit is an **absolute limit, and there is no alternative that grows past it**. If you
exceed it, it throws `STORE_CAP_EXCEEDED`, in the words of your `entities` count or of the intent
label the engine resolved, and not in raw bytes.

> [!WARNING]
> **A limit that is too small fails at construction, and not later.** The engine reserves the
> region of the entity index immediately when it builds the store, which is about 12 MiB at
> the default limit. So a `maxBytes`, `heap.maxBytes`, or `wasm.maximumPages` value that is too
> small throws `STORE_CAP_EXCEEDED` *before the `ECS` exists*. Set the limit to your actual peak.
>
> Give `entities` to avoid this. The engine then sizes the entity index from the count instead of
> from the limit, and a small world reserves a small index.

## Protection during migration

> [!NOTE]
> The pre-release options `initial_capacity` and `buffer_allocator` are **removed**, and there is no
> alias for them. If you give them, it throws `INVALID_MEMORY_OPTIONS` clearly. Replace them with
> the fields of `memory`.

> [!NOTE]
> **The arms of 0.5 are removed in 0.6.** `memory` was one union of five arms, so it could hold only
> one answer. Sizing and backing are now two fields, and every pair of them is legal. Each removed
> arm throws `INVALID_MEMORY_OPTIONS` with its new spelling, because a sizing that the engine
> ignored in silence would give you a world of the wrong size and show it much later.
>
> | 0.5 | 0.6 |
> | --- | --- |
> | `{ budget: { entities: N } }` | `{ entities: N }` |
> | `{ heap: { maxBytes: X } }` | `{ maxBytes: X, backing: "heap" }` |
> | `{ shared: { maxBytes: X } }` | `{ maxBytes: X, backing: "shared" }` |
> | `{ wasm: W }` | `{ backing: { wasm: W } }` |
> | `{ allocator: A, capBytesHint: X }` | `{ maxBytes: X, backing: { allocator: A } }` |
>
> `maxBytes` and `columnCapacity` keep their names and their meaning. The type `EntityBudget` is
> gone, because its three fields are now fields of `memory` itself.

## WASM interoperation and the compute backend

The shared and WASM profile exists so that a WASM simulation can run the bodies of systems directly
against the shared columns. The connection is part of the core. You must supply the WASM module and
the worker entry point.

```ts
get wasmMemory(): WebAssembly.Memory | null;                     // give this to your WASM module
fieldId<S>(def: ComponentDef<S>, fieldName: keyof S): number;    // a stable (componentId, fieldId) for FFI
attachBackend(backend: ComputeBackend): () => void;              // gives a function that detaches it
subscribeLayout(listener: StoreLayoutListener): () => void; // called on each growth of the SAB
```

<a id="compute-backend"></a>

### Compute backend

```ts
interface ComputeBackend extends StoreLayoutListener {
  run(handle: BackendSystemHandle, dt: number, tick: number): void;
}
type BackendSystemHandle = /* an opaque branded number that the backend makes */;
```

`ecs.attachBackend(backend)` selects the backend to run the body of a system, in place of its
TypeScript closure. A system that carries a `backendHandle` on its
[`SystemConfig`](./systems.md#systemconfig) runs as `backend.run(handle, dt, tick)`. A system with
no handle is not affected. `run` executes inside the access span of the system, so its declared
`writes` authorize the shared columns that the backend mutates. There is no backend by default: a plain
`ECS` is pure TypeScript, and it costs nothing.

> [!NOTE]
> There is one backend for each `ECS`. If you attach a second one, it throws
> `BACKEND_ALREADY_ATTACHED` in development builds. The function that `attachBackend` gives you
> detaches the backend, and the systems return to the pure-TypeScript path. The handle is opaque to
> the engine, and the backend owns its id space.

## See also

- [determinism](./determinism.md), the heap and shared storage agree on `stateHash`. How to size
  two instances for a restore
- [WASM backends](./wasm.md), how to connect `WebAssembly.Memory`, `ComputeBackend`, and the FFI
  ids
- [parallel execution](./parallel.md), the worker pool and the `parallel` system form
- [systems](./systems.md), `backendHandle` on a system config
- [components](./components.md), `columnCapacity`, and the field ids that `fieldId` gives
