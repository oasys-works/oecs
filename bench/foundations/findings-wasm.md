# P25, the WASM foundation probes

Can a module from any toolchain run a system body over the columns of oecs with
no copy? The answer splits in two. The **layout** is portable today. The
**address space** is not.

Every number below comes from one machine, one build and one day: Darwin arm64,
Apple silicon, node 24.12.0, deno 2.9.1, bun 1.3.13, zig 0.16.0, oecs 0.6.0
production artifact from `dist/`.

## Status

**Addendum, after `storeBase` landed.** The store now starts at a caller-chosen base, and the
ownership probe runs at two bases. At the default base of one page a default-linked Zig module
still writes into the entity index, because its data segment and stack sit far above one page. At
a base above the module's `__heap_base` the module changes zero store bytes for every action, every
entity stays alive, and `stateHash` is unchanged. The sentence "neither escape route works" in
probe 3 describes the tree before the option existed. The escape route is the base, and the caller
must read `__heap_base` and pass a base above it.

| probe | state | how to run it |
| --- | --- | --- |
| `p25-wasm-abi.mjs` | done, runs on node, deno and bun | `node bench/foundations/p25-wasm-abi.mjs` |
| `p25-wasm-memory-ownership.mjs` | done, node only | `node bench/foundations/p25-wasm-memory-ownership.mjs` |
| `p25-wasm-growth.mjs` | done, the view check runs on all three | `node bench/foundations/p25-wasm-growth.mjs` |
| `p25-wasm-crossing.mjs` | done, all three runtimes | `node bench/foundations/p25-wasm-crossing.mjs` |
| `p25-wasm-backing-cost.mjs` | done, all three runtimes | `node bench/foundations/p25-wasm-backing-cost.mjs` |
| `p25-wasm-stack.mjs` | done, node only, needs zig | `node bench/foundations/p25-wasm-stack.mjs` |

Every probe reads `dist/`. Build it before a run. `p25-wasm-crossing.mjs` and
`p25-wasm-backing-cost.mjs` start one process for each variant, so they take a
few minutes.

The readers now add the header offset to every offset they read, because the
store writes each one measured from the header.

Helpers, all under `bench/foundations/wasm/`:

- `emit.mjs`, a WebAssembly binary emitter, no toolchain. It writes globals and
  a data segment, so a module from no toolchain can follow the stack rule.
- `abi_module.mjs`, the toolchain-free reader of the store, built with `emit.mjs`.
- `abi.zig`, the same reader in Zig.
- `squatter.zig`, a module with a data segment and a stack, used by the
  ownership probe.
- `kernel_module.mjs`, `kernel.zig`, `kernel.rs`, `kernel.c` and `kernel_as.ts`,
  the same kernel bodies from five toolchains.
- `engine-kernels.mjs`, the JavaScript twin of each body.
- `build_zig.mjs`, the compiler call. It writes to `wasm/build/`.
- `gen_kernel_fixtures.mjs`, which builds every kernel module, checks each body
  against its twin, and writes the binaries the unit suite runs. It holds the
  exact build line for each toolchain.
- `world.mjs`, the world every probe shares, and the descriptor readers.

`src/` is unchanged. There is no patch to apply.

Known gaps: no probe touches SpiderMonkey, no probe runs a worker thread, and
no probe measures a module that uses `atomic.wait`. The ownership probe runs on
node only. A skip is not a pass.

## Probe 1, the ABI

**Question.** Do three independent readers of one store agree on the layout and
on the bytes?

**Method.** One world, four archetypes: an empty one, one with position and
velocity, one with position alone, and one that adds a third component so the
masks differ. Three readers walk the header at byte 0, walk the archetype
descriptors, resolve columns by (component_id, field_id) and integrate
`pos += vel * dt` over the enabled rows. The readers are JavaScript, a module
emitted byte by byte with no compiler, and a module compiled by Zig. The probe
then folds the layout each reader found and hashes the whole store.

### The layout, and the bytes

| reader | walk fold | fnv1a over `[0, capacity)` |
| --- | --- | --- |
| javascript | 1653776343 | 1631229605 |
| hand-emitted | 1653776343 | 1631229605 |
| zig 0.16 | 1653776343 | 1631229605 |

### The kernel, eight steps over f32 columns, dt = 0.1

| body | rows touched | store digest | values off the reference |
| --- | --- | --- | --- |
| ts, one rounding for each store | 5120 | 2229087936 | 0 of 21504 |
| ts, rounded at each operation | 5120 | 2229087936 | 0 of 21504 |
| hand-emitted | 5120 | 2229087936 | 0 of 21504 |
| zig 0.16 | 5120 | 2229087936 | 0 of 21504 |

### The kernel over i32 columns, in a deterministic world

| body | `ecs.snapshots.stateHash()` | store digest |
| --- | --- | --- |
| ts | 395164673 | 407359257 |
| hand-emitted | 395164673 | 407359257 |
| zig 0.16 | 395164673 | 407359257 |

**What it shows.** The store buffer is a portable ABI. A module that depends on
no compiler reads the same layout and writes the same bytes as the host. The
emitted module is under two kilobytes and the Zig module is about the same. The
same three tables come out identical on node, deno and bun, so two engine
families agree.

