# findings, running one system on several workers

A worker that holds only the store `SharedArrayBuffer` reads exactly what the
main thread's query reads, and a row-range split of a per-row kernel across
eight workers leaves the same bytes and the same `stateHash` as the sequential
run, on three runtimes and two engine families. The split pays for itself above
a hundred thousand rows on the cheap kernel and above ten thousand rows on the
heavy one. A grow moves the archetype and silently voids every cached view, and
a swap-remove beside a live pass corrupts rows. Both are demonstrated, not
argued.

Node v24.12.0, Deno 2.9.1, Bun 1.3.13. Darwin arm64, Apple silicon.
`os.availableParallelism()` reports **10**, so K is capped at 8.
oecs 0.6.0-dev, production artifact from `dist/`.
**Every number is one machine and one build. Read the positions and the ratios.**

## Status

Every probe here ran to completion on node, on deno and on bun. Nothing is
outstanding.

| probe | node | deno | bun | command |
| --- | --- | --- | --- | --- |
| `p24-par-crossing.mjs` | ran | ran | ran | `node bench/foundations/p24-par-crossing.mjs` |
| `p24-par-bytes-view.mjs` | ran | ran | ran | `node bench/foundations/p24-par-bytes-view.mjs` |
| `p24-par-split.mjs` | ran | ran | ran | `node bench/foundations/p24-par-split.mjs` |
| `p24-par-conflict.mjs` | ran | ran | ran | `node bench/foundations/p24-par-conflict.mjs` |
| `p24-par-structural.mjs` | ran | ran | ran | `node bench/foundations/p24-par-structural.mjs` |
| `p24-par-engine.mjs` | ran | ran | ran | `node bench/foundations/p24-par-engine.mjs` |
| `p24-par-join.mjs` | ran | ran | ran | `node bench/foundations/p24-par-join.mjs` |
| `p24-par-minrows.mjs` | ran | ran | ran | `node bench/foundations/p24-par-minrows.mjs` |

The first five probes changed no file under `src/`, so there is no patch to apply
for them. `p24-par-engine.mjs` came later and measures the shipped engine, so it
fails if the engine regresses. `p24-par-join.mjs` spawns node, deno and bun
itself, so one command prints all three. `p24-par-minrows.mjs` sets
`DEFAULT_PARALLEL_MIN_ROWS`, and it is the file to rerun when that value is
questioned.

Swap `node` for `deno run -A` or for `bun` to repeat on the other runtimes.

The readers now add the header offset to every offset they read, because the
store writes each one measured from the header.
`node bench/foundations/run.mjs p24` runs every one, because `run.mjs` already
matches any file named `p<digits>-`.

Known defects in the probes themselves:

- **The bun spin figure in the crossing probe is bimodal across whole runs.**
  Its median moved between 253 and 302272 nanoseconds over three runs of the
  same file. The number is reported as a range and must not be quoted as one
  value.
- **The despawn race needs the progress word to fire.** An earlier version
  posted the spin job and despawned at once. The host finished before the worker
  woke, and the probe reported a clean run. The worker now publishes its pass
  number and the host waits for a third of the passes before it acts. A future
  edit that drops that wait will silently turn the probe into decoration.
- **The walk cost is timed on the main thread**, where the descriptor bytes are
  already in cache. A worker on a cold core pays more.

Helpers live under `bench/foundations/par/`: `view.mjs` (the descriptor walk and
the column bind), `pool.mjs` (the persistent worker pool and the barrier),
`join.mjs` (the four join variants and the loop they share), `kernels.mjs` (the
two kernels and the partition), `world.mjs` (the world every probe builds, and
the public seam to the buffer), and one worker file for each probe.

---

## What this study did not test

Name the gaps first, because a gap is a risk and a written risk is one you can
control.

- **No browser.** Every probe uses `node:worker_threads` and parks the host on
  `Atomics.wait`. A browser main thread refuses `Atomics.wait`, so a browser host
  must poll. The join cost there is unmeasured.
- **No SpiderMonkey.** Firefox is a supported target in the README and no probe
  here reaches it.
- **No sparse store, no relation, no command buffer, no observer.** Only dense
  archetype columns cross to a worker. Every other subsystem is main-thread JS
  and no worker touches it.
- **No real scheduler.** The probe releases one kernel at a barrier. It does not
  build a conflict graph from the access declarations, does not run two different
  systems at once, and does not interleave a parallel system with a sequential
  one.
- **No WASM.** That is a separate study.
- **One machine, ten logical cores, one thermal state.** A run under load will
  read differently.
- **The float lane has no engine oracle.** `snapshots.stateHash()` refuses to run
  on a world that holds float columns, so the float lane is checked by an exact
  byte compare written inside the probe. The integer lane carries the engine's
  own oracle.

---

## P24 crossing. The floor a split has to clear

**Question.** What does it cost to release a worker and learn it finished, with
an empty worker body?

**Method.** One process. A pool of workers parked on `Atomics.wait` over one
control word. The host bumps an epoch word, notifies, then waits for a done
counter to reach the worker count. Three host wait styles: park on
`Atomics.wait`, spin on `Atomics.load`, and spin a bounded number of times then
park. `postMessage` is measured separately, on a worker that is not in the
barrier loop, because `Atomics.wait` parks the whole thread and a parked worker
never runs its message callback. Median of many samples, spread reported.

### The crossing, nanoseconds for one release and one join

| path | node | deno | bun |
| --- | --- | --- | --- |
| `postMessage` round trip, one number | 8751 | 23666 | 8781 |
| `postMessage` round trip, 512 B copy | 9509 | 24627 | 10948 |
| Atomics wake, one worker, host parks | 3186 | 3490 | 4867 |
| Atomics wake, one worker, host spins then parks | 2083 | 2228 | 230 |
| Atomics wake, one worker, host spins | 2010 | 2062 | 253 to 302272, bimodal |
| Atomics barrier, 2 workers, host parks | 5189 | 5159 | 5529 |
| Atomics barrier, 4 workers, host parks | 11324 | 11398 | 15327 |
| Atomics barrier, 8 workers, host parks | 29223 | 28304 | 48978 |
| Atomics barrier, 2 workers, host spins then parks | 5979 | 5081 | 25006 |
| Atomics barrier, 4 workers, host spins then parks | 8401 | 9107 | 47527 |
| Atomics barrier, 8 workers, host spins then parks | 41828 | 41538 | 85192 |

Spread, node, eight workers, host parks: p25 28523, p75 30450, min 27885, max
34601.

### One word, atomic against plain, nanoseconds for one operation

| op | node | deno | bun |
| --- | --- | --- | --- |
| plain field `++` on an object | 3.08 | 2.04 | 5.25 |
| plain store into a heap `Int32Array` | 2.42 | 2.33 | 6.25 |
| plain store into a shared `Int32Array` | 2.50 | 2.29 | 6.13 |
| `Atomics.add` on a shared `Int32Array` | 8.87 | 8.62 | 6.25 |
| plain read of a shared `Int32Array` | 3.00 | 2.33 | 6.21 |
| `Atomics.load` on a shared `Int32Array` | 8.54 | 8.25 | 5.62 |

### Worker startup, milliseconds, construction to the first message

| workers | node | deno | bun |
| --- | --- | --- | --- |
| 1 | 16.50 | 19.24 | 5.01 |
| 2 | 16.06 | 35.69 | 4.93 |
| 4 | 18.13 | 74.73 | 5.17 |
| 8 | 23.77 | 147.70 | 6.02 |

### What it shows

- **The Atomics barrier is cheaper than `postMessage`, and the gap grows with the
  payload.** On deno `postMessage` costs an order more than the barrier.
- **The barrier is not free and it is not flat.** The join cost rises faster than
  linearly in the worker count on every runtime. The host notifies once but each
  worker increments the same done word and notifies it, so eight workers contend
  on one cache line. A tree join, or one done word for each worker, is untested
  and is the obvious next thing to try.
  **The cache line reading is wrong, and the join section below corrects it.** One
  done word for each worker removes the contention and measures the same. The cost
  is worker wake latency, and a tree join makes it worse.
- **A spin-then-park host is a win on node and deno and a loss on bun.** On bun
  the spin-then-park barrier costs several times what the parking barrier costs,
  at every worker count. Do not build a host wait policy on the bun spin number.
- **An atomic on one word costs a few times a plain access on V8, and nothing on
  JavaScriptCore.** A shared change tick would pay that on every system boundary,
  not on every row, so the cost is a rounding error against a barrier.
