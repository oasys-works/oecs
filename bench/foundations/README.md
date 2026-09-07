# foundations, the substrate study, re-run against the library

The design of this engine rests on a set of measurements made **before** the
engine existed. Those measurements used hand-written buffers and hand-written
loops. This directory asks the question that the study could not: **does the
library still deliver them?**

A library carries an entity index, an archetype table, a row plane and a query
cache that a hand-written loop does not. Every one of those is a cost the study
never measured. A design rule that holds for a hand-written buffer and fails for
the library is a rule the library does not have.

Use these tools only for local work. They are not a part of the package.

```
pnpm build                                # every probe measures dist/, not src/
node bench/foundations/run.mjs            # every probe
node bench/foundations/run.mjs p09        # one probe
node bench/foundations/p23-pillars.mjs    # slow, it builds the package four times
```

`p23-pillars.mjs` is the one probe that does not read `dist/`. It builds its own
copies, one for each pillar it removes, so `run.mjs` takes several minutes once
it is in the list.

## What each probe measures

| probe | the finding it re-tests | the question |
| --- | --- | --- |
| `conformance-all.mjs` | round 3, one engine is not all engines | Do V8 and JavaScriptCore agree bit-for-bit on `stateHash`? |
| `p01-layout.mjs` | exp 01 H1 to H4 | Is the premise still true, and is the layout the number you computed? |
| `p17-composite.mjs` | exp 17 K1 | On a branch-heavy kernel, is the library faster or slower than plain objects? |
| `p21-gc.mjs` | exp 21 R1 to R5 | Does the arena remove the pauses a person feels? |
| `p09-byid.mjs` | exp 09 L3 to L5, exp 17 and exp 19 | What does access by id cost, and where does the SoA layout stop paying? |
| `p20-elemkind.mjs` | exp 20 | Does a world that mixes column types fall off the polymorphism cliff? |
| `p05-growth.mjs` | exp 05 G2 to G3, round 5 S3 | Does a buffer that can grow in place cost the reader, and does the shared profile pay it? |
| `p05-kernels.mjs` | exp 05, one point is not a curve | Does the backing finding hold on the paths one kernel never touched? |
| `p10-accessors.mjs` | exp 10 (accessor shape), P09's diagnosis | Where does a read of one field by id spend, and would a generated accessor help? |
| `p11-memory-grid.mjs` | `ECSMemoryOptions` flattening proposal | Is sizing really independent of backing, and does every cell of the grid work? |
| `p22-change.mjs` | the study's "tick+list" verdict for the entity grain | What does the entity grain cost on the write path and at the drain, which write paths does it see, and how many ticks is one write reported on? |
| `p23-pillars.mjs` | no experiment, the three jit tricks the unit suite cannot see | Each pillar is removed from a copy of the source and the package is rebuilt. Which ones still pay? |
| `p23-solid.mjs` | no experiment, the two ways this engine reaches SolidJS | Does the solid plugin cost less per tick than the observers chain, at each density of dirty rows? |
| `p24-par-crossing.mjs` | no experiment, the parallel study | What does it cost to reach a worker and come back, and what does an atomic cost against a plain access? |
| `p24-par-bytes-view.mjs` | no experiment, the parallel study | Can a worker that holds only the store buffer read what the query reads, and what does a layout republish cost it? |
| `p24-par-split.mjs` | no experiment, the parallel study | Does a row-range split across K workers leave the same bytes and the same `stateHash`, and where does it start to pay? |
| `p24-par-conflict.mjs` | the negative control for `p24-par-split` | Does the byte compare detect a real conflict, or does it detect nothing? |
| `p24-par-structural.mjs` | no experiment, the parallel study | What does a worker see when a grow or a swap-remove runs beside its pass? |
| `p24-par-engine.mjs` | no experiment, the shipped pool | Does `ecs.workers.attach` with a `parallel` system leave the same bytes and the same `stateHash` as the system's own `fn`, and where does it pay? |
| `p24-par-join.mjs` | takes apart what `p24-par-crossing` measured whole | What does the last part of the barrier cost, and does another way for K workers to report a finished pass scale better? |
| `p24-par-minrows.mjs` | the evidence behind `DEFAULT_PARALLEL_MIN_ROWS` | Where does the pool start to pay, and what does it cost below that? |
| `p25-wasm-engine.mjs` | no experiment, the `wasm` kernel form | Does a `wasm` kernel on the shipped pool leave the same `stateHash` as the system's own `fn`, and what does it buy against the `js` kernel? |
| `p25-wasm-stack.mjs` | no experiment, the `wasm` kernel form | Several workers instantiate one module over one memory. What happens to the shadow stack they all address, and what does a region for each instance cost? |

The eight `p24-par-*` probes report into `findings-parallel.md` beside this
file, not into the Results section below. They study running one system on
several workers, which is a question the substrate study never asked. Six of
them measure hand-rolled code. `p24-par-engine.mjs` and `p24-par-minrows.mjs`
measure the shipped pool.

`p25-wasm-engine.mjs` and `p25-wasm-stack.mjs` report into `findings-wasm.md`
beside the other `p25` probes. Both need a `wasm`-backed world, because a worker
imports the world's memory as the module's own. Zig builds a second module lane
in the first and the only module lane in the second, and each probe prints a
skip when the compiler is missing.

## Results

Node v24.12.0, Deno 2.9.1, Bun 1.3.13. Darwin arm64, Apple silicon. oecs 0.5.4,
production artifact. **Every number is for one machine and one build.** Read the
ratios and the positions. Do not quote the milliseconds.

### Cross-engine agreement. Pass, and it is new evidence

| runtime | engine | `stateHash` |
| --- | --- | --- |
| node 24.12.0 | V8 | 2569650762 |
| deno 2.9.1 | V8 | 2569650762 |
| bun 1.3.13 | JavaScriptCore | 2569650762 |

Two engine families agree bit-for-bit across spawn, structural churn, despawn,
generational liveness, 30 ticks of system execution, and a snapshot round trip.
Before this probe the claim rested on a test suite that ran on V8 only.

**This does not cover SpiderMonkey.** Firefox is a supported target in the
README and no probe here touches it. That gap is open, and a skip is not a pass.

### P01, the premise (exp 01)

1,000,000 particles, one physics step, `{pos: Vec3<f32>, vel: Vec3<f32>, mass}`.
Computed layout: 7 × f32 = 28 B + 4 B entity id = **32 B/item**.

| variant | step | vs flatObj | reserved | resident | B/item |
| --- | --- | --- | --- | --- | --- |
| oecs (default sizing) | 2.72 ms | **2.06x** | 256 MiB | 82.5 MiB | 86.5 |
| oecs (`budget`) | 2.70 ms | 2.07x | 196 MiB | 78.9 MiB | 82.8 |
| oecs (`budget` + pinned `columnCapacity`) | 2.72 ms | 2.06x | 199 MiB | 54.4 MiB | 57.1 |
| flatObj | 5.61 ms | 1.00x |, | 162.6 MiB | 170.5 |
| nestedObj | 6.60 ms | 0.85x |, | 268.6 MiB | 281.7 |
| rawSoA (no library) | 2.67 ms | 2.10x | 27 MiB | 31.4 MiB | 32.9 |

- **H1 holds, and is stronger than the study measured**, 2.06x against the best
  plain-object shape, where experiment 01 got 1.77x.
- **The library costs 1.02x raw typed arrays.** The whole archetype machinery,
  query resolution, chunk cursor, column groups, tick stamping, is inside the
  noise of a hand-written SoA loop. This is the strongest result in the file.