The f32 result is the surprise. A naive TypeScript body,
`x[i] = x[i] + vx[i] * dt` over a `Float32Array`, agrees with WebAssembly bit
for bit on all three runtimes. The two do not compute the same expression: the
module rounds the product to f32 and then rounds the sum, while the source
rounds once at the store. Every engine measured folds the arithmetic to f32
when the destination is a `Float32Array`, so the difference disappears. This is
an engine optimisation and not a language guarantee. A body that wants the
agreement in writing should round each operation with `Math.fround`.

### The public state hash is not the digest of the buffer

| digest | value |
| --- | --- |
| `ecs.snapshots.stateHash()` | 18714627 |
| module `fnv1a` over `[0, capacity)` | 2514219043 |
| javascript `fnv1a` over `[0, capacity)` | 2514219043 |

`ecs.snapshots.stateHash()` folds one word at a time over the live rows of each
archetype and then over the sparse stores. It is not FNV-1a over the bytes of
the buffer, and a module that folds the bytes gets a different number. Both are
good oracles. They are different oracles. A cross-language determinism check
must pick one and implement it on both sides. The buffer fold is the easier one
to write in another language, and the row fold is the one the engine already
exposes.

`stateHash` also needs `{ deterministic: true }`, and a deterministic world
rejects f32 and f64 columns. A float world therefore has no public digest.

### A module reads a published row count, not a live one

| moment | enabled rows a module sees |
| --- | --- |
| after 100 spawns, before `publishRowCounts` | 0 |
| after `publishRowCounts` | 100 |
| after 100 more spawns, unpublished | 100 |
| after `publishRowCounts` | 200 |
| after 100 more spawns and one `ecs.update` | 300 |

`ecs.update` publishes. A host that drives a module outside the schedule must
call `ecs.publishRowCounts()` first, or the module silently skips every row
spawned since the last publication. The failure is silent because the
descriptor is well formed and merely stale.

### The header sits at address 0, and address 0 is not readable everywhere

| zig `-O` | `fnv1a` from address 0 | `fnv1a` from address 4096 |
| --- | --- | --- |
| Debug | trap: unreachable | 1672919891 |
| ReleaseSafe | trap: unreachable | 3493574206 |
| ReleaseFast | 3479235764 | 3493574206 |
| ReleaseSmall | 3479235764 | 3493574206 |

A safe Zig build traps when it dereferences address 0, because a non-optional
pointer may not be null. The store header lives at address 0. So a safe build
of a Zig module cannot read the header of the store at all. The same rule
holds for Rust, whose references may not be null. The workaround inside the
module is ugly, and the fix at the engine is a header that does not start at
byte 0.

**What this probe does not cover.** No f64 column. No u8 or u16 column, where
the stride is not four and a column may start on an odd address. No sparse
component and no relation, both of which live outside the archetype and outside
this walk. No growth during a step. No worker thread. No SpiderMonkey.

## Probe 3, memory ownership

**Question.** The store owns byte 0 and grows upward. A linker owns low
addresses too. What breaks?

**Method.** A Zig module with a data segment and a stack, and no reader of the
store at all. Every byte of the store that changes is therefore a collision.
The probe instantiates it against `ecs.wasmMemory` and diffs the store bytes.

### Where the linker puts the module

| build | data segment | one stack local | `__data_end` | `__heap_base` | declared memory minimum |
| --- | --- | --- | --- | --- | --- |
| default | 1048576 .. 1052672 | 1048512 | 1052676 | 1052688 | 17 pages |
| `--global-base=8388608` | 8388608 .. 8392704 | 9441232 | 8392708 | 9441296 | 145 pages |
| `--global-base=33554432` | 33554432 .. 33558528 | 34607056 | 33558532 | 34607120 | 529 pages |

The linker exports `__heap_base` and `__data_end` when asked with
`--export=__heap_base --export=__data_end`. Those two globals are what an
engine would have to read to place a store above the module.

### What the module writes into a live store

| module action | store byte runs changed | span | region |
| --- | --- | --- | --- |
| instantiate | 1 | 1048576 .. 1052673 | entity index |
| `touch_global` | 1 | 1048604 .. 1048605 | entity index |
| `touch_stack` | 1 | 1044480 .. 1048576 | entity index |

The damage is real and it is silent:

| check | world of 7168 entities | world of 350000 entities |
| --- | --- | --- |
| magic still correct | yes | yes |
| capacity still correct | yes | yes |
| `stateHash` changed | no | no |
| entities still alive | 7168 of 7168 | 347951 of 350000 |
| `ecs.update` after | no error | no error |

A small world survives, because the module lands in entity-index slots the
world has not reached. A larger world loses two thousand entities to a module
that never read the store. Nothing raises. `stateHash` does not move, because
it folds archetype rows and sparse stores and never folds the entity index.
The digest the engine offers for determinism cannot see this corruption.

### The module's own data segment is initialised only sometimes

| state of the memory before instantiation | first word of the data segment after |
| --- | --- |
| untouched memory | 0xa5a5a5a5 |
| every byte 0x00 | 0xa5a5a5a5 |
| every byte 0x11 | 0x11111111 |
| every byte 0x01 | 0x01010101 |

