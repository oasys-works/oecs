# Memory & storage profiles

An `ECS` stores every component column in **one backing buffer**. The `memory` option on the constructor picks the buffer kind and its size cap. The default needs no configuration — a plain `ArrayBuffer` reserved fixed at a 256 MiB cap (untouched pages cost no resident memory; columns grow on demand within it) — so reach for `memory` only to size deliberately or to switch to a shared/WASM backing.

```ts
new ECS();                                              // heap, 256 MiB cap — the default
new ECS({ memory: { budget: { entities: 50_000 } } }); // size from an entity budget
new ECS({ memory: { maxBytes: 32 * 1024 * 1024 } });   // explicit byte ceiling
new ECS({ memory: { shared: {} } });                   // SharedArrayBuffer (workers / WASM)
```

## The arms

`memory` is a discriminated union — pick **exactly one** arm (or none). `columnCapacity` (initial rows per archetype column) can be pinned on any arm.

| Arm | What it does | Pick when |
| --- | --- | --- |
| *(omitted)* | fixed heap `ArrayBuffer`, 256 MiB cap | you don't care yet |
| `{ heap: { maxBytes? } }` | fixed heap `ArrayBuffer`, explicit cap | the default profile, sized |
| `{ budget: { entities, … } }` | derives column cap, entity-index reservation, byte cap **and** cap-error wording from an entity count | you know your rough peak entity count |
| `{ maxBytes: N }` | fixed heap with an explicit byte ceiling | you want a hard byte cap |
| `{ shared: { maxBytes? } }` | growable `SharedArrayBuffer` | worker offload / a WASM backend |
| `{ wasm: {…} }` | the backing **is** a `WebAssembly.Memory` | zero-copy sharing with a WASM sim |
| `{ allocator }` | your own in-place allocator | expert escape hatch |

```ts
interface EntityBudget {
  readonly entities: number;         // expected peak live entities (bounded by 2^20)
  readonly archetypes?: number;      // default 8
  readonly bytesPerEntity?: number;  // default 64
}
```

> [!TIP]
> **`budget` is the arm to reach for.** Give it an entity count and it derives sensible column capacity, entity-index reservation, and byte cap, and phrases any cap-overflow error in your terms ("3× the declared budget — runaway entity creation upstream?"). `entities > 2^20` (≈1M) throws `INVALID_MEMORY_OPTIONS`.

## Storage profiles

Three backings, one core — same archetypes, same [`stateHash`](./determinism.md), only the buffer differs.

- **Heap** (default) — a plain **fixed (non-resizable)** `ArrayBuffer` reserved at the cap. Fixed keeps TypedArray views on V8's fast element-access path (a resizable buffer taxes every `col[i]`), and untouched pages cost no resident memory, so the reservation is virtually free. **No `SharedArrayBuffer`, no cross-origin isolation (COOP/COEP).** Trade-off: no worker offload, no WASM compute backend. This is why oecs works anywhere out of the box.
- **Shared** (`@oasys/oecs/shared`) — a growable `SharedArrayBuffer`. Enables sharing columns with a worker or a WASM sim. **Requires cross-origin isolation in browsers** (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). Bun/Node expose SAB unconditionally.
- **WASM** — a `WebAssembly.Memory` whose buffer *is* the store, so a WASM sim and the ECS columns share bytes with no copying.

```ts
// The opt-in shared/WASM allocators live behind a separate entry:
import { growableSabAllocator, wasmMemoryAllocator, DEFAULT_SAB_ALLOCATOR, SabUnavailableError } from "@oasys/oecs/shared";

new ECS({ memory: { shared: {} } });
new ECS({ memory: { allocator: growableSabAllocator() } });         // equivalent, explicit
new ECS({ memory: { wasm: { maximumPages: 4096 } } });              // engine builds the Memory
new ECS({ memory: { wasm: { memory: myWasmMemory } } });            // bring your own (must be shared: true)
```

> [!WARNING]
> A shared/WASM allocator throws `SabUnavailableError` at construction if `SharedArrayBuffer` is absent — i.e. no cross-origin isolation. Either serve isolated, or use the heap profile (which needs neither).

## Inspecting the plan

```ts
get memoryPlan(): ResolvedECSMemory;   // what `memory` resolved to
get wasmMemory(): WebAssembly.Memory | null;
```

`memoryPlan` reports the chosen allocator, column capacity, entity-index reservation, byte cap, and a human-readable `derivation` trace (one line per sizing decision) — useful when a cap error surprises you.

## The cap is a hard ceiling

The byte cap is a **hard limit with no grow-beyond fallback** — exceeding it throws `STORE_CAP_EXCEEDED`, phrased in your `budget`/`intentLabel` terms rather than raw bytes.

> [!WARNING]
> **A too-small cap fails at construction, not later.** The entity-index region is reserved eagerly when the store is built (≈12 MiB at the default cap), so an unreasonably small `maxBytes` / `heap.maxBytes` / `wasm.maximumPages` throws `STORE_CAP_EXCEEDED` *before the `ECS` even exists*. Size the cap to your actual peak.

## Migration guard

> [!NOTE]
> The pre-release `initial_capacity` and `buffer_allocator` options were **removed** (not aliased). Passing them throws `INVALID_MEMORY_OPTIONS` loudly — replace them with a `memory` arm.

## WASM interop & the compute backend

The shared/WASM profile exists to let a WASM sim run system bodies directly against the shared columns. The seam is in the core; the WASM module and worker entry are yours to provide.

```ts
get wasmMemory(): WebAssembly.Memory | null;                     // hand to your WASM module
fieldId<S>(def: ComponentDef<S>, fieldName: keyof S): number;    // stable (componentId, fieldId) for FFI
attachBackend(backend: ComputeBackend): () => void;              // returns a detach function
onStoreLayoutPublished(listener: StoreLayoutListener): () => void; // notified on every SAB grow
```

<a id="compute-backend"></a>

### Compute backend

```ts
interface ComputeBackend extends StoreLayoutListener { run(handle: BackendSystemHandle): void; }
type BackendSystemHandle = /* opaque branded number the backend mints */;
```

`ecs.attachBackend(backend)` opts into running a system's body via the backend instead of its TS closure. A system carrying a `backendHandle` (on its [`SystemConfig`](./systems.md#systemconfig)) is executed as `backend.run(handle)`; systems without one are untouched. `run` executes inside the system's access span, so its declared `writes` authorize whatever shared columns the backend mutates. Default is none — a bare `ECS` is pure-TS and pays nothing.

> [!NOTE]
> One backend per `ECS` — attaching a second throws `BACKEND_ALREADY_ATTACHED` in dev builds. The returned function detaches it and reverts to the pure-TS path. The handle is engine-opaque; the backend owns its id space.

## See also

- [determinism](./determinism.md) — heap and shared backings agree on `stateHash`; sizing both instances for restore
- [WASM backends](./wasm.md) — wiring `WebAssembly.Memory`, `ComputeBackend`, and FFI ids
- [parallelism](./parallel.md) — what shared-memory and worker support means today
- [systems](./systems.md) — `backendHandle` on a system config
- [components](./components.md) — `columnCapacity` and the field ids `fieldId` returns