- **Worker startup is a one-time cost everywhere, and deno's grows with the
  count.** Deno pays roughly its single-worker cost for each extra worker. A deno
  host must start its pool once and keep it.

### What it does not cover

The barrier releases one job to every worker. It does not measure releasing
different work to different workers, and it does not measure a host that has
other work to do while it waits.

---

## P24 bytes-view. A worker sees bytes, not the world

**Question.** Can a worker that receives only the store buffer find the same
column values the main thread's query reads, and what does re-finding them cost
after a layout republish?

**Method.** A world of 50,000 entities over three archetypes. The worker imports
nothing from the package. It reads the 52-byte header at byte 0, walks the layout
descriptor at `layout_descriptor_off`, and builds a typed-array view for each
`(component_id, field_id)` pair it was asked for. It returns the sum, the first
row, the last row of each bound field, and an FNV fold over the live bytes. The
host derives the same four from `query.forEachChunk`.

The only public path to the buffer is a declared region: `ECSOptions.regions`
plus `ecs.regionHandle(id).buffer`. There is no `ecs.buffer`. The archetype's
live row count comes from the descriptor's `row_count` field, which `ecs.update()`
and `ctx.flush()` publish, and which `ecs.publishRowCounts()` forces.

### Agreement

| slot | archetype id | host rows | worker rows | host sum `Pos.x` | worker sum `Pos.x` | match |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 28571 | 28571 | 14148735 | 14148735 | yes |
| 1 | 2 | 14286 | 14286 | 7197061 | 7197061 | yes |
| 2 | 3 | 7143 | 7143 | 3629204 | 3629204 | yes |

Byte fold: host 3334598825, worker 3334598825, equal. The lean walk agrees with
the object walk.

### What one republish costs a worker, microseconds, node

| what | median | p25 | p75 |
| --- | --- | --- | --- |
| walk 4 archetypes, 24 columns, one object for each column | 6.17 | 6.00 | 6.75 |
| walk plus bind, 4 fields | 10.29 | 9.96 | 10.50 |
| bind only, walk cached | 3.96 | 3.92 | 4.00 |
| lean bind, no per-column object | 3.71 | 3.67 | 3.92 |

### The walk against the archetype count, microseconds, median

| archetypes in the buffer | columns | node walk | node lean bind | deno lean bind | bun lean bind |
| --- | --- | --- | --- | --- | --- |
| 5 | 12 | 1.87 | 1.87 | 1.62 | 2.08 |
| 17 | 48 | 5.79 | 3.25 | 2.63 | 4.21 |
| 65 | 192 | 23.71 | 11.46 | 9.67 | 16.96 |
| 257 | 768 | 95.33 | 46.58 | 39.33 | 67.42 |

### What it shows

- **The buffer alone is enough.** Every archetype, every row count and every
  column offset the query uses is reachable from byte 0. A worker needs no
  archetype graph, no component registry and no query cache.
- **The walk is linear in the total column count and it is not cheap.** A world
  with a few hundred archetypes costs tens of microseconds for each worker on
  each republish. Eight workers pay it eight times, in parallel, but each one
  pays it before it can do any work.
- **Half the walk cost is the object for each column.** A form that reads the
  descriptor bytes once and builds only the views it keeps costs about half the
  form that describes every column first. A production worker uses the lean form.
- **A worker cannot skip the walk by watching the buffer.** See the structural
  probe: the buffer reference does not change on a grow. `view_stamp` in the
  header is the only signal.

### What it does not cover

The walk is timed on the main thread, where the descriptor bytes are already in
cache. The probe does not measure eight workers re-walking at the same moment.

---

## P24 split. One system across K workers

**Question.** Does a row-range split give the same state as the sequential run,
and where does it start to pay?

**Method.** One process for each size. Three archetypes, all holding `Pos`,
`Vel` and `Target`, told apart by two tags, so the split crosses an archetype
boundary. Column capacity pinned so no grow lands inside a timed run.

Every worker computes its own partition from the same inputs: the row counts in
descriptor order, its index, and the worker count. No plan crosses the wire, so
no two workers can disagree about who owns a row.

The world is seeded, the seeded bytes are saved, and every lane restores them
before it runs. Three lanes for each kernel: the registered system driven by
`ecs.update()`, the same kernel over the raw bound views with no engine frame,
and the K-worker split. The comparison is an exact byte compare of every live
column byte, plus `snapshots.stateHash()` on the integer world.

Kernel A is `pos += vel * dt`, three loads and three fused updates, no branch.
Kernel B is a damped spring toward a target: several dozen flops, a square root,
and two branches.

### Correctness

**40 configurations compared. 0 mismatches, on node, on deno and on bun.**

Every K in 1, 2, 4 and 8, at 10,000, 100,000 and 1,000,000 entities, for both
kernels, left column bytes identical to the sequential system. On the integer
world `snapshots.stateHash()` was equal in every configuration as well.

The byte folds are identical across the three runtimes. Kernel A at 1,000,000
entities gives 466449760 on node, on deno and on bun. Kernel B gives 1628554168
on all three. The integer world gives `stateHash` 1801880042 for kernel A and
388972058 for kernel B, on all three. **Two engine families agree bit for bit on
the result of an eight-way split.**

### Speed, node, milliseconds for one frame, workers already started

| entities | kernel | seq system | 1 worker | 2 | 4 | 8 | best gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | A | 0.0219 | 0.0392 | 0.0428 | 0.0379 | 0.0572 | never wins |
| 10,000 | B | 0.0662 | 0.0916 | 0.0647 | 0.0753 | 0.0786 | 1.02x at K=2 |
| 100,000 | A | 0.2159 | 0.2358 | 0.1357 | 0.1037 | 0.1126 | 2.08x at K=4 |
| 100,000 | B | 0.8018 | 0.8206 | 0.6235 | 0.3647 | 0.2681 | 2.99x at K=8 |
| 1,000,000 | A | 2.1358 | 2.1662 | 1.1366 | 0.6303 | 0.4274 | 5.00x at K=8 |
| 1,000,000 | B | 8.3213 | 8.3711 | 6.1955 | 3.2829 | 1.8659 | 4.46x at K=8 |

Spread, node, 1,000,000 entities, kernel A, eight workers: p25 0.3986, p75
0.5016.

### The best gain against the sequential system, each runtime

| entities | kernel | node | deno | bun |
| --- | --- | --- | --- | --- |
| 10,000 | A | never wins | never wins | 1.19x at K=4 |
| 10,000 | B | 1.02x at K=2 | 1.05x at K=2 | 1.96x at K=4 |
| 100,000 | A | 2.08x at K=4 | 1.83x at K=4 | 3.92x at K=8 |
| 100,000 | B | 2.99x at K=8 | 3.81x at K=8 | 5.25x at K=8 |
| 1,000,000 | A | 5.00x at K=8 | 5.07x at K=8 | 5.54x at K=8 |
| 1,000,000 | B | 4.46x at K=8 | 6.85x at K=8 | 6.36x at K=8 |

Bun's larger ratios come from a slower sequential baseline, not a faster parallel
one. Kernel A at 1,000,000 entities takes 6.28 ms sequentially on bun against
2.14 ms on node, and 1.13 ms on eight bun workers against 0.43 ms on eight node
workers. **Read the milliseconds, not only the ratio.**

### What it shows

- **The split is correct at every size and every worker count tested.** A
  per-row-independent kernel over a row-range partition changes no byte relative
  to the sequential run.
- **`ecs.update()` costs almost nothing against the kernel.** The registered
  system and the bare loop are within the spread of each other at every size. The
  engine frame is not what a split has to beat.
- **One worker is always a loss.** It pays the barrier and gains nothing. A
  scheduler must not split below its own crossing cost.
- **The crossover is between ten thousand and a hundred thousand rows on node and
  deno**, and it is lower for the heavier kernel. At ten thousand rows kernel A
  never wins on either V8 runtime, and kernel B wins by a margin inside the
  spread.
- **Eight workers is worse than four at a hundred thousand rows on node and deno
  for kernel A**, and better at a million. The barrier grows with K while the work
  for each worker shrinks.
- **Scaling stops short of linear.** Eight workers give about five times on kernel
  A at a million rows, not eight. Kernel A is memory bound and eight cores share
  one memory system. Kernel B, the compute-bound one, reaches nearly seven times
  on deno.