The source sets that word to `0xa5a5a5a5`. A module built for a shared memory
carries passive data segments and a one-time initialiser, and the initialiser
is guarded by a word **inside the shared memory**:

| fact | address |
| --- | --- |
| address of the guard word | 1052672 |
| end of the data segment | 1052672 |
| `__data_end` | 1052676 |

The guard sits at the end of the module's data. In the memory of a store, that
address belongs to the entity index. So whether a compiled module initialises
its own constants depends on what the store happens to hold at one address.
This is the worst failure mode found: it is silent, it is data dependent, and
it changes with the size of the world.

### The way out, one: the module moves

| case | result |
| --- | --- |
| engine memory with `maximumPages: 512`, module base 32 MiB | LinkError, the memory has 98 pages and the module demands 529 |
| caller memory of 200 pages, module base 8 MiB | store capacity 13131776, module base 8388608, the base is inside the store |
| 40960 bytes stamped from the old capacity, then a new archetype | capacity moved to 13295616, none of the stamped bytes written in this run |

Moving the module does not work today.

- With `memory.backing.wasm.maximumPages`, the memory's maximum **is** the cap
  of the store. A module whose base is above the cap declares a minimum the
  memory can never reach, so it fails to link. A module whose base is under the
  cap is inside the region the store may claim.
- With `memory.backing.wasm.memory`, the caller can make the memory large
  enough, but the store then declares **no cap at all**, so there is no address
  the module can stand above.

The last row is a partial result and it should not comfort anyone. The store's
capacity swallowed the stamped region, so the region became store owned. This
one extend happened not to write into the first 40960 bytes of it. A later one
will.

### The way out, two: the engine moves in

| check | result |
| --- | --- |
| module memory, defined pages | min 17, max 512, shared |
| the engine mounted on the module memory | yes |
| store header at byte 0 | magic correct, capacity 12828672 |
| module data segment intact | yes |
| module data address against store capacity | 1048576 against 12828672 |
| a stack local of the module | 1048512, inside the store |

A module built with `--export-memory --shared-memory` hands its memory to the
engine, and the engine mounts on it without complaint. That is the good news
and it ends there. The store's header still lands at byte 0 and the store's
capacity still swallows the module's data and stack. The collision is the same
one, from the other direction.

### What a `storeBase` option would have to guarantee

The lowest address a module claims, measured:

| build | highest address the module claims | pages that address needs |
| --- | --- | --- |
| default | 1052688 | 17 |
| `--global-base=8388608` | 9441296 | 145 |
| `--global-base=33554432` | 34607120 | 529 |

An offset for the header is necessary and it is not sufficient. Three things
have to hold together:

1. **The store must own one bounded span.** `storeBase` moves the header, and
   the store must also promise that it writes only inside
   `[storeBase, storeBase + cap)`. A caller-supplied memory declares no cap
   today, so that arm needs a cap before it can make the promise.
2. **`storeBase` must clear `__heap_base`, plus whatever the module allocates
   at run time.** The linker exports the address. The heap growth is the
   module's business and only the module can bound it.
3. **The module must learn `storeBase` at run time.** `ComputeBackend.setLayout`
   already takes the offset, and the engine hard-codes 0 today. Every reader in
   these probes takes the header offset as a parameter for that reason, and
   every one works unchanged at a nonzero base.

For an **import-memory** module, `storeBase` above `__heap_base` fixes both
directions at once, because the linker already keeps the module below its heap
base. For an **export-memory** module the same rule applies, and the host has
one extra duty: the module's memory must already be big enough to hold
`storeBase` plus the store's first allocation, or the store's first write traps.

**What this probe does not cover.** One toolchain only. No Rust, no
AssemblyScript, no Go. No module that calls `malloc` and grows a heap while the
store is live. No thread other than the main one, where a second instance
would race on the same initialisation guard. Node only.

## Probe 4, growth from both sides

**Question.** The memory can grow from either side. What survives?

### What one store grow changes

| field | before | after |
| --- | --- | --- |
| `view_stamp` | 4 | 5 |
| `capacity` | 6582272 | 8192000 |
| `memory.buffer.byteLength` | 6619136 | 8192000 |
| `byte_off` of the `pos.x` column | 6422528 | 6619136 |
| enabled rows | 512 | 40512 |
| `setLayout` calls so far | 1 | 2 |

Every `setLayout` call passed the offset 0.

### A cached column address across that grow

| what the module holds | cached address | live address | rows it claims | live values it changed |
| --- | --- | --- | --- | --- |
| cached before the grow | 6422528 | 6619136 | 512 | 0 of 122688 |
| re-walked after the grow | 6422528 | 6619136 | 40512 | 121536 of 122688 |
| walks the header on every call | 6422528 | 6619136 | 40640 | 121920 of 122688 |

**What it shows.** A module that cached the address before the grow writes into
the abandoned column block. It does not trap, it does not corrupt live data,
and it reports 512 rows done. It changed nothing. Silence is the failure mode
again. The store bumps `view_stamp` and calls `setLayout`, so the signal is
there and the module has to act on it.