- **H2 partly holds**, 2.99x less resident memory than flat objects, where the
  study measured 4x for a hand-written buffer.
- **H3 does not hold.** The study measured 32.01 B/item against a computed 32 B:
  the layout you compute is the layout you get. The library delivers **57.1
  B/item at best and 86.5 B/item by default, 1.78x to 2.70x the computed
  layout.** The gap is the entity index (a fixed 2²⁰-slot allocation), column
  capacity rounding, and abandoned column blocks left behind by doubling.
  Philosophy §8 asks that "the memory for one million items is the number the
  person computed". It is not.
- **Pinning `columnCapacity` is worth 1.5x resident memory** (86.5 → 57.1
  B/item) and costs nothing in speed. The library's own `memoryPlan.derivation`
  names the cause, "double+holes headroom", but no document tells a user to
  pin it.

> **`external` is not memory you are using.** The arena is one large
> `ArrayBuffer`, and `process.memoryUsage().external` reports its full length the
> moment it exists, while the pages fault in lazily. By that measure a default
> world costs 256 MiB before a single entity is spawned. By RSS it costs 0.4 MiB.
> This table reports RSS.

> **Methodology note.** The first version of this probe reported that spawning
> 1,000,000 entities *released* 256 MiB, impossible while the world is alive.
> V8 had collected the world: nothing referenced `ecs` after the spawn loop. The
> probe now pins the world in a sink and asserts its liveness at the final
> snapshot. This is the study's own lesson, re-learned at first hand: a result
> that violates a structural expectation is a bug in the measurement.

### P17, the composite kernel (exp 17 K1), the study's failure is reversed

1,000,000 entities, handle deref + tag dispatch + field update, one tick.
Checksummed: both variants are verified to compute the same answer.

| runtime | engine | oecs | plainObj | oecs vs plain |
| --- | --- | --- | --- | --- |
| node | V8 | 2.44 ms | 3.30 ms | **1.35x** |
| deno | V8 | 2.25 ms | 3.20 ms | **1.42x** |
| bun | JavaScriptCore | 1.17 ms | 1.83 ms | **1.57x** |

Experiment 17 was the study's most consequential result and its clearest
failure: on a branch-heavy, few-field kernel the fully-safe stack ran at
**0.73 to 0.93x plain JS objects on V8**. Slower than the thing it replaces.

**The library does not reproduce that failure.** It is faster than plain objects
on every engine tested, by 1.35x to 1.57x.

The reason is a design choice the study prescribed and the library implements
structurally rather than as a flag. Experiment 17's L3 layer put a
generation-checked handle deref *inside the iteration loop*, and that check cost
28 to 31% on V8, more than the entire buffer advantage on that workload. The
study asked for the check to be elidable. `oecs` does better: dense iteration walks
rows and never checks at all, and the check lives only on the by-id path, which
P09 shows is the case where experiment 19 measured it as free. The cost was not
made optional. It was moved to where it does not apply.

### P21, pauses under churn (exp 21)

Entities gain and lose a tag every tick, 10% of the population per tick.
`--trace-gc` parsed from a subprocess.

At 200,000 entities × 40 ticks:

| metric | all objects | oecs | improvement |
| --- | --- | --- | --- |
| GC events | 11 | 1 | |
| major | 0 | 0 |, |
| total pause | 23.2 ms | 0.4 ms | **55.1x** |
| longest single pause | 4.79 to 5.50 ms | 0.42 to 0.46 ms | **10.4 to 13.1x** |

The worst-pause row is given as a range across repeated runs. A single run put
it at 13.1x and the next at 10.4x. Quoting either alone would be a threshold
sitting on the measurement.

At 600,000 entities × 80 ticks:

| metric | all objects | oecs | improvement |
| --- | --- | --- | --- |
| GC events | 20 | **0** | |
| total pause | 42.7 ms | 0.0 ms | ∞ |
| longest single pause | 6.29 ms | 0.00 ms | ∞ |

The object world's worst pause is 33 to 38% of a 16.7 ms frame. The arena world
takes **no collections at all** at the larger size.

Two honest limits on this result:

- **No major collection occurred in either world**, so experiment 21's headline,
  major collections eliminated, 13.04 ms → 0.33 ms, is **not reproduced here**.
  This workload's object churn dies young, so V8's scavenger handles it. The
  claim that the arena removes *major* collections remains untested against the
  library.
- **`oecs` has no string columns**, so this measures the arena half of
  experiment 21's hybrid only. That experiment's numbers included an interned
  string table and a decode cache. An application that names its entities keeps
  those names in JS objects on the side, and that side is not measured here.

> **Methodology note.** The first version reported **zero GC events for both
> workloads**. Node 24 inserted a `pooled: N MB,` field into `--trace-gc` output
> between the heap figures and the pause pair, so a pattern anchored on the first
> comma matches nothing. Experiment 21 lost a measurement to a wrong grep
> pattern in the same way. The parser now anchors on `(average mu`.

### P09, access by id, the sharpest result in the file

`small` = 10,000 (fits cache), `large` = 1,000,000 (does not). `shuffled` =
Fisher-Yates over xorshift32, not a modulo stride.

Large, 1,000,000 entities:

| impl | runtime | in order | shuffled | shuffle cost |
| --- | --- | --- | --- | --- |
| cursor (dense) | node | 10.87 ms | 68.04 ms | 6.26x |
| cursor (dense) | bun | 3.90 ms | 28.56 ms | 7.33x |
| `getField` (dense) | node | 20.99 ms | 110.46 ms | 5.26x |
| **sparse** | node | 17.00 ms | **18.12 ms** | **1.07x** |
| **sparse** | bun | 5.82 ms | **5.96 ms** | **1.02x** |
| plainObj | node | 1.65 ms | 19.28 ms | 11.68x |
| rawSoA (index = id) | node | 0.94 ms | 1.47 ms | 1.57x |

Three findings, and the third corrects a claim made from reading the code alone.

1. **The dense by-id path is a pointer chase, and it behaves like one.** A
   shuffled pass over 1M entities costs **68 ms through the cursor**, four
   frames for one read of one field. Against a sequential walk of the same data
   (0.94 ms) that is **72x**, squarely inside experiment 19's measured 45 to 66x
   range for pointer chasing. The study says prefer array-of-index over linked
   structures. The entity → row → archetype → column indirection *is* the linked
   structure, inside the library.
2. **The library's own `vs/` comparison understates this.** That comparison runs
   at N = 10,000 in creation order, the cell where cache residency hides the
   effect. Its README already says a permutation "would make the difference in
   this row larger". It does: 3.5x larger.
3. **The remedy already ships, and nothing says so.** `registerSparseComponent`
   is **flat under shuffling (1.02 to 1.07x)** and at 1M shuffled it is 18.1 ms,
   **3.8x faster than the dense cursor, and faster than plain objects**. The
   review that preceded these probes concluded that oecs "is SoA-only and has no
   answer for the far side of the crossover". That was wrong. It has one. It is
   documented as a storage strategy for rarely-held components, not as the
   remedy for by-id-heavy access, and the benchmark that reports `read_by_id`
   does not use it.

`getField` costs about 2x the cursor, which confirms the diagnosis already
recorded in `bench/vs/README.md`: the field-name lookup, not the layout, is the
larger part of that path's cost.

### P20, element-kind polymorphism, hypothesis mis-scoped

200,000 entities, 8 component fields either way. `mono` = all `f64`, one element
kind in the row plane. `mixed` = f64, f32, i32 and u8, four kinds. `mixed` moves
fewer bytes, so any slowdown is a lower bound.

