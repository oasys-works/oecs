# Parallel execution

One system runs across a pool of workers. The schedule keeps its total order, and every other
system runs on the main thread as before.

A parallel system names a **kernel**, which is a body a worker can load. The engine gives each
worker a row range of each matched archetype. The host parks until every worker reports, then it
stamps what the pass wrote. The same system also carries an `fn`. That body runs below the row
threshold. It also runs on a world with no pool, and on a heap world.

## What runs in parallel, and what does not

**In parallel.** The body of one system at a time, over the dense columns of the archetypes its
query matches. Each worker owns a row range of each archetype and writes only the columns the
system declared.

**On the main thread.** Everything else:

- the schedule, and the order of the phases
- every other system, the flush and the command buffer
- the observers, the events and the change tick
- the row-to-entity table
- the sparse stores, the relations and the resources

A worker sees the store bytes and nothing else.

**Never at the same time as a pass.** Every structural change. The host is parked inside
`Atomics.wait` for the length of a pass, so nothing on the main thread runs. No spawn, no despawn
and no grow can overlap the workers. The engine gives that by construction and not by a lock.

## The pool

The pool is a plugin. Install it at construction, and a world that never names it carries neither
the pool nor the plan builder.

```ts
import { ECS } from "@oasys/oecs";
import { workers } from "@oasys/oecs/workers";

const world = ECS.create({ plugins: [workers()] });

const pool = await world.workers.attach({ count: 4 });

console.log(pool.count);        // the workers it started
await pool.settled();           // every kernel registered so far is loaded
world.workers.pool;             // the attached pool, or null

await world.workers.detach();   // stop every worker, back to the sequential path
```

`workers.attach` starts the workers on the package's own entry, `@oasys/oecs/worker`. It hands each
one the store bytes, the store base and a control buffer. It loads the kernel of every parallel
system registered so far. The promise resolves when every worker parks on the barrier with its
kernels in hand.

**A world without the plugin validates no `parallel` config.** The refusals below live in the plan
builder, and the plan builder ships with the plugin. Such a world registers the system, leaves its
plan unbuilt and runs its `fn`. A mistyped `parallel.columns` surfaces once you install the plugin,
so install it in the build you develop against.

At the end of a pass every worker adds one to a done word. One worker carries the count to the
worker count. That worker wakes the host. So the host wakes once for a pass, whatever the worker
count is.

| Option | What it says |
| --- | --- |
| `count` | Workers to start. Defaults to one below the reported parallelism, floor one |
| `workerUrl` | Where the worker entry lives. Defaults to `@oasys/oecs/worker` as the package ships it. A bundled app passes it |
| `joinTimeoutMs` | Milliseconds the host waits at the join before it gives up on the pass |
| `stackBytes` | Shadow stack one instance of a `wasm` kernel module gets. Omit it and the pool takes the whole reserve, which leaves the module no heap |

Rules the engine holds you to:

- **One pool for each world.** A second `workers.attach` throws `WORKERS_ATTACHED`.
- **The backing must be shared or WASM.** A worker reads the bytes directly, and a plain
  `ArrayBuffer` crosses no thread boundary. A heap world throws `WORKERS_NEED_SHARED_BACKING`.
- **The host must be able to park.** `workers.attach` probes `Atomics.wait` and throws
  `WORKERS_HOST_CANNOT_PARK` when the host refuses it. A browser main thread refuses it. Host the
  world inside a worker and attach the pool from there.
- **A system registered after the attach runs `fn` first.** A parked worker runs no message
  callback. So the pool releases the workers, hands them the kernel, and parks them again. Await
  `pool.settled()` to know the kernel is loaded.
- **A worker entry that will not load fails the attach.** `workers.attach` throws
  `WORKERS_ENTRY_UNREACHABLE`, and the message names the URL it tried. A bundled app that kept the
  default URL is the case.
- **A kernel that will not load fails the attach.** The message names the worker index and the
  export.
- **A worker that never reaches the join fails the frame.** `joinTimeoutMs` bounds the park. On a
  timeout the frame throws `PARALLEL_KERNEL_FAILED`, and every later frame runs `fn` until you
  detach. The default is a safety net and not a frame budget. Set it lower only to make a hang
  surface sooner.

## With a bundler

Pass `workerUrl`. The default resolution describes the package as it ships, and a bundler does not
ship it that way.