### What it does not cover

The parallel frame here is one barrier release. It has no sequential systems
around it, no flush, no command apply, and no change-tick advance. A real frame
adds all four. The probe never grows or despawns during a timed run, which is the
case the structural probe shows is unsafe.

---

## P24 conflict. The negative control

**Question.** The split probe reports that every configuration matched. Does the
comparison detect a real conflict, or does it detect nothing?

**Method.** 200,000 entities. Three conflicts written on purpose, each repeated
eight times from the same restored seed. The probe prints every run.

### Case 1. Every worker writes every row of `Pos.x`

FNV over the live column bytes. The sequential answer applies the kernel K times
in order.

| workers | distinct results over 8 runs, node | deno | bun |
| --- | --- | --- | --- |
| 2 | 3 | 4 | 1 |
| 4 | 6 | 8 | 6 |

At two workers on node, five of the eight runs matched the sequential answer by
luck and three did not. On bun at two workers all eight runs matched. **A run
that agrees is not a run that is safe.** The conflict is real in every case and
the oracle fires at four workers on all three runtimes.

### Case 2. Every worker folds `Pos.x` into one shared cell, no atomic

Sequential sum is 99,900,000.

| workers | distinct results over 8 runs | example result, node | lost |
| --- | --- | --- | --- |
| 2 | 7 | 90261326 | 9638674 |
| 4 | 8 | 44897036 | 55002964 |
| 8 | 8 | 23361890 | 76538110 |

Every run on every runtime differs from the sequential sum, and at eight workers
about three quarters of the total is lost. This is the loudest failure in the
study.

### Case 3. A private cell for each worker, and the host's fold order

Nothing races here. Each worker writes its own word. The only question is the
order the host folds the partials in.

| partials | workers | folds in worker order | folds in completion order | distinct completion orders over 8 runs |
| --- | --- | --- | --- | --- |
| world values | 4 | 1 | 1 | 5 |
| world values | 8 | 1 | 1 | 8 |
| spread magnitudes | 4 | 1 | 1 | 5 |
| spread magnitudes | 8 | 1 | 2 | 8 |

**The completion order varies on every run and at every worker count.** With the
world's own values the fold order did not change the sum, because those partials
are small whole numbers a double adds exactly. Scale each worker's partial to a
different magnitude and the completion-order fold takes two distinct values over
eight runs at eight workers, while the worker-order fold takes one.

The same point without any worker: summing
`[1e16, 1, -1e16, 1, 2, -3, 1e-8, 4]` forward gives 4.00000001 and backward
gives 4.

### What it shows

- **The oracle works.** Overlapping writes and an unguarded shared cell both give
  results that vary run to run and differ from the sequential answer. The split
  probe's clean sheet is therefore evidence and not an artifact.
- **A host-side reduction over per-worker partials is deterministic only if the
  fold order is fixed.** The completion order is never stable. A reduction that
  folds in arrival order is a determinism defect that hides whenever the partials
  happen to add exactly.
- **A conflict can pass by luck.** Two workers on bun matched the sequential
  answer eight times out of eight. A single passing run proves nothing.

### What it does not cover

Both conflicts are within one column. The probe does not build a conflict across
two components, across a sparse store, or across a relation, and it does not test
what the access declarations would say about any of them.

---

## P24 structural. A structural change beside a worker iteration

**Question.** The tree claims a grow or a swap-remove cannot run beside a worker
that iterates cached views. Is the claim true, and what exactly does the worker
see?

**Method.** A worker binds its views once and refuses to rebind unless told to.
`Pos.z` carries a row identity so a duplicated or a vanished row is visible as a
number and not only as a bad sum. Stages 1 and 2 are staged rather than raced, so
they repeat. Stages 3a and 3b are real races: the worker publishes its pass number
into a shared word and the host waits for the pass to be well under way before it
makes the structural change. Without that wait the host finished before the worker
woke and the probe measured nothing.

### Stage 1. The host grows while the worker holds cached views

3,000 rows, column capacity 4,096, then 4,096 more spawns.

| backing | same buffer reference | bytes before | bytes after | `view_stamp` | `Pos.x` byte offset | column moved |
| --- | --- | --- | --- | --- | --- | --- |
| shared, growable | yes | 12808384 | 13103296 | 2 to 3 | 12660928 to 12808384 | yes |
| shared, fixed at the cap | yes | 67108864 | 67108864 | 2 to 3 | 12660928 to 12808384 | yes |

What the worker read afterwards, from views it never rebound.

| backing | worker rows | live rows in the descriptor | host rows | worker sum `Pos.x` | host sum `Pos.x` | worker `Pos.x[0]` |
| --- | --- | --- | --- | --- | --- | --- |
| shared, growable | 3000 | 7096 | 7096 | 300000 | 5513592 | 100 |
| shared, fixed at the cap | 3000 | 7096 | 7096 | 300000 | 5513592 | 100 |

A rebind gives 7096 rows and sum 5513592 on both backings, which is the truth.

### Stage 2. The host despawns a block from the middle

10,000 rows, 2,000 despawned, each a swap remove.

| rows at bind | live rows after | column moved | stale pass visits | visits past the live tail | identities read twice | identities no longer live |
| --- | --- | --- | --- | --- | --- | --- |
| 10000 | 8000 | no | 10000 | 2000 | 2000 | 0 |

### Stage 3a. The worker adds each row's own identity while the host despawns

20,000 rows, 6,000 despawned, 300 passes. A clean run leaves every live row at
`100 + passes * identity`.

| attempt | host ran during passes | live rows after | rows with all passes | rows without | min passes seen | max passes seen | values off the lattice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 100 to 126 | 14000 | 12649 | 1351 | 299 | 300 | 110 |
| 1 | 100 to 130 | 14000 | 12715 | 1285 | 299 | 300 | 33 |
| 2 | 100 to 117 | 14000 | 12776 | 1224 | 299 | 300 | 49 |

### Stage 3b. The same pass, and the host grows instead

6,000 rows at bind, 8,192 spawned during the pass, 400 passes.

| runtime | host ran during passes | live rows after | column moved | rows with all passes | min passes seen | max passes seen |
| --- | --- | --- | --- | --- | --- | --- | --- |
| node | 135 to 264 | 14192 | yes | 0 | 172 | 173 |
| deno | 134 to 282 | 14192 | yes | 0 | 187 | 187 |
| bun | 134 to 164 | 14192 | yes | 0 | 144 | 145 |

### What it shows

- **The claim is true, and the failure is silent.** After a grow the worker's
  cached views read a block the store abandoned. The bytes are still there, still
  aligned, still the right type. The worker's sum is a plausible number that is
  wrong by an order.
- **The buffer reference does not change and the byte length may not change.**
  Both backings kept the same `SharedArrayBuffer` object. The fixed-cap backing
  kept the same byte length as well. A worker cannot detect a grow by watching the
  buffer. `view_stamp` moved from 2 to 3 in both cases and is the only signal.
- **Growable and fixed-cap fail the same way.** The fixed-cap backing never
  resizes, and the archetype still relocated to the tail. Reserving the cap up
  front does not make a cached view safe. This overturns the intuition that a
  fixed buffer makes a worker's views permanent.
- **A swap-remove does not move a column, and that makes it worse, not better.**
  The offset stayed put, so a worker sees no signal at all. With a stale row count
  it visited 2,000 rows past the live tail and read 2,000 identities twice,
  because the abandoned tail still holds copies of the rows that moved down.
- **A live despawn corrupts rows.** Around a tenth of the live rows missed a pass,
  and dozens of rows on every attempt hold a value that is not on the lattice at
  all, which is a torn read, add and store.
- **A live grow loses every write after the relocation.** Not one of 6,000 rows
  received all 400 passes, on any runtime. Every row stopped at the pass where the
  store copied the live rows to their new home. Everything the worker wrote after
  that landed in memory nothing reads.

### What it does not cover

The probe never tests a worker that re-reads `view_stamp` before each pass, which
is the obvious mitigation, nor a barrier that forbids a structural change while
any worker is inside a pass. It does not test a WASM backing, whose grow detaches
views rather than relocating them, and it makes only one archetype grow.

---

## P24 engine. The shipped pool, not a hand-rolled one

**Question.** The split probe measured a hand-rolled split: its own worker file, its own barrier,
its own bind. Does the engine's own pool leave the same state, and where does it pay against the
engine's own sequential body?