| op | runtime | mono | mixed | mixed and mono | spreads |
| --- | --- | --- | --- | --- | --- |
| churn | node | 14.39 ms | 13.77 ms | 0.96x | overlap |
| churn | deno | 12.66 ms | 12.04 ms | 0.95x | overlap |
| churn | **bun** | 12.37 ms | 16.38 ms | **1.32x** | **disjoint** |
| byid | node | 2.00 ms | 1.99 ms | 1.00x | overlap |
| byid | deno | 1.80 ms | 1.79 ms | 1.00x | overlap |
| byid | bun | 0.79 ms | 0.80 ms | 1.02x | overlap |

The review hypothesis was that `_bufs` holding up to eight element kinds would
put the keyed accesses in `moveEntityFrom` and the by-id read path onto
experiment 20's 3.8 to 5.6x cliff.

At four kinds that reads as refuted on V8: five of six comparisons have
overlapping middle halves and the by-id path is 1.00x. JavaScriptCore shows a
real but smaller effect, **1.27 to 1.31x** on structural churn, confirmed across
three independent runs with disjoint middle halves every time.

> **That reading was wrong, and a raw sweep found it.** This probe mixes four
> element kinds. V8's polymorphic inline cache holds **four maps**, so four is
> exactly one short of the threshold. Sweeping 1→8 kinds in the substrate study
> (`allegorithm`, experiment 25) puts V8 flat through 4 kinds and then **~11x at
> 5**, and puts jsc at a gradual ~1.9x from the *second* kind, rising to ~3x with
> no knee anywhere. The cost is real on both engine families, larger on V8 than
> the callback cliff it was inferred from, and shaped differently on each.
>
> **Consequence for this library:** it offers eight column types. An archetype
> that mixes five or more crosses V8's threshold on the row-copy path in
> `moveEntityFrom`. Either keep a copy site under five kinds, or split the copy
> into one loop per kind.
>
> **Consequence for this probe:** it should sweep the kind count instead of
> testing one mix. A negative result from one configuration is one point, not a
> curve.

### P05, a buffer that can grow in place (exp 05, round 5 S3), the rule is half right, and the half that holds is on one engine family

The study's S3 measured element access over five backings and concluded that
every buffer which can grow in place charges its reader, on every engine. The
library acted on half of that in 0.5.3: `heapArraybufferAllocator` reserves a
**fixed** `ArrayBuffer` at the cap. The shared profile (`memory: { shared: {} }`)
still grows a growable `SharedArrayBuffer`, and so does the wasm profile by
nature. This probe asks whether those two still pay.

**A. the substrate, f32, read then write**, the shape of the library's own
column loop. `vs fixedAB`, medians:

| backing | node (V8) | deno (V8) | bun (jsc) |
| --- | --- | --- | --- |
| fixed `ArrayBuffer` | 1.00x | 1.00x | 1.00x |
| fixed `ArrayBuffer`, reserved at 256 MiB | 1.01x | 0.97x | 1.00x |
| fixed `SharedArrayBuffer` | 1.01x | 0.99x | 1.02x |
| fixed `SharedArrayBuffer`, reserved at 256 MiB | 0.99x | 1.02x | 1.01x |
| **growable `SharedArrayBuffer`, fixed-length view** | **1.00x** | **1.01x** | **4.16x** |
| growable `SharedArrayBuffer`, length-tracking view | 34.70x | 42.81x | 23.71x |
| resizable `ArrayBuffer`, fixed-length view | 3.16x | 4.03x | 6.34x |
| resizable `ArrayBuffer`, length-tracking view | 2.74x | 2.69x | 5.89x |

The read-only f64 kernel puts the same growable SAB at 0.99 to 1.01x on **every**
runtime including bun. So on JavaScriptCore the cost is on the **store** path
alone, and a probe that measured reads would have reported no problem.

Three things follow.

1. **The 0.5.3 heap fix stands, and is understated.** A resizable `ArrayBuffer`
   costs its reader on all three runtimes, worst on JavaScriptCore.
2. **A length-tracking view is the catastrophic case**, and it is the one the
   study's own table put worst. The library builds every column view with an
   explicit `(byteOffset, length)`, so it never reaches this row. That was
   accidental: `makeView` is the single choke point, but nothing said so and
   nothing checked a view's length. **Now locked**, the `makeView` doc states
   the rule, `column_store.test.ts` walks every column and pins
   `length === rowCapacity`, and `extend.test.ts` pins that the length does not
   move when the buffer below it grows. Both fail when `makeView` drops its
   length argument.
3. **S3 does not reproduce for a growable SAB with a fixed-length view on V8.**
   The study measured 2.8x on node. This measures 1.00x. Either the engine
   changed or the two kernels differ. The narrow claim is the one the data
   carries: on V8, today, this combination is free.

**B. the library, 1,000,000 entities, one physics step.** Same world, same
kernel, three backings, checksums verified equal and resolved plans printed
identical (`columns 1048576, index 1048576`):

| backing | node (V8) | deno (V8) | bun (jsc) |
| --- | --- | --- | --- |
| heap, fixed `ArrayBuffer` (the default) | 1.00x | 1.00x | 1.00x |
| shared, growable `SharedArrayBuffer` (today) | 0.99x | 0.99x | **3.83x** |
| fixed `SharedArrayBuffer` (the candidate) | 0.99x | 1.00x | **0.99x** |

**The shared profile costs 3.83x on JavaScriptCore, and nothing on V8.** The
figure tracks the substrate's 4.16x, so the mechanism is the store path and not
anything the library adds. Safari is JavaScriptCore, and the shared profile is
the one a browser reaches for after it sets COOP and COEP, so this lands on the
target that opted into the harder deployment.

**A fixed `SharedArrayBuffer` removes it completely** and costs nothing on V8.

**C and D. what the reservation costs.** A fixed backing must be born at the
cap. Reserving 256 MiB and touching 1 MiB moves RSS by 1.02 to 1.08 MiB on node,
deno and bun alike: the pages fault in lazily on every runtime tested, exactly
as the heap profile's `ArrayBuffer` reservation does. At 1,000,000 entities the
three library backings sit within noise of each other in RSS (50.4 to 54.1 MiB).
**The remedy is free in resident memory.**

**E. what a world costs to construct.** A reserved backing pays for its
reservation once, at construction, and a small world would feel that as startup
time. `growableSabAllocator`'s own doc warns that a larger cap costs more per
allocation. Medians for `new ECS(...)` plus one component, one startup and one
spawn:

| backing | node (V8) | deno (V8) | bun (jsc) |
| --- | --- | --- | --- |
| heap, fixed `ArrayBuffer` at the cap | 0.336 ms | 0.159 ms | 0.233 ms |
| shared, growable `SharedArrayBuffer` | 0.057 ms | 0.061 ms | 0.153 ms |
| fixed `SharedArrayBuffer` at the cap | 0.057 ms | 0.069 ms | 0.201 ms |

A 256 MiB `SharedArrayBuffer` born at its cap constructs in the same time as one
born small. Nothing is zeroed eagerly, which is the same thing part D says from
the RSS side. Every figure here is well under a millisecond.

