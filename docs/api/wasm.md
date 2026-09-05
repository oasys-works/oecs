# WASM backends

> **Advanced and optional.** A plain `ECS` is pure TypeScript, and it runs over a heap
> `ArrayBuffer`. Use the WASM path only when you supply a compiled module or a worker that can read
> the store layout of oecs and run the bodies of systems against the shared columns.

oecs does **not** supply a compiled WASM simulation. It supplies the engine connections that a WASM
simulation needs:

- `memory.wasm`, make the backing buffer of the ECS a shared `WebAssembly.Memory`.
- `memory.storeBase` with `storeBaseAbove(exports, extraBytes)`, place the store above everything
  the module owns.
- `ecs.wasmMemory`, give that memory to your module.
- `ecs.fieldId(def, field)`, translate the fields of a component into stable numeric ids for FFI.
- `ecs.subscribeLayout(listener)`, read the column offsets again after each attach and each
  growth.
- `ecs.attachBackend(backend)` with `SystemConfig.backendHandle`, send the systems that you select
  to your backend, in place of their TypeScript closure.
- `SystemConfig.parallel` with `ecs.attachWorkers`, run one export of a compiled module across a
  pool of workers, over disjoint row ranges of the matched archetypes.
- `HostCommandDispatcher`, an optional ring transport with fixed slots, for writes from a worker
  or from the wire back into the host ECS.

## Select a memory profile

For a WASM simulation with no copy, make the store itself a shared `WebAssembly.Memory`:

```ts
import { ECS } from "@oasys/oecs";

const ecs = new ECS({
  memory: { backing: { wasm: { maximumPages: 4096 } } }, // 4096 * 64 KiB = 256 MiB limit
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

const ecs = new ECS({ memory: { backing: { wasm: { memory } } } });
```

> [!WARNING]
> You must construct `memory.wasm.memory` with `shared: true`. The engine rejects a memory that is
> not shared, at construction, because the WASM path depends on a `SharedArrayBuffer` backing.

If your backend does not need the storage to be a `WebAssembly.Memory`, but does need bytes that a
worker can see, use the shared profile instead:

```ts
const ecs = new ECS({ memory: { maxBytes: 256 * 1024 * 1024, backing: "shared" } });
```

In a browser, both shared paths require cross-origin isolation:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Two shapes of module contract

Pick one before you write the module. Both share the memory with the engine, and both need the
store base below.

