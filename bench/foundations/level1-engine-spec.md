# Level 1 engine specification: one system across workers

This is the build brief for the first parallel form of oecs. It follows
`direction-parallel-wasm.md` and rests on the probes in `findings-parallel.md`.
It assumes the address-space fix (`storeBase`, relative offsets, `setLayout(base)`,
`run(handle, dt, tick)`) has landed.

## Scope

In: one system body runs across a persistent pool of workers over disjoint row
ranges of dense columns. The schedule keeps its total order. A node, bun or deno
host, and a browser host that itself runs inside a worker.

Out: two different systems at once, a conflict graph, sparse or relation or
resource access from a worker, structural intent from a worker, a browser main
thread as host, reductions across workers. Each is named in the direction file.

## Public surface

### The pool

```ts
const pool = await ecs.attachWorkers({ count: 4 });
// later
await pool.detach();
```

- `attachWorkers` starts `count` workers on the engine's own worker entry
  (`@oasys/oecs/worker`), hands each the store buffer, `storeBase` and a control
  `SharedArrayBuffer`, and resolves when every worker reports ready. One pool per
  world. Attaching twice throws `ECS_ERROR.WORKERS_ATTACHED`.
- The world's backing must be `shared` or `wasm`. A heap world throws
  `ECS_ERROR.WORKERS_NEED_SHARED_BACKING`, and the message names the backing and
  the remedy.
- Node and the node-compatible runtimes use `worker_threads`. A browser uses
  `Worker`. The entry detects which. `Atomics.wait` on the host is required, so a
  browser main thread throws `ECS_ERROR.WORKERS_HOST_CANNOT_PARK` with the remedy
  of hosting the world in a worker.
- `count` defaults to `availableParallelism() - 1`, floor 1, when the runtime
  exposes it.

### The parallel system form

```ts
const integrate = ecs.registerSystem({
  reads: [Vel],
  writes: [Pos],
  queries: [[Pos, Vel]],
  parallel: {
    kernel: { wasm: module, export: "integrate" },          // or { js: url, export: "integrate" }
    columns: [[Pos, "x"], [Pos, "y"], [Vel, "vx"], [Vel, "vy"]],
    minRows: 20_000,
  },
  fn: (ctx, dt) => { /* sequential fallback, also the reference body */ },
});
```

- `parallel.kernel` names a body a worker can load. `wasm` is a compiled
  `WebAssembly.Module` (structured-clone safe, shared with every worker). `js`
  is an absolute module URL the worker imports. `export` is the function name.
- `parallel.columns` is the argument order of the kernel. Each entry is a
  component and a field. Every component named must appear in `reads` or
  `writes`, and every component of the first query must be one of them. A dev
  guard rejects anything else at registration, with `ECS_ERROR.PARALLEL_ACCESS`.
- The kernel receives, per archetype segment: one pointer or view per column,
  then `begin`, `end`, `dt`. For a `wasm` kernel each column argument is the
  absolute byte offset of the column's first row in the shared memory, an `i32`.
  Rows `begin` to `end` are the worker's range, and the kernel addresses row `r`
  at `ptr + r * stride`, where it knows the stride from the field type it
  declared. For a `js` kernel each column argument is a typed array over the
  whole column, and the kernel indexes `begin` to `end`.
- `parallel.minRows` is the total matched row count below which the system runs
  `fn` on the main thread instead. Default is a conservative constant the docs
  call out as a placeholder the caller must tune, because the probes show the
  threshold is a machine and kernel property.
- A parallel system may declare only `reads`, `writes` and `queries`. Any
  `spawns`, `despawns`, `transitions`, `resourceReads`, `resourceWrites`,
  `sparseReads`, `sparseWrites`, `relationReads`, `relationWrites`, `exclusive`
  or `backendHandle` on the same config throws at registration with
  `ECS_ERROR.PARALLEL_ACCESS`. The first query must be dense with-only or
  with-and-without terms. A sparse term, a relation term or a changed filter
  rejects.
- Without an attached pool, or on a heap world, `fn` runs. The system is a
  normal system in every other respect: ordering, run conditions, sets.

## Engine behaviour

### Dispatch

In `_runPhase`, a system whose descriptor carries a parallel plan and whose
world has a pool:

1. Publish row counts if dirty (one flag read when clean).
2. Sum the enabled rows of the matched archetypes on the main thread from the
   query's archetype list. Below `minRows`, call `fn` and return.