**Method.** One process for each size. The world comes from `dist/`, and everything between the
frame and the rows is engine code: `ecs.attachWorkers`, a system with a `parallel` config, the
control buffer, the shipped worker entry, the descriptor walk and the join stamp. The probe calls
`ecs.update()` and nothing else.

Three archetypes, all holding `Pos`, `Vel` and `Target`, told apart by two tags, so the split
crosses an archetype boundary. Column capacity pinned so no grow lands inside a timed run. Two
systems are registered, one for each kernel, and a run condition enables one at a time.

Each kernel body lives in one module. The `parallel.kernel` names it by URL and export, and the
`fn` imports the same file, so a difference between the two lanes can only come from the split.

The world is seeded and the seeded bytes are saved. Each lane restores them before it runs. The
sequential lane runs with no pool attached, so the schedule calls `fn`. Each pooled lane attaches
`K` workers, restores, and times the same frames. The comparison is an exact byte compare of every
live column byte, plus `snapshots.stateHash()` on the integer world.

Kernel A is `pos += vel * dt`. Kernel B is a damped spring toward a target, with a square root and
two branches.

### Correctness

**32 configurations compared on each of node, deno and bun. 0 mismatches on all three.**

Every K in 1, 2, 4 and 8, at 10,000, 100,000 and 1,000,000 entities, for both kernels, left column
bytes identical to the sequential `fn` run. On the integer world `snapshots.stateHash()` was equal
in every configuration.

The byte folds and the hashes agree across the three runtimes. Kernel A at 1,000,000 entities gives
466449760 on node, on deno and on bun. Kernel B gives 1628554168 on all three. The integer world at
100,000 entities gives `stateHash` 1801880042 for kernel A and 388972058 for kernel B, on all
three.

**Those are the same numbers the hand-rolled split reported.** The engine's pool and the probe's
own barrier reach the same state, and two engine families agree with both.

### Speed, node, milliseconds for one frame, pool already attached

| entities | kernel | sequential `fn` | 1 worker | 2 | 4 | 8 |
| --- | --- | --- | --- | --- | --- | --- |
| 10,000 | A | 0.0343 | 0.0290 | 0.0210 | 0.0367 | 0.0497 |
| 10,000 | B | 0.0687 | 0.0757 | 0.0598 | 0.0582 | 0.0763 |
| 100,000 | A | 0.3385 | 0.2281 | 0.1429 | 0.1110 | 0.1046 |
| 100,000 | B | 0.8234 | 0.8323 | 0.6271 | 0.3511 | 0.3095 |
| 1,000,000 | A | 2.1788 | 2.2033 | 1.1717 | 0.6359 | 0.5478 |
| 1,000,000 | B | 8.5138 | 8.5254 | 6.3867 | 3.2838 | 2.5372 |

Integer lane, node, 100,000 entities: kernel A 0.3835 sequential against 0.1140 on eight workers,
kernel B 1.0777 against 0.3353.

### The best gain against the sequential `fn`, each runtime

| entities | kernel | node | deno | bun |
| --- | --- | --- | --- | --- |
| 10,000 | A | 1.64x at K=2 | 2.63x at K=2 | 1.26x at K=2 |
| 10,000 | B | 1.18x at K=4 | 1.14x at K=4 | 2.06x at K=4 |
| 100,000 | A | 3.24x at K=8 | 4.51x at K=8 | 3.13x at K=4 |
| 100,000 | B | 2.66x at K=8 | 3.35x at K=8 | 3.74x at K=8 |
| 1,000,000 | A | 3.98x at K=8 | 3.66x at K=8 | 4.15x at K=8 |
| 1,000,000 | B | 3.36x at K=8 | 4.47x at K=8 | 4.31x at K=8 |

Bun's sequential baseline is the slowest of the three. Kernel A at 1,000,000 entities takes 6.1274
sequentially on bun against 2.1788 on node, and 1.4768 on eight bun workers against 0.5478 on eight
node workers. **Read the milliseconds, not only the ratio.**

### What it shows

- **The shipped pool is correct at every size and every worker count tested.** The dispatch, the
  plan, the shipped worker entry and the join leave the same bytes and the same state hash as the
  system's own `fn`.
- **One worker is not always a loss here, and that is a change from the hand-rolled probe.** The
  two probes have different baselines. The split probe compared the workers against a bare loop over
  the same bound views. This probe compares them against the engine's `fn`, which pays
  `forEachChunk` and `cols.mut` for each archetype, and the kernel lane pays none of that. On the
  cheap kernel one worker already matches or beats the main thread at ten thousand and a hundred
  thousand rows. **The gain there is the driver, not the parallelism.**
- **The gain is smaller than the hand-rolled split reported at a million rows.** The split probe
  reached about five times on kernel A with eight workers against its own sequential system. This
  probe reaches about four. The engine frame, the run condition, the row-count publish and the join
  stamp all sit inside the measured frame here.
- **Eight workers stops paying before the core count.** Kernel A gains almost nothing from four to
  eight workers at a hundred thousand rows on node, and the same holds on the integer lane. Kernel A
  is memory bound, and eight cores share one memory system.
- **A small world still loses.** At ten thousand rows both kernels lose at eight workers on node and
  on deno. The barrier grows with the worker count while the work for each worker shrinks. This is
  what `parallel.minRows` exists for.
- **The worker entry starts on all three runtimes.** node, deno and bun each resolve
  `@oasys/oecs/worker` from the sibling of the package entry, start the workers through
  `node:worker_threads`, load a `js` kernel by URL and park on the barrier. The whole driver, which
  spawns one child process for each size, also runs to completion on bun and on `deno run -A`.

### Known defects in this probe

- **The sequential baseline is bimodal at a hundred thousand rows on V8.** For kernel A its median
  sits well above its p25, and its p25 matches the one-worker lane almost exactly. The shape is
  stable across repeated runs, and it is absent on bun. So every ratio at that size is a range, and
  the one-worker figure there must not be read as a gain.
- **The two lanes do not share a driver.** The kernel and the `fn` share a body, and they do not
  share the loop that reaches the columns. The comparison is honest about a frame, and it is not an
  isolated measure of the split.
- **The frame holds one parallel system and nothing else.** No sequential system beside it, no
  command apply, no observer drain.
- **The pool is attached and detached between worker counts**, inside the same process. A leak
  across that boundary would show up as drift, and nothing here would name it.

### What it does not cover

No `wasm` kernel is timed. The `wasm` path has a test but no probe, so its crossing cost inside the
engine is unmeasured. No browser. No grow or despawn inside a timed run. No world with more than
three archetypes, and none with a tag-only archetype the bind must skip. No measurement of the join
timeout, which only fires on a worker that has already failed.

---

## P24 join. Four ways for K workers to report a finished pass

**The join is not where the barrier's cost sits, and the shipped join still wakes the host once
for each worker.** Cutting the wake count to one for each pass is free and it never loses, and it
does not move a frame the engine runs. Two of the four variants lose outright.

**Question.** The crossing probe measured the whole barrier and said the join grows faster than the
worker count. It never took the join apart. Which part of the release and the join grows, and does
a cheaper join move a pass?

**Method.** One hand-rolled pool for each variant, in a process of its own. The release side is
identical in all four: the host bumps an epoch word and notifies it, and every worker sleeps on that
word. Only the report differs.

| variant | the report |
| --- | --- |
| a | one counter, every worker adds and notifies. What the engine shipped |
| b | one counter, only the worker whose add returned K-1 notifies |
| c | one word for each worker, one cache line apart. The host scans the K words and parks on the first that is behind |
| d | a tree. Worker i waits for the words of 2i+1 and 2i+2, then writes its own. The host waits on worker 0's word |

Variants c and d write the epoch into the word instead of counting, so the host clears nothing
before a release and a stale word can never read as finished. Variants a and b need the counter
cleared, which is one extra store the engine pays today.

The words of c and d sit 128 bytes apart, because that is the Apple silicon line size.

Three measurements for each variant and each K: an empty body, a light body, and a whole pass of
`pos += vel * dt` over a shared world split by row range. The probe also counts how many times the
host comes out of `Atomics.wait` for one pass. `bench/foundations/p24-par-join.mjs`, helpers in
`bench/foundations/par/join.mjs` and `bench/foundations/par/join-worker.mjs`.

### Release to the host's return, nanoseconds for one pass, empty body