`workers.attach` resolves the worker entry from where the plugin module lands. The package ships
that module one directory below the entry the worker sits beside. A bundler renames that chunk, and
it leaves `@oasys/oecs/worker` out of the graph, because no static import names it. The default then
points at a file the server does not hold. The attach throws
`WORKERS_ENTRY_UNREACHABLE` with the URL it tried.

Vite emits the entry when you ask for it by URL:

```ts
import workerUrl from "@oasys/oecs/worker?worker&url";

// Inside the worker that hosts the world.
const pool = await world.workers.attach({
  count: 3,
  workerUrl: new URL(workerUrl, self.location.href),
});
```

Another bundler takes the same shape. Give it the entry to emit. As an alternative, copy
`dist/worker.js` beside your output as a static asset. Then pass the URL it lands on.

Two more things a browser build needs:

- **Cross-origin isolation.** Serve the page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, so `SharedArrayBuffer` exists.
- **A worker host.** The main thread cannot park, so build the world inside a module worker and
  attach the pool from there.

The package names no node builtin in a specifier a bundler resolves. So a browser build reports no
externalized `node:worker_threads`, and it ships no stub for one. `src/__tests__/dist_artifact.test.ts`
holds the emitted files to that.

Three browser engines run this path: Blink, Gecko and WebKit. Each one does four things:

- it refuses `Atomics.wait` on the main thread
- it loads a `js` kernel by URL inside a pool worker
- it runs a `wasm` kernel over a shared `WebAssembly.Memory`
- it leaves the same state hash as the sequential run

Safari proper is not covered, because `safaridriver` needs a privileged enable
step. `bench/foundations/browser/` holds the harness, and `bench/foundations/findings-parallel.md`
holds the matrix and the gaps.

## The parallel system form

### A `js` kernel

A worker cannot receive a closure, so a `js` kernel is a module URL and an export name. Write the
body in a plain module. Import that same module for the `fn`, so one source runs on both paths.

```js
// kernels.js
export function integrate(px, py, vx, vy, begin, end, dt) {
  for (let i = begin; i < end; i++) {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
  }
}
```

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";
import { workers } from "@oasys/oecs/workers";
import { integrate } from "./kernels.js";

const ecs = ECS.create({ memory: { backing: "shared" }, plugins: [workers()] });
const Pos = ecs.registerComponent({ x: "f32", y: "f32" }, { name: "Pos" });
const Vel = ecs.registerComponent({ vx: "f32", vy: "f32" }, { name: "Vel" });
const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],
  parallel: {
    kernel: { js: new URL("./kernels.js", import.meta.url).href, export: "integrate" },
    columns: [
      [Pos, "x"],
      [Pos, "y"],
      [Vel, "vx"],
      [Vel, "vy"],
    ],
    minRows: 20_000,
    query: movers,
  },
  fn: (ctx, dt) => {
    movers.forEachChunk((cols, count) => {
      const p = cols.mut(Pos);
      const v = cols.read(Vel);
      integrate(p.x, p.y, v.vx, v.vy, 0, count, dt);
    });
  },
});

ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.startup();

const pool = await ecs.workers.attach({ count: 4 });
ecs.update(1 / 60);
```

The URL must be absolute, because the worker imports it from its own location.

### A `wasm` kernel

A `wasm` kernel is a compiled `WebAssembly.Module` and an export name. The module object is
structured-clone safe. So the pool shares one module with every worker. Each worker instantiates it
against the world's own memory as `env.memory`. So a `wasm` kernel needs the WASM backing. A
`SharedArrayBuffer` cannot be imported as a module memory.

Read [the module contract](#the-module-contract) before you build the module. It lists the import,
the export, the store base, the stack rule, the data rule and the heap rule. It gives one build
line for each toolchain.

```ts
import { ECS, SCHEDULE, storeBaseAbove } from "@oasys/oecs";
import { workers } from "@oasys/oecs/workers";

const WORKERS = 4;
const STACK_BYTES = 1024 * 1024;

const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096, shared: true });
const module = await WebAssembly.compileStreaming(fetch("./kernels.wasm"));

// One instance on the host, to read where the module's own memory ends.
const probe = new WebAssembly.Instance(module, { env: { memory } });

