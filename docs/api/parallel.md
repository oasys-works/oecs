# Parallel execution

One system runs across a pool of workers. The schedule keeps its total order, and every other
system runs on the main thread as before.

A parallel system names a **kernel**, which is a body a worker can load. The engine gives each
worker a row range of each matched archetype. The host parks until every worker reports, then it
stamps what the pass wrote. The same system also carries an `fn`, and that body runs below the row
threshold, on a world with no pool, and on a heap world.

## What runs in parallel, and what does not

**In parallel.** The body of one system at a time, over the dense columns of the archetypes its
query matches. Each worker owns a row range of each archetype and writes only the columns the
system declared.

**On the main thread.** Everything else. The schedule, the order of the phases, every other system,
the flush, the command buffer, the observers, the events, the change tick, the row-to-entity table,
the sparse stores, the relations and the resources. A worker sees the store bytes and nothing else.

**Never at the same time as a pass.** Every structural change. The host is parked inside
`Atomics.wait` for the length of a pass, so nothing on the main thread runs. No spawn, no despawn
and no grow can overlap the workers. The engine gives that by construction and not by a lock.

## The pool

```ts
const pool = await ecs.attachWorkers({ count: 4 });

console.log(pool.count);   // the workers it started
await pool.settled();      // every kernel registered so far is loaded

await pool.detach();       // stop every worker, back to the sequential path
```

`attachWorkers` starts the workers on the package's own entry, `@oasys/oecs/worker`. It hands each
one the store bytes, the store base and a control buffer, and it loads the kernel of every parallel
system registered so far. The promise resolves when every worker parks on the barrier with its
kernels in hand. `ecs.workers` reports the attached pool, or `null`.

| Option | What it says |
| --- | --- |
| `count` | Workers to start. Defaults to one below the reported parallelism, floor one |
| `workerUrl` | Where the worker entry lives. Defaults to the sibling of the package entry. A bundled app passes it |
| `joinTimeoutMs` | Milliseconds the host waits at the join before it gives up on the pass |

Rules the engine holds you to:

- **One pool for each world.** A second `attachWorkers` throws `WORKERS_ATTACHED`.
- **The backing must be shared or WASM.** A worker reads the bytes directly, and a plain
  `ArrayBuffer` crosses no thread boundary. A heap world throws `WORKERS_NEED_SHARED_BACKING`.
- **The host must be able to park.** `attachWorkers` probes `Atomics.wait` and throws
  `WORKERS_HOST_CANNOT_PARK` when the host refuses it. A browser main thread refuses it. Host the
  world inside a worker and attach the pool from there.
- **A system registered after the attach runs `fn` first.** A parked worker runs no message
  callback, so the pool releases the workers, hands them the kernel and parks them again. Await
  `pool.settled()` to know the kernel is loaded.
- **A worker entry that will not load fails the attach.** `attachWorkers` throws
  `WORKERS_ENTRY_UNREACHABLE`, and the message names the URL it tried. A bundled app that kept the
  default URL is the case.
- **A kernel that will not load fails the attach.** The message names the worker index and the
  export.
- **A worker that never reaches the join fails the frame.** `joinTimeoutMs` bounds the park. On a
  timeout the frame throws `PARALLEL_KERNEL_FAILED`, and every later frame runs `fn` until you
  detach. The default is a safety net and not a frame budget, so set it lower only to make a hang
  surface sooner.

## With a bundler

Pass `workerUrl`. The default resolution describes the package as it ships, and a bundler does not
ship it that way.

`attachWorkers` resolves the worker entry as the sibling of the module the pool lands in. A bundler
renames that chunk, and it leaves `@oasys/oecs/worker` out of the graph, because no static import
names it. The default then points at a file the server does not hold, and the attach throws
`WORKERS_ENTRY_UNREACHABLE` with the URL it tried.

Vite emits the entry when you ask for it by URL:

```ts
import workerUrl from "@oasys/oecs/worker?worker&url";

// Inside the worker that hosts the world.
const pool = await ecs.attachWorkers({
  count: 3,
  workerUrl: new URL(workerUrl, self.location.href),
});
```

Another bundler takes the same shape. Give it the entry to emit, or copy `dist/worker.js` beside
your output as a static asset, then pass the URL it lands on.

Two more things a browser build needs:

- **Cross-origin isolation.** Serve the page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, so `SharedArrayBuffer` exists.
- **A worker host.** The main thread cannot park, so build the world inside a module worker and
  attach the pool from there.

The package names no node builtin in a specifier a bundler resolves, so a browser build reports no
externalized `node:worker_threads` and ships no stub for one. `src/__tests__/dist_artifact.test.ts`
holds the emitted files to that.

## The parallel system form

### A `js` kernel

A worker cannot receive a closure, so a `js` kernel is a module URL and an export name. Write the
body in a plain module, and import that same module for the `fn`, so one source runs on both paths.

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
import { integrate } from "./kernels.js";

const ecs = ECS.create({ memory: { backing: "shared" } });
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

const pool = await ecs.attachWorkers({ count: 4 });
ecs.update(1 / 60);
```

The URL must be absolute, because the worker imports it from its own location.

### A `wasm` kernel

A `wasm` kernel is a compiled `WebAssembly.Module` and an export name. The module object is
structured-clone safe, so one module is shared with every worker, and each worker instantiates it
against the world's own memory as `env.memory`. So a `wasm` kernel needs the WASM backing. A
`SharedArrayBuffer` cannot be imported as a module memory.

```ts
import { ECS, SCHEDULE, storeBaseAbove } from "@oasys/oecs";