| K | join | node | deno | bun |
| --- | --- | --- | --- | --- |
| 2 | a | 6187 | 6084 | 6680 |
| 2 | b | 5189 | 5454 | 8883 |
| 2 | c | 5299 | 5506 | 5841 |
| 2 | d | 6529 | 6522 | 8141 |
| 4 | a | 16438 | 15576 | 20720 |
| 4 | b | 13510 | 15769 | 21495 |
| 4 | c | 11494 | 10985 | 32249 |
| 4 | d | 12283 | 10713 | 52164 |
| 8 | a | 30866 | 31443 | 89488 |
| 8 | b | 30658 | 29743 | 64508 |
| 8 | c | 30386 | 32010 | 56799 |
| 8 | d | 35121 | 33412 | 70603 |
| 10 | a | 38591 | 38620 | 72129 |
| 10 | b | 36900 | 37071 | 63741 |
| 10 | c | 38058 | 37526 | 70719 |
| 10 | d | 44852 | 47929 | 79145 |

Spread, node, eight workers: variant a p25 30534, p75 31679, min 29927, max 35925. Variant b p25
29862, p75 31405, min 29264, max 34672. The two middle halves overlap.

### The same with a light body, nanoseconds for one pass

| K | join | node | deno | bun |
| --- | --- | --- | --- | --- |
| 2 | a | 5958 | 6360 | 6612 |
| 2 | b | 5777 | 5832 | 11186 |
| 2 | c | 5937 | 5781 | 10909 |
| 2 | d | 6667 | 7028 | 7497 |
| 4 | a | 17797 | 17426 | 26065 |
| 4 | b | 15501 | 12857 | 20771 |
| 4 | c | 16616 | 9645 | 20651 |
| 4 | d | 13391 | 10721 | 41448 |
| 8 | a | 32294 | 31754 | 63740 |
| 8 | b | 30853 | 32248 | 60637 |
| 8 | c | 31434 | 30174 | 64919 |
| 8 | d | 36352 | 38192 | 70675 |
| 10 | a | 40771 | 40326 | 73003 |
| 10 | b | 38835 | 38406 | 69994 |
| 10 | c | 38744 | 41556 | 68212 |
| 10 | d | 46076 | 46004 | 75767 |

### Host wakes for one pass, empty body. One is the floor

| K | join | node | deno | bun |
| --- | --- | --- | --- | --- |
| 2 | a | 1.06 | 1.04 | 1.06 |
| 2 | b | 1.00 | 1.00 | 1.00 |
| 2 | c | 1.01 | 1.01 | 1.01 |
| 2 | d | 1.00 | 1.00 | 1.00 |
| 4 | a | 1.41 | 1.27 | 1.61 |
| 4 | b | 1.00 | 1.00 | 1.00 |
| 4 | c | 1.03 | 1.04 | 1.24 |
| 4 | d | 1.00 | 1.00 | 1.00 |
| 8 | a | 1.76 | 1.78 | 2.61 |
| 8 | b | 1.00 | 1.00 | 1.00 |
| 8 | c | 1.35 | 1.32 | 1.76 |
| 8 | d | 1.00 | 1.00 | 1.00 |
| 10 | a | 1.96 | 1.89 | 3.02 |
| 10 | b | 1.00 | 1.00 | 1.00 |
| 10 | c | 1.42 | 1.38 | 1.92 |
| 10 | d | 1.00 | 1.00 | 1.00 |

### The pass split in two, nanoseconds, empty body

Each pass reads the clock twice, so the two parts add up to more than the amortised loop above
reports. Read the split and not the total.

| K | join | node release | node join | deno release | deno join | bun release | bun join |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | a | 750 | 4458 | 1000 | 4875 | 2583 | 6854 |
| 2 | b | 667 | 4417 | 709 | 4500 | 1500 | 4959 |
| 4 | a | 1334 | 11958 | 1334 | 11688 | 6187 | 12208 |
| 4 | b | 667 | 7417 | 1167 | 10917 | 6292 | 14979 |
| 8 | a | 3166 | 27709 | 2833 | 27938 | 20958 | 41938 |
| 8 | b | 2520 | 27750 | 2291 | 27291 | 14375 | 20437 |
| 10 | a | 3750 | 35979 | 3084 | 34188 | 22167 | 31875 |
| 10 | b | 3167 | 33521 | 2833 | 35000 | 24458 | 34458 |

### One whole pass of `pos += vel * dt`, milliseconds, node

| K | join | 10,000 rows | 100,000 rows | 1,000,000 rows |
| --- | --- | --- | --- | --- |
| 2 | a | 0.0188 | 0.1255 | 1.1656 |
| 2 | b | 0.0243 | 0.1359 | 1.1774 |
| 2 | c | 0.0248 | 0.1400 | 1.1718 |
| 2 | d | 0.0224 | 0.1308 | 1.1664 |
| 4 | a | 0.0300 | 0.1011 | 0.6169 |
| 4 | b | 0.0269 | 0.0992 | 0.6145 |
| 4 | c | 0.0296 | 0.1042 | 0.6100 |
| 4 | d | 0.0265 | 0.1040 | 0.6140 |
| 8 | a | 0.0449 | 0.0905 | 0.5187 |
| 8 | b | 0.0434 | 0.0913 | 0.5158 |
| 8 | c | 0.0429 | 0.0923 | 0.5208 |
| 8 | d | 0.0486 | 0.0939 | 0.5292 |
| 10 | a | 0.0507 | 0.0916 | 0.4817 |
| 10 | b | 0.0460 | 0.0943 | 0.4665 |
| 10 | c | 0.0483 | 0.0955 | 0.4685 |
| 10 | d | 0.0523 | 0.0974 | 0.4691 |

### The shipped engine, before and after variant b, node

One frame of the `p24-par-engine` world at 10,000 entities, kernel A, three interleaved rounds of
each side. The only difference between the sides is the notify rule inside `barrierLoop`.

| round | side | 1 worker | 2 | 4 | 8 |
| --- | --- | --- | --- | --- | --- |
| 1 | b | 0.0477 | 0.0414 | 0.0360 | 0.0458 |
| 1 | a | 0.0496 | 0.0303 | 0.0360 | 0.0485 |
| 2 | b | 0.0292 | 0.0264 | 0.0342 | 0.0532 |
| 2 | a | 0.0294 | 0.0222 | 0.0365 | 0.0519 |
| 3 | b | 0.0329 | 0.0280 | 0.0345 | 0.0535 |
| 3 | a | 0.0310 | 0.0302 | 0.0368 | 0.0489 |

### What it shows

- **The join, and not the release, is where the time goes, and it is worker wake latency.** The
  release costs a few microseconds at every worker count. The rest of the barrier is the host
  waiting for the slowest worker to come out of its own `Atomics.wait`. No join variant can touch
  that part, which is why the four variants sit so close together.
- **Variant b takes the host wake count to exactly one, at every K and on every runtime.** The
  shipped join wakes the host almost twice for each pass at eight workers on V8, and about three
  times on JavaScriptCore. Every wake but the last reads a short count and parks again.
- **Variant b never loses in the isolated barrier and it wins a little at high K.** Its empty-body
  median sits below the shipped join at eight and ten workers on node and on deno in all three runs
  of this file. The two middle halves overlap, so the win is inside the spread and must not be
  quoted as a speedup.
- **Variant b does not move a frame the engine runs.** Three interleaved rounds of the shipped
  engine at ten thousand entities put the two sides inside each other's noise, and at eight workers
  the shipped join reads faster in two of the three rounds. The wake count is the only measured
  gain. This is the bad result, and it stays in the list.
- **Variant c ties the shipped join and costs more to hold.** One word for each worker on its own
  cache line removes no measurable time, and it needs K extra cache lines in the control buffer, a
  scan on the host, and a per-worker index the worker must know. Its wake count sits between a and b
  because the host parks on the lowest word that is behind, which is often not the last to finish.
- **Variant d loses at every K above two.** The tree adds a park and a wake for each level, and the
  host saves at most one wake against variant b, which already wakes once. On node at ten workers it
  is the slowest of the four.
- **Cache line contention on the done word is not the problem.** Variant c removes it entirely and
  measures the same as the shipped join. The earlier reading of the crossing probe, that eight
  workers contend on one line, is not supported by this probe.
- **The barrier still grows with the worker count, and none of this changes that.** From two to ten
  workers the empty-body barrier grows about six times on node, and the growth lands almost entirely
  in the release side's wake of K parked threads plus the wait for the last of them.