const ecs = ECS.create({
  memory: {
    backing: { wasm: { memory } },
    // The module's peak run-time heap, plus one stack for each worker.
    storeBase: storeBaseAbove(probe.exports, WORKERS * STACK_BYTES),
  },
  plugins: [workers()],
});
const Pos = ecs.registerComponent({ x: "f32", y: "f32" }, { name: "Pos" });
const Vel = ecs.registerComponent({ vx: "f32", vy: "f32" }, { name: "Vel" });
const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
  name: "move",
  reads: [Vel],
  writes: [Pos],
  parallel: {
    kernel: { wasm: module, export: "integrate" },
    columns: [
      [Pos, "x"],
      [Pos, "y"],
      [Vel, "vx"],
      [Vel, "vy"],
    ],
    minRows: 20_000,
    query: movers,
  },
  fn: (ctx, dt) => {
    movers.forEachChunk((cols, count) => {
      const p = cols.mut(Pos);
      const v = cols.read(Vel);
      for (let i = 0; i < count; i++) {
        p.x[i] += v.vx[i] * dt;
        p.y[i] += v.vy[i] * dt;
      }
    });
  },
});

ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.startup();

const pool = await ecs.workers.attach({ count: WORKERS, stackBytes: STACK_BYTES });
```

The TypeScript body beside a module body must compute the same thing. An engine folds a
`Float32Array` expression to f32 today. That is an optimisation and not a guarantee. Round
each operation with `Math.fround` when the two bodies must agree bit for bit.

## The kernel signature

The engine calls the kernel once for each matched archetype that holds every named column. It
passes one argument for each entry of `parallel.columns`, in that order, then `begin`, `end` and
`dt`. Rows `begin` to `end` are this worker's half-open range of that archetype.

**A `js` kernel takes typed arrays.** Each column argument is a view over the whole column of the
archetype, with the element type the field declares. Index it from `begin` to `end`.

**A `wasm` kernel takes byte offsets.** Each column argument is the absolute byte offset of the
column's first row inside the shared memory, as an `i32`. The kernel addresses row `r` at
`ptr + r * stride`, with the stride it knows from the field type it declared. `begin` and `end` are
`i32`.

```wat
(func (export "integrate")
  (param $px i32) (param $py i32) (param $vx i32) (param $vy i32)
  (param $begin i32) (param $end i32) (param $dt f64)
  ...)
```

The parameter count is fixed. It is one for each entry of `parallel.columns`, plus three. A worker
reads the count off the export and refuses a mismatch with `PARALLEL_KERNEL_FAILED`, and the
message gives both numbers.

**`dt` takes the type the module declares.** The engine passes a JavaScript number, and the
WebAssembly JS API converts it to the declared parameter type. `f64` carries the value exactly.
`f32` rounds. `i32` truncates toward zero and wraps to 32 bits. That is what an integer world
wants, because a deterministic world takes an integer step. So an `i32` `dt` is a conversion the
contract allows, and not a violation. The TypeScript body beside it must do the same thing.

A kernel reads no header, resolves no query and names no entity. It receives addresses, a range and
a time step, and nothing else.

**Every row must be independent of every other row.** A kernel that reads a neighbouring row gives
a different answer under a split. No oracle in this engine catches it for you.

## The module contract

A `wasm` kernel is one module and one export, and every worker instantiates that module over the
world's memory. Follow the six rules below and a module from any toolchain runs. The rules are
about the memory, and they exist because every instance shares one.

**One import: `env.memory`.** A worker supplies the world's memory and nothing else. The engine
refuses any other import at registration with `PARALLEL_KERNEL_MODULE`, and it names the import. It
also refuses a module that imports no memory. Such a module writes into a linear memory of its own,
and reports success.

**The export is a function with the right arity.** The engine refuses a missing export and an
export that is a global at registration. The worker refuses a wrong parameter count at load.

**The store base clears everything the module owns.** A compiled module owns the low addresses: its
data segment, its shadow stack and its heap base all start there. Read `__heap_base` from the
module and pass a store base above it with `storeBaseAbove`. See [the store base](./wasm.md#the-store-base).

**The stack.** Export `__stack_pointer` as a mutable global, or use no stack at all. Every worker
instantiates the same module over one memory, and a wasm global is per-instance. So every worker's
`__stack_pointer` starts at the address the linker chose. Every worker would then write its frames
to the same bytes. When the module exports the global, the pool gives each worker its own region.
The pool carves it downward from the store base, out of the span above `__heap_base`. When the
module does not export it, the engine cannot find the stack and cannot protect it. So a kernel from
such a module may not use one. An LLVM build spills a local array, a struct passed by pointer, or
the address of a local. Export the global whenever the body does any of those.

**Size the reserve for the workers, and say how much of it is stack.** The regions come out of the
span `[__heap_base, storeBase)`, and the pool carves them downward from the store base. Worker `i`
gets the top of its region at `storeBase - i * stackBytes`. So reserve the module's peak run-time
heap plus one stack for each worker, and pass the same `stackBytes` to `workers.attach`:

```ts
const workerCount = 4;
const stackBytes = 1024 * 1024;      // as deep as your kernel goes
const heapPeak = 4 * 1024 * 1024;    // what the module allocates while it runs