The two correct rows differ because the world holds two matching archetypes.
The re-walk row resolved one archetype and the header-walking row resolved
both. The last row is the shape to copy: take the header offset as an argument
and walk on every call.

### The module grows the memory and the store did not ask

| fact | before | after |
| --- | --- | --- |
| `memory.grow` returned the old page count | - | 202 |
| pages the module sees | 202 | 210 |
| header capacity | 13221888 | 13221888 |
| header `view_stamp` | 3 | 3 |
| archetypes in the descriptor region | 2 | 2 |
| `stateHash` | 1004663890 | 1004663890 |
| entities alive | 4096 | 4096 |
| spawn after the module grew | - | no error |
| update after the module grew | - | no error |
| capacity after that spawn | - | 14024704 |

**What it shows.** A grow started by the module is harmless. The store keys its
tail cursor off the header `capacity` and not off `buffer.byteLength`, so extra
pages are invisible to it and it grows from where it left off. The store does
not notice, and it does not need to.

### Do views survive a grow, on each engine?

| runtime | engine | same buffer object | old view still reads | old write seen through new | new write seen through old |
| --- | --- | --- | --- | --- | --- |
| node | V8 | no | yes | yes | yes |
| deno | V8 | no | yes | yes | yes |
| bun | JavaScriptCore | no | yes | yes | yes |

The claim in `allocator.ts` holds on all three. `memory.buffer` returns a new
object after a grow, and views over the previous object still read and write
the same bytes. The old buffer's `byteLength` stays at the pre-grow size, so a
caller that needs the new tail must build a fresh view.

**What this probe does not cover.** No grow from a second thread. No grow while
a module is inside a call. No `memory.grow` that fails at the maximum.

## Probe 2, the crossing

**Question.** What does it cost to leave JavaScript for the frame, and where
does WebAssembly start to win?

**Method.** One frame of `pos += vel * dt`, through `ecs.update`, over eight
archetypes. Each body runs through the compute-backend seam, so the schedule's
real dispatch is inside the measurement. The empty body measures the crossing
and nothing else. One process for each variant.

### node, V8, median ms for one frame, p25 to p75 in brackets

| entities | ts | hand one call | zig one call | zig call per archetype | empty one call | empty per archetype | zig against ts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0.007 [0.007, 0.008] | 0.006 [0.005, 0.006] | 0.006 [0.006, 0.007] | 0.007 [0.007, 0.007] | 0.002 | 0.003 | 1.13x |
| 10000 | 0.026 [0.025, 0.027] | 0.013 [0.013, 0.032] | 0.013 [0.013, 0.041] | 0.013 [0.013, 0.017] | 0.002 | 0.003 | 1.96x |
| 100000 | 0.214 [0.214, 0.217] | 0.113 [0.113, 0.116] | 0.111 [0.110, 0.112] | 0.112 [0.112, 0.114] | 0.002 | 0.003 | 1.93x |
| 1000000 | 2.124 [2.117, 2.133] | 1.187 [1.179, 1.192] | 1.164 [1.159, 1.170] | 1.178 [1.171, 1.195] | 0.002 | 0.003 | 1.82x |

### deno, V8

| entities | ts | hand one call | zig one call | zig call per archetype | empty one call | empty per archetype | zig against ts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0.007 | 0.006 | 0.007 | 0.007 | 0.002 | 0.002 | 0.99x |
| 10000 | 0.023 | 0.019 | 0.021 | 0.021 | 0.002 | 0.002 | 1.10x |
| 100000 | 0.178 | 0.181 | 0.197 | 0.195 | 0.002 | 0.002 | 0.90x |
| 1000000 | 1.799 | 1.833 | 1.973 | 1.981 | 0.002 | 0.003 | 0.91x |

### bun, JavaScriptCore

| entities | ts | hand one call | zig one call | zig call per archetype | empty one call | empty per archetype | zig against ts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0.010 | 0.010 | 0.010 | 0.011 | 0.004 | 0.005 | 1.02x |
| 10000 | 0.054 | 0.043 | 0.022 | 0.020 | 0.004 | 0.005 | 2.50x |
| 100000 | 0.162 | 0.111 | 0.107 | 0.110 | 0.004 | 0.008 | 1.51x |
| 1000000 | 1.583 | 1.161 | 1.129 | 1.129 | 0.004 | 0.005 | 1.40x |

**What it shows.**

- **The crossing is cheap.** An empty module body costs about what an empty
  frame costs. Eight crossings cost a fraction more than one. Dispatching one
  call for each archetype is not a design problem, so a backend can keep its
  loop in JavaScript and hand the module one archetype at a time.
- **The hand-emitted module matches the compiled one.** A module with no
  toolchain is not a slower module.
- **The crossover on node is near ten thousand entities.** Below it the two are
  within the spread. Above it the module wins and holds a lead that does not
  grow with the count.
- **Deno disagrees with node, on the same engine family.** Deno's TypeScript
  body is faster than node's and its module is slower, so the module loses at a
  hundred thousand and at a million. Nothing in the probe explains this. It is
  the same `dist/`, the same module bytes and the same V8 family. Treat every
  crossover claim as engine-specific until this is understood.

