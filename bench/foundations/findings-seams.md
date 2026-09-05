# Seams for worker parallelism and for a language-neutral WASM system

Nothing here was measured. Each statement is marked **tested** (a named test pins it), **read** (read in the source), or **reasoning** (nothing in the tree confirms it). Paths are relative to the repository root. Line numbers describe the tree copied on 2026-09-05.

## Part A. What lives in the bytes, and what lives in JS

**Conclusion.** The buffer carries the layout and the raw data. Every index that turns a query into a set of rows lives in JS on the main thread. A worker or a module can read columns, the entity index and the archetype masks from the bytes alone. It cannot learn which entity occupies a row, which archetypes a query matches, what changed, or what the frame time step is.

| Thing | Home | Owner | Mark |
|---|---|---|---|
| header, `view_stamp` | bytes, at buffer byte 0 | `src/core/store/header.ts` `writeStoreHeader:172`, `readStoreHeader:194`, `bumpViewStamp`. Offsets `src/core/store/vendored_abi/abi.ts:27` | tested, `src/core/store/__tests__/header.test.ts` |
| layout descriptor | bytes, at `header.layout_descriptor_off` | `src/core/store/descriptor.ts:247` | tested, `src/core/store/__tests__/descriptor.test.ts` |
| **live row count, authoritative** | **JS** | `Archetype.length` `src/core/ecs/archetype.ts:231`, `Archetype.enabledCount` `:244` | read |
| **live row count, copy in bytes** | **bytes** | `Store.publishRowCounts` `src/core/ecs/store.ts:1231`. `planLayout` writes zero at `src/core/store/column_store.ts:266`, `:301` | tested, `src/core/ecs/__tests__/unit/store_publish_row_counts.test.ts` |
| column bytes | bytes | `createView` `src/core/store/column_store.ts:210` | tested, `src/core/store/__tests__/extend.test.ts` locks the fixed length across a grow |
| entity index (generation, archetype, row) | bytes, at `header.entity_index_off` | `createEntityIndexViews` `src/core/store/entity_index.ts:153`, views at `:165` to `:167` | tested, `src/core/store/__tests__/entity_index.test.ts` |
| **row to entity id** | **JS** | `Archetype._entityIds` `src/core/ecs/archetype.ts:230`, over a plain heap array (`src/type_primitives/typed_arrays/typed_arrays.ts:72`) | read |
| entity allocator free list | JS | `EntityAllocator._freeIndices: number[]` `src/core/ecs/entity_allocator.ts:39`. Its `generations` view is in the bytes at `:34`, replanted at `:56` | read |
| component ids, names, schemas | JS | the registry on `Store`. The bytes carry only numeric `component_id` and `field_id` per `ColumnDescriptor` | read |
| archetype graph and edges | JS | `src/core/ecs/archetype_graph.ts`, `Archetype._edges` `src/core/ecs/archetype.ts:250` | read |
| query registry, cached archetype lists | JS | `Query._archetypes` `src/core/ecs/query.ts:529`, `_nonEmptyArchetypes` `:538`, `QueryCache` `:146`. `Store._registeredQueries` `src/core/ecs/store.ts:445` | read |
| sparse stores | JS | `SparseComponentStore` heap typed arrays `src/core/ecs/sparse_store.ts:119` to `:133` | read |
| relations and their indexes | JS, on top of sparse stores | `RelationService` `src/core/ecs/relation_service.ts:66`. A relation term resolves to a sparse id, `src/core/ecs/query.ts:320` | read |
| resources | JS | `ResourceRegistry._values: Map<symbol, unknown>` `src/core/ecs/resource_registry.ts:12` | read |
| deferred command buffer | JS | `DeferredCommandBuffer` `src/core/ecs/deferred_commands.ts:61` to `:71`, one per world `src/core/ecs/store.ts:467` | read |
| change tick | JS | `Store.changeTick` `src/core/ecs/store.ts:613`, `advanceChangeTick` `:617` | read |
| row tick plane | JS | `Archetype.rowTicks` `src/core/ecs/archetype.ts:345`, `changedTick` `:412`. Per-component meta `src/core/ecs/store.ts:168` to `:187` | read |
| dirty lists | JS | `Store._dirtyLists` `src/core/ecs/store.ts:743`, reused `_drainResults` `:744` | read |
| observer state | JS | `ObserverRegistry` `src/core/ecs/observer.ts:290` to `:328` | read |
| frame tick | JS | `Store.tick` `src/core/ecs/store.ts:602`. No header field holds it | read |
| delta time | JS | a parameter of `update` and of a system body, `src/core/ecs/schedule.ts:604` | read |
| command ring | bytes, always allocated `src/core/ecs/store.ts:1006` | consumer only, `src/core/ecs/host_commands.ts:695`. No engine producer | read |
| event ring | bytes, always allocated `src/core/ecs/store.ts:1005` | no engine producer and no engine consumer. Events are JS arrays, `src/core/ecs/event.ts:99` | read |
| action ring | bytes, always allocated `src/core/ecs/store.ts:1007` | no engine producer and no engine consumer | read |
| region table, consumer regions | bytes | `src/core/store/region_table.ts`, reached through `Store.regionHandle` `src/core/ecs/store.ts:1196` | tested, `src/core/store/__tests__/region_table.test.ts` |
| sim-bindings block | bytes, only with `bindingsRegionBytes` `src/core/ecs/ecs.ts:194` | reserved and zeroed `src/core/store/column_store.ts:561`. No engine writer, no accessor | read |