const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096, shared: true });
const module = await WebAssembly.compileStreaming(fetch("./kernels.wasm"));

// One instance on the host, to read where the module's own memory ends.
const probe = new WebAssembly.Instance(module, { env: { memory } });

const ecs = ECS.create({
  memory: {
    backing: { wasm: { memory } },
    storeBase: storeBaseAbove(probe.exports, 4 * 1024 * 1024),
  },
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

const pool = await ecs.attachWorkers({ count: 4 });
```

The TypeScript body beside a module body must compute the same thing. An engine folds a
`Float32Array` expression to f32 today, and that is an optimisation and not a guarantee, so round
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
`i32`, and `dt` is `f64`.

```wat
(func (export "integrate")
  (param $px i32) (param $py i32) (param $vx i32) (param $vy i32)
  (param $begin i32) (param $end i32) (param $dt f64)
  ...)
```

A kernel reads no header, resolves no query and names no entity. It receives addresses, a range and
a time step, and nothing else. Any toolchain that exports a function over `i32` and `f64` arguments
qualifies.

**Every row must be independent of every other row.** A kernel that reads a neighbouring row gives
a different answer under a split, and no oracle in this engine catches it for you.

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
rejects, because a worker resolves the matched archetypes from the archetype masks alone. Give it a
query of with-only or with-and-without terms.

The column list is checked as well. Every component in `parallel.columns` must appear in `reads` or
`writes` **and** in the query, every component in `writes` must appear in `parallel.columns`, and
every component of the query must appear in `reads` or `writes`. Each failure names the component
id and the list that is missing it.

`parallel.query` defaults to the first entry of `queries`, resolved as a with-only query. Pass a
query you built with `without` to get a with-and-without match.

## `minRows`, and why you tune it

`parallel.minRows` is the total matched row count below which the system runs `fn` on the main
thread. Below it the pool is never released, so the frame pays no barrier.

**The default is a placeholder, and you must tune it.** The threshold is a property of the machine
and of the kernel, and never a constant the engine can hold. A heavy kernel crosses far earlier
than a memory-bound one, and one worker is close to a loss at every size. The default is high
enough that a world which never tunes it keeps the sequential path. Measure your own kernel on your
own target. `bench/` holds the measurements this engine was tuned against.

## What the join stamps

A pass writes columns from another thread, so nothing on the main thread notices it. The join does
the noticing, for each component in `writes`:

- it sets the archetype's changed tick for that component, the same stamp `cols.mut` makes, so a
  `changed()` query sees the archetype, and
- it fills the row tick plane of every matched archetype, so an entity-level `onSet` observer fires
  for the rows the pass covered.

**The stamp is coarse on purpose.** A parallel system reports every row of every matched archetype
as changed, whatever the kernel wrote. A finer stamp is not built.

## Determinism

A pooled frame and a sequential frame leave the same world.

- **Every worker computes its own partition.** For an archetype with `n` enabled rows and `K`
  workers, worker `i` owns `[floor(n * i / K), floor(n * (i + 1) / K))`. Every worker derives it
  from the same inputs with the same integer arithmetic. The main thread computes nothing, so no
  plan crosses the wire and no two workers can disagree about who owns a row.
- **The join happens before the flush.** The pass finishes inside the system's own span, and every
  deferred change still applies at the phase boundary.
- **There is no reduction.** The engine folds nothing across workers, because completion order is
  never stable. A host-side fold over per-worker partials is deterministic only when you fix the
  order yourself.
- **The oracle is the state hash.** On a `deterministic: true` world, `ecs.snapshots.stateHash()`
  after a pooled run equals the hash after the sequential run. A float world has no engine oracle,
  so compare the column bytes.

## Growth beside a pass

A store grow relocates columns inside the buffer with no change to the buffer reference, and a
swap-remove moves rows with no signal at all. A worker holding cached views would write into
abandoned bytes, or visit a row twice, and report success either way.

Two things close that:

- **The worker rebinds on `view_stamp`.** It reads the header on every release, compares the stamp
  with its cached bind, and re-walks the descriptor region when the stamp moved. It also re-reads
  the enabled row count of each bound archetype on every release.
- **No structural change can overlap a pass.** The host is parked for the length of the pass, so
  nothing on the main thread runs. The guarantee is structural, and it does not depend on the
  worker noticing anything.

## Limits

Name these before you plan around them.

- **One system at a time.** The pool runs one kernel for each release. Two different systems at
  once needs a conflict graph, per-lane change ticks and per-lane command buffers, and none of that
  is built.
- **No sparse store, no relation, no resource and no structural intent from a worker.** Each one is
  a main-thread object.
- **No browser main thread as host.** It cannot park. Host the world in a worker.
- **No watchdog beyond the join timeout.** The engine notices a worker that misses the join. It
  notices nothing about a worker that answers with wrong bytes.
- **No reduction, and no work stealing.** The partition is fixed before the release.
- **The change stamp is per archetype and per component**, not per row the kernel touched.

## Writes from a different thread

A worker, a development tool, UI code, or a network handler must not mutate the ECS directly while
a frame runs. Use the [host write path](./host-write-seam.md), which drains the commands at the
head of a phase:

```ts
import { installHostCommandSeam } from "@oasys/oecs";

const queue = installHostCommandSeam(ecs);

// At any time, outside the schedule:
queue.setField(entity, Pos, "x", 10);

// The host write path applies it during update(), at a known point.
ecs.update(1 / 60);
```

For data from a worker or from the wire, `HostCommandDispatcher` decodes ring slots of a fixed size
into the same command apply path.

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