**What this probe does not cover.** One kernel only, three loads and three
stores for each row. No branch inside the body. No sparse component. No worker
thread and no parallel schedule. No SIMD in the module. No cold start: the
compile time of the module is outside the measurement.

## Probe 5, the cost of the backing

**Question.** A shared `WebAssembly.Memory` gives a growable
`SharedArrayBuffer`. `allocator.ts` predicts that a WASM-backed world pays the
JavaScriptCore store-path cost that a growable shared buffer pays. Does it?

**Method.** A TypeScript body over 100000 entities. No module runs. Only the
backing changes. One process for each backing.

### node, V8, median ms

| backing | read only | against heap | read and write | against heap |
| --- | --- | --- | --- | --- |
| heap | 0.630 | 1.00x | 0.211 | 1.00x |
| shared | 0.633 | 1.00x | 0.211 | 1.00x |
| fixed shared | 0.635 | 1.01x | 0.211 | 1.00x |
| wasm | 0.633 | 1.00x | 0.211 | 1.00x |

### deno, V8, median ms

| backing | read only | against heap | read and write | against heap |
| --- | --- | --- | --- | --- |
| heap | 0.662 | 1.00x | 0.188 | 1.00x |
| shared | 0.658 | 0.99x | 0.178 | 0.95x |
| fixed shared | 0.658 | 0.99x | 0.184 | 0.98x |
| wasm | 0.658 | 0.99x | 0.186 | 0.99x |

### bun, JavaScriptCore, median ms

| backing | read only | against heap | read and write | against heap |
| --- | --- | --- | --- | --- |
| heap | 0.229 | 1.00x | 0.159 | 1.00x |
| shared | 0.228 | 1.00x | 0.602 | 3.79x |
| fixed shared | 0.229 | 1.00x | 0.156 | 0.98x |
| wasm | 0.237 | 1.03x | 0.159 | 1.00x |

**What it shows.** The prediction in `allocator.ts` is wrong, in the direction
that helps. JavaScriptCore does charge for a write through a view over a
growable `SharedArrayBuffer`, and the read is free, exactly as the README
reports. A shared `WebAssembly.Memory` does **not** pay it. Its buffer has a
fixed length that a grow replaces with a new object, so the fast store path
survives. A WASM-backed world on JavaScriptCore costs what the heap profile
costs.

The comment in `wasmMemoryAllocator` that says the WASM backing "should thus
pay the column-write cost" and that this "is not measured" is now measured, and
it should be corrected.

**What this probe does not cover.** One entity count, one kernel, one column
type. No Safari, which is the other JavaScriptCore host. No worker thread.

## Probe 6, a wasm kernel on the engine's own pool

**A `wasm` kernel is correct on the shipped pool, and it is the larger of the
two wins.** On the heavy body the module lane beats the sequential `fn` before
a second worker exists, and the split then multiplies that lead. On the cheap
body the module lane is worth about half again over the `js` kernel, at every
worker count. The whole pool is a loss at ten thousand rows.

**Question.** `p24-par-engine` measured the `js` kernel on `ecs.workers.attach`.
The `wasm` kernel form has tests and no measurement. Does it leave the same
state, and what does it buy against the `js` kernel and against the sequential
body?

**Method.** `node bench/foundations/p25-wasm-engine.mjs`. One process for each
size. The world comes from `dist/`. Everything between the frame and the rows is
engine code: the dispatch, the plan, the control buffer, the shipped worker
entry, the descriptor walk and the join stamp. The probe calls `ecs.update()`
and supplies the kernels.

The world is deterministic and every column is `i32`, because `stateHash`
refuses a float column. The backing is `wasm`, because a worker imports the
world's memory as `env.memory` and a `SharedArrayBuffer` cannot be a module
memory. Four archetypes hold `Pos` and `Vel`, and the query excludes the fourth
by a tag. So a split crosses an archetype boundary, and one archetype must stay
untouched. The columns are seeded from the row index.

Four lanes for each body. The sequential `fn` runs with no pool attached. The
`js` kernel is a module URL the worker imports. The `wasm` kernel is emitted by
`wasm/emit.mjs`, so it depends on no toolchain. The fourth lane is the same
kernel written in Zig, built in one try with `--import-memory --shared-memory`
and `--export=__heap_base`. The store base sits above that heap base, so the
module owns no store byte.

Two bodies. The light one is `pos += vel * dt` over four columns. The heavy one
is a hash mix. Each of four unrolled rounds runs a multiply, a shift, an xor and
a branch. The branch is taken for about half the rows.

Each lane restores the seeded bytes, runs three frames, and reports
`snapshots.stateHash()`. It then times one frame with the pool already
attached, median of fifteen samples after three warmups.

Every lane also runs with no engine around it, over four flat columns in a
memory the world never sees. A pooled number holds the kernel and the crossing
together. That lane holds the kernel alone, so the reader can subtract one from
the other.

### Correctness

**130 lane comparisons, 0 disagreements, 0 lanes that touched an excluded row.**