### Known defects in this probe

- **The split table costs two clock reads for each pass**, so its two parts do not add up to the
  amortised figure above it. It says where the time sits and not how much there is.
- **The light body is a fixed accumulate and not a kernel a user writes.** It exists to stop every
  worker finishing in the same instant, and it does not model a real load imbalance.
- **The whole-pass lane is a hand-rolled split, not the engine.** It has no query, no run condition,
  no row-count publish and no join stamp. The engine table above it is the one that answers the
  engine question, and it is three rounds and one size.
- **bun is bimodal here as it is in the crossing probe.** Variant b at two workers reads 8883 on the
  run quoted above and reads below the shipped join on the other two runs. Read bun as a range.
- **The pools are started and stopped inside one process for each variant**, so a variant is never
  timed against another variant's threads. The three whole-pass sizes do share a process.

### What it does not cover

No browser, and a browser main thread cannot park at all, so its join has no measurement anywhere.
No SpiderMonkey. No machine with more than ten logical cores, and the release side is what grows
with the count, so a larger machine may read differently. No `wasm` kernel. No pass with a real load
imbalance across workers, which is the case a per-worker word could still win. No measurement of
what the join costs when the host has other work it could do instead of parking.
## P24 minRows. Where the pool starts to pay

**The crossover is a property of the body, and it moves by two orders of magnitude between the two
bodies tested.** The compute-bound body wins from a few thousand matched rows. The memory-bound
body needs about twelve thousand rows for each worker on V8, and about twenty thousand for each
worker on bun. The highest sustained crossover anywhere in the sweep is 187,500 matched rows, on
bun, on the wasm backing, on the memory-bound body, at nine workers. `DEFAULT_PARALLEL_MIN_ROWS` is
set to 200,000 from that, so no tested cell dispatches a losing frame.

**The gate is free.** An attached pool whose `minRows` the row count never reaches costs nothing a
sample can see, at any size, on any backing, on any of the three runtimes. So a default that is too
high costs only the gain it declines, and never a standing tax.

**Question.** `p24-par-engine` and `p25-wasm-engine` pin `minRows` at one, so every pooled lane
dispatches and neither says where the threshold belongs. Where does the pooled frame start to beat
the sequential frame, and what does a dispatch below that point cost?

**Method.** `node bench/foundations/p24-par-minrows.mjs`. One process for each backing and size.
The world comes from `dist/`. Four archetypes hold `Pos` and `Vel`, and a tag excludes the fourth,
so a split crosses an archetype boundary and one archetype must stay untouched. Every column is
`i32` and the world is deterministic, which is the only shape `snapshots.stateHash()` will hash.

Two bodies. The light one is `pos += vel * dt` over four columns, memory bound. The heavy one is a
hash mix with a branch for each row, compute bound. Each runs as a `js` kernel and, on the wasm
backing, as a module emitted by `wasm/emit.mjs`, which needs no toolchain.

**The two lanes are paired, and that is what makes the answer trustworthy.** The sequential lane is
not a world with no pool. It is a second system over the same body whose `minRows` sits above every
size in the sweep, running with the pool attached. So the frame it measures is exactly the frame a
world below the threshold pays. The two lanes run in alternating blocks inside one sample loop, so
a machine that changes speed changes it for both lanes in the same round.

`sustained` is the smallest row count that wins and keeps winning at every larger row count. A
single winning size on a sweep of eleven sizes is an accident, and a default built on one would
dispatch a frame that loses at every larger size.

### Correctness

**726 lane comparisons, 0 disagreements, 0 lanes that touched an excluded row.**

242 on each of node, deno and bun. Every backing, every size, every body, every kernel form and
every worker count leaves the `stateHash` the gated lane leaves. The rows of the excluded archetype
keep their seeded values in every lane.

### Sustained crossover, in matched rows

| backing | body | kernel | K | node | deno | bun |
| --- | --- | --- | --- | --- | --- | --- |
| shared | heavy | js | 2 | 1,500 | 1,500 | 48,000 |
| shared | heavy | js | 4 | 3,000 | 3,000 | 24,000 |
| shared | heavy | js | 9 | 3,000 | 3,000 | 24,000 |
| shared | light | js | 2 | 24,000 | 24,000 | 48,000 |
| shared | light | js | 4 | 48,000 | 48,000 | 24,000 |
| shared | light | js | 9 | 93,750 | 93,750 | 24,000 |
| wasm | heavy | js | 2 | 3,000 | 1,500 | 1,500 |
| wasm | heavy | js | 4 | 12,000 | 3,000 | 3,000 |
| wasm | heavy | js | 9 | 3,000 | 3,000 | 6,000 |
| wasm | heavy | wasm | 2 | 750 | 750 | 1,500 |
| wasm | heavy | wasm | 4 | 12,000 | 3,000 | 3,000 |
| wasm | heavy | wasm | 9 | 3,000 | 3,000 | 6,000 |
| wasm | light | js | 2 | 24,000 | 24,000 | 93,750 |
| wasm | light | js | 4 | 48,000 | 93,750 | 93,750 |
| wasm | light | js | 9 | 93,750 | 93,750 | 187,500 |
| wasm | light | wasm | 2 | 12,000 | 24,000 | 93,750 |
| wasm | light | wasm | 4 | 48,000 | 48,000 | 93,750 |
| wasm | light | wasm | 9 | 48,000 | 93,750 | 187,500 |

Each cell is the crossover against the sequential lane's best block of the run, which is the
sequential path at its fastest and the harder bar for the pool to clear. Against the sequential
median the two V8 runtimes give the same cells, except `wasm light js` at four workers on deno,
which crosses at 48,000 there.

### The loss below the crossover, node, milliseconds for one frame

The light body on the shared backing, which is the case the default is sized for.

| rows | K | sequential | pooled | pooled minus sequential |
| --- | --- | --- | --- | --- |
| 3,000 | 9 | 0.0043 | 0.0675 | 0.0631 |
| 12,000 | 9 | 0.0160 | 0.0519 | 0.0359 |
| 24,000 | 2 | 0.0310 | 0.0299 | -0.0011 |
| 24,000 | 9 | 0.0314 | 0.0562 | 0.0248 |
| 48,000 | 4 | 0.0601 | 0.0542 | -0.0060 |
| 48,000 | 9 | 0.0605 | 0.0665 | 0.0060 |
| 93,750 | 9 | 0.1180 | 0.0775 | -0.0405 |
| 750,000 | 9 | 0.9740 | 0.2462 | -0.7278 |

**A frame at a thousand rows is the worst case for a wrong default.** With nine workers the pooled
frame there costs about forty microseconds more than the sequential one, and the sequential frame
itself costs about one microsecond. The barrier is the whole bill.

### The gate, node, milliseconds for one frame

The same system, no pool attached, then with a pool attached whose `minRows` the row count never
reaches.

| backing | rows | body | no pool | pool attached, declines | difference |
| --- | --- | --- | --- | --- | --- |
| shared | 93,750 | light | 0.1214 | 0.1169 | -0.0045 |
| shared | 93,750 | heavy | 2.4889 | 2.5418 | 0.0529 |
| shared | 750,000 | light | 0.9468 | 0.9653 | 0.0185 |
| shared | 750,000 | heavy | 20.3188 | 20.3691 | 0.0503 |
| wasm | 750,000 | light | 0.9651 | 0.9432 | -0.0219 |
| wasm | 750,000 | heavy | 20.5353 | 20.2997 | -0.2356 |

The difference changes sign across the table, which is what no effect looks like. The declined
dispatch reads a dirty flag and compares two numbers, and neither shows.

### The light body has two per-row speeds on V8, and the probe fought that

The probe also runs each body over four flat `Int32Array` columns, with no engine and no pool. The
light body reports two per-row costs there, and the slow one is several times the fast one. The
switch happens with no engine, no worker and no store, so it belongs to the kernel and the engine
that runs it.

On node the standalone lane sits in the fast state at 750 and 1,500 rows and in the slow state at
every larger size. On bun the switch lands one size later, and one bun size straddles it: at 3,000
rows the minimum block is fast and the maximum block is slow. The heavy body shows no such split at
any size on any runtime.

**The in-engine sequential lane sat in the fast state at every size on node and deno.** Its minimum
and its median agree across the whole sweep. So the crossovers above are measured against the
sequential path at its best, and they are the conservative ones. An earlier version of this probe
warmed by row visits alone, which left the sequential lane in the slow state between 12,000 and
93,750 rows, and every light-body crossover there came out far too low. The warmup now counts
frames as well as row visits, and a repeat of the sequential lane guards it.