**One defect found, and fixed.** The library could not carry a fixed
`SharedArrayBuffer` at all before this probe. `tailCursorBytes` chose where a
new column region starts by asking what class the buffer was, a plain
`ArrayBuffer` meant "reserved at the cap, so use the header capacity", anything
else meant "sized to the live extent, so use `byteLength`". A `SharedArrayBuffer`
born at its cap took the second branch, put the tail at the cap, and the first
archetype extend asked for more than the cap. The world died before it could
spawn. The question is whether the allocator reserved, not which class it
returned, so `BufferAllocator.reservedAtCap` now carries that and
`tailCursorBytes` reads it. Four tests in
`src/core/ecs/__tests__/integration/heap_backing.test.ts` cover the fixed-SAB
backing and all four fail without the change.

**Not measured.** The wasm profile. A shared `WebAssembly.Memory` exposes a
growable `SharedArrayBuffer` and cannot expose anything else, so a WASM-backed
world on JavaScriptCore should pay what the shared profile pays. Nothing here
tests it, and no WASM backend ships to test it with.

### P05-kernels, the same three backings, five kernels, the finding holds, and one cell was a mirage

P05 measured one workload. A backing decision resting on one workload is a rule
shaped by whatever that workload stressed, so the same three backings were run
across the paths it did not touch. Ratios against the heap backing, first full
matrix:

| kernel | n | node (V8) shared then fixed | deno (V8) shared then fixed | bun (jsc) shared then fixed |
| --- | --- | --- | --- | --- |
| physics-small (cache-resident) | 10,000 | 1.00x / 1.00x | 1.00x / 1.01x | **3.97x** / 0.99x |
| churn (archetype transitions) | 200,000 | 1.00x / 0.96x | 1.03x / 1.07x | 1.10x / 0.99x |
| byid (shuffled cursor reads) | 200,000 | 1.01x / 1.01x | 1.55x / 1.00x | 1.06x / 1.01x |
| spawn + despawn | 100,000 | 1.00x / 1.00x | 0.99x / 1.00x | 1.10x / 1.05x |
| sparse get + set | 200,000 | 0.99x / 0.99x | 0.98x / 1.00x | 1.01x / 1.00x |

Checksums agree across all three backings in every row.

**The JavaScriptCore cost is not a bandwidth artifact.** At 10,000 entities the
whole working set is cache-resident, and the growable `SharedArrayBuffer` still
costs 3.97x, the same figure the million-entity run gives. It is a per-access
cost on the store path, exactly as the substrate table says.

**It is a write cost, and the kernels rank by how much writing they do.** The
dense column loop writes four fields per entity per tick and pays ~4x. Churn,
spawn and shuffled reads write far less per unit of bookkeeping and pay ~1.1x,
repeatable across three runs. The sparse store is not a column and pays nothing.

**The candidate never loses.** A fixed `SharedArrayBuffer` is 0.96x to 1.07x of the
heap backing on every kernel and every runtime, and it removes the 3.97x.

**One cell was a mirage, and it is the reason this matrix exists.** The first
matrix put deno's shuffled-read row at 1.55x, which read as a V8 runtime paying
a cost node did not. Two re-runs of that cell alone gave 1.00x and then 1.58x,
with the *fixed* backing at 0.62x in between, a backing cannot be faster than
itself. deno's by-id cursor read is **bimodal**: a process lands at either
~1.9 ms or ~3.0 ms and stays there, and the within-run spread on a single
backing straddles both modes (1.92 to 3.11 ms). The ratio was reading which mode
each child process happened to start in. Nothing about the backing.

That bimodality is itself unexplained and is not a backing property. It is
recorded below as an open question, not resolved here.

### P10, the accessor shape (exp 10, P09's diagnosis), the diagnosis holds and the remedy does not transfer

P09 measured `getField` at about twice the cursor and named the field-name
lookup as the cause. That was read from the code. The substrate study's answer
to this shape is to generate a free function for each site at define time. Two
claims sit inside that answer, *hoist the lookup* and *generate the code*, and
only one of them may be paying, so both are measured separately here.

`Archetype.readField` does a string-keyed `_fieldIndex[cid][field]` load on
every read. A field index belongs to the schema and not to the archetype, so it
can resolve once. `bound` is a closure that resolves it once. `generated` is the
same body from `new Function` with the component id and the field index baked in
as literals. 200,000 entities, one f32 field, against the cursor:

| order | path | node (V8) | deno (V8) | bun (jsc) |
| --- | --- | --- | --- | --- |
| in order | `getField` | 1.89x | 2.84x | 1.31x |
| in order | cursor | 1.00x | 1.00x | 1.00x |
| in order | bound closure | 1.03x | 1.55x | 0.94x |
| in order | generated | 1.01x | 1.54x | 0.94x |
| in order | dense walk (floor) | 0.37x | 0.63x | 0.50x |
| shuffled | `getField` | 2.06x | 2.05x | 1.33x |
| shuffled | cursor | 1.00x | 1.00x | 1.00x |
| shuffled | bound closure | 0.99x | 0.99x | 1.04x |
| shuffled | generated | 0.98x | 1.05x | 0.98x |
| shuffled | dense walk (floor) | 0.22x | 0.24x | 0.29x |

Checksums identical across all five paths in both orders.

**Generated code buys nothing a closure does not.** `bound` and `generated` land
on each other in all six cells, within their spreads. The cost this removes is
the string lookup, and a closure removes it as completely. Nothing here
justifies `new Function`, its build-time twin, or the
Content-Security-Policy problem both bring.

**And neither beats the cursor.** Both tie it. The cursor already resolves each
field once and re-points itself, so it is the hoisted accessor, reached by a
different name. The library's remedy for this shipped before the question was
asked.

**P09's diagnosis is confirmed for `getField` alone.** It pays the string lookup
on every read and costs 1.31x to 2.84x the cursor for it. That is the one path
with room in it, and the room is a resolved index, not generated code.

**The floor says where the real cost is.** A dense walk over the same field is
1.6x to 4.5x faster than the best by-id path. What separates them is the entity
to archetype to row resolution, and no accessor shape removes that, which is
P09's rule-15 finding again, from the other side. An accessor cannot buy back an
indirection it still has to perform.

> **The deno in-order cursor row is bimodal**, the same defect P05-kernels found.
> Its spread is 1.36 to 2.18 ms on one backing in one process, so `bound` reading
> 1.55x there is the cursor landing in its fast mode and not the closure
> costing anything. The shuffled rows on the same runtime are stable and put the
> two paths at 0.99x and 1.05x.

## What these probes do not measure

Recorded rather than declared closed.

- **SpiderMonkey and Firefox.** Not installed on this machine. Firefox 128+ is a
  supported target in the README and nothing here touches it. Round 3's whole
  lesson is that the third engine is where the surprise lives.
- **x86-64.** This is Apple silicon. The crossover between SoA and AoS is
  cache-dependent, and cache geometry differs.
- **Major collections.** Neither P21 workload provoked one, so the study's
  strongest pause claim is untested against the library.
- **The `ComputeBackend` seam.** The interface ships and no backend does.
  Experiment 03 verified "one layout, two backends" with a hand-encoded 178-byte
  module and a checksum agreeing to 6.08e-8. Nothing equivalent exists here for
  that seam, so it is an architectural intention and not a measured property. The
  workers plugin runs a WASM kernel over the columns on its own route. That is a
  different seam, and `findings-wasm.md` measures it.
- **Parallelism.** The probes here are single threaded, so experiment 04's 6.20x
  has nothing to measure against in this file. The workers plugin ships a pool and
  a barrier, and `findings-parallel.md` measures them.
- **Why deno's by-id cursor read is bimodal.** P05-kernels and P10 both found a
  cursor walk over 200,000 entities landing at either of two speeds on deno,
  chosen per process and stable within it, with no equivalent split on node or
  bun. Same engine family, same library build. It is a property of the cursor
  path and not of the backing, and nothing here explains it. Every ratio taken
  against a deno cursor number needs a re-run before it is believed.