Twenty six lanes run for each of three sizes on node. Twenty six more run on
deno and on bun, at the smallest size. Every lane runs at one, two, four and
eight workers. Each leaves the `stateHash` the sequential `fn` leaves. The rows
of the excluded archetype keep their seeded values in every lane.

The state hash alone does not prove the exclusion. Every lane resolves the same
mask, so a shared misread would agree with itself. The probe folds the excluded
rows separately and compares that fold against the seed.

Two mutants say the oracles hold. Removing `.not(Frozen)` from the query
makes every lane report a touched excluded row. Turning the emitted kernel's
loop bound from `>=` into `>` runs one row past each range. That makes the hash
disagree at two, four and eight workers.

### Speed, node, milliseconds for one frame, pool already attached

| entities | body | lane | sequential `fn` | 1 | 2 | 4 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | light | js kernel | 0.0168 | 0.0197 | 0.0320 | 0.0708 | 0.0769 |
| 10,000 | light | wasm, emitted | 0.0168 | 0.0319 | 0.0198 | 0.0375 | 0.0567 |
| 10,000 | light | wasm, zig | 0.0168 | 0.0320 | 0.0219 | 0.0362 | 0.0568 |
| 10,000 | heavy | js kernel | 0.2057 | 0.2052 | 0.1334 | 0.1043 | 0.1140 |
| 10,000 | heavy | wasm, emitted | 0.2057 | 0.1621 | 0.1101 | 0.0940 | 0.1004 |
| 10,000 | heavy | wasm, zig | 0.2057 | 0.0443 | 0.0423 | 0.0497 | 0.0624 |
| 100,000 | light | js kernel | 0.1003 | 0.1103 | 0.0824 | 0.0883 | 0.1108 |
| 100,000 | light | wasm, emitted | 0.1003 | 0.0753 | 0.0632 | 0.0589 | 0.0732 |
| 100,000 | light | wasm, zig | 0.1003 | 0.0728 | 0.0638 | 0.0635 | 0.0738 |
| 100,000 | heavy | js kernel | 2.0052 | 1.9676 | 1.0315 | 0.5536 | 0.4384 |
| 100,000 | heavy | wasm, emitted | 2.0052 | 1.5095 | 0.8067 | 0.4384 | 0.3544 |
| 100,000 | heavy | wasm, zig | 2.0052 | 0.3091 | 0.1847 | 0.1402 | 0.1350 |
| 1,000,000 | light | js kernel | 0.9541 | 0.9697 | 0.5329 | 0.3067 | 0.3050 |
| 1,000,000 | light | wasm, emitted | 0.9541 | 0.6490 | 0.3656 | 0.2242 | 0.2063 |
| 1,000,000 | light | wasm, zig | 0.9541 | 0.6549 | 0.3771 | 0.2240 | 0.2051 |
| 1,000,000 | heavy | js kernel | 19.8008 | 19.3714 | 9.9540 | 5.0715 | 3.8939 |
| 1,000,000 | heavy | wasm, emitted | 19.8008 | 14.9973 | 7.6288 | 3.8975 | 2.8501 |
| 1,000,000 | heavy | wasm, zig | 19.8008 | 2.9827 | 1.5705 | 0.8308 | 0.7240 |

The best gain against the sequential `fn` on node is the Zig lane at eight
workers, over a million rows. It reaches 4.65x on the light body and 27.35x on
the heavy one. At ten thousand rows the light body has no winning lane at all.

### The kernels alone, one pass, no engine and no pool, node

| rows | body | js kernel | wasm, emitted | wasm, zig | zig against js |
| --- | --- | --- | --- | --- | --- |
| 10,000 | light | 0.0122 | 0.0079 | 0.0082 | 1.49x |
| 10,000 | heavy | 0.2578 | 0.2003 | 0.0394 | 6.54x |
| 100,000 | light | 0.1244 | 0.0821 | 0.0820 | 1.52x |
| 100,000 | heavy | 2.6615 | 2.1650 | 0.3950 | 6.74x |
| 1,000,000 | light | 1.2493 | 0.8523 | 0.8319 | 1.50x |
| 1,000,000 | heavy | 26.6156 | 23.1591 | 3.9537 | 6.73x |

### The other runtimes, ten thousand entities

Both ran the whole probe. The pool attached, all three kernel lanes loaded, and
every lane agreed with the sequential `fn`.

| runtime | body | best lane | against the sequential `fn` |
| --- | --- | --- | --- |
| node | light | none | 0.85x, every pooled lane loses |
| node | heavy | wasm, zig at one worker | 4.65x |
| deno | light | none | 0.56x, every pooled lane loses |
| deno | heavy | wasm, zig at two workers | 3.94x |
| bun | light | wasm, zig at two workers | 1.26x |
| bun | heavy | wasm, zig at two workers | 4.65x |

Deno's kernels-alone table disagrees with node's on the light body. Deno runs
the `js` kernel over ten thousand rows in 0.0405, and node runs it in 0.0122.
The two module lanes match each other. That is the same V8 family, the same
`dist/` and the same module bytes. The crossing probe reported an unexplained
deno difference as well.

### What it shows

- **The `wasm` kernel form is correct on the shipped pool.** Every worker count
  and every size tested leaves the state hash the sequential body leaves. Three
  runtimes and two engine families agree. The excluded archetype keeps its
  rows.