### What it shows

- **A single default cannot serve both bodies.** The compute-bound body crosses about two orders of
  magnitude earlier than the memory-bound one. A default that serves the memory-bound case leaves
  almost all of the compute-bound case's gain on the table, and the reverse costs a frame.
- **The crossover rises with the worker count on V8, and roughly holds the rows for each worker
  constant.** The light body crosses near twelve thousand rows for each worker at two, four and
  nine workers, on node and on deno, on both backings. Bun does not follow that rule.
- **The kernel form barely moves the crossover.** The `wasm` kernel crosses one ladder step earlier
  than the `js` kernel on node at two workers, and lands on the same cell everywhere else. So a
  default that branched on the kernel form would buy almost nothing, and the engine has no cheap way
  to know the body's weight, which is what actually decides the crossover.
- **Bun's shared backing is far slower than its wasm backing for the same sequential body.** At
  12,000 rows the light body costs 0.0525 on the shared backing and 0.0104 on the wasm backing, in
  the same process shape. The two V8 runtimes show no such gap.
- **A too-high default has no standing cost.** The gate table says so on both backings and all three
  runtimes.

### Known defects in this probe

- **Bun's shared-backing pooled lane spikes at two sizes.** At 12,000 rows the pooled light frame
  reports 0.3342 at two workers, 0.5802 at four and 0.5174 at nine, against a sequential 0.052. At
  6,000 rows and at 48,000 rows the same lane behaves. The spike is present on the heavy body at the
  same sizes. Every bun shared-backing crossover in the table above is therefore suspect, and the
  bun cells that decide the default come from the wasm backing.
- **One node cell spikes the same way.** The wasm backing, heavy body, `js` kernel, four workers,
  6,000 rows reports 0.9106 pooled where 3,000 rows reports 0.0619 and 12,000 rows reports 0.1302.
  That one cell is what pushes that series' crossover from 3,000 to 12,000 in the table.
- **The sequential lane and the pooled lane do not share a JIT state.** The main thread runs the
  body and each worker runs its own copy. A worker at nine workers sees a ninth of the rows, so it
  reaches whatever state it reaches on its own schedule. The pairing cancels a machine-level change
  and it cannot cancel this one.
- **One archetype shape, one column count, one column type.** Four columns, four archetypes, one
  excluded, every column `i32`.
- **The default worker count is read from `availableParallelism()` on this machine.** A machine with
  a different count would put the highest `K` somewhere else, and the highest `K` is what sets the
  default.

### What it does not cover

No browser host, and no SpiderMonkey. No heap backing, which cannot attach workers at all. No float
column, because the state hash refuses one. No grow, no despawn and no second system inside a timed
frame, so the crossover is measured on a frame that holds one parallel system and nothing else. No
cold start: the pool is attached and the kernels are loaded before any timing. No measurement of
what the crossover does under load from another process, and this machine ran other work during
parts of the sweep.

---

## What a scheduler would have to do, and what is still unknown

The probes support these, and no more.

1. A worker can run a system body from the buffer alone. Bind through the
   descriptor, in the lean form, and cache the result against `view_stamp`.
2. Release and join through `Atomics`, not `postMessage`. Park the host rather
   than spin, unless a later probe shows a spin policy that holds on bun.
3. Do not split below the crossing cost. On these runtimes that is somewhere
   between ten thousand and a hundred thousand rows, and it depends on the kernel.
4. Forbid every structural change while any worker is inside a pass. A grow is
   silent, a swap-remove is silent, and both corrupt.
5. Fix the order of any host-side reduction over per-worker partials. Never fold
   in completion order.

Unknown, and each one is a probe someone still has to write.

- What the join costs with a tree barrier, or with one done word for each worker.
- What a browser host pays when it cannot park.
- Whether two different systems, rather than one system split K ways, keep the
  same guarantee.
- What the access declarations would have to say for a conflict graph to be built
  from them, and whether the current `reads` and `writes` sets are enough.
- What happens when a worker touches a sparse store, a relation or the command
  buffer, none of which live in the buffer.
- Whether the deterministic integer world is the only lane that can carry an
  engine-level oracle, or whether `stateHash` could be extended to float columns
  in a storage-independent way.

---

## Browser host. The worker-hosted path runs in Chrome

**Question.** The level 1 pool was built and tested on node, bun and deno. Does the
browser branch run at all, and does the main thread refuse to host?

**Method.** Headless Chrome 153 driven over the DevTools protocol, a static server
that sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and the built `dist/` served as is
with no bundler. The page's main thread calls `attachWorkers` and expects a
refusal. A module worker hosts a deterministic `shared` world of 60,000 entities
over three archetypes, one excluded by a `without` tag, runs twelve frames of an
integer `pos += vel * dt` system sequentially, then builds an identical world,
attaches three pool workers with a `js` kernel by URL, runs the same frames, and
compares `snapshots.stateHash()`. The harness lives outside the repository.

| step | result |
| --- | --- |
| page `crossOriginIsolated`, `SharedArrayBuffer` present | true, true |
| main thread `attachWorkers` | refused, the message names `Atomics.wait` and the remedy |
| worker host, sequential `stateHash` | 2850976559 |
| worker host, three pool workers attached | ready after about 8 ms |
| worker host, parallel `stateHash` after twelve frames | 2850976559 |
| equal | yes |
| `detach` | resolves |

**What it shows.** The browser branch of the worker entry starts, the pool
resolves its worker URL from the served `dist/`, a `js` kernel loads by URL
inside a browser worker, the host parks inside a worker, and the result is the
sequential result. The main thread refusal fires before any worker starts.

**What it does not cover.** No bundler. A bundler that walks
`import("node:worker_threads")` inside the worker entry may refuse it even though
a browser never evaluates that branch. No Firefox and no Safari. No wasm kernel
in the browser. One entity count and one kernel. The timings are one machine and
one run, so read the equality and not the milliseconds.

---

## Bundler pass. A Vite app that imports the package builds and runs in Chrome

**Question.** The unbundled `dist/` runs in Chrome. Does an app that imports the
package and builds for the browser run as well, and what does the bundler say
about `node:worker_threads` and about the worker entry?

**Method.** Vite 6.4.1, rollup 4.53.5, node 24.12.0, headless Chrome 153. An app
outside the repository holds `index.html`, `main.js`, `host.js` and `kernel.js`.
It resolves `@oasys/oecs` through `node_modules/@oasys/oecs`, a link to the
repository, so the package exports map picks the file for each subpath. The
config sets `root`, `worker: { format: "es" }`, `build.target: "es2022"` and
`build.assetsInlineLimit: 0`. `main.js` calls `attachWorkers` on the main thread
and expects the refusal, then starts `host.js` as a module worker. `host.js`
builds the same deterministic 60,000-entity world the unbundled run used, runs
twelve sequential frames, builds a second world, attaches three pool workers and
runs the same frames, then compares `snapshots.stateHash()`. A static server
sets the two cross-origin isolation headers. The harness lives outside the
repository.

**Before, the two failures.**

| what | result |
| --- | --- |
| `vite build` warning | `Module "node:worker_threads" has been externalized for browser compatibility, imported by dist/index.js`, printed twice |
| what the warning ships | a `__vite-browser-external` chunk, in place of the specifier |
| `dist/worker.js` in the app output | absent, because no static import names it |
| the default worker URL at run time | `/assets/worker.js`, which the server answers with 404 |
| what the app saw | `attachWorkers` resolved, `pool.count` reported three, and the first frame then hung until the join timeout |

The hang is the part worth naming. Chrome raises a plain `Event` and not an
`ErrorEvent` when a module worker's script fails to fetch, so `event.message` is
`undefined`. The pool listened for no error at all, so no worker ever answered
`ready` and the attach waited on an answer that could not come.

**After.** `node_threads.ts` reads the builtin through
`process.getBuiltinModule`, and falls back to a specifier it joins at run time,
so neither form reaches the bundler. `startBrowserWorkers` listens for the error
event and reports the URL, and `attach` turns a worker that answered nothing
into `WORKERS_ENTRY_UNREACHABLE`. The app passes `workerUrl` from
`import workerUrl from "@oasys/oecs/worker?worker&url"`.

