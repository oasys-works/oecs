# The architecture of oecs (v0.5.4)

This document describes how oecs is built. It covers the division into two layers, which are the
archetype ECS and the storage-neutral column store. It covers the data layout of the entities, the
components, and the archetypes. It covers how a query stays correct as new archetypes appear, and
how the scheduler and the update loop drive the systems. It then covers the machinery for
determinism, observers, relations, and integration with a host, which sits above all of that.

The emphasis is on *how it is built*, and not on *how to use it*. For usage, read the API pages in
[`docs/api/`](./api/), which have one page for each subsystem and an index at
[`api/index.md`](./api/index.md).

Each claim that is not trivial names its source file, so that you can check it. **Each path is
relative to `src/`**, for example `core/ecs/ecs.ts` and `core/store/state_hash.ts`. This document
gives no line numbers, because a line number becomes incorrect as the source changes. To find a
claim in the source, search for the name of the symbol next to the reference.

## Table of contents

1. [Overview](#1-overview)
2. [The storage layer: `ColumnStore`](#2-the-storage-layer-columnstore)
3. [Entities](#3-entities)
4. [Components](#4-components)
5. [Archetypes](#5-archetypes)
6. [The store](#6-the-store)
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
17. [The host write path](#17-the-host-write-path)
18. [Memory size](#18-memory-size)
19. [Traces](#19-traces)
20. [The reactive and editor connections](#20-the-reactive-and-editor-connections)
21. [Type primitives](#21-type-primitives)
22. [Development mode](#22-development-mode)
23. [Invariants](#23-invariants)

---

## 1. Overview

oecs is an archetype-based ECS in two layers:

- **The archetype ECS** (`src/core/ecs/`) — the entities, components, archetypes, queries, systems,
  scheduler, change detection, observers, relations, and the facade. This is what consumer code
  speaks to.
- **The storage-neutral column store** (`src/core/store/`) — one `ArrayBufferLike` that carries
  each component column. It also holds the machinery at the byte level that arranges the buffer,
  grows it, hashes it, and captures it. When you select that option, that machinery also shares the
  buffer across threads, or with WASM.

The core owns the *logic and the identity*. The store owns the *bytes*. The store never knows what
an archetype "means". The ECS never touches a raw offset, except through the typed API of the
store. Only the allocator decides whether those bytes are in a plain `ArrayBuffer`, which is the
default heap profile, in a `SharedArrayBuffer`, or in a `WebAssembly.Memory`
(`core/store/allocator.ts`).

The graph of objects:

```
ECS  (core/ecs/ecs.ts)              — public facade, implements QueryResolver
 ├── Store  (core/ecs/store.ts)     — owns all mutable ECS state
 │     ├── ColumnStore (core/store/column_store.ts) — the one backing buffer + column views
 │     ├── EntityAllocator (core/ecs/entity_allocator.ts) — generational ids, free list, retirement
 │     ├── ArchetypeGraph (core/ecs/archetype_graph.ts) — mask registry, inverted index, transition edges
 │     ├── DeferredCommandBuffer (core/ecs/deferred_commands.ts) — pending add/remove/destroy/toggle queues
 │     ├── SnapshotService (core/ecs/snapshot_service.ts) — deterministic snapshot/resume orchestration
 │     ├── RelationService (core/ecs/relation_service.ts) — relation registry, traversal, hierarchy matching
 │     ├── EventRegistry and ResourceRegistry — events/resources behind Store delegations
 │     ├── component metadata (per-ComponentID field layout + observer flags)
 │     ├── entity → (ArchetypeID, row) mapping (SAB-backed Int32Array pair)
 │     ├── sparse component stores
 │     └── registered live Query result arrays
 ├── Schedule  (core/ecs/schedule.ts)         — 7 phases, per-phase topological sort
 ├── SystemContext  (core/ecs/query.ts)       — the restricted ctx handed to systems
 └── ObserverRegistry  (core/ecs/observer.ts) — onAdd/onRemove/onSet/onEnable/onDisable
```

`ECS` is the only entry point that external code speaks to (`core/ecs/ecs.ts`). A system receives a
`SystemContext`, and not the `ECS` (`core/ecs/query.ts`). That context sends each structural change
through a deferred buffer, so that live iteration stays correct.

- **An entity** is a packed 31-bit integer: a 20-bit slot index and an 11-bit generation
  (`core/ecs/entity.ts`).
- **A component** is a branded, *callable* handle. Its field schema is a phantom type at compile
  time (`core/ecs/component.ts`). Storage is struct-of-arrays: one typed-array column for each
  field.
- **An archetype** groups each entity with an identical component mask (`core/ecs/archetype.ts`).
  The fields are in columns that the `ColumnStore` buffer supports.
- **A query** resolves the include, exclude, and anyOf masks to a live `Archetype[]` array. The
  store keeps that array current (`core/ecs/store.ts`, `core/ecs/archetype_graph.ts`).
- **Change detection** is one tick value for each `(archetype, component)` pair
  (`core/ecs/archetype.ts`), compared against the last-run tick of each system.
- **A system** is a plain function that declares the components in its `reads` and `writes`. A
  development-mode access checker holds it to those declarations.
- **Observers, relations, sparse storage, determinism, and the host write path** are additional
  subsystems above the same store.

### Entry points

The package has several import paths. Each one past the core is optional, and it costs nothing
until you import it (`index.ts`, `primitives.ts`, `shared.ts`, `extensions/*`).

| Import | Source | What it is |
| --- | --- | --- |
| `@oasys/oecs` | `core/ecs` | the ECS — the pure-TS heap profile by default |
| `@oasys/oecs/primitives` | `primitives.ts` | the data structures that operate alone (`BitSet`, `SparseSet`, and others) |
| `@oasys/oecs/shared` | `shared.ts` | the `SharedArrayBuffer` and WASM allocators (these need COOP/COEP) |
| `@oasys/oecs/reactive` | `reactive` | the reactive kernel, which has no dependencies |
| `@oasys/oecs/reactive-sync` | `extensions/reactive` | the bridge from the ECS to the kernel (it publishes only the changed data) |
| `@oasys/oecs/editor` | `extensions/editor` | undo, redo, and field handles |
| `@oasys/oecs/solid` | `extensions/solid` | the SolidJS adapter (`solid-js` is an optional peer dependency) |
| `@oasys/oecs/internal` | `internal.ts` | the unstable internal parts (codecs, ABI constants, the access checker) |

---

## 2. The storage layer: `ColumnStore`

Source: `src/core/store/`.

A `ColumnStore` is **one backing buffer** that carries each component column. It also has a
`DataView`, a decoded header, and a map of the column views of each archetype
(`core/store/column_store.ts`). The buffer type is `ArrayBufferLike`, which is neutral about the
storage by design. So the same code drives a heap `ArrayBuffer`, a `SharedArrayBuffer`, or a
`WebAssembly.Memory`.

### The layout of the buffer

The buffer has this layout, in byte order (`core/store/column_store.ts`):

```
[52-byte header]
[mechanism prefix regions: command-ring, entity-index, event-ring, action-ring]
[region-table directory + consumer regions]
[opaque WASM sim-bindings block]
[layout descriptor region]
[aligned column data]
```

Each part before the descriptor region keeps a **stable byte offset across a growth**. This is what
lets a WASM simulation, or a worker, hold a raw pointer to the entity index and never find that
address again.

**The header** (52 bytes) is the root of the ABI. `core/store/vendored_abi/abi.ts` is the one
source of truth for each binary offset: `STORE_MAGIC = 0x314d4953` (the ASCII text `SIM1`,
`core/store/vendored_abi/abi.ts`), `STORE_HEADER_BYTES = 52` (`core/store/vendored_abi/abi.ts`),
and 13 `u32` header fields (`core/store/vendored_abi/abi.ts`). Those fields are:

- the magic number and the ABI version;
- `view_stamp`, the capacity, and the number of archetypes;
- the offset of the descriptor region;
- the offset of each ring, of the entity index, of the region table, and of the bindings block.

`header.ts` adds the semantic `StoreHeader` interface, with `writeStoreHeader` and
`readStoreHeader` (`core/store/header.ts`), and `bumpViewStamp` (`core/store/header.ts`), which is
what makes a cached view invalid.

**The order of the regions carries meaning.** `STORE_PREFIX_REGIONS` declares the four *mechanism*
regions of the engine, which are the command ring, the entity index, the event ring, and the action
ring, one time and in byte order (`core/store/store_regions.ts`). The offset of each region is
`STORE_HEADER_BYTES + Σ(the bytes of the earlier regions)`. A change to the order of that list is a
change to the ABI, and golden tests on the header hold it in place. A host declares a *consumer*
region with `StoreRegionSpec`. Those regions are in a generic region table that describes itself,
and an opaque `region_id` addresses them. The engine never interprets that id
(`core/store/region_table.ts`). This table replaced five header fields that were specific to one
game.

### The column descriptors

The table that answers "where is each column" is at `header.layoutDescriptorOff`. It is a sequence
of `ArchetypeDescriptor` records of variable size. Each record has a 36-byte header
(`core/store/vendored_abi/abi.ts`: the archetype id, a component mask of 4 words, the number of
rows, the row capacity, the number of columns, and the number of enabled rows). After that header
come N `ColumnDescriptor` records of 16 bytes each (`core/store/vendored_abi/abi.ts`:
`component_id`, `field_id`, `type_tag`, `byte_off`, and `stride`). The engine walks the region by
the column count of each archetype, and there is no offset table (`core/store/descriptor.ts`).
`TYPE_TAG_STRIDE` (`core/store/descriptor.ts`) maps a tag to a byte width, and it drives each
alignment calculation.

### The views and the column keys

`makeView` constructs a concrete typed array over the buffer, at the byte offset of a column
(`core/store/column_store.ts`). The key of a column is `columnKey = (componentId << 16) | fieldId`
(`core/store/column_store.ts`). So the column map of each archetype has numeric keys, which is the
fast path in V8, and a lookup allocates no string.

`planLayout` does the offset calculation. It gives a size to the descriptor region. Then, for each
column, it does
`cursor = alignUp(cursor, stride); byteOff = cursor; cursor += stride * rowCapacity`
(`core/store/column_store.ts`).

### `BufferBackedColumn`

A column is a view with a fixed capacity and a **logical length**, which the engine tracks above
the immutable `view.length` (`core/store/buffer_backed_column.ts`). It has the shape of a
`GrowableTypedArray` API, with `push`, `pop`, `swapRemove`, `bulkAppend`, and other methods. But it
**cannot grow itself**. If it overflows, it throws `StoreColumnOverflowError`
(`core/store/buffer_backed_column.ts`), because growth is a reallocation at the level of the store.
`refreshView` (`core/store/buffer_backed_column.ts`) points it at a new view after a reallocation,
and it keeps the logical length.

In the live ECS, `Archetype.fromColumnStore` (`core/ecs/archetype.ts`) builds each archetype. So
each column is a `BufferBackedColumn` view into the one store buffer, and the heap profile and the
shared profile differ *only* in the allocator. The abstract `ColumnFactory` and `ColumnBacking`
interface (`core/ecs/archetype.ts`) also accepts a heap `GrowableTypedArray` backing, which the
tests use in isolation.

### Growth and extension

Two operations change the shape of the buffer. Both reallocate and publish again
(`core/store/grow.ts`, `core/store/extend.ts`):

- **Grow** increases the row capacity of the archetypes that exist. `growColumnStore`
  (`core/store/grow.ts`) doubles the archetype that overflowed, and the store drives it
  (`core/ecs/store.ts`). When the allocator operates in place and did not change, it takes a fast
  path. That path moves the columns of the archetypes that grow to the end of the buffer, and it
  builds only their views again (`core/store/grow.ts`). It abandons the old column region as a hole
  that it does not reclaim, and geometric doubling bounds that waste at about 1×. In each other
  condition, it captures the live columns, reallocates, and writes them back.
- **Extend** adds *new* archetypes at the end of the buffer. This is the primitive that the live
  ECS uses when a new combination of components appears for the first time
  (`core/store/extend.ts`). Its fast path in place appends the new column offsets and descriptors
  into space that it reserved in the descriptor region, and it touches no byte that exists. So the
  views that exist stay valid (`core/store/extend.ts`).

**There are two byte limits, and not one.** The limit of the allocator, which you can set and which
is 256 MiB by default, gives `StoreCapExceededError` (`core/store/allocator.ts`). It is a signal of
growth that has no control, and it is far below the absolute structural limit of `2^31` bytes
(`STORE_MAX_BYTE_OFFSET`, `core/store/column_store.ts`). That structural limit exists because the
bitwise operation in `alignUp` in JavaScript converts to a signed 32-bit integer, so an offset past
`2^31` would wrap. `alignUp` checks the value *before* the bitwise operation
(`core/store/column_store.ts`), and it throws `StoreLayoutOverflowError`.

### The entity index

The map `EntityID → (archetype_id, row, generation)` is in a mechanism region. So a WASM simulation
can resolve a target on a different entity, with no callback into TypeScript
(`core/store/entity_index.ts`). Its layout is a small header plus three parallel `Int32Array`
columns, which hold the generations, the archetypes, and the rows. `-1` is the `UNASSIGNED` value,
and it passes through the signed columns correctly. The default capacity is `1 << 20`
(`core/store/entity_index.ts`), which is the full 20-bit `EntityID` space. That is about 12 MiB of
*virtual* memory, but only a small number of KiB of physical memory for a small world. So
`createEntity` can never run out of space under the default plan.

### The state hash

`columnStoreStateHash` is one FNV-1a-32 pass over the full snapshot of the column store: the
header, the descriptors, the entity index, the mechanism and consumer regions, and the bytes of the
column capacity (`core/store/state_hash.ts`, `core/store/snapshot.ts`). The canonical fold of one
byte is `hash = (hash ^ (b & 0xff)) >>> 0; Math.imul(hash, FNV1A_PRIME) >>> 0`
(`core/store/state_hash.ts`). There is also a coarser variant that folds one word at a time, for
the hash of the live rows at a higher level (`core/store/state_hash.ts`). The digest is
**independent of the storage type** for two stores with the same bytes and the same history of
growth. But it scales with the `capacity` of the snapshot, and not with the number of live rows
alone, and that is intentional. `view_stamp` is part of the hash by design: two stores at the same
logical state, but with a different history of reallocation, give different hashes. For the digest
of determinism of the simulation, which scales with the live rows and which folds the sparse and
relation data, use `Store.stateHash()` (§16).

### The snapshot

A snapshot is a `Uint8Array` view over the buffer, with no copy (`core/store/snapshot.ts`). Its
size is the `capacity` that the engine reads live from the view. It does not use the cached header,
which can be out of date, and it does not use `byteLength`, which the engine rounds up to a page.
Restore validates the magic number, the version, and the bound on the length of the header, through
a `DataView`, **before it allocates**. The bounds check on `layout_descriptor_off` runs immediately
after that. It then allocates at the exact length of the snapshot and copies. It converts a raw
`RangeError` from truncated input into a `StoreRestoreError` (`core/store/snapshot.ts`).

---

## 3. Entities

Source: `src/core/ecs/entity.ts`, with the allocator in `src/core/ecs/entity_allocator.ts`.

### The packed handle

`EntityID` is a branded number (`core/ecs/entity.ts`) with the layout `[generation:11][index:20]`.
It has 31 bits in total, so the sign bit is never set. Constants hold the limits in place
(`core/ecs/entity.ts`): `INDEX_BITS = 20`, `MAX_INDEX = 1,048,575`, `GENERATION_BITS = 11`,
`MAX_GENERATION = 0x7FF = 2047`, and `MAX_ENTITY_ID = 0x7FFFFFFF`. The pack and unpack functions
are plain bit operations: `createEntityId(i, g) → (g << 20) | i` (`core/ecs/entity.ts`),
`getEntityIndex → id & 0xFFFFF` (`core/ecs/entity.ts`), and `getEntityGeneration → id >> 20`
(`core/ecs/entity.ts`). The signed right shift is correct, because the packed value never sets bit
31.

### The slot allocator, recycling, and retirement

`EntityAllocator` manages the slots. It has an array of generations that a `SharedArrayBuffer`
supports, a high-water mark, a count of live entities, and a stack for the free list
(`core/ecs/entity_allocator.ts`). `Store.createEntity` asks the allocator for an id, and it records
the new slot in the empty archetype with the row `UNASSIGNED` (`core/ecs/store.ts`). The entity
uses no row until you add a component. The allocator itself takes a slot from the free stack, or it
advances the high-water mark (`core/ecs/entity_allocator.ts`).

Destruction (`_destroyOne`, `core/ecs/store.ts`) does four steps. It removes the entity from its
archetype with a swap. It marks the archetype and the row of that entity as `UNASSIGNED`. It
removes the relations and the sparse data of that entity. It then asks the allocator to recycle the
slot. Recycling increases the generation of the slot, *or* it writes `RETIRED_GENERATION` (2047)
when the counter would run out (`core/ecs/entity_allocator.ts`). The engine never recycles a
**retired** slot. This closes the ABA problem for a stale handle, which plain wraparound would open
.

### Liveness

`isAlive` fails safely (`core/ecs/store.ts`). It rejects an id that is out of range, and it rejects
the `RETIRED_GENERATION` value. It then tests that the current generation of the slot agrees with
the handle, inside the high-water mark. A handle to a recycled slot fails the comparison of the
generation. A stale handle to a retired slot fails it also, because the slot holds the value 2047,
which no live handle carries. The explicit test for that value rejects a handle that literally
carries generation 2047.

---

## 4. Components

Source: `src/core/ecs/component.ts`, with the registration in `src/core/ecs/store.ts`.

A component is a schema that maps a field name to a typed-array tag. `TagToTypedArray`
(`core/ecs/component.ts`) maps each of the eight tags (`f32 f64 i8 i16 i32 u8 u16 u32`) to a
concrete typed-array class. So a column accessor gives the correct type at compile time.

### The callable handle

`ComponentDef<S>` is a **callable** branded handle (`core/ecs/component.ts`):

```ts
interface ComponentDef<S> {
  (...values: ValuesArg<S>): Bundle<S>;   // call it → a (def, values) bundle
  readonly id: ComponentID;               // the raw numeric id
  readonly [__schema]?: [S];              // phantom — never exists at runtime
}
```

`makeComponentDef` makes one as a closure, and it installs a `.id` that is not enumerable, through
`defineProperty` (`core/ecs/component.ts`). So a spread operation and `JSON.stringify` do not see a
definition. The schema `S` travels on the call signature **and** on the phantom `[__schema]` slot.
The call signature alone would make each definition assignable to the tag schema, because a
callable tag needs no argument. So the phantom tuple is what stops a schema with values from
becoming a tag. An internal part that does not need the schema takes a `ComponentHandle` (`{ id }`,
`core/ecs/component.ts`) instead. A call to a definition, or a call to the free function
`bundle(def, values)` (`core/ecs/component.ts`), gives a `Bundle`. That is a pair of a definition
and a subset of the values, and the spawn and add paths that take a variable number of arguments
accept it. The engine writes `0` in each absent field at the attach.

### Registration, the identity budget, and the rule against floats

`registerComponent` takes a dense id from a counter that only increases. It then records
`ComponentMeta` in a parallel array (`core/ecs/store.ts`). That record holds the field names, an
index map, the types, and the flags for the high-frequency observer path. It holds you to
`STORE_DESCRIPTOR_COMPONENT_LIMIT = 128` (`core/store/descriptor.ts`), which is the budget of dense
identities and which comes from the component mask of 4 words. Past that limit it throws
`COMPONENT_LIMIT_EXCEEDED`. On a deterministic ECS, `_rejectNonDeterministicFields`
(`core/ecs/store.ts`) rejects an `f32` or `f64` column at registration
(`NON_DETERMINISTIC_COLUMN_TYPE`), because IEEE-754 rounds differently in different engines.

### Tags

A tag is a component with an empty schema. `registerTag` calls the registration with `{}`. A tag is
part of the archetype mask, but it stores no column. An archetype with tags alone has
`hasColumns === false` (`core/ecs/archetype.ts`), and it takes the fast paths that need no column
(§5). A definition that you do not call is also a bundle of zeros, or a tag, at each position that
expects a bundle.

---

## 5. Archetypes

Source: `src/core/ecs/archetype.ts`.

An archetype groups each entity that shares an identical component mask. Its identity is the
`BitSet` at `core/ecs/archetype.ts`, where bit *b* is set if and only if `ComponentID` *b* is in
the signature. The concrete `Archetype` class implements the read-only `ArchetypeView` interface,
which a query gives to `forEach`. That view exposes read accessors and counts alone. So iteration
can never bypass the contract of the deferred flush.

### The layout of the columns

Each archetype owns a dense flat column store, plus sparse index maps that a `ComponentID` keys:

- `_flatColumns: ColumnBacking[]` — the column of each field of each component, packed one after
  the other. Its index space is the same as that of `ColumnStore.columnsInOrder`.
- `_colOffset[cid]`, `_fieldCount[cid]`, `_fieldIndex[cid]`, and `_fieldNames[cid]` — where the
  fields of component `cid` start, and what their names are.
- `_columnIds` — a dense list of the `ComponentID` values that carry a column. The paths that move,
  copy, and set a tick iterate it.
- `columnGroups[cid]` — a richer `{ layout, columns }` object, which `createRef` keeps for the key
  of its prototype cache.
- `_changedTick[cid]` — the tick of the last change of each component. **This is the only level of
  detail for change tracking: one value for each component in each archetype. The archetype has no
  dirty bit for each row.** Tracking at the level of the entity is an optional list on the side of
  the store (§8 and §11).
- `_mutGroupCache` and `_readGroupCache` — one object with field keys, for each component, that
  `eachChunk` uses again. `_syncRowPlane` points these objects at the current buffers. A call to
  `cols.mut` or `cols.read` writes no property, and it makes no test for a stale buffer.

The constructor walks the layouts that it receives. It allocates one column for each field through
the `columnFactory`, and it records the offsets. The entity ids are in a separate
`GrowableUint32Array`.

### The row plane

A column is a `ColumnBacking` object, and its API (`push`, `pop`, `swapRemove`, and the `buf`
accessor) costs a call, a capacity comparison, and a load and store of the length **for each column
and for each row**. But `Archetype.length` is already the row count of every column. So the
archetype keeps a **row plane**: a cache of the raw views, and it places a row itself.

- `_bufs: AnyTypedArray[]` — the raw view of each column, with the same index space as
  `_flatColumns`. A read of a field is `_bufs[i][row]`.
- `_eids` — the raw view of the entity ids.
- `_colCap` is the smallest column capacity, and `_rowCap` is that value against the capacity of
  the entity-id array. An append compares against `_rowCap` one time, and not against each column.

`_syncRowPlane` is the **only** writer of `_bufs`, `_eids`, `_colCap`, and `_rowCap`. It fills
`_bufs` in place, so a caller that kept the array sees the new buffers. It runs at construction,
and after each operation that can change the identity of a buffer: a grow, a restore, and a refresh
of the views. It also runs on the path where a grow throws, because the entity-id array grows
before the columns do. A cap refusal must not leave the plane on a buffer that the engine
abandoned. A development assertion compares `_bufs[0]` against `_flatColumns[0].buf` and raises
`ARCHETYPE_ROW_INVARIANT` if the two disagree.

### The division into enabled and disabled rows

Each archetype divides its rows. The rows in `[0, enabledCount)` are enabled, and the rows in
`[enabledCount, length)` are disabled. `entityCount` gives `enabledCount` by default.
It gives `length` only while a module flag is set, during an `includeDisabled()` iteration.
`totalCount` is `length`, and `disabledCount` is the difference. So a usual
`for (i < arch.entityCount)` loop skips the disabled rows at no cost.

A disable or an enable is **one row swap, and no archetype transition**. `disableRow` swaps the row
with the last enabled row, and it decreases `enabledCount`. `enableRow` is the inverse. Each path
that places or removes a row tests the usual condition "there are no disabled rows" (`enabledCount
=== length`) first. So an archetype that never disables a row pays nothing.

### Membership

Each change of membership keeps the rows adjacent, because it removes a row with a swap from the
end:

- `addEntity` pushes the id and one zero into each column. It calls the grow handler if the next
  push would exceed the capacity of the `SharedArrayBuffer`. It then places the row in the enabled
  region through `_placeTail`.
- `removeRow` is the swap-remove that knows about the division of the rows, and it updates
  `entityRow` itself. The low-frequency `_removeRowPartitioned` handles an archetype that has
  disabled rows. (`removeEntity`, `core/ecs/archetype.ts`, is the simpler variant that assumes
  "enabled or last". It remains for direct callers and for the tests.)
- `addEntityTag` and `removeEntityTag` skip each column operation, for an archetype that has tags
  alone.
- `addEntityWithValues` and `addEntitiesWithValues` write the values of a template directly into
  the columns in one pass. So they do not write zeros and then write over them. They also set the
  tick of each component.

### Transitions between archetypes

To move one entity, the engine uses a transition map that it calculated in advance. `ArchetypeEdge`
caches both directions of a transition of one component: the ids of the target archetypes, plus the
`Int16Array` plans `addMap` and `removeMap` for the column copy. `buildTransitionMap` builds the
map with an index of the *destination* column position. For each destination column, the value is
the source column index of the shared component, or `-1` for a new column.

`moveEntityFrom` does one pass. It appends the id, copies each destination column from
`srcCols[map[i]]`, or writes `0` when `map[i] < 0`, keeps the enabled or disabled state of the
entity, and removes the entity from the source. It **sets `_changedTick` for each component in the
destination**, and not only for the component that caused the move. So an add or a remove of any
component starts change detection for each component on the new archetype. `moveEntityFromTag` is
the variant that needs no column. `bulkMoveAllFrom` moves each row of a source through
`TypedArray.set`, and it is the primitive behind each batch operation on a full archetype. Each
move method writes its `[dstRow, swappedIndex]` result into a tuple at module scope that it uses
again, `_moveResult`, so that a call allocates nothing.

### The column accessors and how the engine sets a tick

The read-only view exposes `getColumnRead`, `getColumnsRead`, and `getOptionalColumnRead`. These
give live buffers with a read-only type, and they do not change the tick. The **mutable** accessors
are on the concrete `Archetype`, and never on the view. `getColumn(def, field, tick)` sets
`_changedTick[cid]` and then gives the column. `columnGroupMut(def, tick)` resolves each column of
one component into the object with field keys that the engine uses again, and it sets the tick
**one time**. This is what `cols.mut` in `eachChunk` calls. `columnGroupRead` is the read variant
that does not set a tick. The row writers `writeFields` and `writeFieldsPositional`, and
`copySharedFrom`, also set the tick. `readField` does not.

### The mask operations

`matches(required)` is one `BitSet.contains` call. `hasComponent(id)` is one bit test. The engine
caches the transition edges of each component in the sparse `edges` array. The edges for several
components, and the composite add edges, have their own caches. Each cache only grows, and the
engine never makes one invalid.

---

## 6. The store

Source: `src/core/ecs/store.ts`, plus the collaborators that the code extracted from it:
`entity_allocator.ts`, `archetype_graph.ts`, `deferred_commands.ts`, `relation_service.ts`,
`event_registry.ts`, `resource_registry.ts`, and `snapshot_service.ts`.

`Store` arranges the mutable data of the ECS. It still exposes the typed API that `ECS` and
`SystemContext` use. But several subsystems that were once inside it are now behind narrow services
that a closure supplies:

- the allocation of an entity slot, in `EntityAllocator`;
- the archetype topology, in `ArchetypeGraph`;
- the policy for the drain of deferred structural changes, in `DeferredCommandBuffer`;
- the relations, in `RelationService`;
- the events and the resources, in their registries;
- the snapshot and resume operations, in `SnapshotService`.

The engine never gives `Store` to external code.

### The registry of archetypes

`ArchetypeGraph` owns the archetype topology (`core/ecs/archetype_graph.ts`). It has
`archetypes[]`, with an index by id. It has `archetypeMap: Map<hash, ArchetypeID[]>`, which puts
the archetypes in buckets by `BitSet.hash()`. It has `componentIndex: ArchetypeID[][]`, an inverted
index from a component id to the archetypes that contain it. That index **only grows, holds no
duplicate, and ascends strictly, by construction**, because `install` is its one writer and the
engine makes each id in an increasing sequence (`core/ecs/archetype_graph.ts`). That
order is what lets `getMatchingArchetypes` start from the smallest bucket, and what lets
`_forEachChangedArchetype` skip a sort.

`ArchetypeGraph.getOrCreateFromMask` (`core/ecs/archetype_graph.ts`) hashes the mask and scans the
bucket with `BitSet.equals`. When it does not find the archetype, it asks `Store` to do three
steps:

1. Extend the column store.
2. Build the `Archetype` over the live `ColumnStore`.
3. Add that archetype to each registered query that agrees with it. The constructor of `Store`
   creates the empty archetype. `ArchetypeGraph.createManyFromMasks`
   (`core/ecs/archetype_graph.ts`) is the bulk variant for preparation, and it does one extension
   of the column store for each new archetype together.

### The edges of the archetype graph

The engine resolves the transition of one component when it first needs it, and it caches the
result in `ArchetypeGraph.resolveAdd` and `ArchetypeGraph.resolveRemove`
(`core/ecs/archetype_graph.ts`), which `Store.archResolveAdd` and `Store.archResolveRemove` reach.
The graph stops immediately if the component is already present or already absent. If not, it uses
the cached edge. If there is no cached edge, it creates the target archetype, through `copyWithSet`
or `copyWithClear` on the mask, and it calls `cacheEdge` (`core/ecs/archetype_graph.ts`), which
stores both directions plus the `Int16Array` transition maps. After the first transition, each
later "add X to archetype A" is one lookup in a sparse array, plus a column copy with no branch.

### The map from an entity to an archetype and a row

Two parallel `Int32Array` arrays, which a `SharedArrayBuffer` supports and which an entity index
keys, use `-1` as `UNASSIGNED`. They stay on `Store`, because they describe membership. The
generations of the slots, the high-water mark, the count of live entities, and the recycling of the
free list are in `EntityAllocator` (`core/ecs/entity_allocator.ts`). The primary swap-remove path,
`removeRow`, which knows about the division of the rows (`core/ecs/archetype.ts`), updates
`entityRow` itself as it swaps. The remaining paths, `removeEntity` and `removeEntityTag`, give the
index of the entity that they swapped, so that the store can update it.

### The deferred buffers and the flush model

A system must not change the membership of an archetype during iteration. So each write from a
`SystemContext` goes into flat parallel arrays on `DeferredCommandBuffer`
(`core/ecs/deferred_commands.ts`): `destroyIds`, `addIds` with `addDefs` and `addValues`,
`removeIds` with `removeDefs`, and `toggleIds` with `toggleDisable`. There is no wrapper object for
each operation.

`DeferredCommandBuffer` owns `flushStructural`, and `Store.flushStructural` reaches it
(`core/ecs/store.ts`, `core/ecs/deferred_commands.ts`). It has two paths:

- **The fast path with no observer** (`core/ecs/deferred_commands.ts`) runs `_flushAdds`, then
  `_flushRemoves`, then `_flushToggles`. It is byte-for-byte the same as the flush before observers
  existed. The toggles run last, so that a disable or an enable sees the final archetype of the
  entity for this tick.
- **The path with observers** (`core/ecs/deferred_commands.ts`) commits the batch, and then runs
  the observers in a canonical order. It repeats until it reaches a fixed point, so that a cascade
  settles. The order is the adds and removes first, then the destroy operations, then the toggles.
  `OBSERVER_MAX_ROUNDS` protects the loop. An observer never sees a state that is only partially
  applied, because an observer runs only after a round that commits. A re-entrant `ctx.flush()`
  call from inside a callback goes into the loop that is already running.

`_flushAdds` handles three cases for each add in the buffer:

- The component is already present, so it writes over the values in place.
- The entity has no row, so it allocates one.
- The entity has a source row, so it uses `moveEntityFrom`.

It writes the fields through `writeFields(..., this._tick)`. `_flushRemoves` is the mirror image,
through `archResolveRemove`. Each flush loop **validates the generation of the entity again, in
place** (`idx >= hw || entGens[idx] !== gen → skip`, for example `core/ecs/store.ts`). So a stale
handle that a caller put in the buffer earlier in the tick becomes a quiet no-operation.
`flushDestroyed` drains the destroy operations with the same validation of the generation, and it
retires or recycles each slot.

### Enable and disable

The immediate `disableEntity` and `enableEntity` functions move the row inside its archetype,
through `disableRow` or `enableRow`, with no transition. They update the query epoch only when
`enabledCount` crosses zero. The deferred variants push to the toggle buffer and drain in the order
of the operations at the flush, where they become one net observed transition for each entity.

### The registration of a query, and the dirty epoch

`registerQuery` fills a result array through `getMatchingArchetypes`, and it records
`{ includeMask, excludeMask, anyOfMask, result, query }`. The array that it gives back is the live
array that `_fanIntoQueries` pushes each new match into. `getMatchingArchetypes` does the first
intersection. With an empty required mask it scans each archetype. If not, it finds the **smallest
bucket in `componentIndex`** among the required bits, and it filters that bucket.

A change of membership increases one `_queryDirtyEpoch` counter, which only increases. Each `Query`
caches its subset of non-empty archetypes against the last epoch that it saw (§7). A new archetype,
which is empty, does **not** increase the epoch (`core/ecs/archetype_graph.ts`,
`core/ecs/store.ts`). The engine tracks a row count in the `SharedArrayBuffer` descriptors that is
out of date with a separate flag, `_rowCountsDirty`, and `publishRowCountsToDescriptor` writes
those counts.

### The batch operations and the tick

`batchAddComponent` and `batchRemoveComponent` move a full archetype at one time, through
`bulkMoveAllFrom` plus fills of the fields. They do one copy for each column, and not one move for
each entity. They reject an archetype that has disabled rows (`PARTITION_BULK_INTO_DISABLED`). The
`ECS` copies the write tick for change detection, `_tick`, at the start of each `update()` call
(`core/ecs/ecs.ts`). So each tick that the engine sets inside a frame uses one value.

---

## 7. Queries

Source: `src/core/ecs/query.ts`, with the cache in `QueryCache`, the live registration in
`src/core/ecs/store.ts`, and the connection to the resolver in `src/core/ecs/ecs.ts`.

A `Query<Defs>` owns the following (`core/ecs/query.ts`):

- the live result array `_archetypes: Archetype[]`, which the store owns;
- the `_include`, `_exclude`, and `_anyOf` BitSet masks;
- a `_nonEmptyArchetypes` cache, with the epoch flag `_lastSeenEpoch`;
- a stable `_id`;
- small lists of terms for the members that are not dense (`_sparseInclude`, `_optional`,
  `_relationIncludes`, `_hierarchy`, and `_includeDisabled`).

Those lists are frozen empty objects by default, so a dense query allocates none of them.

### Resolution and caching

Each cache for query resolution is in one `QueryCache` object (`core/ecs/query.ts`), which the
resolver sees as `ECS._caches` (`core/ecs/ecs.ts`). `_resolveQuery` (`core/ecs/ecs.ts`) calculates
the key from the three mask hashes:
`incHash ^ imul(excHash, HASH_GOLDEN_RATIO) ^ imul(anyHash, HASH_SECONDARY_PRIME)`. It then asks
`QueryCache.findDedup` to scan the collision bucket linearly, with `BitSet.equals`
(`core/ecs/query.ts`). When it finds no match, it does four steps. It registers a live array with
the store. It puts that array in a `Query` with a new id. It updates the back-reference of the
store to the query. It then adds an entry to the cache. `ECS.query(...defs)` uses one scratch
`BitSet` again, so that a call allocates nothing (`core/ecs/ecs.ts`). `QueryBuilder.with(...)`
(`core/ecs/query.ts`) is the entry point at registration time, which
`registerSystem(fn, qb => qb.with(...))` uses.

### Composition

Each verb that makes a query more exact (`and`, `without`, `anyOf`, `optional`, `changed`,
`includeDisabled`, and the sparse, relation, and hierarchy terms) derives a new cached query. The
engine remembers each one in **shared caches for one term, keyed by
`(parentQueryId << 16) | componentId`**, or by the equivalent sparse or relation id, inside
`QueryCache`. There is one map for each verb, so the memory is O(verbs), and not O(queries × verbs)
(`core/ecs/query.ts`). `_carryNondense` (`core/ecs/query.ts`) makes composition independent of
order: a dense verb resolves on the mask alone, and it carries each term that is not dense to the
new query. So `q.optional(V).and(H)` and `q.and(H).optional(V)` are the same query.

### The subset of non-empty archetypes

`_nonEmpty()` (`core/ecs/query.ts`) compares `_lastSeenEpoch` against the `_queryDirtyEpoch` value
of the store, and it builds the subset again when the cache is out of date. `_rebuildNonEmpty`
(`core/ecs/query.ts`) **builds a new array and puts it in place**, and it does not shorten the
array that exists. So a re-entrant iteration keeps the array that it started with. It filters the
archetypes on `totalCount > 0`, under `includeDisabled`, or on `enabledCount > 0`. A write to a
field never touches the epoch. So repeated iteration inside a frame uses the cache.

### The terminal functions

- `forEach(cb)` (`core/ecs/query.ts`) calls back one time for each non-empty archetype, with a
  read-only `ArchetypeView`. In development it asserts that the query is dense only, and it
  publishes a scope for an optional fetch, for `.optional(T)`. The code writes its default body in
  place, and it does not send that body to another function, because the call site has many shapes
  that V8 will not put in line.
- `eachChunk(cb)` (`core/ecs/query.ts`) is the high-frequency path that writes. It allocates one
  `ChunkColumns` cursor, reads the current tick **one time**, and, for each archetype, points the
  cursor at that archetype and gives `arch.entityCount` as the `count`. `ChunkColumns`
  (`core/ecs/query.ts`) resolves `mut(def)` to `columnGroupMut`, which sets the tick, and
  `read(def)` to `columnGroupRead`. The cursor belongs to one call, so nested `eachChunk` passes
  are safe.
- `forEachEntity(cb)` (`core/ecs/query.ts`) gives the matching entities one id at a time. It is
  **necessary** for each query that carries a sparse, relation, or hierarchy term, because those
  members are distributed across the archetypes and have no span of columns. It uses the match
  drivers for sparse data, relations, and hierarchies in the resolver.
- `entityCount`, `archetypeCount`, and `archetypes` (`core/ecs/query.ts`) are getters for
  introspection.

The dense terminal functions are `forEach`, `eachChunk`, `entityCount`, and `archetypeCount`. They
reject a query with a sparse, relation, or hierarchy term, through `_assertDenseOnly` and
`SPARSE_QUERY_DENSE_PATH` (`core/ecs/query.ts`). A dense walk would miss the members that are not
dense, with no signal.

---

## 8. Change detection

Change detection goes through each layer. The ECS owns a tick counter. The archetype carries one
tick value for each component. Each write path sets that value. `ChangedQuery` then filters the
archetypes by a comparison against the last-run tick of each system.

### The tick

`ECS._tick` (`core/ecs/ecs.ts`) starts at 0, and it increases at the end of each `update()` call
(`core/ecs/ecs.ts`). `Store._tick` (`core/ecs/store.ts`) gets its value at the start of `update()`
(`core/ecs/ecs.ts`). So each tick value that the engine sets inside a frame is the same, and
`ctx.ecsTick` reads it (`core/ecs/query.ts`). The schedule writes `ctx.lastRunTick` immediately
before the `fn` of each system, and it exposes the *previous* run tick of that system
(`core/ecs/schedule.ts`). Startup and the first `update()` call both run with tick 0.

### What sets `_changedTick`

The mutable column paths on the archetype set `_changedTick[cid]`. They are `getColumn`,
`columnGroupMut` (which is `cols.mut`), `writeFields` and `writeFieldsPositional`,
`copySharedFrom`, `addEntityWithValues`, and the three move paths, of which each one sets the value
for *every* component on the destination. At the level of the facade and the context, `setField`
and `updateField` write the column and set the value, and `ctx.ref` sets it immediately when you
create the ref. The read paths do not set it: `getColumnRead`, `columnGroupRead` (which is
`cols.read`), `readField`, `getField`, and `ctx.refRead`.

### `ChangedQuery`

`Query.changed(...defs)` (`core/ecs/query.ts`) gives a `ChangedQuery` that contains the base query
and the ids of the components to watch. The constructor asserts that each id is in the include mask
(`core/ecs/query.ts`). Its `forEach` (`core/ecs/query.ts`) reads the threshold *again at each
call*, through `_query._ctxLastRunTick()`. It walks the non-empty archetypes of the base query, and
it gives each archetype where `arch._changedTick[id] >= lastTick` for one or more of the ids that
it watches. At the first run of a system, `lastRunTick` is 0, so it visits each non-empty matching
archetype. The `ChangedQuery` itself composes: `and`, `without`, `anyOf`, and `optional` derive the
base query again and put the result in a new `ChangedQuery` (`core/ecs/query.ts`). So
`q.changed(P).without(D)` is equal to `q.without(D).changed(P)`.

**The level of detail is one `(archetype, component)` pair.** A write to one row sets the value for
the full archetype, for that component. `ChangedQuery` gives full archetypes, and a filter on each
row is your task. For exact information about each entity, use an `onSet` observer with entity
granularity (§11).

---

## 9. Sparse storage

Source: `src/core/ecs/sparse_store.ts`, with the connections in `src/core/ecs/store.ts`.

A sparse component is *outside* the archetype identity. So an add or a remove causes **no archetype
transition**, and it uses **no** bit of the dense identity. `SparseComponentID` is a separate id
space from `ComponentID` (`core/ecs/sparse_store.ts`). It indexes the `sparseStores` array of the
store (`core/ecs/store.ts`), and never the archetype mask. A different phantom brand stops a sparse
definition from entering the dense surface of `addComponent` and `getField`
(`core/ecs/sparse_store.ts`).

`SparseComponentStore` (`core/ecs/sparse_store.ts`) holds the membership and the data of one
component. It is a `SparseMap<number[]>` that an **entity index** keys
(`core/ecs/sparse_store.ts`). The presence of a key is the membership, and each value is a row of
field values by position (`[]` for a tag). Because the key is an entity index, a swap-remove of a
dense neighbour never disturbs the sparse data. Only the destruction of an entity does that,
through the removal hook of the store. Each read and write (`has`, `getField`, `setField`,
`setRow`, and `remove`) is O(1). The registration is the mirror image of a dense component, with a
record form, an array shorthand, and a tag form. The same rule against floats for determinism
applies at the registration surface of the store.

For iteration, `indices` (`core/ecs/sparse_store.ts`) is the live key array in swap order, which
`forEachEntity` walks. `canonicalIndices()` (`core/ecs/sparse_store.ts`) gives a sorted copy, which
is the order for determinism that `stateHash` and the snapshot use. The snapshot and restore
functions serialize the members in the canonical order, with a fingerprint of the schema in the
header (`core/ecs/sparse_store.ts`). The restore fails safely for a difference in the number of
stores, the number of fields, the identity of the schema, `MAX_INDEX`, or the bytes at the end
(`SparseRestoreError`).

---

## 10. Relations

Source: `src/core/ecs/relation.ts`, `src/core/ecs/relation_service.ts`,
`src/core/ecs/builtin_relations.ts`, with the connections in `src/core/ecs/store.ts`.

A relation is a `(relation, target)` pair on a source entity, and it is a first-class object. It is
built **on the class for sparse storage**. So an add, a remove, or a change of target causes no
archetype transition and uses no identity bit, and each relation operation is immediate. They are
safe during a tick for exactly that reason: no dense row moves. `RelationID` is a third id space
(`core/ecs/relation.ts`).

### Storage

Each `RelationStore` (`core/ecs/relation.ts`) owns a **reverse index** that does not depend on the
cardinality: `Map<targetEntityID, Set<sourceEntityID>>`. The key is the *full* `EntityID`, which is
the index and the generation. So a recycled target slot cannot look like the sources of a dead
target. The store also holds a handle on a sparse store below it. The forward representation is
virtual:

- **Exclusive** (the default) — the forward link *is* a `{ target: f64 }` sparse row
  (`core/ecs/relation.ts`). A second `addRelation` call writes over the first. There is one target
  for each source.
- **Multi** — the membership is a sparse tag, and the set of targets is in a separate
  `Map<sourceIndex, Set<target>>` (`core/ecs/relation.ts`). Those set values are not in the sparse
  store. So the engine folds them into `stateHash` and serializes them explicitly.

A reverse lookup (`sourcesOf`) sorts in ascending order on the low-frequency path
(`core/ecs/relation.ts`). The public reads, the wildcards (`pairsOf` for `(R, *)`, and
`sourcesOfAny` for `(*, T)`), the traversal helpers, the arrangement of the cleanup, and the cycle
detection are on `RelationService` (`core/ecs/relation_service.ts`). `Store` keeps one-line calls
into that service, for the public facade (`core/ecs/store.ts`).

### Wildcards and query terms

`ANY_RELATION` (`core/ecs/relation.ts`) is an authorization value for a `(*, T)` query.
`forEachRelatedTo` reads the reverse index of each relation, so it cannot name one specific
relation. So you authorize it with `relationReads: [ANY_RELATION]` instead. The relation terms of a
query (`withRelation` and `withoutRelation`) resolve the *sparse id below the relation*, and they
use the sparse match driver again. They record the `RelationDef` only for the development access
check (`core/ecs/query.ts`). `hierarchy(relation, maxDepth)` puts a matched set into depth order,
with each parent before its children, over an exclusive relation (`core/ecs/query.ts`,
`core/ecs/relation_service.ts`).

### The cleanup policies

`onDeleteTarget` decides what happens to the *sources* of a relation when the engine destroys a
*target* (`core/ecs/relation.ts`). `"delete"` destroys the sources, and it repeats down the tree.
`"clear"` removes the link but keeps the sources. `"orphan"`, which is the overall default, leaves
the link in place. Under `orphan` the reverse index grows until each source points at a different
target or is destroyed. `compactRelations`, through `pruneDeadReverse`
(`core/ecs/relation_service.ts`, `core/ecs/relation.ts`), reclaims the reverse entries of destroyed
targets at a scene or snapshot boundary. It changes no observable state, and it does not change
`stateHash`.

### The supplied relations

`registerChildOf` and `registerIsA` (`core/ecs/builtin_relations.ts`) are small free functions
above `registerRelation`, and both are always exclusive. `ChildOf` uses `"delete"` by default, so
the destruction of a parent destroys the subtree. `IsA` uses `"clear"` by default, and it records
the link only. There is **no inheritance of components**: an instance does not get the components
of its exemplar.

---

## 11. Observers

Source: `src/core/ecs/observer.ts`.

An observer runs a callback when the engine adds, removes, or sets a component, or when it enables
or disables the entity of that component. It is the push equivalent of a `changed()` query, which
you must poll. `ecs.observe(def, config)` (`core/ecs/ecs.ts`) registers one, and it gives a handle
that you can dispose of. The shape of the config selects the kind: structural (`onAdd`, `onRemove`,
`onDisable`, and `onEnable`), `onSet` with archetype granularity (the default), or `onSet` with
entity granularity. The declared `access` of each observer builds a `SystemDescriptor`. So the
access checker validates its callbacks exactly as it validates a system.

### When each callback runs

- **`onAdd` and `onRemove`** run at the **structural flush boundary**, after the deferred batch is
  committed. So an observer never sees a state that is only partially applied. The flush repeats
  until it reaches a fixed point, so that a cascade settles (`dispatchStructural`,
  `core/ecs/observer.ts`, which `core/ecs/deferred_commands.ts` drives).
- **`onDisable` and `onEnable`** run at the same boundary, one time for each net transition across
  a drain, for each component that the entity carries.
- **`onSet`** runs at the detection point after the update, which is the end of the tick, from
  `ECS.update` after each phase (`core/ecs/ecs.ts`). *Archetype granularity* uses the change tick,
  which costs nothing more: `store._forEachChangedArchetype` runs the callback one time for each
  archetype column that changed, and it advances the baseline of the observer
  (`core/ecs/observer.ts`, `core/ecs/store.ts`). *Entity granularity* drains an optional dirty
  list, which has one entry for each row: `store._takeDirty(cid)` (`core/ecs/observer.ts`,
  `core/ecs/store.ts`). **Registration of it turns on dirty tracking for each row** of that
  component (`core/ecs/observer.ts`, `core/ecs/store.ts`). It runs only for an entity that is still
  alive, still present, and still enabled at the time of the drain.

### The deterministic order

Two layers together make a replay reproducible. **Across observers**, the order is topological on
the access: a writer of `X` comes before a reader of `X`, and a tie breaks on the component id and
then on the registration id. This is the "glitch-free" order. **Inside one observer**, the order is
ascending `EntityID`, through an LSD radix sort of O(K), and never through `Array.sort`. **Inside
one structural round**, the order is remove, add, disable, enable: the edges that leave come before
the edges that enter. `stateHash` and the snapshots do not include the observer state, but the
engine produces it in a canonical order, so a replay reproduces it.

`yieldExisting: true` runs `onAdd` again over the current *enabled* matches at registration. An
emission of an event from `onSet` throws `OBSERVER_ONSET_EMIT` (§15). A cyclic dependency between
observers reduces the quality of the sort but does not break it. But the loop that finds the fixed
point raises `OBSERVER_NON_CONVERGENT` if it never settles (`core/ecs/deferred_commands.ts`).

---

## 12. Events

Source: `src/core/ecs/event.ts`, with the storage and lifetime in `src/core/ecs/event_registry.ts`,
`src/core/ecs/store.ts`, and `src/core/ecs/ecs.ts`.

An event is a typed, send-and-forget message. A system emits it and reads it inside one frame. The
implementation is one `EventChannel` for each event id, and `EventRegistry` owns them
(`core/ecs/event_registry.ts`). An `EventChannel` (`core/ecs/event.ts`) holds one plain `number[]`
column for each field, plus a `reader` that it built in advance. The fields of that reader *are*
those column arrays, and its `length` is a counter that changes. So `ctx.read(key).amount[i]` reads
directly from the storage, with no copy. `emit` validates each field before it pushes any of them,
which is a development-mode check that prevents a loss of synchronization in the middle of the
loop. It then pushes one value into each column and increases `reader.length`
(`core/ecs/event.ts`). `emitSignal` increases the counter alone. `clear` sets the counter to zero
and shortens each column.

`EventKey<S>` and `SignalKey` are branded symbols that carry a phantom schema
(`core/ecs/event.ts`), and `eventKey` and `signalKey` make them at module scope
(`core/ecs/event.ts`). A signal carries an extra phantom, so that the type system stops you if you
give it a payload. `ECS.update` clears each dirty channel as its last action before it increases
the tick (`core/ecs/ecs.ts`). `startup()` clears the events of the startup phases separately
(`core/ecs/ecs.ts`). So an event exists for exactly one `update()` call, and frame 1 never sees an
old startup event. The storage of the events is separate from the archetype graph, and `stateHash`
and the snapshots do not include it.

---

## 13. Resources

Source: `src/core/ecs/resource.ts`, with the storage in `src/core/ecs/resource_registry.ts` and the
calls in `src/core/ecs/store.ts`.

A resource is one value with the scope of the world, and a `ResourceKey<T>` keys it. That key is a
symbol that carries its value type as a phantom (`core/ecs/resource.ts`), and `resourceKey` makes
it one time at module scope (`core/ecs/resource.ts`). The storage is a plain `Map<symbol, unknown>`
inside `ResourceRegistry` (`core/ecs/resource_registry.ts`), with one-line calls from `Store`
(`core/ecs/store.ts`). `registerResource` inserts one time, and a second registration throws
`RESOURCE_ALREADY_REGISTERED`. `getResource` and `setResource` throw `RESOURCE_NOT_REGISTERED` for
a key that is absent. `removeResource` fails safely, and it releases the key for a new
registration. `hasResource` is the one lookup that never throws. There is no change tracking, there
is no column for each field, and there is no link to an archetype. The value can be any JS value.
`stateHash`, the snapshots, and the restore functions **do not include resources**. So a resource
never disturbs determinism.

---

## 14. Systems and the scheduler

Source: `src/core/ecs/system.ts`, `src/core/ecs/schedule.ts`, `src/core/ecs/run_condition.ts`, and
`src/core/ecs/access_check.ts`.

### The configuration of a system

A `SystemConfig` (`core/ecs/system.ts`) carries:

- `fn`;
- the necessary `reads` and `writes` access declarations;
- the optional structural, resource, sparse, and relation declarations;
- the `queries` field, for a check;
- the lifecycle hooks `onAdded`, `onRemoved`, and `dispose`;
- the `exclusive` bypass flag;
- an optional `backendHandle`.

`registerSystem` (`core/ecs/ecs.ts`) makes the three forms uniform (config, function alone, and
function with a query builder). It runs a development guard on the number of parameters, which
gives `SYSTEM_FN_ARITY` for a function alone with three parameters that has no query builder. It
runs the `_assertQueriesDeclared` check (`queries ⊆ reads ∪ writes`, which gives
`QUERY_ACCESS_UNDECLARED`, `core/ecs/system.ts`). It then freezes a `SystemDescriptor`, which is
the identity handle that you use to schedule the system, to set its order, and to remove it.

### The access checker

For each descriptor, `access_check.ts` derives an `AccessSets` object (`core/ecs/access_check.ts`)
and caches it in a `WeakMap`. Each write implies a read, and it authorizes `addComponent` on that
column. The `spawns`, `transitions`, and `despawns` fields authorize the adds and removes. The
resource, sparse, and relation terms fill their own sets (`computeSets`,
`core/ecs/access_check.ts`). A module singleton, `accessCheck` (`core/ecs/access_check.ts`), tracks
the active span. `enter(desc)` sets it, and an `exclusive` system leaves `sets` as null, so each
check passes (`core/ecs/access_check.ts`). `leave` clears it. Each `check*` function returns
immediately when no span is active, which is why a call from the host is not checked. A run
condition gets a variant that permits reads only. So each write that a predicate tries fails
(`core/ecs/access_check.ts`).

### The phases and the order

`SCHEDULE` is an enum of 7 values (`core/ecs/schedule.ts`): `PRE_STARTUP`, `STARTUP`, and
`POST_STARTUP` run one time, through `startup()`; `FIXED_UPDATE` runs at a fixed timestep, inside
`update()`; `PRE_UPDATE`, `UPDATE`, and `POST_UPDATE` run one time in each frame. Each system that
you schedule becomes a `SystemNode` with an `insertionOrder` value that only increases, and with
`before` and `after` edge sets. Inside a phase, `sortSystems` builds a map of adjacency from the
`before` and `after` constraints of each node and of each set, and it removes the edges to a
different phase. It then calls the shared `topologicalSort`, which is Kahn's algorithm with a
`BinaryHeap` queue of ready nodes and with `insertionOrder` as the deterministic value that breaks
a tie. The engine caches the result for each phase as a **phase plan**, and it clears that cache on
a change. It raises a cycle again as `CIRCULAR_SYSTEM_DEPENDENCY`, and the message names the phase.
**The build tool never removes cycle detection from a production build**, because the sort needs it
to be correct. `hasFixedSystems` holds the node list of `FIXED_UPDATE` directly, so a frame makes
no lookup by key to find out whether a fixed step is necessary.

### System sets and run conditions

A `SystemSet` is a handle with the identity of an object. Each member inherits its `runIf`,
`before`, and `after` configuration, which `configureSet` sets. The engine reads that configuration
*live*, at the time of the run or the sort, so it respects a later `configureSet` call. A
`RunCondition` (`core/ecs/run_condition.ts`) is a pure, read-only gate for each tick, and the
engine evaluates it inside an access span that permits reads only. The effective gate of a member
is the AND of its own conditions and of the conditions of each of its sets (`shouldRun`). The
engine evaluates the conditions of a set one time for each set in each phase. So each member shares
one result for that phase. The supplied conditions are `runIfResourceEq`, `runEveryNTicks`, and
`runIfAnyMatch`. A schedule with no set and no condition takes a byte-for-byte fast path, because
the engine skips the gate completely when `gatedSystems` is empty.

### The tick bookkeeping of each system

The last-run tick of each system is in `systemLastRun`, which is a packed array. A **slot**, which
is a small integer, indexes it. `lastRunSlots` maps a descriptor to its slot, and only `addSystems`
and `removeSystem` consult that map. The phase plan carries the slot of each system in a parallel
`slots` array, next to the sorted descriptors. So the loop for each frame reads and writes the tick
through an index, and it makes no lookup by object identity.

`runLabel` is the high-frequency loop. For each sorted system, it tests the gate, sets
`ctx.lastRunTick` to the *previous* run tick of that system, and runs `fn` inside an access span.
It runs `backend.run(handle)` instead, when a compute backend is attached and the system carries a
`backendHandle`. It then records the *current* tick as the last run of that system. After the
phase, it calls `ctx.flush()`, and, in development, it calls the `phaseBoundary` trace hook. A
system that a `false` condition skips leaves its last-run tick unchanged, and it puts nothing in a
queue. So a tick that a system skips is byte-identical to a tick in which the system is absent,
which is what keeps `changed()` correct across a period in which a gate stopped the system.

A phase copies the `slots` array of its plan into a local before it runs. So a system that you
remove from inside that phase still runs from the snapshot, and it still writes its last-run tick.
The engine therefore **recycles a slot only outside a running drive**. If it recycled a slot during
the drive, the write of the removed system could land on the tick of a system that you added in the
same drive. That write would then move the `changed()` window of the new system. Between drives the
slots recycle as before, so the array stays bounded.

---

## 15. The update loop

Source: `src/core/ecs/ecs.ts`.

`ECS.update(dt)` does the following, in order:

1. It records the access span of the caller, in development. It restores that span in a `finally`
   block. So a system that drives the `update()` of a *second* world from inside its own span does
   not lose the development checks.
2. `store._tick = this._tick` copies the write tick for the full frame.
3. `publishRowCountsToDescriptor()` writes any mutation from the host into the `SharedArrayBuffer`
   descriptors, before the first phase.
4. **The catch-up for the fixed update** runs only when fixed systems exist. It does
   `accumulator += dt`. It then limits `accumulator` to `maxFixedSteps * fixedTimestep`, which is
   the protection against the spiral of death. It then runs `FIXED_UPDATE` one time for each full
   `fixedTimestep` in the accumulator, and each run has the delta `fixedTimestep`.
5. `schedule.runUpdate(ctx, dt, _tick)` runs `PRE_UPDATE`, `UPDATE`, and `POST_UPDATE`, and it
   flushes `ctx` between the phases and after the last one.
6. **The dispatch of `onSet`** runs while `store._tick` is still equal to this tick. So an `onSet`
   observer, at either level of detail, sees exactly the writes of this tick. In development, an
   `onSet` observer that emitted an event throws `OBSERVER_ONSET_EMIT`, because the next step would
   remove the emission, and it would break the determinism of a snapshot.
7. `store.clearEvents()` is the last mutation of the tick. An event exists for exactly one update.
8. `_tick++`.

Each fixed step in one frame shares one tick value. The engine does not clear an event that a fixed
step emitted until the end of `update()`. `fixedAlpha` exposes `accumulator / fixedTimestep`, for
interpolation of the display. `startup()` does four steps:

1. It prepares the closure of archetypes over each system and observer (`prewarmArchetypes`,
   `core/ecs/ecs.ts`).
2. It runs the `onAdded` hook of each system, inside an access span.
3. It runs the three startup phases, with a delta of 0.
4. It clears the startup events.

`_tick` is 0 through startup and through the systems of the first `update()` call. It becomes 1
only after the first `update()` call ends.

---

## 16. Determinism, snapshot, and replay

Source: `src/core/ecs/store.ts`, `src/core/ecs/snapshot_service.ts`, `src/core/ecs/resume.ts`,
`src/core/store/state_hash.ts`, and `src/core/store/snapshot.ts`.

A deterministic ECS (`new ECS({ deterministic: true })`) guarantees that the same operations give
the same state, bit for bit, across storage types and after a snapshot and a restore. The flag
controls exactly the surface that has a canonical order: `stateHash`, `snapshot` and `restoreInto`,
and `snapshotSparse` and `restoreSparse`. Each of them throws `DETERMINISM_DISABLED` when the flag
is off (`core/ecs/store.ts`). The invariants for memory safety, and the division into enabled and
disabled rows, are always on.

### `stateHash`

`Store.stateHash` (`core/ecs/store.ts`) folds an FNV-1a digest. For each archetype, in id order, it
folds `(id, the number of live rows, the number of enabled rows)` and the bytes of the live
columns, one word at a time. It then folds the sparse stores in the canonical index order. It then
folds the forward target sets of the multi relations, in the canonical order. The digest is
independent of the storage type, and it scales with the number of live entities, and not with the
capacity of the buffer. The digest is opaque. Compare it only at a tick boundary, or at a
`phaseBoundary` settle point, and never against a literal that you wrote by hand.

### Snapshot and restore

`Store` controls `snapshot()` (`core/ecs/store.ts`), and `SnapshotService.snapshot` implements it
(`core/ecs/snapshot_service.ts`). It captures three sections into one frame that is complete in
itself (`core/ecs/resume.ts`):

- the **dense** section: the column bytes, the entity index, and the layout descriptors;
- the **sparse** section: the sparse components and the relations, in the canonical order;
- the **host bookkeeping** section (`SnapshotService.collectHostState`,
  `core/ecs/snapshot_service.ts`). It holds the tick, the free list of recycled entities *in live
  LIFO order*, the count of live entities, and the length and the number of enabled rows of each
  archetype.

The engine serializes the order of the free list, and it does not scan that order again. The order
is pure history of destruction, with no source in the bytes, and it carries meaning for a resume
that is byte-identical.

`Store` controls `restoreInto` (`core/ecs/store.ts`), and `SnapshotService.restoreInto` implements
it (`core/ecs/snapshot_service.ts`). It **validates completely before it touches the live
storage**. It reads the dense magic number and version, the capacity of the entity index, the set
of archetypes, and the `(componentId, fieldId, typeTag)` identity of each column, directly from the
incoming bytes (`assertDenseLayoutMatchesLive`, `core/ecs/resume.ts`). It also validates the sparse
section (`core/ecs/snapshot_service.ts`). Only then does it write. Each difference throws
(`ECSRestoreError` or `SparseRestoreError`), and it leaves the live ECS unchanged. It does not
capture the resources, the events, or the baselines of change detection. The conditions: the target
ECS must have the same registration of components and archetypes, which means that you must prepare
it, the same capacity of the entity index, and `deterministic: true`.

### Record and replay

Each mutation from a host or a UI crosses one apply control point (§17). So a log of the applied
commands for each tick, plus the `dt` of each tick and a seed, is enough to replay a session.
`replayCommandLog` (`core/ecs/command_log.ts`) pushes the commands from the seed time, calls
`startup()`, and then, for each tick, pushes the commands and calls `update(dt)`. It does this for
an empty tick also, because the `dt` drives the simulation. With `{ hash: true }` on a
deterministic ECS, it gives the sequence of `stateHash` values for each tick. The equality of that
sequence across two replays *is* the test of fidelity.

---

## 17. The host write path

Source: `src/core/ecs/host_commands.ts`, `src/core/ecs/command_log.ts`, with the ring transports in
`src/core/store/`.

A write that starts *outside* the schedule, in a UI, an editor, a network handler, or a worker,
cannot touch the ECS during a frame without corruption of the live iteration. The host write path
makes each write from outside a **typed command**. It holds that command outside the schedule, and
it applies it at one approved point.

`installHostCommandSeam(ecs, opts?)` (`core/ecs/host_commands.ts`) gives a `HostCommandQueue`, and
it registers **one `exclusive` apply system for each phase head that you configured**, which is
`[PRE_STARTUP, PRE_UPDATE]` by default. Each method of the queue adds a command to the queue, and
nothing reaches the ECS until the apply system drains at the head of the phase
(`core/ecs/host_commands.ts`). The drain sends each command through one dispatch function,
`applyHostCommand(ctx, cmd)` (`core/ecs/host_commands.ts`), which issues the usual deferred
structural operations of a `SystemContext`. The exception is `set_field`, **which is immediate**
and which sets the change tick. That division between immediate and deferred is the one difficult
point. Look at a `set_field` command that targets a component whose add is still in the queue in
the same drain. In development it throws a `COMPONENT_NOT_REGISTERED` error that tells you what to
do. `onSpawned` is the only way to learn the id of a new entity, because the create is deferred
from the point of view of the host. The callback runs after the id exists, and after the component
adds are in the queue, but before those adds flush. The queue records its length before it drains,
so a command that the callback adds waits for the next drain.

The type of `spawnEntry` demands the complete `FieldValues<S>` (`core/ecs/host_commands.ts`). If
command data that has no type omits a field, the shared `writeFields` path writes `0` in it. A
`HostCommandRecorder` (`core/ecs/command_log.ts`) connects to the drain for record and replay.
`serializeCommandLog` tags a definition in the data as `{ "__component_def": id }`, and it throws
`COMMAND_LOG_TAG_COLLISION` if the values map of a command owns that reserved key
(`core/ecs/command_log.ts`). A recorder that would drain on `FIXED_UPDATE` throws
`INVALID_RECORDER_SCHEDULE`, because the fixed delta gives a different result on a replay
(`core/ecs/host_commands.ts`).

### The ring transport between threads

For a write from a worker or from the wire, a second transport decodes ring slots of a fixed size
into the same `applyHostCommand`. A `HostCommandDispatcher` connects a `ring*Codec`, or a raw apply
function, to each operation code (`core/ecs/host_commands.ts`). Each codec holds its component and
field inside itself, because the payload of 15 bytes cannot carry them
(`HOST_COMMAND_PAYLOAD_BYTES`, `core/ecs/host_commands.ts`). There is deliberately no ring codec
for `spawn` or `add_component`, because values of a variable width do not fit a slot of a fixed
size. The rings below (the command ring, the event ring, and the action ring) share a header of 16
bytes and slots of 16 bytes, with heads that only increase (`core/store/command_ring.ts`,
`event_ring.ts`, `action_ring.ts`). The action ring uses `Atomics` on the heads for the
happens-before edge between threads. `CommandDispatcher` (`core/store/command_dispatch.ts`) is the
lower-level generic surface on the side of the store, and the connection in the ECS is built on it.

---

## 18. Memory size

Source: `src/core/ecs/ecs_memory.ts`.

`ECSMemoryOptions` is a union that a key discriminates. Select exactly one arm, or none:

- `budget` derives the size from a number of entities;
- `maxBytes` is an explicit byte limit on the heap;
- `heap`, `shared`, and `wasm` select a storage type;
- `allocator` takes your own allocator that operates in place.

`columnCapacity` sets the number of rows for each archetype, on any arm. `resolveECSMemory` turns
the intention that you selected into a `ResolvedECSMemory` plan. That plan has the allocator, the
column capacity, the reservation of the entity index, the byte limit, and a `derivation` trace that
a person can read. `ecs.memoryPlan` exposes it.

The **`budget` arm** is the one to select. It derives:

- the column capacity;
- a reservation of the entity index, with 2× of extra space;
- a byte limit of 3× the live memory, with a floor of 4 MiB;
- the words of a limit error, in the terms of the caller.

A value of `entities` more than 2^20 throws `INVALID_MEMORY_OPTIONS`. The default, with no `memory`
option, is a heap `ArrayBuffer` reserved **fixed, and not resizable, at the full limit**, where
`DEFAULT_ECS_CAP_BYTES = 256 MiB`, with the full 20-bit reservation of the entity index. Fixed, and
not resizable, is deliberate (version 0.5.3). V8 has no fast path for element access on a
TypedArray view over a resizable `ArrayBuffer`. A heap storage that could grow thus removed that
fast path from each `col[i]` operation. The buffer is now fixed at the limit, so each `col[i]`
operation keeps the fast path. The pages arrive when a program touches them, so the resident memory
follows the live use, and not the reservation. Growth still happens in place, because the engine
moves the columns *inside* the fixed buffer, and it uses the logical `capacity` in the header, and
not `buffer.byteLength`. So the identity of the buffer never changes, and each view that exists
stays valid. Only the heap storage is fixed. The `shared` and `wasm` storage keep their resizable
buffers and their layout.

The byte limit is an **absolute limit with no alternative that grows past it**. If you exceed it,
it throws `STORE_CAP_EXCEEDED`. The engine reserves the region of the entity index immediately at
construction, which is about 12 MiB of virtual memory at the default limit. So a limit that is
unreasonably small throws `STORE_CAP_EXCEEDED` *before the ECS exists*. Each live store requires an
allocator that operates in place. The `InPlaceBufferAllocator` type on the `allocator`
arm holds you to that, and a run-time check does also. The pre-release options `initial_capacity`
and `buffer_allocator` no longer exist. They throw `INVALID_MEMORY_OPTIONS` clearly, from the
constructor of the ECS (`core/ecs/ecs.ts`), and the engine does not accept them as an alias
quietly.

---

## 19. Traces

Source: `src/core/ecs/frame_trace.ts` and `src/core/ecs/dispatch_trace.ts`.

The compile-time `__DEV__` flag controls both tracers, and the build tool removes them completely
from a production build. So they cost nothing in a release build.

**The frame trace** (`core/ecs/frame_trace.ts`) rebuilds the sequence of causes and effects of *one
frame*. `ecs.setTrace(sink)` (`core/ecs/ecs.ts`) attaches a `FrameTraceSink`. The engine then emits
ordered events inside each `update()` call (`core/ecs/frame_trace.ts`):

- the systems that ran, in each phase;
- the structural commands that went into the queue;
- the flush boundaries;
- the observers that ran;
- the emissions and the reads of events.

The `phaseBoundary(phase)` hook (`core/ecs/frame_trace.ts`) runs one time for each phase,
immediately after the flush of that phase. It is the one safe point at which a sink that you write
can read `ecs.snapshots.stateHash()` and reduce a divergence of determinism to one phase. The
supplied `FrameTraceRecorder` captures each frame as a flat `FrameTrace` that you can serialize to
JSON. It does nothing in `phaseBoundary`, because it holds no reference to an ECS and so cannot
read the hash (`core/ecs/frame_trace.ts`).

**The dispatch trace** (`core/ecs/dispatch_trace.ts`) is a global object. It collects the *counts*
of the dispatches of events, resources, and actions, by call site. It is a profile of how
frequently a channel runs. It has two gates: `__DEV__` removes each call site from a production
build, and at run time it stays inactive unless `VISUAL_INTEL_TRACE` is set. It finds the call
sites from stack traces, and it caches the result for each line. It is in memory only.

---

## 20. The reactive and editor connections

These are optional extension entry points. The core ECS never imports a UI library.

**The reactive kernel** (`@oasys/oecs/reactive`, `reactive/`) is a fine-grained, glitch-free
machine for signals, and it has no dependencies. It has `signal`, `computed`, `effect`, `batch`,
`untrack`, `root`, and `onCleanup` (`reactive/kernel.ts`). It pulls each value when a reader needs
it, through a dependency graph of intrusive doubly-linked lists. A `computed` value increases its
version only when its `eq` function reports a change. So a recompute that gives an equal value
stops the propagation. A flush that continues past `MAX_CASCADE = 100_000` reruns throws "did not
settle" (`reactive/kernel.ts`). The reactive collections (`reactiveMap`, `reactiveStruct`, and
`reactiveArray`, in `reactive/{map,struct,array}.ts`) give a channel for each key, each field, or
each slot. So a reader subscribes to one key alone, which is `O(changed)`, and not `O(all)`.

**The bridge from the ECS to the kernel** (`@oasys/oecs/reactive-sync`,
`src/extensions/reactive/ecs_sync.ts`) drains the ECS observers into the reactive collections, and
in each tick it publishes only the changed entities and columns. `syncComponentToMap`
(`extensions/reactive/ecs_sync.ts`) is the primary function. With `grain: "entity"` it drains the
dirty list of each row. With `grain: "column"` it examines the struct-of-arrays storage of the
archetype, which is better for a component that changes frequently. `batchedUpdate` puts
`ecs.update(dt)` inside a `batch()` call, so that the publications of a full tick go together into
one UI flush (`extensions/reactive/ecs_sync.ts`).

**The editor** (`@oasys/oecs/editor`, `src/extensions/editor/`) adds undo, redo, and field handles
that operate in two directions, above the host write path. Each edit is a transaction with a
forward list of `HostCommand` values and an inverse list, on the one queue. Undo puts the inverse
list in the queue, and redo puts the forward list in the queue again. So undo is only one more
command that the engine applies at the next phase head (`extensions/editor/editor.ts`).
`fieldHandle` makes one field into a reactive read plus a write that you can undo, for an input in
an inspector (`extensions/editor/field_handle.ts`).

**The SolidJS adapter** (`@oasys/oecs/solid`, `src/extensions/solid/`) brings the values of the
kernel into Solid. `solid-js` is an optional peer dependency, and only this entry point imports it.

---

## 21. Type primitives

Source: `type_primitives/`, exported again at `@oasys/oecs/primitives` (`primitives.ts`).

The package also exports the primitives that the ECS is built from, so that they can operate alone:

- **`BitSet`** — a bit set that grows automatically, with a `number[]` behind it
  (`type_primitives/bitset/bitset.ts`). It is the identity of each archetype. It is also the
  include, exclude, and anyOf mask of each query. Through `hash()`, which is FNV-1a over the words
  that are not trailing zeros, it is also the key of the query cache. Two `BitSet` objects with the
  same bits, but with different lengths behind them, give the same hash and compare as equal.
- **`SparseSet` and `SparseMap<V>`** — containers with integer keys and O(1) operations, with dense
  iteration (`type_primitives/sparse_set/` and `sparse_map/`). `SparseMap` supports each sparse
  component store (§9). The sparse-set pattern also appears in the index maps of an archetype that
  a `ComponentID` keys.
- **The `GrowableTypedArray` family** — typed arrays with a separate logical length and a backing
  buffer that doubles (`type_primitives/typed_arrays/`). They support the `entityIds` of an
  archetype, and the path for a column that operates alone. An append that causes growth makes the
  `buf` and `view()` reference invalid.
- **`BinaryHeap<T>`** — a heap with an array behind it and a comparator that you supply
  (`type_primitives/binary_heap/`). It is the queue of ready nodes inside `topologicalSort`.
- **`topologicalSort`** — Kahn's algorithm over the heap (`type_primitives/topological_sort/`). It
  is the deterministic core that puts the systems in order. It throws a plain `TypeError` for a
  cycle, and the message names the nodes that it cannot schedule.

The package deliberately does *not* export the internal helpers for assertions, brands, and errors,
under `type_primitives/` (`primitives.ts`). `Brand<T, Name>` (`type_primitives/brand.ts`) is the
helper for nominal typing with a phantom symbol, and it is behind `EntityID`, `ComponentID`,
`ArchetypeID`, `SystemID`, `EventID`, `SparseComponentID`, and `RelationID`.

---

## 22. Development mode

`__DEV__` is a compile-time constant for a build that a bundler makes. Each `if (__DEV__) { … }`
branch is dead code in a production build, and the bundler removes it. **Production is the default
on both distribution channels**, because `dev_flag.ts` resolves `DEV` to `false` when nothing
defines `__DEV__`. On npm, `@oasys/oecs` is the production build, with the guards removed. A
bundler in development mode selects the build with the guards automatically, or you can import
`@oasys/oecs/dev`. The `vite build` command emits both variants (`scripts/build.mjs`). On JSR and
Deno, which use the raw source, there is no bundler. So the engine turns the guards on and off, and
it does not remove them. To turn them on, set `globalThis.__DEV__ = true` before the first import.
In both conditions, each behavior that the documentation describes as "throws in development" is a
development aid, and not a production guarantee. In a production build, the same mistake fails
*without a signal*: you get an incorrect value, a `NaN`, or quiet corruption, and not an exception.
See the [Development guards and production builds](PRODUCTION.md) guide.

### What the engine checks in development

- **The liveness of an entity** — Each entry point on a `SystemContext` or on the `ECS` that reads
  or mutates one specific entity throws `ENTITY_NOT_ALIVE` for a stale handle. A deferred operation
  validates the handle again at the flush.
- **The access checker** — A system that touches a component, a resource, a sparse component, or a
  relation that it did not declare throws (§14). The `queries ⊆ reads ∪ writes` check runs at
  registration.
- **Bounds and identity** — The engine checks the bounds of `createEntityId` (`EID_MAX_*_OVERFLOW`)
  and the bounds of an archetype (`ARCHETYPE_NOT_FOUND`). It checks the membership of a column and
  the validity of a field (`COMPONENT_NOT_REGISTERED`). It checks that each id in a `ChangedQuery`
  is in the include mask. It runs the guard for a query that must be dense only
  (`SPARSE_QUERY_DENSE_PATH`), and it detects an overflow of a sparse cache key.
- **The row invariants of an archetype** — The engine compares the cached row plane against the
  backing columns, and it tests the capacity that a reserve gave and the partition boundary that a
  restore gave. A disagreement throws `ARCHETYPE_ROW_INVARIANT`. This reports a failure of an
  internal invariant, and not a mistake by the caller.
- **The schedule** — A system that you scheduled two times (`DUPLICATE_SYSTEM`), and the guard on
  the number of parameters of a system function (`SYSTEM_FN_ARITY`).
- **Observers** — An invalid config, and the guard against an emission from `onSet`
  (`OBSERVER_ONSET_EMIT`).

### What is always active

Some checks are structural, and not development aids. They run in each build:

- the **cycle detection** in the topological sort (`CIRCULAR_SYSTEM_DEPENDENCY`);
- the guard on the limit of the store (`STORE_CAP_EXCEEDED`);
- the validation of the memory options (`INVALID_MEMORY_OPTIONS`);
- the gate for determinism (`DETERMINISM_DISABLED`);
- the validators of the timestep, at construction;
- the detection of a second registration of a resource or an event, which would write over the
  state quietly.

Each throw from the ECS is an `ECSError` that carries a `category` that a program can read. The
package root exports `ECSError`, the `ECS_ERROR` enum, and `isEcsError` (`core/ecs/index.ts`).

---

## 23. Invariants

This is a short list of the invariants across the system that are useful to know:

1. **The membership of an archetype changes only at a flush boundary, during the execution of a
   system.** Inside `forEach` or `eachChunk`, the `(archetype, row)` of an entity is stable,
   because each structural operation through a `SystemContext` is deferred. An immediate operation
   on the `ECS` bypasses this, and you must not call one from inside a system.
2. **`_archetypes` only grows, and the engine never changes its order.** The store pushes each new
   matching archetype into the array of each registered query, through `_fanIntoQueries`
   (`core/ecs/store.ts`), but it removes none. An empty archetype stays, and `_nonEmpty()` filters
   it out.
3. **The map from an entity to its `(archetype, row)` pair is always consistent.** Each swap-remove
   updates `entityRow` before it gives control back. The `removeRow` function that knows about the
   division of the rows updates the map internally as it swaps. `removeEntity` and
   `removeEntityTag` give the index that they swapped, so that the store can apply it. A difference
   would be quiet corruption.
4. **A handle to a destroyed slot fails `isAlive` after the flush.** A slot that uses all of its
   generation counter is *retired*, and not recycled, which closes the ABA problem
   (`core/ecs/store.ts`).
5. **A registered query never becomes out of date.** `ArchetypeGraph.install` calls the fan-in hook
   of the store at creation, and `_fanIntoQueries` tests each registered query again before it
   gives control back. No background scan is necessary.
6. **A write to a field does not make the cache of non-empty archetypes invalid.** Only a change of
   membership increases `_queryDirtyEpoch`. So repeated iteration inside a frame uses the cache.
7. **The level of detail of change detection is one `(archetype, component)` pair.** A write to one
   row sets the value for the full archetype, for that component. `ChangedQuery` gives full
   archetypes, and a filter on each row is the task of the caller.
8. **The engine sets `ctx.lastRunTick` for each dispatch, and not for each system.** Read it at the
   start of the body. Do not keep it between calls. A tick that a system skips leaves the value
   unchanged, so nothing is missed across a period in which a gate stopped the system.
9. **A deferred operation validates the generations again at the time of the flush.** So an entity
   that an earlier deferred operation destroyed cannot break a later one, because the later
   operation becomes a no-operation.
10. **An archetype transition sets the tick on the destination, and not on the source.**
    `moveEntityFrom` and `bulkMoveAllFrom` set `_changedTick` for *each* component on the
    destination. So an add or a remove of any component starts change detection for each component
    that the entity then has.
11. **An event exists for one `update()` call, and no longer.** `clearEvents` runs one time in each
    `update()` call, before the tick increases, and one time at the end of `startup()`. No other
    path clears the events. `onSet` runs inside that window, and it must not emit.
12. **`stateHash` and the snapshots do not include the resources, the events, or the observer and
    change-detection state.** Those are artifacts of one frame, or of the schedule, and not of the
    simulation. Anything that you must reproduce must be in a component, or you must set it again
    after a restore.
13. **The sparse ids and the relation ids are separate from the dense component ids.** Sparse
    membership and relations never touch the archetype mask, they cause no transition, and they use
    no bit of the dense identity. This is why a relation operation is immediate.
14. **The three id spaces have separate brands.** `ComponentID`, `SparseComponentID`, and
    `RelationID` carry different phantom brands. So you cannot give a handle from one surface to a
    different surface.