- **A module beats the `js` kernel on both bodies at every size above ten
  thousand rows.** On the light body the gain is about half again, and it holds
  from one worker to eight. The light body is memory bound, so the module wins
  the loop and not the memory system.
- **On the heavy body the kernel matters more than the split.** The Zig lane at
  one worker beats the sequential body by more than six times. That holds at a
  hundred thousand rows and at a million. Eight workers then take it to about
  twenty seven times. A caller with a compute-bound body gets more from
  compiling the body than from adding workers, and the two multiply.
- **The gap between the two module lanes is in the kernel, not in the
  crossing.** The two modules are within the spread on the light body. On the
  heavy body the Zig module is about six and a half times the emitted one. The
  kernels-alone table shows that same ratio with no engine around it. So the
  emitter is not a slow path into the pool. It writes a slow branch.
- **A toolchain-free module is a real option for a simple body.** The emitted
  module matches Zig on the light body, at every size. The crossing probe found
  the same for the sequential seam.
- **The pool still loses on a cheap body in a small world.** At ten thousand
  rows every pooled lane loses to the sequential `fn` on node and on deno. The
  barrier costs more than the rows. `minRows` is the control for that, and it
  stays a value the caller measures.
- **Eight workers stops paying before the core count.** The light body gains
  almost nothing from four workers to eight at a million rows, on any lane.

### What this probe does not cover

- One column type. Every column is `i32`, because the state hash needs an
  integer world. No `f32` lane, so no rounding comparison between the module and
  the TypeScript body.
- One column count and one archetype shape. Four columns, four archetypes, one
  excluded.
- No SIMD in either module, and no threads inside a module.
- Cold start. The module compiles before the timing, and `workers.attach` runs
  before it. Neither the compile nor the attach is measured.
- One `minRows`, pinned at one, so every pooled lane dispatches. The probe
  never measures where the engine's own threshold should sit.
- The state hash covers live rows. A kernel that writes one row past the end of
  an archetype is invisible at one worker. That is why the mutant above fails
  only from two workers up.
- No browser host, no SpiderMonkey, and deno and bun run the smallest size only.
- The join stamp is not measured apart from the frame that contains it.

---

## Browser reader. `store_reader.wasm` reads a live store in three browsers

**Question.** `store_reader.wasm` is the checked-in module the vitest suite
drives against a wasm-backed world. It had never run in a browser. Does a
browser's WebAssembly engine read the store the way node's does?

**Method.** `bench/foundations/browser/` holds the harness, and `page.js` runs
this case on the page's main thread, because the reader needs no worker.
`drive.mjs` starts chromium, firefox and webkit through Playwright. The page
fetches the module from `src/core/ecs/__tests__/fixtures/store_reader.wasm` and
instantiates it against the world's own `WebAssembly.Memory`.

`walk.js` is the same descriptor walk in JavaScript, and it takes its ABI
constants from `par/view.mjs`, because a probe must not import `src/`. The world
is the one `wasm_store_reader.test.ts` builds: three archetypes, position and
velocity, position alone, and position, velocity and a third component. The
masks differ, so a reader that ignores the descriptor and walks every column
gets a different answer. The page checks that shape before it compares anything.

The page learns the header offset from `subscribeLayout` and assumes no value
for it.

| check | chromium 153.0.8010.12 | firefox 155.0 | webkit 26.6 | Safari 18.5 |
| --- | --- | --- | --- | --- |
| the header offset the world publishes | 65536 | 65536 | 65536 | not run |
| archetypes that hold columns, and both mask shapes present | 3, yes | 3, yes | 3, yes | not run |
| `walk`, the module against the page | 509280631, equal | 509280631, equal | 509280631, equal | not run |
| `fnv1a` over the range the header claims | 2085181029, equal | 2085181029, equal | 2085181029, equal | not run |
| `step`, rows the module reports against the page | 80, equal | 80, equal | 80, equal | not run |
| the f32 columns after the step, module against page | equal | equal | equal | not run |
| `step_i32`, rows the module reports against the page | 80, equal | 80, equal | 80, equal | not run |
| `stateHash` after the integer step, module world against page world | equal | equal | equal | not run |

**What it shows.**

- A browser's WebAssembly engine folds the descriptor region to the value the
  page folds. The offsets baked into the module and the offsets the store writes
  agree in a browser.
- The byte digest over the range the header claims agrees, so the module reads
  the same range the header describes.
- The f32 step leaves the columns the page's own rounded body leaves, on three
  engines. The page rounds every operation with `Math.fround` and does not lean
  on an engine folding the arithmetic to f32 by itself.
- Two of the three archetypes hold both components, and both the module and the
  page report eighty rows. A reader that skipped the mask test would report
  every row.
- The integer twin leaves the same `snapshots.stateHash()` on both sides, so the
  agreement is about the world and not only about the bytes around it.
- The header sits above address 0 on the wasm backing, in a browser as in node,
  and every offset the reader adds is measured from it.

**What it does not cover.**