| what | result |
| --- | --- |
| `vite build` warnings | none |
| `__vite-browser-external` chunk | gone |
| worker entry in the app output | `assets/worker-<hash>.js`, emitted by `?worker&url` |
| page `crossOriginIsolated`, `SharedArrayBuffer` | true, true |
| main thread `attachWorkers` | refused, the message names `Atomics.wait` |
| worker host, sequential `stateHash` | 2850976559 |
| worker host, three pool workers attached | resolves |
| worker host, parallel `stateHash` after twelve frames | 2850976559 |
| equal | yes |
| the same app with the default URL kept | throws `WORKERS_ENTRY_UNREACHABLE`, and the message names the URL and `workerUrl` |

`p24-par-engine.mjs` still reports no mismatch on node, on bun and on deno, so
the `getBuiltinModule` path serves all three.

**What it shows.** A browser app can bundle the package and drive the pool. The
supported idiom is `workerUrl`, and the default sibling resolution is for the
package as it ships. A wrong worker URL is now a fault with a remedy instead of
a park with no end.

**What it does not cover.** One bundler. No esbuild alone, no rollup alone, no
webpack, no parcel and no bun bundler. One browser, so no Firefox and no Safari.
No wasm kernel through a bundler. One entity count and one kernel. The `?url`
import of the kernel module inlines it as a `data:` URL under the default
`assetsInlineLimit`, and the run above set that limit to zero instead of testing
the inline form.

---

## Browser matrix. The worker path runs in Chrome, in Firefox and in WebKit

**Question.** The worker-hosted pool ran in Chrome. Does it run in the other two
browser engine families, and does a `wasm` kernel run on the pool in a browser at
all?

**Method.** `bench/foundations/browser/` holds the harness, and it is checked in.
`server.mjs` serves the repository with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`. `page.js` runs the case a main
thread owns. `host.js` is a module worker that hosts a world and runs the four
cases a worker host owns. `drive.mjs` starts each browser through Playwright,
which it imports from a directory that `OECS_PLAYWRIGHT_DIR` or `--playwright`
names, so Playwright stays out of the package. The page reads the built `dist/`,
so a run measures the artifact and not the source.

Each pooled lane builds the same world twice: four archetypes over `Pos` and
`Vel`, one of them excluded by a tag, integer columns, `deterministic: true`. One
world runs sixteen frames with no pool. The other attaches three workers and runs
the same frames. The two must leave the same `snapshots.stateHash()`.

The lane also counts the calls to the sequential `fn`. The two hashes also agree
when every dispatch falls back to `fn`, and that fallback is the failure the lane
exists to catch, so a pooled run that calls `fn` at all fails the lane.
`parallel.minRows` is one, so every frame takes the pool. The grow lane reads the
store buffer length through the public region seam before and after the spawn, so
a run that never grew fails as well.

| case | chromium 153.0.8010.12 | firefox 155.0 | webkit 26.6 | Safari 18.5 |
| --- | --- | --- | --- | --- |
| main thread `attachWorkers` refuses with `WORKERS_HOST_CANNOT_PARK` | pass | pass | pass | not run |
| worker host, shared backing, three workers, `js` kernel | pass | pass | pass | not run |
| worker host, wasm backing, three workers, `wasm` kernel from the emitter | pass | pass | pass | not run |
| a wrong `workerUrl` gives `WORKERS_ENTRY_UNREACHABLE` and does not hang | pass | pass | pass | not run |
| a store grow between two runs of passes keeps the pooled answer | pass | pass | pass | not run |

What the passing lanes carried:

| what | value |
| --- | --- |
| sequential and pooled `stateHash`, `js` lane and `wasm` lane | 3818282166, in every browser |
| sequential and pooled `stateHash`, the grow lane | 1110936159, in every browser |
| calls to the sequential `fn` during a pooled run | zero, in every lane and every browser |
| the store buffer, before and after the grow lane spawns | longer after, in every browser |

**What it shows.**

- Three engines refuse `Atomics.wait` on a main thread. The refusal is a browser
  rule and not a Chrome behaviour, so `hostCanPark` probes the right thing.
- A `js` kernel loads by URL inside a browser pool worker on all three.
- A `wasm` kernel runs on the pool inside a browser, over a shared
  `WebAssembly.Memory` at the default store base. That path carried tests and no
  browser run before this.
- A store grow between two runs of passes leaves the pooled answer equal to the
  sequential answer. The worker rebinds on the moved `view_stamp` on all three.
- The state hash is the same value on all three engines. So the store bytes agree
  across engine families, and not only inside one.
- A wrong `workerUrl` is a fault with a remedy on all three. The error listener
  in `startBrowserWorkers` covers Gecko and WebKit and not only Blink, and the
  message names the URL in each.

**Two defects the matrix found and did not fix.** Both live in
`src/utils/error.ts`, which this study did not change.

- **`AppError` calls `Error.captureStackTrace` with no guard.** That function is
  a V8 extension. Every engine in this matrix has it, so no case failed. An
  engine without it turns every named fault into
  `TypeError: Error.captureStackTrace is not a function`, and the category the
  caller needs is lost. Delete the function in node and call `attachWorkers` on a
  heap world to watch it happen. The README names a Safari floor below the
  release that adopted the function, so the risk sits inside the supported
  window.
- **`AppError` sets `name` from `this.constructor.name`.** A production build
  renames the class, so `error.name` reads as one minified letter in every result
  above. `error.category` carries the code and is unaffected.

**Safari proper.** Not run. `safaridriver` answers a session request with
`Could not create a session: You must enable 'Allow remote automation' in the
Developer section of Safari Settings to control Safari via WebDriver.` That is a
privileged enable step, so the WebKit build Playwright ships is the closest this
study reaches. WebKit and Safari share an engine and not a release train, so a
WebKit pass is evidence about the engine and not about a shipped Safari.

**What the harness itself was tested against.** Four deliberate defects, one per
behaviour the matrix names, each run in chromium and then restored:

| defect | what noticed |
| --- | --- |
| `parallel.minRows` raised above the row count | the `fn` count, and not the hashes, which still agreed |
| the column stride read from the wrong descriptor offset in the walk | the layout fold |
| the wrong `workerUrl` pointed at the real worker entry | the attach resolved, so the lane reported no fault |
| the grow lane's column capacity raised above the spawn | the store buffer length did not move |

The first one is the one worth keeping. A pooled run that silently falls back to
`fn` leaves the same state hash as the sequential run, so equality alone would
have called that lane a pass.

**What it does not cover.**

- **No bundler in Firefox and in WebKit.** The Vite pass above ran in Chrome
  only.
- **No Safari, no Chrome for Android, no Safari on iOS, and no Windows browser.**
  One machine, one operating system.
- **One entity count, one kernel, one worker count and one frame count.** Nothing
  here says where the threshold sits in a browser, because the harness measures
  no time at all.
- **No join timeout lane.** A worker that dies inside a pass is untested in a
  browser, so `PARALLEL_KERNEL_FAILED` from a missed join has no browser
  evidence.
- **No kernel that throws.** The failed word path is untested in a browser.
- **No detach under load, and no second attach after a detach.**
- **No page reload with a pool attached**, so nothing says what a browser does
  with workers parked in `Atomics.wait` when the page goes away.
- **No float lane.** Every column is `i32`, because the state hash is the oracle.

## Root entry bytes. What the workers plugin takes out of every program

The pool left the `ECS` class and became `workers()` on `@oasys/oecs/workers`.
The root entry shrinks by the pool, the plan builder, the protocol constants and
the node threads shim. A program that never attaches a pool now ships none of
them.

**Method.** esbuild bundles `src/index.ts` as one ESM file, `es2022`, minified,
with `__DEV__` folded to `false` and `solid-js`, `solid-js/store` and
`node:worker_threads` external. The same command runs against the tree at the
checkpoint before the move and against the tree after it. One machine, one
build.

| tree | minified bytes |
| --- | --- |
| the pool on `ECS` | 188086 |
| the pool in the workers plugin | 175249 |
| difference | 12837 |

Read the direction and not the ratio. The pool was a small share of the root
entry, and it was the share every program shipped and almost no program used.

**What this does not say.** It measures one entry, not an application bundle. A
tree shaker in an app may already have dropped some of the same code through the
`sideEffects` flag, so an app sees this difference at most and not exactly. It
also says nothing about run time. The dispatch path did not change, and
`bench/ab/ref.mjs` against the checkpoint is what holds that claim.