There is a third path, and it is not a backend at all. A `parallel` system carries a compiled
module and an export name, and the engine runs that export across a pool of workers over disjoint
row ranges. It is the kernel contract below, with the dispatch done for you, and
[the module contract](./parallel.md#the-module-contract) states every rule a toolchain has to
follow. See [parallel execution](./parallel.md).

**A kernel over pointers.** The host resolves the query, and calls the module once for each matched
archetype. It passes the byte offset of each declared column, the row count and `dt`. Take each
offset from `forEachChunk`, where every typed array carries its own `byteOffset`. The module knows
nothing about the header, the descriptors or the row counts. So any toolchain that exports a
function over `i32` and `f32` arguments qualifies. Start here.

Three rules follow from one memory shared by every instance of the module, and they hold on both
paths:

- **The stack.** Export `__stack_pointer` as a mutable global, or use no stack. A pool then gives
  each worker a region of its own. Without the export every instance keeps one stack.
- **The data.** A data segment is initialised once and every instance reads it. A static the module
  writes is one variable for every instance, not one for each.
- **The heap.** A module does not allocate while a pool runs it, because every instance draws from
  one heap and nothing serialises them.

**A walker.** The module reads the header and the archetype descriptors itself, resolves its own
columns by `(componentId, fieldId)`, and loops over the rows of every archetype it matches. It
receives the store base through `setLayout` and walks from it on every call. Choose this when one
crossing has to run several systems.

A walker reads a column at `storeBase + byte_off`, and the descriptor region at `storeBase +
layout_descriptor_off`. Every offset the store writes is measured from the header, so a module that
treats one as a buffer address is wrong at any base but zero.

Each archetype descriptor starts with a 40-byte header, then one 16-byte column descriptor per
column. The header holds, in order, `archetype_id`, a component mask of 4 words, `row_count`,
`row_capacity`, `column_count`, `enabled_count` and `entity_ids_off`. A walker steps to the next
record by `40 + column_count * 16`.

`entity_ids_off` is reserved. It will hold the offset of the archetype's row-to-entity table, so a
module can name the entity a row belongs to. The store writes zero today, which says the archetype
carries no such table, and a walker that ignores the field reads every other field as before.
`descriptor.test.ts` locks the offset, the header width and the zero.

A walker re-walks on every call. A store grow relocates a column inside the buffer. It abandons the
block the column sat in. A module that kept the old address writes into that block, reports success
and changes nothing the world reads. `wasm_store_reader.test.ts` pins that silence.

## Published row counts

A walker reads `row_count` and `enabled_count` out of the descriptor. Both are copies. The store
refreshes them at the start of `ecs.update`, at each phase flush, and before each backend dispatch.
So a module the schedule drives sees live counts.

A host that drives a module outside the schedule publishes first:

```ts
ecs.publishRowCounts();      // refresh the descriptor copies
sim.step(storeBase, Pos.id, Vel.id, dt);
```

Without that call the module reads the counts of the last publication and silently skips every row
spawned since.

## The store base

The store header sits at a byte offset the caller chooses, and every offset in the header and in
every column descriptor is measured from it. A wasm-backed world defaults the base to one WASM
page, and it refuses a base of 0.

```ts
const ecs = new ECS({
  memory: {
    backing: { wasm: { maximumPages: 4096 } },
    storeBase: 16 * 1024 * 1024, // above everything the module owns
  },
});
```

Set the base above the module's `__heap_base` plus whatever the module allocates while it runs. A
compiled module owns the low addresses of its linear memory. Its data segment, its shadow stack and
its heap all start there. A store based below them overlaps them, and the loss is silent. The
region that lands under a module is the entity index, and `stateHash` never folds it.

A module built for shared memory fails worse. It initialises its data segment once, behind a guard
word inside the memory. Inside a store that word belongs to the entity index. So whether the
module's constants survive depends on what the world holds. Above the base the same mechanism
works: the guard word and the segment both sit below `__heap_base`, every instance reads the same
constants, and the store never writes there.

The default base clears nothing on its own. It keeps the header off address 0. A safe Zig or Rust
build cannot read address 0, because a non-optional pointer may not be null. A default link places
a module's data far above one page, so read `__heap_base` from the module and pass a base above it.

`storeBaseAbove` does that read for you:

```ts
import { ECS, storeBaseAbove } from "@oasys/oecs";

const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096, shared: true });
const instance = await WebAssembly.instantiate(module, { env: { memory } });

const ecs = new ECS({
  memory: {
    backing: { wasm: { memory } },
    storeBase: storeBaseAbove(instance.exports, 4 * 1024 * 1024), // the module's run-time heap
  },
});
```

It reads `__heap_base` from the exports, as a `WebAssembly.Global` or as a plain number, adds the
extra bytes, and rounds up to a whole WASM page. It throws `INVALID_MEMORY_OPTIONS` when the module
exports no `__heap_base`, and the message names the link flag `--export=__heap_base`.

**The extra bytes are yours to bound.** `__heap_base` is where the module's data segment and its
shadow stack end. Whatever the module allocates while it runs sits above that, and only the module
knows how far. Pass its peak. A store based inside that heap fails the same silent way.

**A pool takes its stack regions from the same span.** The span `[__heap_base, storeBase)` is the
caller's reserve, and `attachWorkers` divides it evenly among the workers to give each instance a
private shadow stack. So a world that runs a `wasm` kernel across a pool adds one stack for each
worker to the extra bytes:

```ts
storeBase: storeBaseAbove(probe.exports, moduleHeapPeak + workers * stackBytes),
```

See [the module contract](./parallel.md#the-module-contract).

`WASM_STORE_BASE_BYTES` is the default base for the wasm backing, one page. It is on
`@oasys/oecs/internal`.

The base never reaches a digest. Both the snapshot and the state hash ignore it, so a heap world
and a module-hosted world with the same history agree.

## Attach a compute backend

A compute backend is small by design. The engine publishes the current store layout. It then calls
`run(handle, dt, tick)` when a scheduled system selected backend execution.

```ts
import type { BackendSystemHandle, ComputeBackend } from "@oasys/oecs";

class WasmBackend implements ComputeBackend {
  constructor(private readonly sim: {
    set_layout(storeBase: number): void;
    run_system(handle: number, dt: number, tick: number): void;
  }) {}

  setLayout(storeBase: number): void {
    this.sim.set_layout(storeBase);
  }

  run(handle: BackendSystemHandle, dt: number, tick: number): void {
    this.sim.run_system(handle as number, dt, tick);
  }
}

const detach = ecs.attachBackend(new WasmBackend(simExports));
```

`dt` is the seconds of the phase, the same value a TypeScript body receives. `tick` is the frame
tick, the count of `update()` calls so far. Neither is in the store bytes, so both travel as call
arguments.

The engine calls `setLayout(storeBase)` immediately when you attach the backend. It calls it again
after each growth of the storage, and after each new publication of the layout. If your WASM side
caches the offsets of the descriptors, the pointers to the columns, or typed views, make them
invalid in `setLayout`.

You can attach one backend to an `ECS` at a time. The function that `attachBackend` gives you
detaches the backend, and the matching systems return to their TypeScript alternative.

## Send systems to the backend

A system selects backend execution when it carries a `backendHandle` that the backend made. With a
backend attached, the schedule calls `backend.run(handle, dt, tick)` in place of `fn`. With no
backend attached, `fn` runs as usual.

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
    movers.forEachChunk((cols, count) => {
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

The row-to-entity table is a main-thread object. A module cannot name an entity from the bytes.

## Two digests, and which one to compare

`ecs.snapshots.stateHash()` folds the live rows of each archetype and the sparse stores. It is not
a digest of the buffer. It needs `deterministic: true`, which rejects a float column, and it never
folds the entity index.

A digest of the bytes is a different number. FNV-1a over `[storeBase, storeBase + capacity)` is a
few lines in any language, and a module can compute it. Name one digest and implement it on both
sides. Comparing one against the other reports a difference that is not there.

## Writes from WASM or from a worker

For mutations that the host must see, and that start outside the schedule, do not write to the
`ECS` directly during a frame. Use the [host write path](./host-write-seam.md). For writes from a
worker or from the wire, connect a ring dispatcher, and let the host write path drain it at the
head of the schedule:

```ts
import { installHostCommandSeam } from "@oasys/oecs";
// The ring transport is a wire and ABI surface, @oasys/oecs/internal (no semver guarantees):
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
   descriptors again, from the base it receives.
6. Put `backendHandle` on the systems that your backend can run, and on no others. Keep `fn` as the
   alternative.
7. Send each write that starts outside the schedule through the host write path. Do not mutate the
   ECS directly.
8. Call `ecs.publishRowCounts()` before each run of a module that you drive outside the schedule.
9. Read the base from the module with `storeBaseAbove(instance.exports, extraBytes)`, and pass the
   module its own peak run-time heap plus one stack for each worker of the pool.
10. Link a kernel module with `--export=__stack_pointer` when its body spills anything, and keep it
    off the module's heap either way.

## See also

- [memory](./memory.md), the storage profiles, the limits, and `memoryPlan`
- [systems](./systems.md), `backendHandle` and the access declarations of a system
- [the host write path](./host-write-seam.md), the typed queue and the ring transport between
  threads
- [parallel execution](./parallel.md), a `wasm` kernel across a pool of workers
- [determinism](./determinism.md), how to keep the heap, shared, and WASM runs comparable