- **No cached-address lane.** The vitest suite drives `step_cached` across a grow
  and shows the module writing into an abandoned block. That lane is not in the
  browser harness, so nothing here says what a browser does with an address held
  across a relocation.
- **No Safari, no mobile browser and no Windows browser.** `safaridriver` needs a
  privileged enable step, so Safari proper is not run. WebKit and Safari share an
  engine and not a release train.
- **One module.** `store_reader.wasm` only. The emitted kernel module runs in the
  worker lane of the parallel matrix, and no toolchain-built module runs in a
  browser here.
- **One world shape, one column capacity and one row count.**
- **No timing.** The harness compares values and measures nothing.
- **No growth lane inside the browser.** The store never grows during this case.

## Probe 7, one shadow stack under several instances

**Every worker of the pool shared one shadow stack, and a kernel that spilled
anything read back another worker's frame.** The corruption is total on the
first run and it needs no shared column. Giving each instance its own region
removes it, and the region lane is also the faster of the two, because the
shared stack puts every worker on one cache line.

**Question.** Probe 6 ran a `wasm` kernel on the shipped pool and every lane
agreed with the sequential body. Its kernels hold every value in a wasm local,
so no frame ever reaches memory. What happens to a kernel that spills?

**Method.** `node bench/foundations/p25-wasm-stack.mjs`. One Zig module, built
with `--export=__heap_base --export=__stack_pointer`. Two bodies. `stack_i32`
fills a scratch array for each row, then gathers from it with an index the
scratch itself decides, so no compiler folds the array into registers.
`table_i32` reads a constant table out of the module's data segment and spills
nothing, and it is the control.

Three lanes. The **shared** lane starts workers that leave `__stack_pointer`
where the link put it. The **private** lane gives each worker the top of its own
slice of `[__heap_base, storeBase)`. Both drive `node:worker_threads` directly
over four flat columns, so neither lane holds any engine code. The **engine**
lane registers the same module and the same export on `ecs.workers.attach` and
compares `snapshots.stateHash()` against the sequential `fn` of the same world.

The reference is the JavaScript twin of the body, run on one thread.

### Runs that disagree with the one-thread reference, node

| body | workers | lane | wrong |
| --- | --- | --- | --- |
| stack | 2 | shared | 5 of 5 |
| stack | 2 | private | 0 of 5 |
| stack | 4 | shared | 5 of 5 |
| stack | 4 | private | 0 of 5 |
| stack | 8 | shared | 5 of 5 |
| stack | 8 | private | 0 of 5 |
| table | 2 | shared | 0 of 5 |
| table | 2 | private | 0 of 5 |
| table | 4 | shared | 0 of 5 |
| table | 4 | private | 0 of 5 |
| table | 8 | shared | 0 of 5 |
| table | 8 | private | 0 of 5 |

### Median milliseconds for one pass, node

| body | workers | shared | private |
| --- | --- | --- | --- |
| stack | 2 | 1.7688 | 0.5957 |
| stack | 4 | 1.4565 | 0.3484 |
| stack | 8 | 3.6275 | 0.3144 |
| table | 2 | 0.0527 | 0.0532 |
| table | 4 | 0.0364 | 0.0267 |
| table | 8 | 0.0657 | 0.0580 |

### The engine lane

Before the fix the shipped pool disagreed with the sequential body at two, four
and eight workers, and each worker count gave a different hash. After the fix
every worker count leaves the hash the sequential body leaves.

### What it shows

- **A shadow stack under several instances is a correctness bug, not a race
  that sometimes fires.** Every run of the shared lane disagrees, at every
  worker count. The instances collide on exactly the same bytes, because every
  copy of `__stack_pointer` starts at the address the linker chose.
- **The fix costs nothing inside a pass.** The assignment happens once for each
  kernel load. The `table` body, which spills nothing, is inside the spread on
  both lanes at every worker count.
- **The shared lane is far slower as well as wrong.** Every worker writes the
  same frame addresses, so the line ping-pongs between cores. That cost grows
  with the worker count while the private lane's falls.
- **A data segment is safe above the store base.** The `table` body agrees on
  both lanes and at every worker count. The segment and the guard word the
  linker places beside it both sit below `__heap_base`, and the store starts
  above that.
- **The Zig layout puts the stack first.** `__stack_pointer` links below
  `__data_end`, and `__heap_base` sits above both. Rust and C through `zig cc`
  land on the same three addresses. So the reserve above `__heap_base` is the
  only span the engine can hand out.

### What this probe does not cover

- Node only. It drives `node:worker_threads` itself, so deno and bun run
  nothing here.
- One module and one compiler. The unit suite runs the same bodies from Zig,
  from Rust, from C and from a hand emitter, and that is where the
  any-toolchain claim is tested.
- One scratch size, one row count and one store base.
- No kernel that overruns its region. A wasm stack has no guard page, so an
  overrun writes into the neighbour's region and nothing reports it. The engine
  cannot size a stack, and this probe does not measure what happens when the
  caller sizes it wrong.
- No module whose `__stack_pointer` is immutable, and none that exports the
  stack pointer without `__heap_base`. Both paths throw, and only the unit suite
  covers them.
- Cold start. The module compiles and the pool attaches before the timing.