### Where a reader learns the current row count

- The truth is two JS numbers, `Archetype.length` and `Archetype.enabledCount`. **read**
- `Store.publishRowCounts` copies both into the descriptor, walking the region in lockstep with `_archGraph.archetypes`. A dev guard throws on order drift at `src/core/ecs/store.ts:1245`. **read**
- Gated by `_rowCountsDirty` `src/core/ecs/store.ts:751`. Five mutation paths set it. **read**
- Refreshed twice per frame. Tick start `src/core/ecs/ecs.ts:1609`. Each phase flush `src/core/ecs/system_context.ts:662`. **read**
- Untested risk: an immediate mutation inside a system body leaves the descriptor stale for a backend later in the same phase. **reasoning**
- `src/core/store/grow.ts:17` still says no live code writes `row_count`. Stale comment. **read**

## Part B. The byte-0 assumption and memory ownership

**Conclusion.** The store owns byte 0 of whatever buffer it gets. A caller who hands over a module's exported memory loses that module's data segment and shadow stack. A nonzero base is a contained change, because almost every read already goes through one `DataView` whose start is the header.

### Sites that assume byte 0

| Site | Assumption | Mark |
|---|---|---|
| `src/core/store/column_store.ts:537` | `new DataView(buffer)` with no offset. The base for every later header read | read |
| `src/core/store/column_store.ts:486` | `cursor = STORE_HEADER_BYTES`, first region at absolute byte 52 | read |
| `src/core/store/header.ts:172`, `:194` | index `STORE_HEADER_OFFSETS` off the view start | read |
| `src/core/store/snapshot.ts:60` | `new Uint8Array(store.buffer, 0, capacity)`, a hard zero | read |
| `src/core/store/snapshot.ts:112` to `:115` | restore sizes to `bytes.byteLength` and rebuilds the view at zero | read |
| `src/core/store/state_hash.ts:87` | hashes `columnStoreBytesView`, inherits the zero | read |
| `src/core/store/layout_ops.ts:121` | `new DataView(grownBuffer)` after an in-place grow | read |
| `src/core/store/layout_ops.ts:150` | `tailCursorBytes` treats `capacity` or `byteLength` as the absolute tail | read |
| `src/core/store/layout_ops.ts:207`, `:209` | bindings size as `descriptorOff - bindingsOff`, both absolute | read |
| `src/core/store/grow.ts:201` to `:204`, `src/core/store/extend.ts:321` to `:326` | write `view_stamp`, `capacity`, `archetype_count` off the view start | read |
| `src/core/store/region_table.ts:100`, `:179`, `:190`, `:206` | read the table offsets off the same view | read |
| `src/core/store/descriptor.ts:112` | `byteOff` documented as measured from byte 0 | read |
| `src/core/ecs/store.ts:1147`, `:1234` | read `entity_index_off` and `layout_descriptor_off` off `_columnStore.view` | read |
| `src/core/ecs/ecs.ts:553`, `:626` | `setLayout(0)` | read |
| `src/core/ecs/resume.ts:266` | header at the blob start | read |
| `src/core/store/allocator.ts` every arm | `alloc(bytes)` sizes the whole store from zero | read |
| `src/core/store/store_regions.ts:26` | region rule stated as `STORE_HEADER_BYTES + Σ(prior)` | read |

