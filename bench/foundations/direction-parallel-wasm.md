# Direction: parallel systems and any-toolchain WASM bodies

Status: the address-space fix and level 1 are built in the probe copy. `storeBase` with
store-relative offsets and ABI version 1 landed first, then `attachWorkers` and the `parallel`
system form. The findings files hold the measurements, the CHANGELOG holds the user-facing
summary, and `level1-engine-spec.md` holds the build brief. Open items are listed at the end.

This file states the design direction the probes support, and the direction they
refute. It quotes no number. `findings-parallel.md`, `findings-wasm.md` and
`findings-seams.md` hold the evidence, and each claim below names the probe that
carries it. A claim marked **open** has no probe yet.

## The shape in one paragraph

A kernel is a function over column pointers, a row count and `dt`. The engine
resolves the query, and hands the kernel one archetype at a time. A kernel can be
a WASM export from any toolchain, or a JS function a worker can import. The same
kernel runs sequentially on the main thread, or across several workers over
disjoint row ranges, and the schedule keeps its total order either way. Every
structural change stays on the main thread at the phase flush, after every
worker has joined. The store never starts at byte 0 of a memory a module shares.
The state hash of a deterministic world is the oracle for every step.

## What the probes established

### The layout is portable, the address space is not (`p25-wasm-abi`, `p25-wasm-memory-ownership`)

- A module emitted byte by byte with no compiler, a Zig module, and JavaScript
  read the same header and descriptors, write the same bytes, and agree with
  `stateHash` on an integer world, on V8 and on JavaScriptCore. The layout is a
  real ABI today.
- A compiled module owns low addresses. Its data segment, its shadow stack and
  its heap base all land inside the store's entity index. The world loses
  entities silently, `update` raises nothing, and `stateHash` does not move
  because it never folds the entity index.
- A module built for shared memory initialises its data segment once, guarded
  by a word inside the shared memory at the end of its own data. Inside a store
  that word belongs to the entity index, so whether the module's constants exist
  depends on the world's contents. This is the worst failure found: silent, data
  dependent, and it changes with world size.
- Before `storeBase` neither escape route worked. With `maximumPages` the
  memory's maximum was the store cap, so a module based above the cap failed to
  link. With a caller memory the store declared no cap, so no address was safe.
  An export-memory module mounted, and the store still landed on byte 0. With
  `storeBase` above the module's `__heap_base` the ownership probe shows zero
  store bytes changed by the module and every entity alive. The default base of
  one page clears only address 0, so the caller passes the base.
- A safe Zig build traps on a read of address 0, because a non-optional pointer
  may not be null. Rust has the same rule. A header at byte 0 is unreadable
  from a safe build of two major toolchains.

### One module, several instances, one shadow stack (`p25-wasm-stack`)

- Every worker instantiates the same module over one memory. A wasm global is
  per-instance, and every copy of `__stack_pointer` starts where the linker put
  it, so every worker writes its frames to the same bytes. A kernel that spills
  anything reads back another worker's frame. Every run disagrees, at every
  worker count. The earlier probes missed it because their kernels hold every
  value in a wasm local.
- The fix is a region for each instance, carved from `[__heap_base, storeBase)`,
  which is the span the caller already reserves. It costs nothing inside a pass,
  and the shared-stack lane is far slower as well as wrong.
- The regions come off the top of that span, so `attachWorkers({ stackBytes })`
  can leave the module a heap below them. Without the option the pool divides
  the whole span and the module has no heap, which is the right default only
  because a kernel may not allocate anyway.
- The engine cannot find the stack of a module that exports no
  `__stack_pointer`, so the contract says such a kernel uses none.
- A data segment above the store base is safe. The segment and the guard word
  the linker places beside it both sit below `__heap_base`.
- Zig, Rust and C through `zig cc` all link the stack first, below the data, and
  put `__heap_base` above both.

### The crossing is cheap and per-archetype dispatch is free (`p25-wasm-crossing`)

- An empty module body costs about what an empty frame costs, and one call per
  archetype costs a fraction more than one call per frame. The dispatch loop can
  stay in JavaScript.
- The hand-emitted module is as fast as the compiled one.
- The module wins above a modest entity count on node and on bun, and loses at
  every size on deno, on the same engine family and the same bytes. Unexplained.
  No crossover claim is portable, so the engine must not assume a module body
  is faster than the TypeScript one.

### Growth (`p25-wasm-growth`)

- A store grow bumps `view_stamp`, relocates columns, and calls `setLayout`. A
  module that cached a column address writes into the abandoned block, changes
  nothing, and reports success. Silence again. A module that walks from the
  header offset on every call is the shape to copy.
- A grow the module starts is harmless. The store keys its tail off the header
  capacity, not the buffer length.
- Views over a shared memory survive a grow on all three runtimes.

### Backing cost (`p25-wasm-backing-cost`)