- **The wasm backing under JavaScriptCore.** P05 shows a growable
  `SharedArrayBuffer` costs 4.16x on a column write there. A shared
  `WebAssembly.Memory` can only expose a growable buffer, so the wasm profile
  should pay the same and has no remedy of the same shape. Untested.
- **Strings.** There are no string columns, so experiment 08 has no counterpart.

## The probes had drifted, and five of them threw

Recorded because it decides what the numbers above are worth. Every probe here
was written against 0.5. Against 0.6.0 five of them died before they measured
anything, and one more died on its first line:

- `memory: { budget: { entities: N } }` was removed in 0.6, which broke
  `p01`, `p09`, `p10`, `p17` and `p21` at world construction.
- `Query.eachChunk` is now `forEachChunk`, which broke the same five again plus
  `p05-growth`, `p05-kernels`, `p11` and `conformance`.
- `conformance.mjs` passed a `lib` binding it never defined, and the
  plugins it installs now ship as their own entries rather than as named
  exports of the root.

All of that is repaired and every probe runs again. The lesson is the one the
directory already argues for a test: a probe nothing runs is a probe that
records the API of the day it was written. Nothing in the repository fails when
these rot, because `run.mjs` is not in a gate.

## Two defects found while writing these probes

Neither is a performance result. Both cost time and both are one-line fixes.
**Both are fixed.** The JSDoc no longer shows the array form, and `spawn` now
rejects a component definition in a dev build with `ECS_ERROR.INVALID_TEMPLATE`.
What follows is the record of the tree the probes ran against.

1. **`src/core/ecs/ecs.ts:586` documents an API that throws.** The JSDoc on
   `spawn` shows `ecs.template([{ def: Pos, values: { x: 0, y: 0 } }])`. The real
   signature takes varargs callable bundles, `ecs.template(Pos({ x: 0, y: 0 }))`.
   The array form reaches `resolveTemplate` and dies with
   `TypeError: Cannot read properties of undefined (reading 'id')`. This JSDoc
   ships in the `.d.ts`, so an editor offers it on hover. It is stale from the
   0.5 callable-bundle grammar change.
2. **Passing a `ComponentDef` where a `Template` belongs is unguarded.**
   `ecs.spawn(Pos)` throws `TypeError: Cannot read properties of undefined
   (reading 'materializesRows')` from inside the store, in the **development**
   build as well as production. Every other misuse in this library is caught by a
   `DEV` guard that names the mistake. This one is not, and the raw error points
   at the wrong place.

### P11, the sizing x backing grid, the premise holds, and two defects fell out

`ECSMemoryOptions` is one key-discriminated union over five arms, and it mixes
two independent questions: how big the world is, and what backs it. The
proposal is to split them into two fields. That proposal makes a claim, the
axes are independent, so the claim was measured before anything changed.

The probe uses the library as its own oracle. A `budget` world resolves the
derivation, and the other backings are then built from the numbers that world
reports. Nothing reimplements the arithmetic. Every cell then runs the same
spawn, churn, despawn and respawn workload and reports its resolved plan and its
`stateHash`.

**The premise holds.** `capBytes` and `columnCapacity` agree across heap, shared
and fixed-SAB backings in every runnable cell, and `stateHash`, the query sum
and the live count agree across all three backings on all three runtimes. The
backing does not change the world. Sizing and backing really are orthogonal, so
the flattening is sound.

**Defect 1, the `{ allocator }` arm ignores its cap and reserves the whole
entity index. Fixed in 0.6.0.** With no entity count the arm now derives the
index from its declared cap, and `src/core/ecs/ecs_memory.ts` names this defect
as the reason. What follows is the record of the tree the probe ran against.
`resolveECSMemory`'s allocator arm set
`entityIndexCapacity: ENTITY_INDEX_DEFAULT_CAPACITY` unconditionally, which is
1,048,576 slots = 12,582,912 B. Every other arm derives the index from the cap
(`floor_pow2(cap/4 ÷ 12 B)`) and scales down. So the escape hatch is unusable
below about 12.6 MiB. It asks for 12,660,852 B and dies, no matter what
`capBytesHint` says:

| sizing | cap | heap | shared | allocator (fixed SAB) |
| --- | --- | --- | --- | --- |
| tiny (100 entities) | 4 MiB | ok | ok | **fail** |
| small (10,000 entities) | 4 MiB | ok | ok | **fail** |
| bytes8m | 8 MiB | ok | ok | **fail** |
| mid (200,000 entities) | 42.6 MiB | ok | ok | ok |
| both and default | 64 / 256 MiB | ok | ok | ok |

Nine of eighteen cells fail, identically on node, deno and bun. This is not
engine-specific and it is not new: it is a shipped defect in 0.5.4, reachable by
any caller of the documented escape hatch with a cap under about 12.6 MiB. The
`fixedSabAllocator` tests pass only because they use a 32 MiB cap, above the
floor. The error text makes it worse by blaming the caller. It says "a real
workload stays ~16 MiB, reaching it signals runaway entity and column growth
upstream", while the world under it held 2,000 entities.

**Defect 2, `entityIndexCapacity` is the one field the backing changes, and a
budget cannot reach it.** It is the only field that differs across backings, and
in every budget-bearing sizing the budget's derived value is lost:

| sizing | budget wanted | heap | shared | allocator |
| --- | --- | --- | --- | --- |
| mid (200,000 entities) | 524,288 | 524,288 | 524,288 | 1,048,576 |
| both (50,000 entities + 64 MiB cap) | 131,072 | 1,048,576 | 1,048,576 | 1,048,576 |

The `mid` row's heap and shared agreement is a coincidence, not a mechanism:
`floor_pow2(42.6 MiB/4 ÷ 12 B)` and `pow2(2 × 200,000)` both land on 524,288.
The `both` row is the honest one. It is the combination the union forbids today
(`entities` and `maxBytes`), and it over-reserves the entity index eight times
over, because there is no way to say "size the index from the entity count and
take the ceiling from the byte cap". That is exactly the combination the
flattened shape makes sayable, so this row is the strongest single argument for
the change.

**What the implementation must therefore do.** Derive `entityIndexCapacity` from
`entities` on every backing when an entity count is given, including the
allocator arm. Fall back to the cap-derived formula, then to the default. Until
that lands, the allocator arm's hardcoded reservation is the floor under every
custom-allocator world.

**After the flattening, the whole grid is green.** The same probe, re-run
against the two-field shape, with the sizing now travelling with the backing
instead of being hand-carried:

| sizing | heap | shared | allocator (fixed SAB) |
| --- | --- | --- | --- |
| tiny, small and bytes8m | ok | ok | **ok** (was fail) |
| mid, both and default | ok | ok | ok |

Eighteen cells of eighteen construct and run on all three runtimes. `capBytes`,
`columnCapacity` and `entityIndexCapacity` agree across all three backings in
every row, and `stateHash`, the query sum and the live count agree in every row. There are no
lost rows left: the entity count reaches the index on every backing.

The `both` row is the one to read. It went from 1,048,576 index slots to
131,072, the eight-times over-reservation is gone, because "size the index from
the entity count and take the ceiling from the byte cap" is now something a
caller can say.

The probe itself is the other evidence. Building one cell used to mean
constructing a throwaway budget world, reading its `memoryPlan`, and carrying
`columnCapacity` and the cap across to the other backings by hand. It is now one
object spread. Only the allocator backing keeps a real step, and it is inherent:
a caller-built allocator needs its byte cap before any plan exists, so the
sizing is resolved once to learn the cap. That is a cost of owning the buffer,
not of the option shape.