### What a `storeBase` option costs

All **reasoning**. No prototype exists.

- `column_store.ts`. Small. `cursor = base + STORE_HEADER_BYTES`, base view as `new DataView(buffer, base)`. `createView` unchanged, it already takes an absolute offset.
- `header.ts`, `descriptor.ts`, `entity_index.ts`, `region_table.ts`, every ring. None. All already take an explicit offset.
- `snapshot.ts`. Medium. `columnStoreBytesView` needs the base. Restore should keep the snapshot base free and let the caller pick a base, which makes a snapshot portable between a heap world and a module-hosted world.
- `state_hash.ts`. None once the snapshot view is right.
- `grow.ts`, `extend.ts`, `layout_ops.ts`. Medium. Each reasons about the buffer extent, not the store extent. Each needs `base + capacity` where it now uses `capacity`.
- `allocator.ts`. Medium. Every allocator reserves `base + bytes`. `wasmMemoryAllocator` is the one that matters.
- `ecs.ts`. Small but public. `setLayout(0)` becomes `setLayout(base)` at both sites, which makes the parameter honest.
- `store.ts`, `resume.ts`. Small. Both read through `_columnStore.view`.

### Absolute or store-relative offsets, an open decision

Every `*_off` in the header and every `byte_off` in a column descriptor is absolute today, measured from buffer byte 0. With a nonzero base the two choices trade against each other. **reasoning**

- Absolute offsets keep a module's address arithmetic at `byte_off + row * stride`. A snapshot then carries the base it was taken at, so restore at a different base must rewrite every offset, and two worlds at the same logical state but different bases hash differently.
- Store-relative offsets cost the module one add, `base + byte_off + row * stride`, which a compiler folds into a constant base register. The snapshot, the restore and the state hash stay independent of the base. A heap world and a module-hosted world with the same history then agree on `stateHash`, which is the comparison the determinism tooling exists for.

The snapshot portability named above holds only under the relative choice. The orchestrator's lean is relative. The WASM ownership probe (`findings-wasm.md`) decides how often a nonzero base occurs in practice, which is what the choice turns on.

### The bring-your-own-memory arm today

`WasmMemoryArm` is `src/core/ecs/ecs_memory.ts:89` to `:95`, resolved at `:377` to `:416`.

- It rejects a memory that is not shared at `src/core/ecs/ecs_memory.ts:382`, code `ECS_ERROR.INVALID_MEMORY_OPTIONS`. `wasmMemoryAllocator` repeats the check at `src/core/store/allocator.ts:503`, so a direct allocator caller is covered too. **read**
- What happens today with a module's exported memory: the store writes the header over bytes 0 to 51, then its regions and columns over everything after. The module's data segment and shadow stack sit there. The world overwrites them. The module reads corrupt constants, or traps. Nothing detects this. **reasoning**
- Two further blocks. A module that exports memory cannot have one imported. And most toolchains do not emit `shared: true`, so the guard rejects the memory before the layout question arises. **reasoning**

## Part C. The compute backend seam against a language-neutral contract

**Conclusion.** The seam carries a handle and a header offset. That suffices for a module written against one hand-agreed binding table. It does not suffice for an arbitrary toolchain. Four things are missing from the bytes: row to entity, dt, the frame tick, and any query term that is not a dense mask test.

The seam is `run(handle)` plus `setLayout(headerOff)`, `src/core/ecs/compute_backend.ts:59` to `:70`. Routing is `src/core/ecs/schedule.ts:598` to `:606`, inside the same access span as a TypeScript body. Attach is `src/core/ecs/ecs.ts:647`. **read**

### What exists

