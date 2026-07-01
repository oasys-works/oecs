# oecs Architecture (v0.4)

This document describes how oecs is built: the two-layer split between the archetype ECS and the backing-neutral column store, the data layout that entities, components, and archetypes settle into, how queries stay correct as archetypes appear, how the scheduler and update loop drive systems, and the determinism, observer, relation, and host-integration machinery layered on top.

The emphasis is *how it's built*, not *how to use it*. For usage, see the API docs in [`docs/api/`](./api/) — one page per subsystem, indexed by [`api/index.md`](./api/index.md).

Every non-trivial claim is tagged with a `file:line` reference so it can be checked against source. **Paths are relative to `src/`** — e.g. `core/ecs/ecs.ts:1484`, `core/store/state_hash.ts:51`. Line numbers drift as the source changes; the surrounding symbol name is the durable anchor.

## Table of contents

1. [Overview](#1-overview)
2. [The storage substrate: `ColumnStore`](#2-the-storage-substrate-columnstore)
3. [Entities](#3-entities)
4. [Components](#4-components)
5. [Archetypes](#5-archetypes)
6. [The Store](#6-the-store)
7. [Queries](#7-queries)
8. [Change detection](#8-change-detection)
9. [Sparse storage](#9-sparse-storage)
10. [Relations](#10-relations)
11. [Observers](#11-observers)
12. [Events](#12-events)
13. [Resources](#13-resources)
14. [Systems and the scheduler](#14-systems-and-the-scheduler)
15. [The update loop](#15-the-update-loop)
16. [Determinism, snapshot, and replay](#16-determinism-snapshot-and-replay)
17. [The host-write seam](#17-the-host-write-seam)
18. [Memory sizing](#18-memory-sizing)
19. [Tracing](#19-tracing)
20. [The reactive and editor seams](#20-the-reactive-and-editor-seams)
21. [Type primitives](#21-type-primitives)
22. [Dev mode](#22-dev-mode)
23. [Invariants](#23-invariants)

---

## 1. Overview

oecs is an archetype-based ECS built in two layers:

- **The archetype ECS** (`src/core/ecs/`) — entities, components, archetypes, queries, systems, the scheduler, change detection, observers, relations, and the facade. This is what consumer code talks to.
- **The backing-neutral column store** (`src/core/store/`) — a single `ArrayBufferLike` carrying every component column, plus the byte-level machinery for laying it out, growing it, hashing it, snapshotting it, and (optionally) sharing it across threads or with WASM.

The core owns *logic and identity*; the store owns *bytes*. The store never knows what an archetype "means"; the ECS never touches a raw offset except through the store's typed API. Only the allocator arm decides whether those bytes live in a plain `ArrayBuffer` (the default heap profile), a `SharedArrayBuffer`, or a `WebAssembly.Memory` (`core/store/allocator.ts:281, 204, 361`).

The object graph:

```
ECS  (core/ecs/ecs.ts)              — public facade, implements QueryResolver
 ├── Store  (core/ecs/store.ts)     — owns all mutable ECS state
 │     ├── ColumnStore (core/store/column_store.ts) — the one backing buffer + column views
 │     ├── entity slot allocator (generational ids, free list, retirement)
 │     ├── component metadata (per-ComponentID field layout + observer flags)
 │     ├── archetype registry (mask → Archetype), transition-edge cache, inverted index
 │     ├── entity → (ArchetypeID, row) mapping (SAB-backed Int32Array pair)
 │     ├── deferred pending-add/remove/destroy/toggle buffers
 │     ├── sparse component stores + relation stores
 │     ├── EventChannel[] and a resource Map<symbol, unknown>
 │     └── registered live Query result arrays
 ├── Schedule  (core/ecs/schedule.ts)         — 7 phases, per-phase topological sort
 ├── SystemContext  (core/ecs/query.ts)       — the restricted ctx handed to systems
 └── ObserverRegistry  (core/ecs/observer.ts) — onAdd/onRemove/onSet/onEnable/onDisable
```

`ECS` is the only entry point external code talks to (`core/ecs/ecs.ts:203`). Systems receive a `SystemContext` instead of `ECS` (`core/ecs/query.ts:1387`), which routes structural changes through deferred buffers so live iteration stays valid.

- **Entities** are 31-bit packed integers: a 20-bit slot index and an 11-bit generation (`core/ecs/entity.ts:51-55`).
- **Components** are branded, *callable* handles whose field schema is a compile-time phantom (`core/ecs/component.ts:91-94`). They are struct-of-arrays: one typed-array column per field.
- **Archetypes** group every entity with an identical component mask (`core/ecs/archetype.ts:176-178`). Fields live in columns backed by the `ColumnStore` buffer.
- **Queries** resolve include/exclude/anyOf masks to a live `Archetype[]` the store keeps populated as new archetypes appear (`core/ecs/store.ts:4683, 1520`).
- **Change detection** is a per-`(archetype, component)` tick stamp (`core/ecs/archetype.ts:264`) compared against each system's last-run tick.
- **Systems** are plain functions that declare the components they `reads`/`writes`; a dev-mode access checker enforces those declarations.
- **Observers, relations, sparse storage, determinism, and the host-write seam** are additive subsystems layered on the same store.

### Entry points

The package ships several import paths; everything past the core is opt-in and costs nothing until imported (`src/index.ts:16`, `src/primitives.ts`, `src/shared.ts`, `src/extensions/*`).

| Import | Source | What it is |
| --- | --- | --- |
| `@oasys/oecs` | `src/core/ecs` | the ECS — pure-TS heap profile by default |
| `@oasys/oecs/primitives` | `src/primitives.ts` | standalone data structures (`BitSet`, `SparseSet`, …) |
| `@oasys/oecs/shared` | `src/shared.ts` | `SharedArrayBuffer` / WASM allocators (needs COOP/COEP) |
| `@oasys/oecs/reactive` | `src/core/reactive` | zero-dependency reactive kernel |
| `@oasys/oecs/reactive-sync` | `src/extensions/reactive` | ECS → reactive bridge (publishes only dirty) |
| `@oasys/oecs/editor` | `src/extensions/editor` | undo/redo + field handles |
| `@oasys/oecs/solid` | `src/extensions/solid` | SolidJS adapter (`solid-js` optional peer) |

---

## 2. The storage substrate: `ColumnStore`

Source: `src/core/store/`.

A `ColumnStore` is **one backing buffer** carrying every component column, plus a `DataView`, a decoded header, and a map of per-archetype column views (`core/store/column_store.ts:103-114`). The buffer type is `ArrayBufferLike` — deliberately backing-neutral, so the same code drives a heap `ArrayBuffer`, a `SharedArrayBuffer`, or a `WebAssembly.Memory`.

### Buffer layout

The buffer is laid out, in byte order (`core/store/column_store.ts:421-548`):

```
[52-byte header]
[mechanism prefix regions: command-ring, entity-index, event-ring, action-ring]
[region-table directory + consumer regions]
[opaque WASM sim-bindings block]
[layout descriptor region]
[aligned column data]
```

Everything before the descriptor region keeps a **stable byte offset across growth**, which is what lets a WASM sim or worker hold a raw pointer to the entity index and never re-resolve it.

**The header** (52 bytes) is the ABI root. `core/store/__generated__/abi.ts` is the single source of truth for every binary offset: `STORE_MAGIC = 0x314d4953` (ASCII `SIM1`, `abi.ts:12`), `STORE_HEADER_BYTES = 52` (`abi.ts:16`), and 13 `u32` header fields (`abi.ts:17-31`) — magic, ABI version, `view_stamp`, capacity, archetype count, and the offsets of the descriptor region, each ring, the entity index, the region table, and the bindings block. `header.ts` adds the semantic `StoreHeader` interface plus `writeStoreHeader`/`readStoreHeader` (`core/store/header.ts:173, 189`) and `bumpViewStamp` (`core/store/header.ts:210`), the cached-view-invalidation trigger.

**Region order is load-bearing.** The four engine *mechanism* regions (command ring, entity index, event ring, action ring) are declared once, in byte order, by `STORE_PREFIX_REGIONS` (`core/store/store_regions.ts:88-152`); each region's offset is `STORE_HEADER_BYTES + Σ(prior region bytes)`. Reordering the list is an ABI change pinned by header golden tests. *Consumer* regions — declared by a host via `StoreRegionSpec` — live in a generic, self-describing region table addressed by an opaque `region_id` the engine never interprets (`core/store/region_table.ts:46-57, 189`); this replaced five game-specific header fields (#623).

### Column descriptors

The "where is each column" table lives at `header.layoutDescriptorOff` and is a sequence of variable-size `ArchetypeDescriptor`s — a 36-byte header (`abi.ts:49-57`: archetype id, a 4-word component mask, row count, row capacity, column count, enabled count) followed by N 16-byte `ColumnDescriptor`s (`abi.ts:40-47`: `component_id`, `field_id`, `type_tag`, `byte_off`, `stride`). The region is walked by per-archetype column count, with no offset table (`core/store/descriptor.ts:247-272`). `TYPE_TAG_STRIDE` (`core/store/descriptor.ts:73-82`) is the tag→byte-width map that drives all alignment.

### Views and column keys

`makeView` constructs a concrete typed array over the buffer at a column's byte offset (`core/store/column_store.ts:191-215`). Columns are keyed by `columnKey = (componentId << 16) | fieldId` (`core/store/column_store.ts:139-141`) so the per-archetype column map is number-keyed (V8 fast path, no per-lookup string alloc).

`planLayout` is the offset math: it sizes the descriptor region, then for each column does `cursor = alignUp(cursor, stride); byteOff = cursor; cursor += stride * rowCapacity` (`core/store/column_store.ts:237-299`).

### `BufferBackedColumn`

A column is a fixed-capacity view with a **logical length** tracked on top of the immutable `view.length` (`core/store/buffer_backed_column.ts:40-185`). It presents a `GrowableTypedArray`-shaped API (`push`, `pop`, `swapRemove`, `bulkAppend`, …) but **cannot grow itself** — an overrun throws `StoreColumnOverflowError` (`core/store/buffer_backed_column.ts:28`); growth is a store-level realloc. `refreshView` (`core/store/buffer_backed_column.ts:62`) repoints it at a new view after a realloc, preserving the logical length.

In the live ECS, every archetype is built by `Archetype.fromColumnStore` (`core/ecs/archetype.ts:341`), so its columns are `BufferBackedColumn` views into the single store buffer — heap and shared profiles differ *only* in the allocator. The abstract `ColumnFactory`/`ColumnBacking` seam (`core/ecs/archetype.ts:102-118`) also admits a heap `GrowableTypedArray` backing used in isolation (tests).

### Growth and extension

Two operations reshape the buffer, both realloc-and-republish (`core/store/grow.ts`, `core/store/extend.ts`):

- **Grow** raises existing archetypes' row capacities. `growColumnStore` (`core/store/grow.ts:276`) doubles the overflowing archetype (driven from the store, `core/ecs/store.ts:630-706`). When the allocator is in-place and unchanged it takes a fast path that relocates only the growing archetypes' columns to the buffer tail and rebuilds only their views (`core/store/grow.ts:128-260`); the old column region is abandoned as an unreclaimed hole (bounded ~1× by geometric doubling). Otherwise it snapshots live columns, reallocates, and restores.
- **Extend** adds *new* archetypes at the buffer tail — the primitive the live ECS uses when a new component combination first appears (`core/store/extend.ts:290`). Its in-place fast path appends new column offsets and descriptors into reserved descriptor headroom without touching existing bytes, so existing views stay valid (`core/store/extend.ts:506-625`).

**Two byte caps, not one.** The tunable allocator cap (default 256 MiB, `StoreCapExceededError`, `core/store/allocator.ts:93`) is a runaway-growth signal and sits far below the hard structural ceiling of `2^31` bytes (`STORE_MAX_BYTE_OFFSET`, `core/store/column_store.ts:156`) — because JS bitwise `alignUp` coerces to signed 32-bit, an offset past `2^31` would wrap. `alignUp` guards *before* the bitwise op (`core/store/column_store.ts:184-189`) and throws `StoreLayoutOverflowError`.

### The entity index

`EntityID → (archetype_id, row, generation)` lives in a mechanism region so a WASM sim can resolve cross-entity targets without a callback into TS (`core/store/entity_index.ts`). Its layout is a small header plus three parallel `Int32Array` columns (generations, archetypes, rows); `-1` is the `UNASSIGNED` sentinel and round-trips through the signed columns. Default capacity is `1 << 20` (`core/store/entity_index.ts:74`) — the entire 20-bit `EntityID` space, ~12 MiB *virtual* but only a few KiB physical for a small world, so `createEntity` can never run out under the default plan.

### State hash

`columnStoreStateHash` is one FNV-1a-32 scan over the live buffer bytes (`core/store/state_hash.ts:86`). The canonical byte fold is `hash = (hash ^ (b & 0xff)) >>> 0; Math.imul(hash, FNV1A_PRIME) >>> 0` (`core/store/state_hash.ts:51-54`); a coarser word-at-a-time variant folds columns ~4× faster (`core/store/state_hash.ts:63`). The digest is **backing-agnostic** (heap and SAB stores with identical history hash the same) and its cost scales with live bytes, not capacity. `view_stamp` is part of the hash by design — two stores at the same logical state but different realloc generations hash differently.

### Snapshot

A snapshot is a zero-copy `Uint8Array` view over the buffer (`core/store/snapshot.ts:60`), sized to `capacity` read live from the view (not the possibly-stale cached header, not the page-rounded `byteLength`). Restore validates magic/version/bounds through a `DataView` **before allocating**, then allocates at the exact snapshot length and copies — converting any raw `RangeError` from truncated input into `StoreRestoreError` (`core/store/snapshot.ts:83-151`).

---

## 3. Entities

Source: `src/core/ecs/entity.ts`, allocator in `src/core/ecs/store.ts`.

### Packed handle

`EntityID` is a branded number (`core/ecs/entity.ts:34`) with layout `[generation:11][index:20]`, 31 bits total so the sign bit is never set. Constants pin the limits (`core/ecs/entity.ts:51-72`): `INDEX_BITS = 20`, `MAX_INDEX = 1,048,575`; `GENERATION_BITS = 11`, `MAX_GENERATION = 0x7FF = 2047`; `MAX_ENTITY_ID = 0x7FFFFFFF`. Pack/unpack are plain bit ops — `createEntityId(i, g) → (g << 20) | i` (`core/ecs/entity.ts:74-85`), `getEntityIndex → id & 0xFFFFF` (`core/ecs/entity.ts:87`), `getEntityGeneration → id >> 20` (`core/ecs/entity.ts:89`); the signed right-shift is clean because the packed value never sets bit 31.

### Slot allocator, recycling, and retirement

The store manages slots with a SAB-backed generation array, a high-water mark, and a free-list stack (`core/ecs/store.ts:359-362`). `createEntity` pops the free stack when non-empty, otherwise advances the high-water mark (`core/ecs/store.ts:1588-1625`), placing the new entity in the empty archetype with row `UNASSIGNED` — it occupies no row until a component is added.

Destruction (`_destroyOne`, `core/ecs/store.ts:1914-1967`) swap-removes the entity from its archetype, marks its archetype/row `UNASSIGNED`, purges its relations and sparse data, and then either increments the slot's generation *or* stamps `RETIRED_GENERATION` (2047) when the counter would exhaust (`core/ecs/store.ts:1959-1965`). A **retired** slot is never recycled — this closes the ABA stale-handle window that plain wraparound would open (#376).

### Liveness

`isAlive` is fail-closed (`core/ecs/store.ts:1985-1991`): it rejects out-of-range ids and the `RETIRED_GENERATION` tombstone, then checks the slot's current generation matches the handle within the high-water mark. A handle to a recycled slot fails the generation compare; a handle to a retired slot fails the tombstone check.

---

## 4. Components

Source: `src/core/ecs/component.ts`, registration in `src/core/ecs/store.ts`.

A component is a schema mapping field names to typed-array tags. `TagToTypedArray` (`core/ecs/component.ts:46-55`) maps each of the eight tags (`f32 f64 i8 i16 i32 u8 u16 u32`) to a concrete typed-array class so column accessors return the right type at compile time.

### The callable handle

`ComponentDef<S>` is a **callable** branded handle (`core/ecs/component.ts:91-94`):

```ts
interface ComponentDef<S> {
  (values?: Partial<FieldValues<S>>): Bundle<S>;   // call it → a (def, values) bundle
  readonly id: ComponentID;                         // the raw numeric id
}
```

`makeComponentDef` mints one as a closure with a non-enumerable `.id` installed via `defineProperty` (`core/ecs/component.ts:123-130`) — so a def is invisible to spreads and `JSON.stringify`. The schema `S` rides on the *call signature*, not a phantom property; that makes `ComponentDef<S>` invariant in `S`, which is why schema-agnostic internals take a `ComponentHandle` (`{ id }`, `core/ecs/component.ts:104`) instead. Calling a def, or the free `bundle(def, values)` (`core/ecs/component.ts:143`), produces a `Bundle` — a `(def, partial-values)` pair the varargs spawn/add paths accept; omitted fields zero-fill at attach.

### Registration, the identity budget, and the float ban

`registerComponent` allocates a dense id from a monotonic counter and records `ComponentMeta` (field names, index map, types, plus observer hot-path flags) in a parallel array (`core/ecs/store.ts:2861-2899`). It enforces `STORE_DESCRIPTOR_COMPONENT_LIMIT = 128` (`core/store/descriptor.ts:161`) — the dense-identity budget, derived from the 4-word component mask — and throws `COMPONENT_LIMIT_EXCEEDED` past it. On a deterministic ECS, `_rejectNonDeterministicFields` (`core/ecs/store.ts:894-915`) bans `f32`/`f64` columns at registration (`NON_DETERMINISTIC_COLUMN_TYPE`), because IEEE-754 rounds differently across engines.

### Tags

A tag is a component with an empty schema; `registerTag` forwards to registration with `{}`. Tags participate in the archetype mask but store no columns — a tag-only archetype has `hasColumns === false` (`core/ecs/archetype.ts:179`) and takes column-free fast paths (§5). A bare, uncalled def doubles as an all-zero bundle / tag wherever a bundle is expected.

---

## 5. Archetypes

Source: `src/core/ecs/archetype.ts`.

An archetype groups all entities sharing an identical component mask. Its identity is the `BitSet` at `core/ecs/archetype.ts:178`, where bit *b* is set iff `ComponentID` *b* is in the signature. The concrete `Archetype` class implements the read-only `ArchetypeView` interface (`core/ecs/archetype.ts:134-176`) that queries hand to `forEach` — the view exposes only read accessors and counts, so iteration can never bypass the deferred-flush contract.

### Column layout

Each archetype owns a dense flat column store plus sparse-by-ComponentID index maps (`core/ecs/archetype.ts:244-264`):

- `_flatColumns: ColumnBacking[]` — every field's column across every component, packed contiguously; its index space is shared with `ColumnStore.columnsInOrder`.
- `_colOffset[cid]`, `_fieldCount[cid]`, `_fieldIndex[cid]`, `_fieldNames[cid]` — where component `cid`'s fields begin and how they're named.
- `_columnIds` — a dense list of ComponentIDs that carry columns, iterated by move/copy/tick-stamp paths.
- `columnGroups[cid]` — a richer `{ layout, columns }` object kept for `createRef`'s prototype-cache keying.
- `_changedTick[cid]` — the per-component last-modified tick. **This is the only change-tracking granularity: per-component, per-archetype; there is no per-row dirty bit in the archetype** (entity-granular tracking is an opt-in store-side list, §8/§11).
- `_mutGroupCache` / `_readGroupCache` — one reusable field-keyed object per component for `eachChunk`, refreshed in place so column-group resolution allocates nothing per archetype.

The constructor walks the supplied layouts, allocating one column per field via the `columnFactory` and recording offsets (`core/ecs/archetype.ts:279-328`). Entity ids live in a separate `GrowableUint32Array` (`core/ecs/archetype.ts:193`).

### The enabled/disabled partition

Each archetype partitions its rows: `[0, enabledCount)` are enabled, `[enabledCount, length)` are disabled (#577). `entityCount` returns `enabledCount` by default and `length` only while a module flag is set during an `includeDisabled()` iteration (`core/ecs/archetype.ts:442-444`); `totalCount` is `length` and `disabledCount` is the difference (`core/ecs/archetype.ts:447-454`). So an ordinary `for (i < arch.entityCount)` loop skips disabled rows for free.

Disable/enable is a **single row swap, no archetype transition**: `disableRow` swaps the row to the last enabled slot and decrements `enabledCount` (`core/ecs/archetype.ts:532-541`); `enableRow` is the inverse (`core/ecs/archetype.ts:547-556`). The common "no disabled rows" case (`enabledCount === length`) is short-circuited on every placement/removal path so archetypes that never disable pay nothing (ADR-0016).

### Membership

All membership changes keep rows contiguous by swap-removing from the end:

- `addEntity` (`core/ecs/archetype.ts:965-978`) pushes the id and one zero into every column, invokes the grow handler if the next push would overflow SAB capacity, then places the row into the enabled region via `_placeTail`.
- `removeRow` (`core/ecs/archetype.ts:570-599`) is the partition-aware swap-remove that owns its `entityRow` updates; the cold tail `_removeRowPartitioned` handles disabled-bearing archetypes. (`removeEntity`, `core/ecs/archetype.ts:985-1010`, is the simpler "assume enabled-or-last" variant kept for direct callers/tests.)
- `addEntityTag` / `removeEntityTag` (`core/ecs/archetype.ts:1013, 1132`) skip all column work for tag-only archetypes.
- `addEntityWithValues` / `addEntitiesWithValues` (`core/ecs/archetype.ts:1087, 1110`) write template values straight into columns in one pass — skipping the zero-fill-then-overwrite — and stamp every component's tick (ADR-0010).

### Transitions between archetypes

Moving one entity uses a pre-computed transition map. `ArchetypeEdge` (`core/ecs/archetype.ts:58-65`) caches both directions of a single-component transition — the target archetype ids plus `Int16Array` `addMap`/`removeMap` column-copy plans. `buildTransitionMap` builds the map indexed by *destination* column position: for each dst column, the source column index of the shared component, or `-1` for a new column (`core/ecs/archetype.ts:1451-1480`).

`moveEntityFrom` (`core/ecs/archetype.ts:1154-1215`) does one pass: append the id, copy each dst column from `srcCols[map[i]]` (or `0` if `map[i] < 0`), preserve the entity's enabled/disabled state, and remove it from the source. It **stamps `_changedTick` for every component in the destination** (`core/ecs/archetype.ts:1197-1200`), not just the one that triggered the move — so adding or removing any component lights up change detection for every component on the new archetype. `moveEntityFromTag` (`core/ecs/archetype.ts:1222`) is the column-free variant; `bulkMoveAllFrom` (`core/ecs/archetype.ts:1253`) moves every row of a source via `TypedArray.set`, the primitive behind whole-archetype batch ops. Move methods write their `[dstRow, swappedIndex]` result into a reused module-scope tuple `_moveResult` (`core/ecs/archetype.ts:1395`) to avoid per-call allocation.

### Column accessors and tick stamping

The read-only view exposes `getColumnRead` / `getColumnsRead` / `getOptionalColumnRead` (`core/ecs/archetype.ts:672, 706, 740`) — live buffers typed read-only, no tick bump. The **mutable** accessors live on the concrete `Archetype`, never on the view: `getColumn(def, field, tick)` stamps `_changedTick[cid]` then returns the column (`core/ecs/archetype.ts:766-792`), and `columnGroupMut(def, tick)` resolves a whole component's columns into the reused field-keyed object and stamps the tick **once** (`core/ecs/archetype.ts:808-833`) — this is what `eachChunk`'s `cols.mut` calls. `columnGroupRead` (`core/ecs/archetype.ts:836`) is the no-stamp read variant. Row writers `writeFields` / `writeFieldsPositional` (`core/ecs/archetype.ts:860, 910`) and `copySharedFrom` (`core/ecs/archetype.ts:942`) also stamp; `readField` (`core/ecs/archetype.ts:926`) does not.

### Mask ops

`matches(required)` is a single `BitSet.contains` (`core/ecs/archetype.ts:660-662`); `hasComponent(id)` is a bit test (`core/ecs/archetype.ts:656-658`). Per-component transition edges are cached in the sparse `edges` array; multi-component and composite-add edges have their own caches, all monotonic and never invalidated (`core/ecs/archetype.ts:223-237`).

---

## 6. The Store

Source: `src/core/ecs/store.ts` (~4900 lines — the ECS's data orchestrator).

`Store` owns every piece of mutable ECS state and exposes a typed API to `ECS` and `SystemContext`; it is never handed out directly.

### Archetype registry

Archetypes are deduplicated by BitSet mask across three structures (`core/ecs/store.ts:401-426`): `archetypes[]` indexed by id; `archetypeMap: Map<hash, ArchetypeID[]>` hash-bucketed by `BitSet.hash()`; and `componentIndex: ArchetypeID[][]`, an inverted index (component id → archetypes containing it) that is **push-only, duplicate-free, and strictly ascending by construction** because `archInstall` is its sole writer and ids are minted monotonically (ADR-0015). That ordering is what lets `getMatchingArchetypes` start from the smallest bucket and `_forEachChangedArchetype` skip a sort.

`archGetOrCreateFromMask` (`core/ecs/store.ts:1263-1284`) hashes the mask, scans the bucket via `BitSet.equals`, and on miss builds a new archetype, extends the column store with its columns, and calls `archInstall` (`core/ecs/store.ts:1459-1531`) — which registers it, appends its id to each component's inverted-index bucket, and **fans it into every matching registered query's result array** before returning. The empty archetype is bootstrapped in the constructor (`core/ecs/store.ts:837`). `archCreateManyFromMasks` (`core/ecs/store.ts:1302`) is the bulk prewarm variant that does one column-store extend for all new archetypes.

### Archetype graph edges

Per-component transitions resolve lazily and cache. `archResolveAdd` / `archResolveRemove` (`core/ecs/store.ts:1534, 1547`) short-circuit if the component is already present/absent, else consult the cached edge, else create the target archetype (via `copyWithSet`/`copyWithClear` on the mask) and call `archCacheEdge` (`core/ecs/store.ts:1560-1582`), which stores both directions plus the `Int16Array` transition maps. After the first transition, every subsequent "add X to archetype A" is a sparse-array lookup plus a branchless column copy.

### Entity → archetype/row

Two SAB-backed parallel `Int32Array`s keyed by entity index (`core/ecs/store.ts:431-434`), both using `-1` as `UNASSIGNED`. Every swap-remove path returns the swapped entity's index so the store can update its `entityRow` to the vacated slot.

### Deferred buffers and the flush model

Systems must not shuffle archetype membership mid-iteration, so `SystemContext` writes land in flat parallel arrays (`core/ecs/store.ts:439-452`): `pendingDestroy`; `pendingAddIds`/`Defs`/`Values`; `pendingRemoveIds`/`Defs`; and `pendingToggleIds`/`ToggleDisable`. There is no per-op wrapper object.

`flushStructural` (`core/ecs/store.ts:2428-2515`) has two paths:

- **No-observer fast path** (`core/ecs/store.ts:2440-2447`): `_flushAdds` → `_flushRemoves` → `_flushToggles`, byte-for-byte the pre-observer flush. Toggles run last so a disable/enable sees the entity's final archetype for the tick.
- **Observed path** (`core/ecs/store.ts:2458-2514`): commit the batch, then fire observers in canonical order, looping to a fixed point so cascades settle — one kind of op per round (adds/removes, then destroys, then toggles), guarded by `OBSERVER_MAX_ROUNDS`. Observers never see a torn state because they fire only *after* a committing round; a re-entrant `ctx.flush()` from inside a callback is absorbed by the running loop.

`_flushAdds` (`core/ecs/store.ts:2518-2618`) handles three cases per buffered add — component already present (overwrite in place), entity has no row (allocate one), entity has a source row (`moveEntityFrom`) — writing fields through `writeFields(..., this._tick)`. `_flushRemoves` (`core/ecs/store.ts:2621`) is symmetric via `archResolveRemove`. Every flush loop **re-validates the entity's generation inline** (`idx >= hw || entGens[idx] !== gen → skip`, e.g. `core/ecs/store.ts:2544`), so a stale handle buffered earlier in the tick becomes a silent no-op. `flushDestroyed` (`core/ecs/store.ts:2286`) drains destructions with the same generation re-validation, retiring or recycling each slot.

### Enable / disable

Immediate `disableEntity` / `enableEntity` (`core/ecs/store.ts:2082, 2105`) move the row within its archetype via `disableRow`/`enableRow` — no transition — and update the query epoch only on an `enabledCount` 0-crossing. Deferred variants push to the toggle buffer and drain (in op order, collapsing to one net transition per entity) at the flush (`core/ecs/store.ts:2206-2251`).

### Query registration and the dirty epoch

`registerQuery` (`core/ecs/store.ts:4683-4693`) seeds a result array via `getMatchingArchetypes` and records `{ includeMask, excludeMask, anyOfMask, result, query }`; the returned array is the live one `archInstall` pushes new matches into. `getMatchingArchetypes` (`core/ecs/store.ts:4611-4677`) does the initial intersection — with an empty required mask it scans all archetypes; otherwise it finds the **smallest `componentIndex` bucket** among the required bits and filters that.

Membership changes bump a single monotonic `_queryDirtyEpoch` (`core/ecs/store.ts:575`); each `Query` caches its non-empty subset against the last epoch it saw (§7). New (empty) archetypes do **not** bump the epoch. Row-count staleness in the SAB descriptors is tracked separately by `_rowCountsDirty` and flushed by `publishRowCountsToDescriptor` (`core/ecs/store.ts:1008-1048`).

### Batch ops and the tick

`batchAddComponent` / `batchRemoveComponent` (`core/ecs/store.ts:4476, 4536`) move an entire archetype at once via `bulkMoveAllFrom` + one `bulkWriteFields` per field — much faster than per-entity moves — and reject archetypes with disabled rows (`PARTITION_BULK_INTO_DISABLED`). The change-detection write tick `_tick` (`core/ecs/store.ts:454`) is synced from the ECS at the top of every `update()` (`core/ecs/ecs.ts:1484`) so all stamps within a frame use one value.

---

## 7. Queries

Source: `src/core/ecs/query.ts`, cache keying in `src/core/ecs/ecs.ts`, live registration in `src/core/ecs/store.ts`.

A `Query<Defs>` owns (`core/ecs/query.ts:301-368`): the live `_archetypes: Archetype[]` result array owned by the store; the `_include` / `_exclude` / `_anyOf` BitSet masks; a `_nonEmptyArchetypes` cache with an epoch-counter dirty flag `_lastSeenEpoch`; a stable `_id`; and small term lists for non-dense members (`_sparseInclude`, `_optional`, `_relationIncludes`, `_hierarchy`, `_includeDisabled`), which default to frozen empty singletons so a dense query allocates none.

### Resolution and caching

Queries are cached in `ECS.queryCache: Map<number, QueryCacheEntry[]>` (`core/ecs/ecs.ts:224`). `_resolveQuery` (`core/ecs/ecs.ts:1205-1245`) computes the key by combining the three mask hashes — `incHash ^ imul(excHash, HASH_GOLDEN_RATIO) ^ imul(anyHash, HASH_SECONDARY_PRIME)` — then linearly scans the bucket comparing masks by `BitSet.equals` (`_findCached`, `core/ecs/ecs.ts:1247-1272`); buckets tolerate hash collisions. On a miss it registers a live array with the store, wraps it in a `Query` with a fresh id, and pushes the cache entry. `ECS.query(...defs)` reuses a single scratch `BitSet` to avoid allocating on every call (`core/ecs/ecs.ts:1097-1106, 226`). `QueryBuilder.with(...)` (`core/ecs/query.ts:1308`) is the registration-time entry used inside `registerSystem(fn, qb => qb.with(...))`.

### Composition

Refine verbs (`and`, `without`, `anyOf`, `optional`, `changed`, `includeDisabled`, and the sparse/relation/hierarchy terms) each derive a new cached query and are memoized on **shared single-term caches keyed by `(parentQueryId << 16) | componentId`** that live on the resolver — one map per verb, so the footprint is O(verbs), not O(queries × verbs) (`core/ecs/query.ts:100-133`, `core/ecs/ecs.ts:231-253`). `_carryNondense` (`core/ecs/query.ts:460-488`) makes composition order-independent: dense verbs resolve on the mask alone and re-thread any non-dense terms, so `q.optional(V).and(H)` and `q.and(H).optional(V)` are the same query.

### The non-empty subset

`_nonEmpty()` (`core/ecs/query.ts:1206-1210`) compares `_lastSeenEpoch` against the store's `_queryDirtyEpoch` and rebuilds when stale. `_rebuildNonEmpty` (`core/ecs/query.ts:1218-1236`) **builds a fresh array and swaps it in** rather than truncating in place, so a re-entrant iteration keeps its snapshot; it filters archetypes on `totalCount > 0` (under `includeDisabled`) or `enabledCount > 0`. Per-field writes never touch the epoch, so repeated iteration within a frame hits the cache.

### Terminals

- `forEach(cb)` (`core/ecs/query.ts:944-977`) calls back once per non-empty archetype with a read-only `ArchetypeView`. In dev it asserts dense-only and publishes an optional-fetch scope for `.optional(T)`. Its default body is inlined (not delegated) because it is a megamorphic call site V8 won't inline.
- `eachChunk(cb)` (`core/ecs/query.ts:1017-1063`) is the mutable hot path. It allocates one `ChunkColumns` cursor, captures the current tick **once**, and per archetype re-points the cursor and passes `arch.entityCount` as `count`. `ChunkColumns` (`core/ecs/query.ts:286-299`) resolves `mut(def)` → `columnGroupMut` (stamps the tick) and `read(def)` → `columnGroupRead`; the cursor is per-call, so nested `eachChunk` passes are re-entrancy-safe.
- `forEachEntity(cb)` (`core/ecs/query.ts:1154-1188`) yields matching entities one id at a time — **required** for any query carrying a sparse, relation, or hierarchy term, since those scatter across archetypes with no column span. It routes through the resolver's sparse/relation/hierarchy match drivers.
- `count()` / `archetypeCount` / `archetypes` (`core/ecs/query.ts:434, 426, 445`) — introspection.

The dense terminals (`forEach`, `eachChunk`, `count`, `archetypeCount`) reject queries with sparse/relation/hierarchy terms via `_assertDenseOnly` → `SPARSE_QUERY_DENSE_PATH` (`core/ecs/query.ts:410-423`), because a dense walk would silently miss the non-dense members.

---

## 8. Change detection

Change detection threads through every layer: the ECS owns a tick counter, the archetype carries one stamp per component, write paths stamp it, and `ChangedQuery` filters archetypes by comparing against each system's last-run tick.

### The tick

`ECS._tick` (`core/ecs/ecs.ts:215`) starts at 0 and increments at the end of every `update()` (`core/ecs/ecs.ts:1533`). `Store._tick` (`core/ecs/store.ts:454`) is synced from it at the top of `update()` (`core/ecs/ecs.ts:1484`) so stamps within a frame share one value; `ctx.ecsTick` reads it (`core/ecs/query.ts:1394`). `ctx.lastRunTick` is written by the schedule immediately before each system's `fn`, exposing that system's *previous* run tick (`core/ecs/schedule.ts:361`). Startup and the first `update()` both run with tick 0.

### What stamps `_changedTick`

The mutable column paths on the archetype stamp `_changedTick[cid]`: `getColumn`, `columnGroupMut` (`cols.mut`), `writeFields` / `writeFieldsPositional`, `copySharedFrom`, `addEntityWithValues`, and the three move paths (each stamps *every* destination component). At the facade/context level, `setField` / `updateField` write the column and stamp; `ctx.ref` stamps eagerly at ref creation. The read paths — `getColumnRead`, `columnGroupRead` (`cols.read`), `readField`, `getField`, `ctx.refRead` — do not stamp.

### `ChangedQuery`

`Query.changed(...defs)` (`core/ecs/query.ts:1279`) returns a `ChangedQuery` wrapping the base query with the watched component ids; the constructor asserts every id is in the include mask (`core/ecs/query.ts:1782-1795`). Its `forEach` (`core/ecs/query.ts:1826-1872`) reads the threshold *fresh per call* via `_query._ctxLastRunTick()`, walks the base query's non-empty archetypes, and emits any archetype where `arch._changedTick[id] >= lastTick` for any watched id. On a system's first run `lastRunTick` is 0, so every non-empty matching archetype is visited. The `ChangedQuery` is itself composable — `and` / `without` / `anyOf` / `optional` re-derive the underlying query and re-wrap (`core/ecs/query.ts:1807-1824`), so `q.changed(P).without(D)` equals `q.without(D).changed(P)`.

**Granularity is per `(archetype, component)`.** Writing one row stamps the whole archetype for that component; `ChangedQuery` yields whole archetypes, and per-row filtering is the caller's job. For entity precision, use an entity-granular `onSet` observer (§11).

---

## 9. Sparse storage

Source: `src/core/ecs/sparse_store.ts`, wiring in `src/core/ecs/store.ts`.

A sparse component lives *outside* the archetype identity, so adding or removing one causes **no archetype transition** and consumes **no** dense-identity bit. `SparseComponentID` is a separate id space from `ComponentID` (`core/ecs/sparse_store.ts:37`), indexing the store's `sparseStores` array (`core/ecs/store.ts:376`) and never the archetype mask. A distinct phantom brand keeps a sparse def from crossing into the dense `addComponent`/`getField` surface (`core/ecs/sparse_store.ts:44-48`).

`SparseComponentStore` (`core/ecs/sparse_store.ts:53-146`) is one component's membership plus data: a `SparseMap<number[]>` keyed by **entity index** (`core/ecs/sparse_store.ts:55`), where membership is key presence and each value is a positional field-value row (`[]` for a tag). Keying by entity index means a dense neighbour's swap-remove never disturbs sparse data; only entity destruction does, via the store's purge hook. Reads/writes (`has`, `getField`, `setField`, `setRow`, `remove`) are all O(1). Registration mirrors dense components — record, array-shorthand, and tag forms — and the same deterministic float ban applies at the store's registration surface.

For iteration, `indices` (`core/ecs/sparse_store.ts:77`) is the live key array in swap order that `forEachEntity` walks, while `canonicalIndices()` (`core/ecs/sparse_store.ts:88`) returns a sorted copy — the determinism ordering used by `stateHash` and snapshot. Snapshot/restore serialize members in canonical order with a schema fingerprint folded into the header (`core/ecs/sparse_store.ts:172-190, 216-339`), and restore fails closed on any store-count, field-count, schema-identity, `MAX_INDEX`, or trailing-byte mismatch (`SparseRestoreError`).

---

## 10. Relations

Source: `src/core/ecs/relation.ts`, `src/core/ecs/builtin_relations.ts`, wiring in `src/core/ecs/store.ts`.

A relation is a first-class `(relation, target)` pair on a source entity, built **on the sparse storage class** — so add/remove/re-target cause no archetype transition and consume no identity bit, and all relation ops are immediate (safe mid-tick precisely because no dense row moves). `RelationID` is a third id space (`core/ecs/relation.ts:73`).

### Storage

Every `RelationStore` (`core/ecs/relation.ts:155-332`) owns a cardinality-agnostic **reverse index** — `Map<targetEntityID, Set<sourceEntityID>>` keyed by the *full* EntityID (index + generation) so a recycled target slot can't alias a dead target's sources — plus a handle on a backing sparse store. The forward representation is virtual:

- **Exclusive** (the default) — the forward link *is* a `{ target: f64 }` sparse row (`core/ecs/relation.ts:337-414`); a second `addRelation` overwrites the first. One target per source.
- **Multi** — membership is a sparse tag and the target set lives in a side `Map<sourceIndex, Set<target>>` (`core/ecs/relation.ts:421-531`); those set values aren't in the sparse store, so they're folded into `stateHash` and serialized explicitly.

Reverse lookups (`sourcesOf`) sort ascending on the cold path (`core/ecs/relation.ts:245-255`). The public reads, wildcards (`pairsOf` for `(R, *)`, `sourcesOfAny` for `(*, T)`), traversal helpers, cleanup orchestration, and cycle detection live on the `Store` (`core/ecs/store.ts:3370-3808, 3665-3759`), building on these per-relation mechanics.

### Wildcards and query terms

`ANY_RELATION` (`core/ecs/relation.ts:89`) is an authorization sentinel for `(*, T)` queries — `forEachRelatedTo` reads every relation's reverse index, so it can't name a specific relation and is authorized via `relationReads: [ANY_RELATION]` instead. Query relation terms (`withRelation`/`withoutRelation`) resolve the relation's *backing sparse id* and reuse the sparse-match driver, recording the `RelationDef` only for the dev access check (`core/ecs/query.ts:657-732`). `hierarchy(relation, maxDepth)` reorders a matched set into parents-before-children depth order over an exclusive relation (`core/ecs/query.ts:754-809`).

### Cleanup policies

`onDeleteTarget` decides what happens to a relation's *sources* when a *target* is destroyed (`core/ecs/relation.ts:103`): `"delete"` cascade-destroys sources recursively, `"clear"` drops the link but keeps sources, `"orphan"` (the overall default) leaves the link dangling. Under `orphan` the reverse index leaks until sources re-target or die; `compactRelations` → `pruneDeadReverse` (`core/ecs/store.ts:3629`, `core/ecs/relation.ts:232`) reclaims reverse entries for destroyed targets at scene/snapshot boundaries without perturbing observable state or `stateHash`.

### Built-in relations

`registerChildOf` and `registerIsA` (`core/ecs/builtin_relations.ts:74, 53`) are thin free-function presets over `registerRelation`, both always exclusive. `ChildOf` defaults to `"delete"` (destroying a parent cascade-destroys the subtree); `IsA` defaults to `"clear"` and records the link only — **there is no component inheritance**, an instance does not gain the exemplar's components.

---

## 11. Observers

Source: `src/core/ecs/observer.ts`.

An observer runs a callback when a component is added, removed, set, or when its entity is enabled/disabled — the push-based counterpart to polling with a `changed()` query. `ecs.observe(def, config)` (`core/ecs/ecs.ts:1421`) registers one and returns a disposable handle. The config shape discriminates the kind (`core/ecs/observer.ts:102-124`): structural (`onAdd`/`onRemove`/`onDisable`/`onEnable`), archetype-granular `onSet` (the default), or entity-granular `onSet`. Each observer's declared `access` synthesizes a `SystemDescriptor` so the access checker validates its callbacks exactly like a system (`core/ecs/observer.ts:166-178`).

### When callbacks fire

- **`onAdd` / `onRemove`** fire at the **structural-flush boundary**, after the deferred batch commits, so an observer never sees torn state; the flush loops to a fixed point so cascades settle (`dispatchStructural`, `core/ecs/observer.ts:432-474`, driven from `core/ecs/store.ts:2458-2514`).
- **`onDisable` / `onEnable`** fire at the same boundary, once per net transition across a drain, for every component the entity carries.
- **`onSet`** fires at the post-update detection point — the tick tail, from `ECS.update` after all phases (`core/ecs/ecs.ts:1520`). *Archetype-granular* reuses the free change tick: `store._forEachChangedArchetype` fires once per changed archetype-column and advances the observer's baseline (`core/ecs/observer.ts:573-589`). *Entity-granular* drains an opt-in per-row dirty list `store._takeDirty(cid)` (`core/ecs/observer.ts:535-571`); **registering it turns on per-row dirty tracking** for that component (a write-path cost), and it fires only for entities still alive, present, and enabled at drain time.

### Deterministic firing order

Two composed layers make replay reproducible (`core/ecs/observer.ts:197-242`): **across observers**, access-topological (a writer of `X` before readers of `X`, tie-broken by component id then registration id — "glitch-free"); **within one observer**, ascending `EntityID` via an O(K) LSD radix sort (`core/ecs/observer.ts:631-659`), never `Array.sort`. **Within one structural round**, the order is remove → add → disable → enable — leaving edges before entering ones. Observer state is excluded from `stateHash`/snapshots but produced in canonical order, so replays reproduce it.

`yieldExisting: true` replays `onAdd` over current *enabled* matches at registration (`core/ecs/observer.ts:595-620`). Emitting an event from `onSet` throws `OBSERVER_ONSET_EMIT` (§15). A cyclic observer dependency degrades gracefully in the sort but the store's fixed-point loop raises `OBSERVER_NON_CONVERGENT` if it never settles.

---

## 12. Events

Source: `src/core/ecs/event.ts`, storage/lifecycle in `src/core/ecs/store.ts` and `src/core/ecs/ecs.ts`.

An event is a typed, fire-and-forget message emitted and read within one frame. The implementation is one `EventChannel` per event id. `EventChannel` (`core/ecs/event.ts:83-143`) holds one plain `number[]` column per field plus a pre-built `reader` whose fields *are* those column arrays and whose `length` is a mutable counter — so `ctx.read(key).amount[i]` reads directly from storage, zero-copy. `emit` validates all fields before pushing any (avoiding a mid-loop desync) then pushes one value per column and bumps `reader.length` (`core/ecs/event.ts:109-129`); `emitSignal` only bumps the counter; `clear` resets the counter and truncates every column.

`EventKey<S>` / `SignalKey` are branded symbols carrying a phantom schema (`core/ecs/event.ts:151-165`), minted at module scope by `eventKey` / `signalKey`. A signal carries an extra phantom so the type system stops you passing a payload to it. `ECS.update` clears every channel as its last act before incrementing the tick (`core/ecs/ecs.ts:1531`), and `startup()` drains startup-phase events separately (`core/ecs/ecs.ts:1452`) — so an event lives exactly one `update()` and frame 1 never sees stale startup events. Event storage is separate from the archetype graph and is excluded from `stateHash`/snapshots.

---

## 13. Resources

Source: `src/core/ecs/resource.ts`, storage in `src/core/ecs/store.ts`.

A resource is a world-scoped singleton keyed by a `ResourceKey<T>` — a symbol carrying its value type as a phantom (`core/ecs/resource.ts:32`), minted once at module scope by `resourceKey`. Storage is a plain `Map<symbol, unknown>` on the store (`core/ecs/store.ts:4802-4839`): `registerResource` inserts once (duplicate throws `RESOURCE_ALREADY_REGISTERED`), `resource`/`setResource` throw `RESOURCE_NOT_REGISTERED` on a missing key, `removeResource` fails closed and frees the key for re-registration, and `hasResource` is the one lookup that never throws. There is no change tracking, no per-field column, no archetype linkage — the value is any JS value. Resources are **excluded from `stateHash` and from snapshot/restore**, so they never perturb determinism.

---

## 14. Systems and the scheduler

Source: `src/core/ecs/system.ts`, `src/core/ecs/schedule.ts`, `src/core/ecs/run_condition.ts`, `src/core/ecs/access_check.ts`.

### System configuration

A `SystemConfig` (`core/ecs/system.ts:142-177`) carries `fn`, the mandatory `reads`/`writes` access declarations, optional structural/resource/sparse/relation declarations, a `queries` lint field, lifecycle hooks (`onAdded`/`onRemoved`/`dispose`), an `exclusive` bypass flag, and an optional `backendHandle`. `registerSystem` (`core/ecs/ecs.ts:1296-1350`) normalizes the three overloads (config / bare fn / fn + query builder), runs a dev arity guard (`SYSTEM_FN_ARITY` on a 3-param bare fn that forgot its query builder) and the `_assertQueriesDeclared` lint (`queries ⊆ reads ∪ writes` → `QUERY_ACCESS_UNDECLARED`, `core/ecs/system.ts:241-264`), and freezes a `SystemDescriptor` — the identity handle used to schedule, order, and remove the system.

### The access checker

`access_check.ts` derives, per descriptor, an `AccessSets` (`core/ecs/access_check.ts:38-51`) cached in a `WeakMap`: each write implies a read and authorizes `addComponent` on that column; spawns/transitions/despawns authorize adds/removes; resource/sparse/relation terms populate their own sets (`computeSets`, `core/ecs/access_check.ts:60-165`). A module-singleton `accessCheck` (`core/ecs/access_check.ts:460`) tracks the active span: `enter(desc)` sets it (an `exclusive` system leaves `sets` null so every check passes, `core/ecs/access_check.ts:239-247`), `leave` clears it, and every `check*` early-returns when no span is active — which is why host-side calls are unchecked. Run conditions get a reads-only variant so any write a predicate attempts fails (`core/ecs/access_check.ts:190-217`).

### Phases and ordering

`SCHEDULE` is a 7-value enum (`core/ecs/schedule.ts:48-56`): `PRE_STARTUP`/`STARTUP`/`POST_STARTUP` (once, via `startup()`); `FIXED_UPDATE` (fixed timestep, inside `update()`); `PRE_UPDATE`/`UPDATE`/`POST_UPDATE` (once per frame). Each scheduled system becomes a `SystemNode` with a monotonic `insertionOrder` and `before`/`after` edge sets (`core/ecs/schedule.ts:111-121`). Within a phase, `sortSystems` (`core/ecs/schedule.ts:457-546`) builds an adjacency map from each node's and each set's `before`/`after` constraints (edges to other phases dropped) and delegates to the shared `topologicalSort` — Kahn's algorithm with a `BinaryHeap` ready queue and `insertionOrder` as the deterministic tiebreaker. The result is cached per phase and invalidated on change; a cycle is re-thrown as `CIRCULAR_SYSTEM_DEPENDENCY` naming the phase. **Cycle detection is never stripped in production** — the sort needs it to be correct.

### System sets and run conditions

A `SystemSet` (`core/ecs/schedule.ts:70`) is an object-identity handle whose `runIf`/`before`/`after` config (via `configureSet`, `core/ecs/schedule.ts:219`) is inherited by every member, read *live* at run/sort time so a later `configureSet` is honored. A `RunCondition` (`core/ecs/run_condition.ts:59-72`) is a pure, read-only per-tick gate evaluated inside a reads-only access span; a member's effective gate is the AND of its own conditions and every set's (`shouldRun`, `core/ecs/schedule.ts:399-421`). Built-ins: `runIfResourceEq`, `runEveryNTicks`, `runIfAnyMatch` (`core/ecs/run_condition.ts:79, 104, 131`). A schedule using no sets and no conditions takes a byte-for-byte fast path — the gate is skipped entirely when `gatedSystems` is empty (`core/ecs/schedule.ts:333, 351`).

### Per-system tick bookkeeping

`runLabel` (`core/ecs/schedule.ts:330-389`) is the hot loop: for each sorted system it checks the gate, sets `ctx.lastRunTick` to that system's *previous* run tick, runs `fn` (or `backend.run(handle)` if a compute backend is attached and the system carries a `backendHandle`) inside an access span, then records the *current* tick as its last run. After the phase it calls `ctx.flush()` and, in dev, fires the `phaseBoundary` trace hook. A system skipped by a `false` condition leaves its last-run tick unadvanced and enqueues nothing — so a skipped tick is byte-identical to the system being absent, which is what keeps `changed()` correct across a gated pause.

---

## 15. The update loop

Source: `src/core/ecs/ecs.ts`.

`ECS.update(dt)` (`core/ecs/ecs.ts:1469-1538`) is, in order:

1. Snapshot the caller's access span in dev (`core/ecs/ecs.ts:1482`) — restored in `finally` so a system that drives a *second* world's `update()` from inside its own span doesn't lose dev enforcement (#785).
2. `store._tick = this._tick` (`core/ecs/ecs.ts:1484`) — sync the write tick for the whole frame.
3. `publishRowCountsToDescriptor()` (`core/ecs/ecs.ts:1494`) — flush any host mutations into the SAB descriptors before the first phase.
4. **Fixed-update catch-up** (`core/ecs/ecs.ts:1496-1506`), only if fixed systems exist: `accumulator += dt`; clamp `accumulator` to `maxFixedSteps * fixedTimestep` (the spiral-of-death guard); then run `FIXED_UPDATE` once per whole `fixedTimestep` in the accumulator, each with delta `= fixedTimestep`.
5. `schedule.runUpdate(ctx, dt, _tick)` (`core/ecs/ecs.ts:1508`) — `PRE_UPDATE` → `UPDATE` → `POST_UPDATE`, flushing `ctx` between phases and after the last.
6. **onSet dispatch** (`core/ecs/ecs.ts:1520`) — `store._tick` still equals this tick, so archetype/entity `onSet` observers see exactly this tick's writes. In dev, an onSet observer that emitted an event throws `OBSERVER_ONSET_EMIT` (`core/ecs/ecs.ts:1526`) because the emission would be wiped by the next step and would break snapshot determinism.
7. `store.clearEvents()` (`core/ecs/ecs.ts:1531`) — the tick's last mutation; events live exactly one update.
8. `_tick++` (`core/ecs/ecs.ts:1533`).

Fixed steps in one frame share one tick value; events emitted during a fixed step aren't cleared until the end of `update()`. `fixedAlpha` (`core/ecs/ecs.ts:464`) exposes `accumulator / fixedTimestep` for render interpolation. `startup()` (`core/ecs/ecs.ts:1425-1453`) prewarms the archetype closure over all systems and observers (`prewarmArchetypes`, `core/ecs/ecs.ts:1463`), runs each system's `onAdded` inside an access span, runs the three startup phases with delta 0, and drains startup events. `_tick` is 0 through startup and the first `update()`'s systems, becoming 1 only after the first `update()` completes.

---

## 16. Determinism, snapshot, and replay

Source: `src/core/ecs/store.ts`, `src/core/ecs/resume.ts`, `src/core/store/state_hash.ts`, `src/core/store/snapshot.ts`.

A deterministic ECS (`new ECS({ deterministic: true })`) guarantees the same operations produce the same state bit-for-bit across backings and after a snapshot round-trip. The flag gates exactly the canonical-ordering surface — `stateHash`, `snapshot`/`restoreInto`, `snapshotSparse`/`restoreSparse` — each throwing `DETERMINISM_DISABLED` when off (`core/ecs/store.ts:874-883`). Memory-safety invariants and the enabled/disabled partition are always on.

### `stateHash`

`Store.stateHash` (`core/ecs/store.ts:1093-1215`) folds an FNV-1a digest over, per archetype in id order, `(id, live row count, enabled count)` and the live column bytes (word-at-a-time), then the sparse stores in canonical index order, then the multi-relation forward target sets in canonical order. It is backing-agnostic and scales with live entity count, not buffer capacity. The digest is opaque — compare it only at a tick boundary or a `phaseBoundary` settle point, never against a hard-coded literal.

### Snapshot / restore

`snapshot()` (`core/ecs/store.ts:3169-3181`) captures three sections into one self-contained frame (`core/ecs/resume.ts:173`): **dense** (column bytes + entity index + layout descriptors), **sparse** (sparse components + relations, canonical order), and **host bookkeeping** (`_collectHostState`, `core/ecs/store.ts:3185-3204`) — the tick, the entity recycle free-list *in live LIFO order*, alive count, and per-archetype length/enabled-count. The free-list order is serialized rather than rescanned because it is pure destroy-history with no byte source and is load-bearing for byte-identical resume.

`restoreInto` (`core/ecs/store.ts:3218-3275`) **validates completely before touching the live backing**: it reads the dense magic/version, entity-index capacity, the archetype set, and each column's `(componentId, fieldId, typeTag)` field identity directly from the incoming bytes (`assertDenseLayoutMatchesLive`, `core/ecs/resume.ts:261-365`), plus the sparse section, and only then overwrites. Any mismatch throws (`WorldRestoreError` / `SparseRestoreError`) and leaves the live ECS untouched. Resources, events, and change-detection baselines are not captured. Preconditions: the target ECS must be built with the same component/archetype registration (prewarmed), the same entity-index capacity, and `deterministic: true`.

### Record & replay

Because every host/UI mutation crosses one apply chokepoint (§17), logging the applied commands per tick plus each tick's `dt` and a seed is enough to replay a session. `replayCommandLog` (`core/ecs/command_log.ts:239`) pushes the seed-time commands, calls `startup()`, then per tick pushes commands and calls `update(dt)` — even empty ticks, because `dt` drives the sim. With `{ hash: true }` on a deterministic ECS it returns the per-tick `stateHash` sequence, whose equality across replays *is* the fidelity check.

---

## 17. The host-write seam

Source: `src/core/ecs/host_commands.ts`, `src/core/ecs/command_log.ts`, ring transports in `src/core/store/`.

Writes that originate *outside* the schedule — a UI, editor, network handler, or worker — can't touch the ECS mid-frame without corrupting live iteration. The seam makes every outside write a **typed command** buffered off-schedule and applied at one blessed point.

`installHostCommandSeam(ecs, opts?)` (`core/ecs/host_commands.ts:557-616`) returns a `HostCommandQueue` and registers **one `exclusive` apply system per configured schedule head** (default `[PRE_STARTUP, PRE_UPDATE]`). Every queue method enqueues; nothing reaches the ECS until the apply system drains at the head (`core/ecs/host_commands.ts:169-256`). Draining routes each command through the single dispatch `applyHostCommand(ctx, cmd)` (`core/ecs/host_commands.ts:117-160`), which issues the normal deferred `SystemContext` ops — **except `set_field`, which is immediate** and bumps the change tick. That immediate/deferred split is the sharp edge: a `set_field` targeting a component whose add is still pending in the same drain throws an actionable `COMPONENT_NOT_REGISTERED` in dev. `onSpawned` is the only way to learn a spawned id, since the create is deferred; the queue snapshots its length before draining so an `onSpawned` that enqueues more defers to the next drain.

`SpawnEntry` values must be complete — the deferred add writes exactly the fields given, with no zero-default. A `HostCommandRecorder` (`core/ecs/command_log.ts:107`) taps the drain for record/replay; `serializeCommandLog` tags a def in-band as `{ "__component_def": id }` and throws `COMMAND_LOG_TAG_COLLISION` if a command's values map owns that reserved key (`core/ecs/command_log.ts:165-186`). A recorder that would drain on `FIXED_UPDATE` throws `INVALID_RECORDER_SCHEDULE` (the fixed dt diverges on replay).

### Cross-thread ring transport

For writes from a worker or the wire, a second transport decodes fixed-size ring slots into the same `applyHostCommand`. A `HostCommandDispatcher` binds a `ring*Codec` or raw applier per opcode (`core/ecs/host_commands.ts:449-488`); each codec bakes its component/field in because the 15-byte payload can't carry them, and there is deliberately no `spawn`/`add_component` ring codec (variable-width values don't fit a fixed slot). The underlying rings — command, event, action — share a 16-byte header and 16-byte slots with monotonic heads (`core/store/command_ring.ts`, `event_ring.ts`, `action_ring.ts`); the action ring uses `Atomics` on the heads for the cross-thread happens-before edge. `CommandDispatcher` (`core/store/command_dispatch.ts:52`) is the lower-level generic store-side surface the ECS seam builds on.

---

## 18. Memory sizing

Source: `src/core/ecs/ecs_memory.ts`.

`ECSMemoryOptions` is a key-discriminated union — pick exactly one arm, or none (`core/ecs/ecs_memory.ts:145-212`): `budget` (derive sizing from an entity count), `maxBytes` (explicit heap byte cap), `heap`, `shared`, `wasm`, or `allocator` (your own in-place allocator); `columnCapacity` pins per-archetype rows on any arm. `resolveECSMemory` (`core/ecs/ecs_memory.ts:269-553`) turns the chosen intent into a `ResolvedECSMemory` plan — allocator, column capacity, entity-index reservation, byte cap, and a human-readable `derivation` trace, surfaced as `ecs.memoryPlan`.

The **`budget` arm** is the one to reach for: it derives column capacity, a 2×-headroom entity-index reservation, a `3×`-live-footprint byte cap with a 4 MiB floor, and cap-error wording in the caller's terms; `entities > 2^20` throws `INVALID_MEMORY_OPTIONS`. The default (no `memory`) is a growable heap `ArrayBuffer` capped at `DEFAULT_ECS_CAP_BYTES = 256 MiB` (`core/ecs/ecs_memory.ts:59`) with the full 20-bit entity-index reservation.

The byte cap is a **hard ceiling with no grow-beyond fallback** — exceeding it throws `STORE_CAP_EXCEEDED`. Because the entity-index region is reserved eagerly at construction (≈12 MiB virtual at the default cap), an unreasonably small cap throws `STORE_CAP_EXCEEDED` *before the ECS exists*. Every live store requires an in-place allocator (ADR-0008), enforced both by the `InPlaceBufferAllocator` type on the `allocator` arm and a runtime check (`core/ecs/ecs_memory.ts:435-443`). The removed pre-release `initial_capacity` / `buffer_allocator` options throw `INVALID_MEMORY_OPTIONS` loudly from the ECS constructor (`core/ecs/ecs.ts:291-302`) rather than being silently aliased.

---

## 19. Tracing

Source: `src/core/ecs/frame_trace.ts`, `src/core/ecs/dispatch_trace.ts`.

Both tracers are gated by the compile-time `__DEV__` flag and tree-shaken to nothing in production — zero cost in a release build.

**Frame trace** (`core/ecs/frame_trace.ts`) reconstructs the causal sequence of *one frame*. `ecs.setTrace(sink)` (`core/ecs/ecs.ts:509`) attaches a `FrameTraceSink`; the engine then emits ordered events inside each `update()` — systems run per phase, structural commands queued, flush boundaries, observer firings, event emits/reads (`core/ecs/frame_trace.ts:47-90`). The `phaseBoundary(phase)` hook (`core/ecs/frame_trace.ts:82`) fires once per phase right after its flush — the one safe point at which a custom sink may read `ecs.stateHash()` to bisect a determinism divergence to a single phase. The shipped `FrameTraceRecorder` captures each frame as a flat JSON-serializable `FrameTrace` and no-ops `phaseBoundary` (it holds no ECS reference to hash).

**Dispatch trace** (`core/ecs/dispatch_trace.ts`) is a global singleton aggregating event/resource/action dispatch *counts* by call site — a profiling view of how often channels fire. It's double-gated: `__DEV__` removes the call sites in production, and at runtime it stays inert unless `VISUAL_INTEL_TRACE` is set. It resolves call sites from stack traces (cached per line) and is in-memory only.

---

## 20. The reactive and editor seams

These are optional extension entry points; the core ECS never imports a UI library.

**The reactive kernel** (`@oasys/oecs/reactive`, `src/core/reactive/`) is a zero-dependency, fine-grained, glitch-free signals machine: `signal`/`computed`/`effect`/`batch`/`untrack`/`root`/`onCleanup` (`core/reactive/kernel.ts:408-476`). Values are pulled lazily through an intrusive doubly-linked dependency graph; a `computed` bumps its version only when its `eq` reports a changed value, so an equal recompute cuts propagation, and a flush that cascades past `MAX_CASCADE = 100_000` re-runs throws "did not settle" (`core/reactive/kernel.ts:54, 376-381`). Reactive collections (`reactiveMap`/`reactiveStruct`/`reactiveArray`, `core/reactive/{map,struct,array}.ts`) give per-key/per-slot/per-field channels so a reader subscribes to one key alone — `O(changed)`, not `O(all)`.

**The ECS → reactive bridge** (`@oasys/oecs/reactive-sync`, `src/extensions/reactive/ecs_sync.ts`) drains ECS observers into reactive collections, publishing only dirty entities/columns each tick. `syncComponentToMap` (`core/reactive`/`extensions/reactive/ecs_sync.ts:261`) is the workhorse — `grain: "entity"` drains the per-row dirty list, `grain: "column"` sweeps the archetype SoA for high-churn components; `batchedUpdate` wraps `ecs.update(dt)` in a `batch()` so a whole tick's publishes coalesce into one UI flush.

**The editor** (`@oasys/oecs/editor`, `src/extensions/editor/`) adds undo/redo and two-way field handles over the host-write seam. Every edit is a transaction of forward + inverse `HostCommand`s on the one bus; undo enqueues the inverse, redo re-enqueues the forward — undo is just another command applied at the next schedule head (`core/`/`extensions/editor/editor.ts:227-390`). `fieldHandle` wraps one field as a reactive read plus an undoable write for an inspector input.

**The SolidJS adapter** (`@oasys/oecs/solid`, `src/extensions/solid/`) bridges kernel values into Solid; `solid-js` is an optional peer dependency pulled only by this entry.

---

## 21. Type primitives

Source: `src/type_primitives/`, re-exported at `@oasys/oecs/primitives` (`src/primitives.ts`).

The primitives the ECS is built on are also exported standalone:

- **`BitSet`** — a `number[]`-backed auto-growing bit set (`type_primitives/bitset/bitset.ts`). It is the identity of every archetype, the include/exclude/anyOf mask of every query, and (via `hash()`, FNV-1a over non-trailing-zero words) the key of the query cache. Two BitSets with the same bits but different backing lengths hash and compare equal.
- **`SparseSet` / `SparseMap<V>`** — O(1) integer-keyed containers with dense iteration (`type_primitives/sparse_set/`, `sparse_map/`). `SparseMap` backs every sparse component store (§9); the sparse-set pattern also appears in the archetype's per-ComponentID index maps.
- **`GrowableTypedArray`** family — typed arrays with a separate logical length and a doubling backing buffer (`type_primitives/typed_arrays/`). Backs the archetype `entityIds` and the standalone-column path; its `buf`/`view()` reference is invalidated by any append that triggers a grow.
- **`BinaryHeap<T>`** — an array-backed heap with a user comparator (`type_primitives/binary_heap/`), the ready queue inside `topologicalSort`.
- **`topologicalSort`** — Kahn's algorithm over the heap (`type_primitives/topological_sort/`), the deterministic system-ordering core; it throws a plain `TypeError` naming the unschedulable nodes on a cycle.

The internal assertion/brand/error helpers under `src/type_primitives/` are deliberately *not* re-exported (`src/primitives.ts:6-8`). `Brand<T, Name>` (`type_primitives/brand.ts`) is the phantom-symbol nominal-typing helper behind `EntityID`, `ComponentID`, `ArchetypeID`, `SystemID`, `EventID`, `SparseComponentID`, and `RelationID`.

---

## 22. Dev mode

`__DEV__` is a compile-time constant. Every `if (__DEV__) { … }` branch is dead code in production and tree-shaken by the bundler — so everything documented as "throws in dev" is a development tripwire, not a production guarantee. In a production build the same mistake fails *open*: a wrong value, a `NaN`, or silent corruption instead of an exception.

### What gets checked in dev

- **Entity liveness** — every `SystemContext`/`ECS` entry that reads or mutates a specific entity throws `ENTITY_NOT_ALIVE` on a stale handle; deferred ops re-validate at flush.
- **The access checker** — a system touching a column, resource, sparse, or relation it didn't declare throws (§14); the `queries ⊆ reads ∪ writes` lint fires at registration.
- **Bounds and identity** — `createEntityId` bounds (`EID_MAX_*_OVERFLOW`), archetype bounds (`ARCHETYPE_NOT_FOUND`), column membership/field validity (`COMPONENT_NOT_REGISTERED`), `ChangedQuery` watched-id-in-include-mask, dense-only query guard (`SPARSE_QUERY_DENSE_PATH`), sparse cache-key overflow.
- **Scheduling** — duplicate system scheduling (`DUPLICATE_SYSTEM`), the system arity guard (`SYSTEM_FN_ARITY`).
- **Observers** — invalid config, the `onSet`-emit guard (`OBSERVER_ONSET_EMIT`).

### What is always active

Some checks are structural, not tripwires, and run in every build: the topological sort's **cycle detection** (`CIRCULAR_SYSTEM_DEPENDENCY`), the store cap guard (`STORE_CAP_EXCEEDED`), memory-option validation (`INVALID_MEMORY_OPTIONS`), the determinism gate (`DETERMINISM_DISABLED`), the construction-time timestep validators, and duplicate resource/event registration (which would silently overwrite state). Every ECS throw is an `ECSError` carrying a machine-readable `category`; `ECSError`, the `ECS_ERROR` enum, and `isEcsError` are exported from the package root (`core/ecs/index.ts:258`).

---

## 23. Invariants

A short list of cross-cutting invariants worth knowing:

1. **Archetype membership changes only at flush boundaries during system execution.** Inside `forEach`/`eachChunk`, an entity's `(archetype, row)` is stable because all structural ops routed through `SystemContext` are deferred; immediate ops on `ECS` bypass this and must not be called from inside a system.
2. **`_archetypes` is append-only, never reordered.** The store pushes new matching archetypes into each registered query's array (`core/ecs/store.ts:1520`) but never removes; empty archetypes stay and `_nonEmpty()` filters them.
3. **The entity → (archetype, row) map is always consistent.** Every swap-remove returns the swapped entity's index so the store updates the map before returning control; a mismatch would be silent corruption.
4. **Handles to destroyed slots fail `isAlive` after the flush**, and a slot that exhausts its generation is *retired* rather than recycled — closing the ABA window (`core/ecs/store.ts:1959-1965, 1985`).
5. **Registered queries never go stale.** `archInstall` re-checks every registered query on creation and pushes into matching arrays before returning; no background scan is needed.
6. **Per-field writes do not invalidate the non-empty cache.** Only membership changes bump `_queryDirtyEpoch`; repeated iteration within a frame hits the cache.
7. **Change-detection granularity is per `(archetype, component)`.** Writing one row stamps the whole archetype for that component; `ChangedQuery` yields whole archetypes, per-row filtering is the caller's job.
8. **`ctx.lastRunTick` is set per-dispatch, not per-system.** Read it at the top of the body; don't cache across calls. A skipped tick leaves it unadvanced, so nothing is missed across a gated pause.
9. **Deferred ops re-validate generations at flush time**, so an entity destroyed by an earlier deferred op can't crash a later one — the later op becomes a no-op.
10. **Archetype transitions stamp the destination, not the source.** `moveEntityFrom`/`bulkMoveAllFrom` stamp `_changedTick` for *every* component on the destination — so adding or removing any component lights up change detection for every component the entity ends up with.
11. **Events outlive one `update()` and no longer.** `clearEvents` runs once per `update()` before the tick increments; nothing else clears events; onSet runs inside that window and may not emit.
12. **Resources, events, and observer/change-detection state are excluded from `stateHash` and snapshots** — they're per-frame or non-sim scheduling artifacts. Anything you need to reproduce must live in a component (or be re-seeded after restore).
13. **Sparse and relation ids are disjoint from dense component ids.** Sparse membership and relations never touch the archetype mask, cause no transition, and consume no dense-identity bit — which is why relation ops are immediate.
14. **The three id spaces are brand-separated.** `ComponentID`, `SparseComponentID`, and `RelationID` carry distinct phantom brands so a handle from one surface can't be passed to another.