const world = ECS.create({
  memory: {
    backing: { wasm: { memory } },
    storeBase: storeBaseAbove(probe.exports, heapPeak + workerCount * stackBytes),
  },
  plugins: [workers()],
});
const pool = await world.workers.attach({ count: workerCount, stackBytes });
```

Everything below the lowest region stays the module's heap, and the pool never writes there.

**Omit `stackBytes` and the module has no heap.** The pool then divides the whole span among the
workers. Every byte between `__heap_base` and the store base belongs to a stack. That is the
default. It is right for a kernel that allocates nothing, which is what the heap rule below asks
for anyway. It needs no number from you.

`stackBytes` must be an integer, and a multiple of the frame alignment of 16. It must be at least
one WASM page of 65536 bytes. A value outside that fails the attach with `WORKERS_COUNT_INVALID`. A
span too small to hold one region for each worker fails the kernel load with
`PARALLEL_KERNEL_FAILED`. The message names the span, the region, the worker count and the remedy.

A wasm stack has no guard page. A kernel that runs deeper than its region writes into the region
below it, and nothing reports the overrun. Only you can size it. One worker needs no region, because
one instance owns the linked stack alone.

**The data segment is shared, and the heap is shared.** A module built for shared memory
initialises its data segment once, behind a guard word. The linker places that word in the same
memory. So every instance reads the same constants. That works, and the checked-in fixture kernels prove it
across several workers. Two things follow. A static the kernel writes is one variable for every
worker, not one for each. And a kernel does not allocate: `malloc`, `new` and a garbage collector
all draw from one heap that every instance shares, and nothing serialises them.

### Build lines that work

Each of these produces a module the pool runs. `<bytes>` is the maximum of the world's memory in
bytes. The module must declare the same maximum, or the instantiation fails.

```sh
# Zig
zig build-exe kernel.zig -target wasm32-freestanding \
  -mcpu=generic+atomics+bulk_memory -fno-entry -O ReleaseFast -rdynamic \
  --import-memory --shared-memory --max-memory=<bytes> \
  --export=__heap_base --export=__stack_pointer

# Rust, a no_std crate
rustc kernel.rs --target wasm32-unknown-unknown --edition 2021 \
  --crate-type cdylib -C opt-level=3 -C panic=abort \
  -C target-feature=+atomics,+bulk-memory,+mutable-globals \
  -C link-arg=--import-memory -C link-arg=--shared-memory \
  -C link-arg=--max-memory=<bytes> -C link-arg=--no-entry \
  -C link-arg=--export=__heap_base -C link-arg=--export=__stack_pointer \
  -o kernel.wasm

# C, through zig cc, because apple clang has no wasm32 target
zig cc -target wasm32-freestanding -O3 -nostdlib \
  -matomics -mbulk-memory -mmutable-globals \
  -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
  -Wl,--max-memory=<bytes> \
  -Wl,--export=<each kernel> \
  -Wl,--export=__heap_base -Wl,--export=__stack_pointer \
  -o kernel.wasm kernel.c

# AssemblyScript
asc kernel.ts --outFile kernel.wasm --optimize --runtime stub \
  --importMemory --sharedMemory --initialMemory 1 --maximumMemory <pages> \
  --noAssert --enable threads,bulk-memory,mutable-globals