### P22, change detection at the row grain. One verdict reversed, three defects

node (V8) and bun (JSC), 200,000 entities in one archetype, one component of
three `f32` fields, production artifact of the working tree. Deno was not run.

**The store beats the push.** The substrate study chose "raw write plus an int
push" for the entity grain after measuring it against an observable setter. It
never measured the third shape, one typed-array store into a tick column that
rides the row plane. That shape costs within noise of the raw write on both
engines. The push, as shipped in `ctx.markChanged`, costs about fifteen times
the raw write on V8 and about twenty-five times on JSC. The verdict the design
rests on is reversed for the dense loop.

| dense loop, per row | node | bun |
| --- | --- | --- |
| raw `x[i] += 1` | 0.73 ns | 0.37 ns |
| raw + `markChanged`, no observer registered | 2.45 ns | 0.87 ns |
| raw + `markChanged`, entity `onSet` registered | 11.34 ns | 9.49 ns |
| raw + one `Uint32Array` tick store (hand-written) | 0.86 ns | 0.52 ns |
| raw + one bit set (hand-written) | 2.09 ns | 2.23 ns |

The gated call is not free either: with no observer registered, `markChanged`
in a hot loop still costs about three times the raw write on V8.

**A record on `at()` is cheap, and today there is none.** A mutable cursor
whose `at()` also stores one tick costs about a sixth more than the cursor
alone. `markChanged` beside the cursor costs more than the cursor itself. On
the shipped artifact a `ctx.ref` write and a `ctx.cursor` write land in the
column and never reach an entity-grain `onSet`, while `docs/api/change-detection.md`
says a `ref` write does. The conservative stamp at acquisition is the accuracy
fix, and the measurement says it is affordable.

| by id, shuffled, per row | node | bun |
| --- | --- | --- |
| `cursor.at(id).x = v` | 10.96 ns | 13.37 ns |
| cursor + one index-keyed tick store (hand-written) | 12.74 ns | 15.47 ns |
| cursor + `markChanged`, observer registered | 25.70 ns | 20.72 ns |
| `ctx.setField` | 26.26 ns | 12.10 ns |
| `ctx.setField`, observer registered | 39.72 ns | 21.76 ns |

**The drain pays for lookups the row plane already answers.** `list` is today's
mechanism end to end (mark, take, radix, three liveness lookups per entity, one
empty callback). `base` is the same K calls with no observer. `handlist` is a
dedup byte and a push with nothing around it. `scan` is a linear pass over a
tick column. `scanbits` is a bitset pass that skips zero words. All in ms per
update.

| K dirty of 200,000, node | base | list | list minus base | handlist | scan | scanbits |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.003 | 0.004 | 0.002 | 0.000 | 0.568 | 0.025 |
| 200 | 0.005 | 0.032 | 0.027 | 0.001 | 0.128 | 0.028 |
| 2,000 | 0.009 | 0.112 | 0.103 | 0.007 | 0.147 | 0.022 |
| 20,000 | 0.052 | 0.560 | 0.507 | 0.061 | 0.236 | 0.069 |
| 200,000 | 0.510 | 6.509 | 5.998 | 0.542 | 0.660 | 0.665 |

| K dirty of 200,000, bun | base | list | list minus base | handlist | scan | scanbits |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.008 | 0.012 | 0.004 | 0.000 | 0.130 | 0.007 |
| 2,000 | 0.014 | 0.123 | 0.109 | 0.007 | 0.148 | 0.016 |
| 200,000 | 0.129 | 22.131 | 22.002 | 0.243 | 0.251 | 0.796 |

At full density the shipped drain costs about ten times a hand list per entity
on V8 and about ninety times on JSC. The cost sits in `isAlive`, `hasComponent`
and `isDisabled` per fired entity (three random table reads), the mark clear,
the radix pass, and the call. A row inside an archetype's enabled partition is
alive, a member and enabled by construction, so a drain that walks the row
plane needs none of the three reads. A bitset with a zero-word skip drains one
dirty row of 200,000 in tens of microseconds on both engines. A tick-column
scan costs a linear pass at every density, and it serves any number of
consumers with their own baselines, which a bitset cannot. On V8 the scan at
one dirty row measured slower than at 200, on three runs. The probe does not
explain that.

**The idle tax is small.** Thirty-two entity observers with nothing dirty add
under ten microseconds to an update on V8. The memory is not small: each
tracked component allocates one dedup byte per entity index slot, which is
`ENTITY_INDEX_DEFAULT_CAPACITY` bytes at the default sizing, whatever the live
count.

**The facts, on the artifact.** The `a:facts` group prints these:

- `ref` and `cursor` writes land, and an entity-grain `onSet` fires for neither.
- `cols.mut(Pos)` with no write makes `changed(Pos)` report the archetype.
- One `setField` at tick 3 with the writer ordered before the reader is
  reported on ticks 3 and 4. With the reader before the writer it is reported
  on tick 4 only. The spawn is reported on ticks 0 and 1 in both orders. The
  frame-grain tick cannot order a writer and a reader inside one frame, and
  writer-before-reader is the usual order, so the usual order reports every
  change twice.
- `observe()` on a sparse component throws, and the message names
  "component undefined". `changed()` on a sparse term is accepted on the
  production build and never matches, because nothing stamps a sparse column.

**Not covered.** More than one archetype (the scan's cost is per archetype the
gate admits, and the gate is the archetype tick, which `cols.mut` sets on
acquisition). The row-move cost of one more column in the row plane. The
shared backing. Densities 200 and 20,000 on JSC. Deno.

#### P22 after the change: the row record and the change tick

The same probe, on the artifact of the tree that carries the accuracy fixes and the row grain.
node (V8) and bun (JSC), same machine, same shape. The facts group now reads:

- `ref` and `cursor` writes fire the entity-level `onSet`, one each.
- One write at tick 3 is reported on one tick in both system orders.
- `observe()` on a sparse component names the remedy.

The library's row record, `cols.ticks(def)` with `t[i] = cols.tick`, costs what the hand-written
tick store cost. Where a chunk loop records every row, the end-to-end cost against `markChanged`
is the drain's share, and it falls by half on V8.

| dense loop, per row, after | node | bun |
| --- | --- | --- |
| raw `x[i] += 1` | 0.77 ns | 0.37 ns |
| raw + `markChanged`, entity `onSet` registered | 13.83 ns | 13.04 ns |
| raw + `cols.ticks` store, entity `onSet` registered | 0.88 ns | 0.52 ns |
| raw + one `Uint32Array` tick store (hand-written) | 0.89 ns | 0.50 ns |

| whole update, every row recorded and fired | node | bun |
| --- | --- | --- |
| `markChanged` | 8.34 ms | 24.78 ms |
| `cols.ticks` | 3.72 ms | 21.04 ms |

A mutable cursor now records the entity on each `at()` when the component is tracked. That record
is a list push behind a tick compare, and it costs about what the old `markChanged` cost beside
the cursor, so a by-id sweep that records every entity pays it once instead of twice.

| by id, shuffled, per row, after | node | bun |
| --- | --- | --- |
| `cursor.at(id).x = v`, untracked | 10.99 ns | 9.62 ns |
| `cursor.at(id).x = v`, entity `onSet` registered | 23.15 ns | 24.37 ns |
| cursor + `markChanged`, observer registered | 48.04 ns | 20.72 ns |
| `ctx.setField`, observer registered | 41.28 ns | 23.87 ns |