3. Write the job: the system's kernel slot, `dt`, the frame tick, and the query's
   include and exclude masks. Bump the epoch, notify, park on the done word until
   every worker reports.
4. Stamp changes at join (below). Record the run tick as for any system.

The dispatch sits inside the same access span as a TypeScript body. Nothing else
runs on the main thread while the host is parked, so no structural change can
overlap a pass. That is the guarantee the structural probe demands, and the
engine gives it by construction rather than by a lock.

### The worker

- At start: receives the buffer, `storeBase`, the control buffer, its index and
  the count. Reports ready.
- On kernel registration (a `postMessage` outside any frame, before the first
  dispatch of that system): compiles or imports the kernel, resolves the export,
  and stores the column specs as `(component_id, field_id, type_tag)` triples.
- On each release: reads the header at `storeBase`. If `view_stamp` moved,
  re-walks the descriptor region and rebuilds its bind for every registered
  kernel, in the lean form. Then, for the job's masks, lists the matched
  archetypes in descriptor order, reads each enabled row count, and computes its
  own row range per archetype from `(rowCount, index, count)` with the same
  integer arithmetic every worker uses. No plan crosses the wire.
- Runs the kernel once per archetype segment with a non-empty range. Adds one to
  the done word and notifies.
- A worker never writes to a column it did not receive, never touches the
  header, never spawns, never calls back.

### Change stamping at join

The row tick plane and the dirty lists are main-thread JS. At join the main
thread, for each component in `writes` and each matched archetype:

- sets the archetype's per-component changed tick to the run tick, the same
  stamp `cols.mut` makes, so `changed()` queries see the archetype, and
- if the component has row ticks, calls `noteScan(cid)` so the next entity-level
  drain scans the plane instead of trusting the list.

This is correct and coarse. A parallel system reports every row of every matched
archetype as changed. A finer stamp is open.

### Partition arithmetic

For an archetype with `n` enabled rows and `K` workers, worker `i` owns
`[floor(n * i / K), floor(n * (i + 1) / K))`. Every worker computes this from
the same inputs. The main thread never computes it, so there is one source of
truth and it is deterministic.

### Errors

Every throw carries an `ECS_ERROR` code, states the fact and the remedy, and
names the value. New codes: `WORKERS_ATTACHED`, `WORKERS_NEED_SHARED_BACKING`,
`WORKERS_HOST_CANNOT_PARK`, `PARALLEL_ACCESS`, `PARALLEL_KERNEL_FAILED` (a
worker reported an exception, the message carries the worker index and the
kernel export name).

## Tests, each must fail against the broken behaviour it names

- Split correctness: a parallel `pos += vel * dt` system across 1, 2, 4 workers
  on an integer deterministic world leaves `stateHash` equal to the sequential
  `fn` run, over several frames, with three matched archetypes and one excluded
  archetype. Mutation: shift one worker's range by one row.
- Column bytes on a float world equal the sequential run with a `Math.fround`
  body. Mutation: skip the last row in the worker.
- `minRows` routes to `fn` below the threshold and to the pool above it.
  Mutation: invert the compare.
- The join stamps: a `changed(Pos)` query after a parallel frame sees every
  matched archetype, and an entity-level `onSet` observer with `trackRows`
  fires for rows the kernel wrote. Mutation: drop the stamp.
- A grow between frames is followed: spawn past capacity between two parallel
  frames, the second frame writes the relocated columns, checked by bytes.
  Mutation: freeze the worker's cached bind.
- A parallel system with a sparse term, a resource, a spawn declaration or
  `exclusive` throws `PARALLEL_ACCESS` at registration.
- A heap world throws `WORKERS_NEED_SHARED_BACKING` on attach.
- Without a pool the system runs `fn` and the world matches the pooled run.
- A kernel that throws surfaces `PARALLEL_KERNEL_FAILED` with the index and the
  export name, and the world remains usable for the next frame.
- A `wasm` kernel and a `js` kernel with the same body give the same bytes.

## Gate

`tsc`, the full suite, the build, the `bench/ab` comparison against the
checkpoint before this phase (the sequential path must not move), and a rerun of
`p24-par-split` rewritten to drive the engine's own pool so the probe measures
the shipped path. Numbers stay under `bench/`.

## Open after this phase

Everything in the direction file's open list, plus: the default `minRows`
placeholder, a browser main-thread host, and a tree join once the pool exists to
measure it on.