```

AssemblyScript is the one with a narrower contract. It exports no `__stack_pointer` a host can
move. Its constants live on the heap of its runtime, which every instance shares. So an
AssemblyScript kernel keeps every value in a wasm local and allocates nothing.

A module needs no toolchain at all. One of the checked-in fixture kernels is emitted byte by byte.
It carries its own `__heap_base` and `__stack_pointer`. It pushes a frame and reads a data segment.
It runs beside the compiled ones.

## What a parallel system may declare

A parallel system declares `reads`, `writes`, `queries` and its kernel. That is the whole surface.
Everything else reaches state no worker can see, so `registerSystem` refuses it with
`PARALLEL_ACCESS` in a development build.

| Refused beside `parallel` | Why |
| --- | --- |
| `spawns`, `despawns`, `transitions` | A worker makes no structural change |
| `resourceReads`, `resourceWrites` | A resource is a main-thread value |
| `sparseReads`, `sparseWrites` | A sparse store is a main-thread object |
| `relationReads`, `relationWrites` | A relation store is a main-thread object |
| `exclusive` | An exclusive system reaches state no worker can see |
| `backendHandle` | One system body cannot run in two places |
| a missing `fn` | The sequential body is required, and it runs below the threshold |

The query must be dense. A sparse term, a relation term, a hierarchy term or `includeDisabled`
rejects. A worker resolves the matched archetypes from the archetype masks alone. Give it a
query whose only terms are `and` and `not`.

The column list is checked as well. Three rules hold:

- every component in `parallel.columns` must appear in `reads` or `writes`, **and** in the query
- every component in `writes` must appear in `parallel.columns`
- every component of the query must appear in `reads` or `writes`

Each failure names the component id and the list that is missing it.

`parallel.query` defaults to the first entry of `queries`, resolved as a require-only query. Pass a
query you built with `not` to get a require-and-exclude match.

## `minRows`, and why you tune it

`parallel.minRows` is the total matched row count below which the system runs `fn` on the main
thread. Below it the pool is never released, so the frame pays no barrier.

**The default is measured, and it is deliberately too high for most kernels.** It sits above every
crossover a sweep of both bodies, both kernel forms, both backings and every runtime tested found. A
world that never tunes it therefore never pays a pooled frame that the sequential frame would have
won. It pays the other cost instead, which is the gain it does not take.

**A compute-bound kernel should set its own value, far lower.** The crossover is a property of the
body, and one constant cannot hold both cases. A body that does real arithmetic on each row wins
early. A body that only moves memory needs many more rows before the split pays. The default serves
the second case, because that is the case where a wrong guess costs a frame.

The crossover also rises with the worker count, because the barrier grows while the work for each
worker shrinks. The engine cannot fold that into the default, because `workers.attach` runs after
the system is registered.

Your value always wins, and `0` is a value. It means dispatch at every row count.

### Measuring your own kernel

Run `node bench/foundations/p24-par-minrows.mjs`. It pairs two systems over one body. No row count
reaches the `minRows` of the first. The `minRows` of the second is one. So the two lanes differ
only by the dispatch. It sweeps the row count, and prints both milliseconds side by side at every
size. It names the smallest row count that wins and keeps winning.

To measure your own kernel, change three things in that file:

1. `BODIES`, to name your kernel's export and its JavaScript twin,
2. `buildWorld`, to register your components and your archetype shape,
3. `SIZES` and `KS`, to the row counts and worker counts you ship.

Read the crossover of the row that matches your backing, your kernel form and your worker count.
Set `minRows` to it. Read the loss column below that row as well. That is what a value set
too low costs you on every frame.

`bench/foundations/findings-parallel.md` holds the measurements this default came from, and the
cells where the pool loses are still in them.

## What the join stamps

A pass writes columns from another thread, so nothing on the main thread notices it. The join does
the noticing, for each component in `writes`:

- it sets the archetype's changed tick for that component, the same stamp `cols.mut` makes. A
  `changed()` query then sees the archetype.
- it fills the row tick plane of every matched archetype. An entity-level `onSet` observer then
  fires for the rows the pass covered.

**The stamp is coarse on purpose.** A parallel system reports every row of every matched archetype
as changed, whatever the kernel wrote. A finer stamp is not built.

## Determinism

A pooled frame and a sequential frame leave the same world.

- **Every worker computes its own partition.** For an archetype with `n` enabled rows and `K`
  workers, worker `i` owns `[floor(n * i / K), floor(n * (i + 1) / K))`. Every worker derives it
  from the same inputs with the same integer arithmetic. The main thread computes nothing. So no
  plan crosses the wire, and no two workers can disagree about who owns a row.
- **The join happens before the flush.** The pass finishes inside the system's own span, and every
  deferred change still applies at the phase boundary.
- **There is no reduction.** The engine folds nothing across workers, because completion order is
  never stable. A host-side fold over per-worker partials is deterministic only when you fix the
  order yourself.
- **The oracle is the state hash.** On a `deterministic: true` world, `ecs.snapshots.stateHash()`
  after a pooled run equals the hash after the sequential run. A float world has no engine oracle,
  so compare the column bytes.

## Growth beside a pass

A store grow relocates columns inside the buffer, with no change to the buffer reference. A
swap-remove moves rows with no signal at all. A worker holding cached views would write into
abandoned bytes, or visit a row twice, and report success either way.

Two things close that:

- **The worker rebinds on `view_stamp`.** It reads the header on every release, and compares the
  stamp with its cached bind. It re-walks the descriptor region when the stamp moved. It also
  re-reads the enabled row count of each bound archetype on every release.
- **No structural change can overlap a pass.** The host is parked for the length of the pass, so
  nothing on the main thread runs. The guarantee is structural, and it does not depend on the
  worker noticing anything.

## Limits

Name these before you plan around them.

- **One system at a time.** The pool runs one kernel for each release. Two different systems at
  once needs a conflict graph, per-lane change ticks and per-lane command buffers. None of that
  is built.
- **No sparse store, no relation, no resource and no structural intent from a worker.** Each one is
  a main-thread object.
- **No browser main thread as host.** It cannot park. Host the world in a worker. Blink, Gecko and
  WebKit all refuse the park, so this is a browser rule and not one engine's behaviour.
- **No watchdog beyond the join timeout.** The engine notices a worker that misses the join. It
  notices nothing about a worker that answers with wrong bytes.
- **No stack guard.** The pool gives each worker a region and sets `__stack_pointer` to its top. A
  kernel that runs deeper than its region writes into the region below, and nothing reports it.
- **One stack size for every worker.** `stackBytes` is one number for the pool, not one for each
  kernel or each worker.
- **No stack for a module that hides it.** A module that exports no mutable `__stack_pointer` keeps
  the stack the linker gave it, and every worker shares it. Such a kernel uses no stack.
- **No allocation from a module.** Every instance draws from one heap, and nothing serialises them.
- **No reduction, and no work stealing.** The partition is fixed before the release.
- **The change stamp is per archetype and per component**, not per row the kernel touched.

## Writes from a different thread

A worker, a development tool, UI code, or a network handler must not mutate the ECS directly. That
rule holds while a frame runs. Use the [host write path](./host-write-seam.md), which drains the
commands at the head of a phase:

```ts
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);