The drain has two sources now. The dirty list serves the by-id paths, and its cost is the count
of recorded entities. A frame in which a chunk loop took `cols.ticks` scans every archetype of
the component that a writer stamped, and its cost is the rows of those archetypes. The chunk
loop over every row runs in both `ticks` rows below, so the low densities show the floor of that
loop, and the crossover sits between one and ten percent of the rows.

| K dirty of 200,000, whole update, ms | list, node | ticks, node | list, bun | ticks, bun |
| --- | --- | --- | --- | --- |
| 1 | 0.005 | 0.236 | 0.011 | 0.247 |
| 2,000 | 0.133 | 0.230 | 0.140 | 0.292 |
| 20,000 | 0.738 | 0.384 | 0.928 | 0.380 |
| 200,000 | 8.405 | 3.555 | 25.875 | 19.586 |

The memory of the entity grain is now one word for each row of each archetype that holds the
component, and no byte for each entity slot: the idle group reports no buffer growth at
registration, because the columns arrive with the archetypes.

**Two results that need a second look.** On JSC the drain at full density still costs far more
than the hand list at every density, in both modes, so the cost is not in the record or the
scan. It sits in the dispatch, and this probe does not say where. The `bench/ab` run of the same
two artifacts shows every row inside the calibration floor except two small ones: the update of
twenty empty systems, which pays one counter increment per system run, and the template spawn,
which zeroes the tick tail of the new row.

#### P22 after the follow-ups: the JSC drain, the adaptive record, the pull, the sparse grain

The same probe, on the artifact of the tree that carries the four follow-ups. node (V8) and
bun (JSC), same machine, same shape.

**The JSC drain cost was the radix scratch.** The pass that orders a drain by entity index kept
its scratch in a plain array grown by a length assignment, which JavaScriptCore turns into a
sparse store, so every element store in the pass became a hash insert. A typed scratch, grown by
doubling, removes it. V8 did not care either way. The `d:` rows on bun now sit near the V8 rows.

| whole update, every row recorded and fired | node | bun before | bun after |
| --- | --- | --- | --- |
| `markChanged` | 8.43 ms | 24.78 ms | 6.55 ms |
| `cols.ticks` | 3.61 ms | 21.04 ms | 2.44 ms |

**The by-id record switches to the scan past a cap.** A frame whose dirty list outgrows a
fraction of the live entities stops pushing and lets the drain walk the plane instead. The
tracked cursor and `setField` rows fall on both engines, and a system that writes every entity
by id no longer pays a push and three checks for each.

| by id, shuffled, per row, observer registered | node before | node after | bun after |
| --- | --- | --- | --- |
| `cursor.at(id).x = v` | 23.15 ns | 18.36 ns | 19.69 ns |
| `ctx.setField` | 41.28 ns | 35.66 ns | 19.98 ns |

`markChanged` stamps no archetype, so its records stay on the list, and the `d:list` rows, which
use it, do not move.

**The sparse row grain costs the read-only cursor nothing.** The mutable sparse cursor's `at()`
carries one load and one branch while the component keeps no row ticks, and two stores once it
does. The read-only literal is untouched, and `sparse/cursor_read` in the `bench/ab` run reads the same.

| sparse, shuffled, every member once, per row | node | bun |
| --- | --- | --- |
| `sparseCursorRead(def).at(id).v` | 1.26 ns | 1.25 ns |
| `sparseCursor(def).at(id).v = v`, no row ticks | 1.35 ns | 1.28 ns |
| `sparseCursor(def).at(id).v = v`, entity `onSet` registered | 3.25 ns | 2.33 ns |
| `ctx.setSparseField`, no row ticks | 14.78 ns | 2.12 ns |
| `ctx.setSparseField`, entity `onSet` registered | 16.78 ns | 3.11 ns |

`setSparseField` on V8 resolves the field name through a string-keyed lookup on every call, as
`getField` does on the dense side, and that lookup is the row, not the record.

**The `bench/ab` run of the final artifact against the pre-change one** shows every row inside the
calibration floor. The two small costs from before remain and nothing joined them: the update of
twenty empty systems pays one counter increment per system run, and the template spawn zeroes the
tick tail of the new row.

**Not covered.** The pull API (`changed().forEachChunk` with `ticksRead`) has no timing row here:
its loop is the `w:ticks` loop with a compare in place of a store, and the archetype filter of
`forEach`. Deno.

### P23, the three jit pillars. One is large, one is small, one buys nothing

Node 24.12.0, Deno 2.9.1, Bun 1.3.13. Darwin arm64. oecs 0.6.0, production
artifact on both sides.

Three pieces of this library exist for the compiler. Each one is correct without
the trick. Delete any of them and the whole unit suite passes: 140 files, 1771
tests, green in each case, and the typechecker complains only that the function
you stopped calling is now unused. Each one carries a file comment that says it
was measured, and until now that comment was the only thing holding it in place.

The probe removes each pillar from a copy of `src/`, rebuilds the package with
`scripts/build.mjs`, and measures the same workload on both builds. It refuses
to report when a patch matches its anchor text zero times or twice, and it
refuses when the two builds emit identical bytes: both of those look exactly
like a pillar that costs nothing.

| pillar | case | node | deno | bun |
| --- | --- | --- | --- | --- |
| `kinds` | eight element kinds | 3.16x | 2.64x | 1.29x |
| `kinds` | one element kind (control) | 1.00x | 0.99x | 1.00x |
| `dispatch` | one system, small world | 1.05x | 1.51x | 1.01x |
| `dispatch` | one system, large world | 0.99x | 0.99x | 1.00x |
| `shape` | sparse cursor, no dense cursor first | 1.03x | 1.00x | 1.00x |
| `shape` | sparse cursor, dense cursor first | 1.00x | 0.98x | 1.02x |

Each number is the patched build over the base build, so above one means the
pillar still pays.

**`kinds` is the large one, and it is the pillar with no test at all.** One
accessor body for all eight element kinds costs a multiple on every field read
of a component that mixes kinds, on both V8 runtimes. JavaScriptCore charges
less, which is what `ref.ts` predicts: it says JSC pays from the second kind
rather than at the fifth, so it has less headroom to lose. The control row is
the one that makes the result readable. A component whose fields are all `f64`
measures the same either way, so the cost is the cliff and not the refactor.

Collapsing those eight copy-pasted bodies into one helper is behaviour
preserving, it deletes about eighty lines, and it is the first change a tidy-up
pass would make. Before this probe nothing in the repository would have
objected.

**`dispatch` still pays, and it pays less than the comment implies.** The
schedule's comment says the inlined loop runs "much slower". What reproduces
today is smaller and narrower than that. The effect is real on both V8 runtimes
in a small world, where the scheduler's per-system cost is a visible share of
the frame. It vanishes in a large world, where the system body dominates. It
does not appear on JavaScriptCore at all. The direction of the claim holds. The
size of it does not, on this engine, on this day. Note also that the existing
`sched/update_20systems` suite case does **not** show this: twenty closures from
one literal are already enough targets, so the seed protects the one-system
world and the true factory world, not that case.

**`shape` buys nothing that this probe can find.** Six comparisons, three
runtimes, two orders, and every one of them lands inside the spread. The single
disjoint row reads below one, which is the patched build winning by noise. The
claim was order sensitivity: that a dense cursor running first would make a
later sparse cursor slower. Both orders measure the same on both builds.