| Need | In the bytes | Where |
|---|---|---|
| header offset | yes, but always the constant zero | `src/core/ecs/ecs.ts:553`, `:626` |
| column by `(component_id, field_id)` | yes, sequential walk | `src/core/store/descriptor.ts:259` |
| element width and stride | yes | `src/core/store/vendored_abi/abi.ts:51` |
| row count and enabled count | yes, subject to the publish points | `src/core/ecs/store.ts:1231` |
| dense component mask | yes, four `u32` words at descriptor offset 4 | `src/core/store/vendored_abi/abi.ts:60` |
| entity to archetype and row | yes | `src/core/store/entity_index.ts:153` |
| a slot for structural intent | yes | `src/core/store/command_ring.ts` |
| a JS drain for that slot | yes, opt in | `src/core/ecs/host_commands.ts:695` |

### What is missing

| Missing | Why it blocks | Mark |
|---|---|---|
| row to entity id | a JS heap array, `src/core/ecs/archetype.ts:230`. A module cannot name the entity it found | read |
| delta time | not a header field and not a region | read |
| frame tick | `Store.tick` is a JS number, `src/core/ecs/store.ts:602` | read |
| sparse terms | JS heap, `src/core/ecs/sparse_store.ts:119` | read |
| relation terms | resolve to a sparse id, `src/core/ecs/query.ts:320` | read |
| changed filters | the row tick plane is JS heap, `src/core/ecs/archetype.ts:345` | read |
| a written contract | `ecs.fieldId` `src/core/ecs/ecs.ts:1757` returns the pairs out of band. The sim-bindings block exists to hold them, but no engine code writes it and no accessor exposes its offset | read |
| a stable header offset | `setLayout(0)` hard codes zero | read |

**Does the archetype mask suffice for a with-only query?** Yes, and for a with-and-without query too. Both are bit tests on the four mask words, and `enabled_count` gives the bound. A dense query with no sparse term, no relation term and no changed filter is fully resolvable from the bytes. **read**

**Reporting structural intent.** The command ring is the right shape and is allocated on every world. Slots are 16 bytes, one `u8` opcode and 15 payload bytes. The engine never interprets an opcode. Fixed-slot codecs cover `set_field`, `despawn`, `disable`, `enable` and `remove_component`. `spawn` and `add_component` are variable width and stay on the typed queue. Two gaps: the ring has no engine-side producer, so a module writes it against a layout no test exercises, and a module cannot name an entity from a row. **read**

**What must not enter the contract.** Allocators, `__heap_base`, `__stack_pointer`, a language runtime, garbage collection roots, exception tables, and any convention about where a module's own data lives. The `storeBase` option is the change that keeps these out. **reasoning**

## Part D. What a parallel scheduler must partition

**Conclusion.** The world holds one of everything a running system touches. One change tick, one command buffer, one context, one observer scratch, one flush. Three further pieces are process global, not even per world. The declarations support a conflict graph over component and resource state. They do not cover events.