// At any time, outside the schedule:
queue.setField(entity, Pos, "x", 10);

// The host write path applies it during update(), at a known point.
ecs.update(1 / 60);
```

Data can come from a worker or from the wire. For that data, `HostCommandDispatcher` decodes ring
slots of a fixed size into the same command apply path.

## How to write systems that are ready for the pool

A system that already declares its access honestly is most of the way there.

```ts
const integrate = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  fn: (ctx, dt) => { /* the high-frequency loop */ },
});
```

Rules to follow:

- Declare each component, sparse component, relation, and resource that the system reads or writes.
- Use narrow systems. Do not use broad `exclusive` systems.
- Keep the body row-independent. One row's result must not depend on another row's value.
- Use `ctx.commands` for a structural change during iteration, and let the flush at the end of the
  phase apply it.
- Keep each run condition deterministic and read-only.
- Keep each write from a host or a worker that is outside the schedule behind
  `installHostCommandSeam`.
- Keep a backend system honest: the TypeScript declaration must describe the memory that the
  backend touches.

## What `exclusive` means

`exclusive: true` bypasses the access check for the whole run of the system. It may read, write,
add, remove and destroy anything without declaring it. Use it for the apply system of the host
write path, for save and load, and for debug tools.

It is refused beside `parallel`, because a system that reaches arbitrary state cannot run on a
worker.

```ts
const applyHostCommands = ecs.registerSystem({
  exclusive: true,
  reads: [],
  writes: [],
  fn: (ctx) => { /* may touch arbitrary ECS state */ },
});
```

## The order is still explicit

A pool changes nothing about the order. Inside a phase, oecs sorts the `before` and `after`
constraints topologically. It then uses insertion order to break a tie, which keeps the result
deterministic.

```ts
ecs.addSystems(SCHEDULE.UPDATE,
  input,
  { system: simulate, ordering: { after: [input] } },
  { system: renderPrep, ordering: { after: [simulate] } },
);
```

If two systems are independent, do not add an order constraint between them.

## See also

- [WASM backends](./wasm.md), a shared `WebAssembly.Memory`, the store base, and `ComputeBackend`
- [memory](./memory.md), the heap, shared, and WASM storage profiles, and `storeBase`
- [systems](./systems.md), the access declarations, `parallel`, `backendHandle` and `exclusive`
- [schedule](./schedule.md), the phases, the order, system sets, and run conditions
- [errors](./errors.md), the codes a pool and a parallel registration throw
- [the host write path](./host-write-seam.md), safe writes from outside the schedule
- [plugins](./plugins.md), what a world installs at construction, and what a bare world carries