That is not proof the mechanism never existed. V8's tracking of a field's
constness is a version-dependent detail, and the comment says it was measured.
It is a statement that the mechanism does not reach the shipped library on any
runtime installed here. `primeAccessorShapes` costs two objects at module load,
so keeping it is cheap insurance. What it must not keep is a comment that reads
as a current measurement. The finding belongs next to the claim.

**Not measured.** Three sibling rules have no probe and stay untested:
`ref.ts` requires `__cols` and `__row` to appear as literals at every hot site
rather than through an imported constant, `row_kinds.ts` requires the same of
its type tags, and `row_kinds.ts` forbids folding its eight `switch` cases into
a shared helper. Each of those is behaviour preserving to break. Each would be
invisible to the suite, and to this probe.

### P23-solid, ECS state into SolidJS. A signal per row wins at every dense density

**The solid plugin costs less per tick than the observers chain at every
dense density this probe measures.** It reads the store's change feed and writes
one Solid signal per row. Its publish alone, with no subscriber, is below the
chain's. The chain measures lower on the two rows that move almost nothing, one
dirty row and an idle tick, and both of those sit in single-digit microseconds.

The plugin's first design wrote a Solid store keyed by entity id. That
design lost on every dense row of this probe. Both result sets are below, the
first design first. The chain rows come from the probe as it stood
before the kernel chain was removed. The probe now measures the plugin alone.

node (V8) only. 200,000 entities in one archetype, one component of two `f32`
fields, production artifact of the working tree. Deno and bun were not run.

One `UPDATE` system writes `x` on K rows by id through `ctx.setField`, on a
fixed shuffled order. The written value changes on every tick, so no equality
skip on either path can hide a publish. The warm-up counts row visits and not
ticks, so a sparse density gets more warm-up ticks than a dense one. Both worlds
carry one `createEffect` for each entity, subscribed after the seed and before
the timing. The chain effect reads `bindCell(id)()`. The plugin effect reads
`cell(id)()`, bound once per row for parity. The timed region is the whole tick
call, `batchedUpdate(world, dt)` for the chain and `world.update(dt)` for the
plugin. Both paths wake the same count of effects on every row, and the
probe prints that count.

#### The first design, a Solid store keyed by entity id. It lost on every dense row

**The store publish cost more than the chain at every density above one row.**
The multiple moved between runs, 1.74x to 2.29x at K = 2,000 and 1.38x to 1.59x
at K = 20,000, so read the direction and not the multiple.

| K dirty of 200,000 | chain ms | cap ms | cap vs chain | chain ns/row | cap ns/row |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.009 | 0.008 | 0.90x | 8980 | 8083 |
| 200 | 0.165 | 0.306 | **1.85x** | 826 | 1529 |
| 2,000 | 2.143 | 4.908 | **2.29x** | 1072 | 2454 |
| 20,000 | 33.943 | 49.032 | **1.44x** | 1697 | 2452 |
| 200,000 | 130.521 | 237.835 | **1.82x** | 653 | 1189 |

| variant | chain ms | cap ms |
| --- | --- | --- |
| idle, nothing written, every effect subscribed | 0.004 | 0.003 |
| nosub, K = 2,000, no effect subscribed | 0.557 | 1.639 |

**The store design already lost at the publish, before Solid read anything.**
Its `nosub` row sat at about three times the chain's. That row was not
symmetric and it favoured the plugin: the chain's `nosub` variant drops the
per-entity kernel-to-Solid bridge along with the effects, so the chain figure
was the half that reaches `reactiveMap` and the plugin figure was its whole
path with nobody watching.

**One dirty row was a tie.** The middle halves overlapped, chain 0.008 to 0.020
and cap 0.007 to 0.017.

#### The second design, one Solid signal per row. It wins at every dense density

**The plugin is the cheaper path at 200 dirty rows and above.** One run of
the whole probe, after the warm-up fix below.

| K dirty of 200,000 | chain ms | cap ms | cap vs chain | chain ns/row | cap ns/row |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.003 | 0.010 | **3.57x** | 2875 | 10250 |
| 200 | 0.114 | 0.085 | **0.74x** | 573 | 423 |
| 2,000 | 2.484 | 1.485 | **0.60x** | 1242 | 742 |
| 20,000 | 33.255 | 21.292 | **0.64x** | 1663 | 1065 |
| 200,000 | 146.216 | 75.639 | **0.52x** | 731 | 378 |

| variant | chain ms | cap ms |
| --- | --- | --- |
| idle, nothing written, every effect subscribed | 0.001 | 0.003 |
| nosub, K = 2,000, no effect subscribed | 0.511 | 0.365 |

**The 200-row loss the first run of this design reported was the probe's
warm-up.** The shipped warm-up ran six ticks whatever the density. Under it,
`chain:d200` measured 0.156, 0.160 and 0.173 ms across three runs and `cap:d200`
measured 0.525, 0.541 and 0.547 ms. Raising the warm-up to 200 ticks and
changing nothing else gave `chain:d200` 0.111, 0.116 and 0.122 ms, and
`cap:d200` 0.084, 0.085 and 0.084 ms. So the plugin was the cheaper path at
that density all along, and the six-tick warm-up hid it.

**The cause is where the seed runs.** The seed walks every entity through the
publish path before a single cell exists, so the branch that writes a cell's
setter is never taken until the samples begin. Six ticks at 200 rows are 1,200
visits of that branch, which is too few for the optimizing tier to come back.
Six ticks at 2,000 rows are 12,000 visits, which is enough, and that density
never showed the step. The chain shows no step at all, because its per-row path
is the same code the seed already ran with its subscribers in place. The probe
now warms by row visits and not by ticks.

**The publish alone is the cheaper of the two.** The `nosub` row puts the
plugin below the chain at the middle density with no subscriber on either
side. Both variants drop their per-row reader, the chain its bridge and the
plugin its cell, so the two figures answer the same question.

**The subscriber half is cheaper as well.** Subtracting `nosub` from the
K = 2,000 row leaves 1.973 ms for the chain and 1.120 ms for the plugin, for
the same 2,000 woken effects.

**The gap widens with density.** At 200,000 dirty rows the plugin runs at
half the chain's tick and at half its per-row cost. The chain writes the kernel
map and then wakes one bridge for each changed row, which is a second graph to
walk. The plugin writes the signal the effect reads.

**The two rows that move almost nothing go the other way, and they are the bad
result here.** One dirty row costs the chain 0.003 ms and the plugin
0.010 ms, and an idle tick costs 0.001 ms against 0.003 ms. Both are single-digit
microseconds on a tick that carries 200,000 subscribed effects, and the run with
the six-tick warm-up called both a tie. The direction on these two moved when the
warm-up moved, so read them as small and warm-up sensitive. One run, so neither
is repeated.

> **The export condition decides whether this probe measures anything.** Under
> node's own condition solid-js resolves to its server build, where a signal
> holds a value and no effect ever runs. Every row would then report the cost of
> writing values nobody reads. Each variant child spawns with
> `--conditions=browser` in its node arguments, and asserts before it measures
> that an effect inside a `createRoot` runs at creation and again after each
> signal write.

**Not measured.** No DOM and no renderer, so nothing here says what a real view
adds. No `<For>`, so the key set and the row reconciler are untested. Effects
only, which is the cheapest subscriber Solid has, so every row is a floor. One
component, one archetype, one view and one field list. No spawn, no despawn and
no disable inside the timed region, so the structural half of both paths is
untested. The `eq` skip, which this probe defeats on purpose by changing the
written value every tick. The plugin's column grain and its `singleton`
entry point. Whether the one-row and idle rows hold, since each is one run.
JavaScriptCore and Deno. One machine and one build.