| State | Owner | Grain | What breaks |
|---|---|---|---|
| change tick | `Store.changeTick` `src/core/ecs/store.ts:613`, `:617` | per world, advanced per system run | a non-atomic read-modify-write. The tick is ordinal, and `lastRunTick` assumes a total order that concurrency destroys |
| advance sites | `src/core/ecs/schedule.ts:593` per system, `:614` per flush, `src/core/ecs/ecs.ts:1639` at settle, `:1658` for the host window | per run and per frame | the per-system advance is what separates one system's stamps from another's |
| row tick plane | `Archetype.rowTicks` `src/core/ecs/archetype.ts:345`, meta `src/core/ecs/store.ts:168` to `:187` | per archetype, per component | concurrent stamps to one row |
| dirty lists | `Store._dirtyLists` `src/core/ecs/store.ts:743`, push in `noteSet` `:2870` and `noteSetEntity` `:2889` | per world | `list.push` is not safe across workers. The `t[row] <= drainTick` dedup races. `_drainResults` `:744` are reused objects shared between consumers by design |
| deferred command buffer | `DeferredCommandBuffer` `src/core/ecs/deferred_commands.ts:61` to `:71`, `_flushing` `:77` | per world, appended per command, drained per phase | six plain arrays with `push`. The append order is the transaction. `_flushing` is one boolean, so a second flush silently no-ops |
| drain order | adds and removes, then destroys, then toggles, `src/core/ecs/deferred_commands.ts:194` to `:207` | per flush | the order is the semantics. A partitioned buffer must merge deterministically |
| single `SystemContext` | `ECS._ctx` `src/core/ecs/ecs.ts:422`, built `:579` | per world | `ctx.lastRunTick` `src/core/ecs/system_context.ts:255` is written per system at `src/core/ecs/schedule.ts:592`. Two systems read each other's baseline. There is no `dt` field and no current-system field |
| observer dispatch and cascade | `ObserverRegistry` `src/core/ecs/observer.ts:290`. Scratch `_radixOut` `:316`, `_addBuckets` `:305`. Shared `Store._obsEvents` `src/core/ecs/store.ts:651`, reset per round `src/core/ecs/deferred_commands.ts:190` | per world | every buffer is a reused singleton. `_fireEach` sorts into `_radixOut` in place. `nextObserverId` `src/core/ecs/observer.ts:189` is module global |
| run conditions | `src/core/ecs/run_condition.ts:61`, evaluated `src/core/ecs/schedule.ts:644` | per phase, memoized per set at `:568` | pure by contract, unenforced. A set verdict is computed once and shared |
| `lastRunTick` slots | `Schedule._lastRunTicks` `src/core/ecs/schedule.ts:225`, read `:592`, written `:608` | per system, per schedule | the array partitions cleanly. The hazard is the value, a stamp from the global counter |
| frame trace sink | `Store.trace` `src/core/ecs/store.ts:627`. `FrameTraceRecorder._current` `src/core/ecs/frame_trace.ts:141`. `dispatchTrace` singleton `src/core/ecs/dispatch_trace.ts:241` | per world, and one process global | interleaved spans destroy causality. Dev only |
| access checker | `AccessCheck` `src/core/ecs/access_check.ts:228`, **module singleton at `:463`** | one active span, process wide | `enter` is a plain overwrite with no stack. `ecs.ts:885` states the slot is process global. Two concurrent spans clobber each other |
| structural change beside iteration | `removeRow` `src/core/ecs/archetype.ts:1076`, `swapRemoveRow` `:1494` (no iteration guard), `_syncRowPlane` `:604`, `refreshViews` `:892`, `Store._growHandler` `src/core/ecs/store.ts:800` | per world | a swap remove moves a row under a reader. A grow reallocs the buffer and re-points every view on the main thread. `iterDepth` `src/core/ecs/archetype.ts:269` is per archetype and dev only |
| query caches | `Query._lastSeenEpoch` `src/core/ecs/query.ts:545`, `_nonEmptyArchetypes` `:538`, rebuilt `:1452` | per query, across runs | check then swap. `_rebuildNonEmpty` allocates fresh rather than truncating, which helps, but a lane holding the old array walks a stale snapshot |
| **`iterAllRows`** | **module global, `src/core/ecs/archetype.ts:1921`** | process wide, not dev gated | it flips the meaning of `Archetype.entityCount` `:953`. One lane running an `includeDisabled` query makes another lane walk disabled rows. A production correctness break |
| entity allocator | `EntityAllocator._freeIndices` `src/core/ecs/entity_allocator.ts:39`, `lastIndex` `:46`, `alloc` `:83` | per world, per spawn | `pop` plus `_aliveCount++` with no synchronisation. `lastIndex` is a single out-param read right after the call. This is the strongest argument for keeping structural work on a serial flush |

### Are the declarations enough for a conflict graph?

The fields are on `SystemAccessConfig` `src/core/ecs/system.ts:83`, which `SystemConfig` extends at `:143`.

| Line | Field |
|---|---|
| 85 | `reads` (required) |
| 87 | `writes` (required) |
| 91 | `spawns` |
| 97 | `despawns` |
| 99 | `transitions` |
| 101 | `resourceReads` |
| 103 | `resourceWrites` |
| 118 | `sparseReads` |
| 121 | `sparseWrites` |
| 124 | `relationReads` |
| 127 | `relationWrites` |