- A shared `WebAssembly.Memory` pays none of the JavaScriptCore write tax that a
  growable `SharedArrayBuffer` pays. The comment in `wasmMemoryAllocator` that
  predicts the tax is wrong and must be corrected. A WASM-backed world costs
  what the heap profile costs on every runtime tested.
- Candidate, **open**: back the `shared` profile with a `WebAssembly.Memory`
  even when no module runs, and remove the tax for every worker world.

### Two oracles, not one (`p25-wasm-abi`, `findings-seams.md`)

- `stateHash` on `ecs.snapshots` folds archetype id, row count, enabled count,
  live row bytes and the sparse stores, one word at a time. It needs
  `deterministic: true`, which rejects float columns. It never folds the entity
  index.
- The store-level digest in `state_hash.ts` is FNV-1a over the store bytes. A
  module can compute it in a few lines. The two digests are different numbers.
- A cross-language conformance check must name one digest and implement it on
  both sides. The buffer fold is the one to expose to modules.

### Float bodies agree today, by luck of the engines (`p25-wasm-abi`)

- A naive `Float32Array` body agrees with the module bit for bit on all three
  runtimes because each engine folds the arithmetic to f32. This is an
  optimisation, not a guarantee. A fallback body that must match a module
  rounds each operation with `Math.fround`.

### Correctness of a row split (`p24-par-split`, `p24-par-conflict`)

- A per-row kernel split across workers by row range leaves the same column
  bytes as the sequential run, on V8 and on JavaScriptCore, at every world size
  and worker count tested. On an integer world `stateHash` agrees as well.
- The oracle detects a real conflict. A conflict can still pass by luck on one
  run, so a gate needs repeated runs.
- A host-side reduction over per-worker partials is deterministic only when the
  fold order is fixed. Completion order is never stable.

### Where a split pays (`p24-par-split`, `p24-par-crossing`)

- One worker is always a loss. The split loses on a small archetype and wins on
  a large one, and a heavy kernel crosses earlier than a memory-bound one. The
  threshold is a machine and kernel property, never a constant in the engine.
- Adding workers stops paying before the core count on a memory-bound kernel.
- An `Atomics` release and join beats `postMessage`. The join is not where the
  barrier cost sits. `p24-par-join.mjs` shows the release side grows with the
  worker count, a per-worker done word ties the shared word, and a tree join
  loses above two workers. One worker now notifies the host.
- Park the host on `Atomics.wait`. A spin wins on V8 and loses on JavaScriptCore.
  A browser main thread cannot park, and its policy is **open**.
- The engine frame costs nothing against the kernel.

### A worker sees bytes, not the world (`p24-par-bytes-view`, `findings-seams.md` part A)

- The buffer alone gives every archetype, its live row count, its mask and every
  column offset. A dense with-only or with-and-without query resolves from the
  bytes.
- The descriptor walk is linear in the column count and is not free at a few
  hundred archetypes. The lean bind costs about half. Cache it against
  `view_stamp`.
- The descriptor row count is a copy of the JS truth, refreshed at tick start
  and each phase flush. A module driven outside the schedule sees stale counts
  unless the host publishes first.
- Everything else is main-thread JS: sparse stores, relations, resources, the
  command buffer, events, observers, the change tick, the dirty lists, and the
  row-to-entity table.

### Structural change beside a pass corrupts silently (`p24-par-structural`)

- A grow relocates columns within the buffer with no change to the buffer
  reference, even on a fixed-cap backing. A worker holding cached views loses
  every write after the relocation. `view_stamp` is the only signal.
- A swap remove moves no column, so the worker sees no signal, visits rows past
  the live tail and reads moved rows twice. A live despawn tears rows.
- Therefore no structural change of any kind while a worker or a module is
  inside a pass. The command buffer and the host write path already defer to
  boundaries outside a system span.

## The design this supports

### The kernel contract, two tiers

**Tier A, a kernel over pointers.** The engine resolves the query and, for each
matched archetype, calls the kernel with the byte offset of each declared column,
the enabled row count and `dt`. The kernel knows nothing about the header, the
descriptors or the row counts. Any toolchain that can export a function over
`i32` and `f32` arguments qualifies, which is every toolchain. This is the
"any module" path and the default. The engine already pays nothing extra for a
call per archetype.

**Tier B, a walker.** A module that wants several systems per crossing, or that
must resolve an entity id, reads the header and descriptors itself, as the probe
modules do. It receives the header offset through `setLayout` and walks on every
call. Tier B needs the row-to-entity table in the store, which is an ABI
addition, before it can name an entity.

Both tiers share one memory with the engine, so both need the address-space fix
below. Neither tier ever receives a JS closure, so a Tier A kernel is also the
body a worker can run, and a WASM export is the kernel the engine can ship to a
worker with no extra machinery.

### The address-space fix