Write implies read uniformly, folded at `src/core/ecs/access_check.ts:76`, `:119`, `:132`, `:144`. A conflict graph over component and resource state is computable today. **read**

**Not covered**, each **read** unless marked:

- **Events.** `ctx.emit` `src/core/ecs/system_context.ts:684` and `readEvents` `:709` call no assertion. No event field exists. Two emitters on one channel corrupt the SoA columns and the shared dirty list, and the graph cannot see it. This is the largest gap, because events carry a strict ordering guarantee with no declaration to derive it from.
- **The event reader aliases live state.** `src/core/ecs/event.ts:103`, and `:118` says the `readonly` is advisory.
- **`ctx.flush()`** `src/core/ecs/system_context.ts:659`. Any system forces a world-wide structural barrier with no term.
- **The relations facade.** `src/core/ecs/facades.ts:82` and `:89` write relations with no check, while the `ctx` twins at `src/core/ecs/system_context.ts:609` and `:616` do check. An inconsistency, not a deliberate hole.
- **Resource reads hand out the live object.** `src/core/ecs/resource_registry.ts:25`. So `resourceReads` is not a read-only guarantee.
- **Column reads hand out the live buffer.** `src/core/ecs/archetype.ts:1165`, documented at `:1158`.
- **`exclusive`.** `src/core/ecs/access_check.ts:247`. Declares nothing, granted everything. The scheduler never reads the flag, so it grants no slot today. The host apply system uses it with empty declarations at `src/core/ecs/host_commands.ts:677`.
- **The backend body.** `backendHandle` `src/core/ecs/system.ts:190`. The declaration is asserted to authorise what the backend touches. Nothing verifies it.
- **Plugin facades.** `ECS._pluginHost` `src/core/ecs/ecs.ts:401` hands a plugin the store, the world and the context.
- **Closures.** `SystemFn` is `(ctx, dt) => void`. `queries` `src/core/ecs/system.ts:163` is the partial mitigation and it is optional. **reasoning**
- **Cross-world mutation.** `_assertOutsideSystem` `src/core/ecs/ecs.ts:888` scopes to one world by design, so a system of world A mutating world B is unguarded.

### Tests that pin order and flush timing

- `src/core/ecs/__tests__/integration/schedule.test.ts:47`, `:65`, phase order for startup and update. **tested**
- `src/core/ecs/__tests__/integration/schedule.test.ts:137`, insertion order breaks a tie. **tested**
- `src/core/ecs/__tests__/unit/frame_trace.test.ts:255`, the interleaved `flush_end` and `phase_boundary` stream across all three update phases. Order and flush structure in one assertion. **tested**
- `src/core/ecs/__tests__/integration/schedule.test.ts:380`, a despawn deferred in one phase reads dead in the next. The direct phase-boundary pin. **tested**
- `src/core/ecs/__tests__/integration/commands.test.ts:9`, `:40`, `:64`, deferred ops apply at the flush. **tested**
- `src/core/ecs/__tests__/breakage/deferred_ordering.test.ts:94`, adds and removes settle before destroys. **tested**

Gap: nothing pins the order of `ctx.advanceChangeTick()` `src/core/ecs/schedule.ts:614` against `ctx.flush()` `:616`, except through the change-detection suites.

## Part E. Re-verification of the prior analysis

| Claim | Verdict | Current location |
|---|---|---|
| `system.ts` declares the eleven access fields, 85 to 127 | corrected in one detail | the fields are on `SystemAccessConfig` `src/core/ecs/system.ts:83`, not on `SystemConfig`, which extends it at `:143`. The span is right. Only `reads` and `writes` are required |
| `schedule.ts` sorts topologically, ties by insertion order, near 766 | corrected | `src/core/ecs/schedule.ts:775` builds the tiebreaker, `:781` calls `topologicalSort`. Kahn with a binary heap, `src/type_primitives/topological_sort/topological_sort.ts:31` |
| `entity_index.ts` exposes the three tables as typed views over the store buffer, near 153 | confirmed, with a qualification | `src/core/store/entity_index.ts:153`, views `:165` to `:167`. The parameter is `ArrayBufferLike` at `:154`, so under the heap profile it is a plain `ArrayBuffer` |
| the phase runner is sequential, near 569 | confirmed, corrected line | `src/core/ecs/schedule.ts:550`, loop `:577`, dispatch `:603`. No worker, promise or await in the file |
| change tick advances per system and per flush, 585 and 606 | corrected | `:593` and `:614`. Two more advances exist, `src/core/ecs/ecs.ts:1639` and `:1658` |
| dirty lists are plain arrays, `store.ts:743` | confirmed | `src/core/ecs/store.ts:743` |
| a write pushes to them, `store.ts:2889` | corrected | `:2889` is the `ctx.markChanged` path. The primary write path is `noteSet` `:2857`, pushing at `:2870`. The push is conditional and flips to a scan past a list cap |
| one command buffer per world, `store.ts:467` | confirmed | `src/core/ecs/store.ts:467` |
| one `SystemContext` per world, `ecs.ts:526` | corrected | declared `src/core/ecs/ecs.ts:422`, built `:579`. Substance holds |
| observer cascade assumes a single drain, `deferred_commands.ts:184` | corrected | `:184` is the non-convergence throw. The single-drain assumption is `_flushing` `:77`, checked `:126` and `:152`, set `:159`, cleared `:218`. The shared scratch is one instance at `:160` |
| `stateHash` on the facade, `facades.ts:298` | confirmed, with a qualification | `src/core/ecs/facades.ts:298`, on class `ECSSnapshots`, so the call is `ecs.snapshots.stateHash()`. It throws `DETERMINISM_DISABLED` unless the world was built with `deterministic: true` |
| `exclusive` bypasses the access check, `access_check.ts:238`, `system.ts:477` | confirmed, with detail | `:238` declares the flag, `:243` sets it, `:247` is the bypass, and twelve assertions early-return on a null set. `system.ts:477` is a different thing, the registration-time skip of the query-declaration lint. `exclusive` does not change scheduling. `grep exclusive src/core/ecs/schedule.ts` finds nothing. It does not bypass `assertOptionalFetch` `:405` |
| the wasm backing rejects a memory that is not shared | confirmed | `src/core/ecs/ecs_memory.ts:382`, `ECS_ERROR.INVALID_MEMORY_OPTIONS`. Repeated at `src/core/store/allocator.ts:503` |
| the golden layout fixture exists and compares TS against a TS capture only | confirmed | `src/core/store/__tests__/layout_golden.json`, test `layout_golden.test.ts:24`, runner `layout_scenarios.ts:227`. Captured from an earlier TypeScript implementation. No regen script and no environment flag. The `wasm_memory` strategy uses a real shared `WebAssembly.Memory` as an allocator only, so no module reads the layout back |
| `header.ts` says a transposed field is impossible, `abi.ts` says the snapshot is hand maintained | confirmed | `src/core/store/header.ts:85` to `:88` against `src/core/store/vendored_abi/abi.ts:4` to `:9` and `:17` to `:20`. `header.ts` imports the constants from the file that calls them hand copied with unverified provenance. `SIM_ABI_VERSION` is the sentinel `0` at `abi.ts:23`, so version detection is inert |

## Where the code contradicts the docs or itself

- `header.ts:85` claims Zig-generated constants. `vendored_abi/abi.ts:4` calls the same constants hand copied with unverified provenance. `header.ts` imports from that file.
- `grow.ts:17` says no live code writes `row_count`. `publishRowCounts` writes it.
- `docs/api/parallel.md` says a heap world cannot use a WASM compute backend. No code enforces that. `attachBackend` has no backing guard.
- `facades.ts:82` and `:89` perform relation writes with no access check, while the `ctx` equivalents check.
- `resourceReads` is not a read-only guarantee. `resource_registry.ts:25` hands back the live object.

## Untested areas

- No test covers a stale descriptor `row_count` seen by a backend inside a phase.
- No test covers a store at a nonzero base, because the option does not exist.
- No test drives a real module against the layout. Every layout test is TypeScript against TypeScript.
- No test drives the event ring or the action ring. Both are allocated on every world and neither has an engine producer or consumer.
- No test covers two systems running at once, because the scheduler cannot do it.
- No test covers `iterAllRows` under two concurrent readers, and the flag is not dev gated.