1. **`storeBase`.** The header moves to a caller-chosen byte offset, and the
   store promises to write only inside `[storeBase, storeBase + cap)`. Seventeen
   sites assume byte 0, in five files of medium work (`findings-seams.md` part
   B). The caller-memory arm gains a mandatory cap so it can make the promise.
2. **The base clears the module.** For an import-memory module the caller sets
   `storeBase` above the module's `__heap_base` plus its run-time heap. For an
   export-memory module the same rule holds, and the memory must already hold
   `storeBase` plus the first allocation. The engine cannot read `__heap_base`
   before instantiation, so the caller passes the base. A dev guard accepts the
   module's exports and checks the inequality.
3. **Never byte 0 with a module.** The wasm arm rejects `storeBase` of zero,
   because safe builds cannot read address 0.
4. **Store-relative offsets.** Every `*_off` in the header and every `byte_off`
   in a column descriptor becomes relative to `storeBase`. The snapshot, the
   restore and both digests then ignore the base, so a heap world and a
   module-hosted world with the same history agree on every digest. A module
   pays one add per column, which a compiler folds into a base register. This is
   a schema change, so `SIM_ABI_VERSION` leaves its inert sentinel and becomes a
   real version.
5. **`setLayout(base)`.** The parameter becomes honest. The engine also passes
   `dt` and the frame tick as call arguments to `run`, because neither is in the
   bytes and neither belongs in the layout.
6. **Publish before dispatch.** The schedule publishes row counts before the
   first backend or worker dispatch of a phase when they are dirty. A host that
   drives a module outside the schedule publishes explicitly, and the docs say
   so.

### Level 1, one system across workers

Build this after the address-space fix, using the Tier A kernel as the body.

1. **The engine owns the pool and the barrier.** One persistent pool, started
   once. Release and join through `Atomics`, host parked. The join happens before
   the phase flush, always.
2. **The worker binds from bytes.** It receives the buffer and `storeBase` once.
   On each release it compares `view_stamp` with its cached bind and re-walks
   only on a change. It computes its own row range from the descriptor row
   counts, its index and the worker count, so no plan crosses the wire.
3. **Only dense reads and writes cross.** A dev guard rejects a parallel system
   that declares sparse, relation, resource, spawn, despawn or transition
   access, or that emits events.
4. **Change detection is stamped at join, coarsely.** The main thread stamps
   every row of every matched archetype for each declared write. Correct and
   coarse. A finer scheme is **open**.
5. **A reduction folds in worker order.**
6. **The threshold is configured or measured**, never a constant.
7. **The gate is the state hash**, several runs, on a deterministic integer
   world, plus a byte compare on a float world.

### Level 2, different systems at once

Do not build this before level 1 ships. `findings-seams.md` part D lists what it
needs and each item is a real change: per-lane forms of the change tick, the
dirty lists, the command buffer, the observer scratch and the `SystemContext`,
each with a deterministic merge. Three pieces are process global, and
`iterAllRows` is not dev gated. Events have no access declaration. The conflict
graph itself is computable today from the declarations.

### What `exclusive` should mean now

Make the scheduler read it as "runs alone" from the first parallel build, so the
meaning the docs reserve becomes an engine fact.

## Corrections the tree needs regardless

- `wasmMemoryAllocator` predicts a write tax the backing does not pay.
- `header.ts` claims Zig-generated constants that `vendored_abi/abi.ts` calls
  hand copied. One of the two is wrong.
- `grow.ts` says no live code writes `row_count`. `publishRowCounts` does.
- `docs/api/parallel.md` said a heap world cannot use a compute backend, and no
  code enforced that. The page is rewritten around the pool and the claim is
  gone.
- `docs/api/wasm.md` should state that a module reads published row counts and
  that `stateHash` is not the buffer digest.

## Open, each one a probe someone still has to write

- A browser host that cannot park. The browser matrix in `findings-parallel.md`
  shows Blink, Gecko and WebKit all refuse the park, and a worker host runs the
  pool on all three. A main thread policy for level 2 is still open.
- Two different systems at once under a conflict graph. The design is in
  `direction-level2.md`, and its probe `p26-par-level2.mjs` is still open.
- A finer change stamp than every matched row at join. `direction-level2.md`
  keeps the coarse stamp, because a full pass writes every row.
- A digest for float columns, so the float lane gets an engine oracle.
- The deno crossover anomaly.
- A Go module against a nonzero `storeBase`. Rust, C and AssemblyScript are
  closed: each builds the kernel bodies, each runs on the pool, and each binary
  is checked into the unit suite.
- The `shared` profile over a `WebAssembly.Memory` with no module.
- A kernel that overruns its stack region. A wasm stack has no guard page, so
  the overrun writes into the neighbouring region and nothing reports it. Only
  the caller can size the reserve.
- A module whose kernel allocates. Every instance draws from one heap and
  nothing serialises them, so the docs refuse it and no probe measures it.
- SIMD in a kernel, and threads inside a module.
