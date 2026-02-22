# OECS Architecture

This document explains the internal design of OECS: how data is stored, how entities move between archetypes, how queries stay live, and how the system schedule executes.

## Table of contents

1. [Overview](#overview)
2. [Entity IDs](#entity-ids)
3. [Components](#components)
4. [Archetypes](#archetypes)
5. [The Store](#the-store)
6. [Archetype graph](#archetype-graph)
7. [Queries](#queries)
8. [Systems and scheduling](#systems-and-scheduling)
9. [Deferred operations](#deferred-operations)
10. [Events](#events)
11. [World facade](#world-facade)
12. [Type primitives](#type-primitives)
13. [Dev/Prod guards](#devprod-guards)

---

## Overview

```
World (public API facade)
  ├── Store (data orchestrator)
  │     ├── Entity slot allocator (generational IDs)
  │     ├── Component metadata registry
  │     ├── Archetype graph (BitSet masks, edge cache)
  │     ├── Entity → archetype/row mapping
  │     ├── Deferred operation buffers
  │     └── Event channels
  ├── Schedule (system execution)
  │     └── Per-phase topological sort (Kahn's algorithm)
  └── SystemContext (system interface)
        └── Deferred add/remove/destroy + event emit/read
```

External code talks to **World**. Systems receive a **SystemContext**. The Store and Schedule are never exposed outside World.

---

## Entity IDs

**File:** `src/entity.ts`

An EntityID is a packed integer using 31 of 32 bits. The sign bit is never set, so all bitwise results stay positive — no unsigned coercion is needed.

```
  30        20 19           0
  ┌──────────┬──────────────┐
  │generation│    index     │
  │ (11 bit) │  (20 bit)   │
  └──────────┴──────────────┘
```

- **Index** (bits 0–19): Slot number in the entity arrays. Max 1,048,575 entities.
- **Generation** (bits 20–30): Reuse counter. Max 2,047 before overflow.

### Why generational IDs?

When an entity is destroyed, its slot is recycled. Without generations, a stale ID from before destruction could accidentally reference the new occupant of that slot. The generation counter catches this: if the stored generation doesn't match the slot's current generation, the ID is stale.

### Operations

```
create_entity_id(index, gen) → (gen << 20) | index
get_entity_index(id)         → id & 0xFFFFF
get_entity_generation(id)    → id >> 20
```

Since the packed value fits in 31 bits, signed right-shift (`>>`) extracts the generation cleanly without masking.

### Slot allocator

The Store manages entity slots with:

- `entity_generations: number[]` — current generation per slot
- `entity_high_water: number` — next never-used slot index
- `entity_free_indices: number[]` — stack of recycled slot indices

Creating an entity pops from the free stack (or advances the high water mark). Destroying pushes the index back and bumps the generation.

---

## Components

**File:** `src/component.ts`

A component is defined by its field names:

```ts
const Pos = world.register_component(["x", "y"] as const);
```

At registration, the Store assigns a `ComponentID` (sequential integer) and records the field metadata:

```ts
interface ComponentMeta {
  field_names: string[]; // ["x", "y"]
  field_index: Record<string, number>; // { x: 0, y: 1 }
}
```

### Phantom typing

`ComponentDef<F>` is a branded number at runtime, but carries the field tuple `F` at compile time via a phantom symbol property:

```ts
type ComponentDef<F> = ComponentID & { readonly [__schema]: F };
```

This means `ComponentDef<["x", "y"]>` and `ComponentDef<["vx", "vy"]>` are incompatible types even though both are just numbers. The phantom type flows through the entire API:

- `arch.get_column(Pos, "x")` — TypeScript knows `"x"` is valid for `Pos`
- `q.each((pos, vel, n) => ...)` — `pos` is inferred as `{ x: number[], y: number[] }`
- `world.add_component(e, Pos, { x: 1, y: 2 })` — the values object is type-checked

### Tag components

Tags are components with an empty field array. They participate in archetype matching but store no data:

```ts
const IsEnemy = world.register_tag(); // ComponentDef<readonly []>
```

Tags get special handling in archetype operations — see [Tag-only optimization](#tag-only-optimization).

---

## Archetypes

**File:** `src/archetype.ts`

An archetype groups all entities that share the exact same set of components. Its identity is a `BitSet` mask where each set bit corresponds to a `ComponentID`.

### Data layout (Structure-of-Arrays)

Each archetype stores component data in SoA layout:

```
Archetype [Position, Velocity] (3 entities)
┌──────────────────────────────────────────────────────────────────┐
│ entity_ids:  [ e0,  e1,  e2 ]                                   │
│                                                                  │
│ Position columns:                                                │
│   x: [ 10,  20,  30 ]    ← entity i's x is at index i          │
│   y: [ 15,  25,  35 ]                                           │
│                                                                  │
│ Velocity columns:                                                │
│   vx: [ 1,   2,   3 ]                                           │
│   vy: [ 4,   5,   6 ]                                           │
└──────────────────────────────────────────────────────────────────┘
```

Each field is a plain `number[]`. Entity data at index `i` spans all column arrays at position `i`. This layout is cache-friendly for systems that iterate one or two fields across many entities.

### Column groups

Columns are organized into `ArchetypeColumnGroup` objects, one per data-bearing component:

```ts
interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout; // field_names, field_index
  columns: number[][]; // indexed by field_index
  record: Record<string, number[]>; // { "x": columns[0], "y": columns[1] }
}
```

The `record` object is what `query.each()` passes to system callbacks — it's a pre-built `{ fieldName: column }` mapping.

Column groups are stored in a **sparse array** indexed by `ComponentID`:

```ts
column_groups: (ArchetypeColumnGroup | undefined)[] = [];
// column_groups[componentId] → group or undefined if not present
```

This gives O(1) lookup by component. A separate dense `_column_ids: number[]` array holds only the IDs of components that have columns, used for iteration in `add_entity`, `remove_entity`, and `copy_shared_from`.

### Swap-and-pop membership

Entities are packed contiguously at indices `0..length-1`. When entity at row `i` is removed:

1. The last entity (row `length-1`) is swapped into row `i` — both its `entity_ids` entry and all column values.
2. The last slot is popped.
3. The swapped entity's `entity_row` in the Store is updated to `i`.

This keeps data dense with no holes, at the cost of unstable ordering.

### Tag-only optimization

If an archetype has `has_columns === false` (all its components are tags), the `add_entity_tag` / `remove_entity_tag` methods skip all column operations. Only the `entity_ids` array is maintained. This is a significant speedup when archetypes consist entirely of marker tags.

### Graph edges

Each archetype caches add/remove transitions to other archetypes:

```ts
interface ArchetypeEdge {
  add: ArchetypeID | null; // "add component X" → target archetype
  remove: ArchetypeID | null; // "remove component X" → target archetype
}
```

Edges are stored in a sparse array indexed by `ComponentID`. Once an edge is resolved, subsequent transitions for the same component are O(1) lookups instead of hash-map searches.

---

## The Store

**File:** `src/store.ts`

The Store is the internal data orchestrator. It owns:

1. **Entity slot allocator** — generational ID allocation and recycling
2. **Component metadata** — field names and indices per ComponentID
3. **Archetype graph** — all archetypes, hash-bucketed lookup, graph edge cache
4. **Entity mapping** — `entity_archetype[index]` and `entity_row[index]` arrays
5. **Deferred buffers** — pending adds, removes, and destroys
6. **Event channels** — SoA-based event storage and readers
7. **Registered queries** — live Archetype[] arrays pushed into as new archetypes appear

### Archetype lookup

Archetypes are deduplicated by their BitSet mask. The Store uses a hash-bucketed map:

```
BitSet.hash() → Map<number, ArchetypeID[]>
```

To find an archetype for a mask: compute the hash, scan the bucket for an exact `BitSet.equals()` match. Buckets are typically 1–2 entries, so this is effectively O(1).

### Component index

An inverted index maps each `ComponentID` to the set of archetypes containing it:

```
component_index: Map<ComponentID, Set<ArchetypeID>>
```

This is used by `get_matching_archetypes` to find the component with the fewest archetypes and start the search from there, minimizing the number of superset checks.

### Entity-to-archetype mapping

Two parallel arrays map entity slot indices to their current archetype and row:

```
entity_archetype[entity_index] → ArchetypeID
entity_row[entity_index]       → row within that archetype
```

Both are set to `UNASSIGNED (-1)` when an entity is destroyed or has no row.

### Adding a component (immediate)

```
add_component(entity, def, values):
  1. Look up entity's current archetype
  2. If archetype already has this component → overwrite values in-place (no transition)
  3. arch_resolve_add(current_archetype, component) → target archetype
     a. Check cached edge → hit? return target
     b. Miss? create archetype for (current_mask | component_bit), cache edge
  4. Add entity to target archetype (push 0s into columns) → new row
  5. Copy shared column data from source row to target row
  6. Swap-remove entity from source archetype
  7. Write new component's values into target row
  8. Update entity_archetype and entity_row
```

### Batch add / remove

`add_components` walks the archetype graph through all component additions to find the final target, then does a single entity move. This avoids intermediate archetype transitions when adding multiple components at once.

`remove_components` works the same way via `arch_resolve_remove` — it walks through all removals to reach the final target archetype, then performs one transition. If no components were actually present (target equals source), it's a no-op.

---

## Archetype graph

The archetype graph is an implicit directed graph where:

- **Nodes** are archetypes (unique component masks)
- **Edges** represent "add component X" or "remove component X" transitions

Edges are cached bidirectionally:

```
Archetype [A, B] --add C--> Archetype [A, B, C]
                 <--remove C--
```

When the Store resolves `arch_resolve_add(archetype, component)`:

1. Check if the archetype's mask already has the bit → return same archetype (no-op)
2. Check the cached edge → return target if cached
3. Create or find the target archetype via `arch_get_or_create_from_mask(mask | bit)`
4. Cache the edge in both directions

After the first transition, all subsequent identical transitions are a single sparse-array lookup.

### New archetype creation

When a new archetype is created:

1. Column layouts are built from the component metadata
2. The archetype is added to the hash-bucketed map
3. The component index is updated (each component's set gains this archetype)
4. **All registered queries are checked** — if the new archetype matches a query's masks, it's pushed into that query's result array

Step 4 is what makes queries "live": they never go stale because the Store eagerly pushes new matches.

---

## Queries

**File:** `src/query.ts`

A `Query<Defs>` holds:

- A reference to a live `Archetype[]` (owned by the Store's registered_queries)
- The component defs it was created with (for `each()` column group lookup)
- The include/exclude/any_of BitSet masks (for composing new queries via `and`/`not`/`or`)
- A pre-allocated `_args_buf` array (avoids allocation in the `each()` hot path)

### Query caching

Queries are cached in the World's `query_cache`:

```
hash(include, exclude, any_of) → Map<number, QueryCacheEntry[]>
```

The hash combines three BitSet hashes using xor with golden-ratio multipliers to reduce collisions:

```ts
key = (inc_hash ^ imul(exc_hash, 0x9e3779b9) ^ imul(any_hash, 0x517cc1b7)) | 0;
```

Within a bucket, entries are matched by exact `BitSet.equals()` on all three masks.

### `each()` iteration

```ts
each(fn):
  for each archetype:
    if archetype.entity_count === 0: skip
    for each component def:
      args_buf[i] = archetype.get_column_group(def)  // { x: number[], y: number[] }
    args_buf[last] = entity_count
    fn.apply(null, args_buf)
```

The pre-allocated `args_buf` avoids creating a new array per archetype. `apply` spreads it as individual function arguments.

The system callback receives typed column-group objects (thanks to the `DefsToColumns` mapped type) and the entity count. The system is responsible for the inner `for` loop — this design pushes one function call per archetype instead of per entity.

### `count()`

`Query.count()` sums `entity_count` across all matching archetypes, giving a total entity count without iteration.

### Query composition

Queries compose immutably via chaining:

- `q.and(Health)` — copies the include mask, sets the Health bit, resolves a new (cached) query
- `q.not(Dead)` — copies the exclude mask, sets the Dead bit, resolves a new query
- `q.or(Fire, Ice)` — copies the any_of mask, sets both bits, resolves a new query

Each method returns a new Query (or a cached one if the mask combination already exists).

### QueryBuilder

`QueryBuilder` is a thin wrapper used inside `register_system`:

```ts
world.register_system(
  (q, ctx, dt) => { ... },
  (qb) => qb.every(Pos, Vel),  // QueryBuilder
);
```

`every()` builds a BitSet from the defs and calls `_resolve_query`. The resulting Query is captured once at registration time and reused every frame.

---

## Systems and scheduling

**Files:** `src/system.ts`, `src/schedule.ts`

### SystemConfig and SystemDescriptor

A system is defined by a `SystemConfig`:

```ts
interface SystemConfig {
  fn: (ctx: SystemContext, dt: number) => void;
  on_added?: (store: Store) => void;
  on_removed?: () => void;
  dispose?: () => void;
}
```

When registered, the World assigns a `SystemID` and returns a frozen `SystemDescriptor` (SystemConfig + id). The descriptor is the identity handle used for ordering constraints and removal.

### Schedule phases

The Schedule manages seven phases:

```
Startup (once):          PRE_STARTUP → STARTUP → POST_STARTUP
Fixed update (per tick): FIXED_UPDATE
Update (per frame):      PRE_UPDATE  → UPDATE  → POST_UPDATE
```

`FIXED_UPDATE` runs at a configurable fixed timestep (default 1/60s) using an accumulator. On each `world.update(dt)`, the accumulator is incremented by `dt` and the fixed phase runs zero or more times to catch up. Spiral-of-death protection caps at `max_fixed_steps` iterations per frame (default 4). `world.fixed_alpha` exposes `accumulator / fixed_timestep` for rendering interpolation. If no systems are registered in `FIXED_UPDATE`, the accumulator loop is skipped entirely.

Each phase holds a list of `SystemNode` objects:

```ts
interface SystemNode {
  descriptor: SystemDescriptor;
  insertion_order: number;
  before: Set<SystemDescriptor>; // "I must run before these"
  after: Set<SystemDescriptor>; // "I must run after these"
}
```

### Topological sort

Within each phase, systems are sorted using **Kahn's algorithm** (BFS-based topological sort):

1. Build adjacency list and in-degree map from before/after constraints
2. Seed a ready queue with all zero in-degree nodes
3. Pop the node with the **lowest insertion order** (stable tiebreaker)
4. Decrement in-degrees of its neighbors; add newly-zero nodes to the ready queue
5. Repeat until empty
6. If result length != node count → circular dependency detected → throw

The ready queue is sorted descending by insertion order so that `pop()` yields the lowest (earliest-registered) system first.

### Sort caching

The sorted order is cached per phase. Adding or removing a system invalidates that phase's cache. The next `run_label` call recomputes the sort.

### Phase execution

```ts
run_label(label, ctx, dt):
  sorted = get_sorted(label)  // cached topological sort
  for each system in sorted:
    system.fn(ctx, dt)
  ctx.flush()  // apply deferred changes
```

The flush after each phase ensures that the next phase sees a consistent state.

### Fixed update loop

Inside `world.update(dt)`:

```
1. clear events
2. if FIXED_UPDATE has systems:
     accumulator += dt
     clamp accumulator to max_fixed_steps * fixed_timestep
     while accumulator >= fixed_timestep:
       run FIXED_UPDATE (fixed_timestep)
       accumulator -= fixed_timestep
3. run PRE_UPDATE  (dt)
4. run UPDATE      (dt)
5. run POST_UPDATE (dt)
```

Fixed phase runs before variable phases so variable systems always see the latest fixed-step state.

---

## Deferred operations

### Why defer?

During system execution, iterating a query walks archetype arrays. If a system moves an entity to a different archetype mid-iteration (by adding/removing a component), it would invalidate the iteration. Deferred operations solve this by buffering changes and applying them in batch after all systems in the phase complete.

### Buffer layout

Deferred operations use **flat parallel arrays** instead of per-operation objects to avoid allocation pressure:

```ts
// Deferred adds
pending_add_ids:    EntityID[]
pending_add_defs:   ComponentDef[]
pending_add_values: Record<string, number>[]

// Deferred removes
pending_remove_ids:  EntityID[]
pending_remove_defs: ComponentDef[]

// Deferred destroys
pending_destroy: EntityID[]
```

Operation `i` is described by `pending_add_ids[i]`, `pending_add_defs[i]`, `pending_add_values[i]`.

### Flush order

`SystemContext.flush()` processes in this order:

1. **Structural changes** (adds, then removes)
2. **Destructions**

This ordering ensures that a component added and the entity destroyed in the same frame will see the add applied before the destroy.

### Hot-path optimizations in flush

The `_flush_adds` and `_flush_destroyed` methods inline entity ID unpacking (avoiding function call overhead) and hoist frequently-accessed arrays to locals:

```ts
const idx = (eid as number) & INDEX_MASK; // inline get_entity_index
const gen = (eid as number) >> INDEX_BITS; // inline get_entity_generation
```

They also check for stale entities (generation mismatch) and skip them silently — an entity destroyed in one deferred op shouldn't crash a subsequent deferred op targeting the same entity.

---

## Events

**File:** `src/event.ts`

Events are fire-and-forget messages that systems emit within a frame and other systems can read during the same frame. They are auto-cleared at the start of each `world.update()` cycle.

### Event channels

Each event type gets an `EventChannel` that stores data in SoA layout, matching the component pattern:

```ts
class EventChannel {
  field_names: string[]; // ["target", "amount"]
  columns: number[][]; // [[...targets], [...amounts]]
  reader: EventReader<F>; // { length, target: number[], amount: number[] }
}
```

The `reader` object is a pre-built view over the channel's columns. Its field properties are the actual backing arrays, so reads are zero-copy. The `length` property tracks how many events have been emitted this frame.

### Signals

Signals are zero-field events — they carry no data, just a count of how many times they were emitted. Internally, `emit_signal()` only increments `reader.length` without touching any columns.

```ts
const OnReset = world.register_signal();

// Emit
ctx.emit(OnReset);

// Read — check count
const r = ctx.read(OnReset);
if (r.length > 0) {
  /* signal fired */
}
```

### Data events

Events with fields store values in SoA columns:

```ts
const Damage = world.register_event(["target", "amount"] as const);

// Emit
ctx.emit(Damage, { target: entityId, amount: 50 });

// Read
const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i];
  const amount = dmg.amount[i];
}
```

### Phantom typing

`EventDef<F>` follows the same phantom-typing pattern as `ComponentDef<F>` — a branded `EventID` at runtime, carrying the field tuple `F` at compile time. This makes `emit()` and `read()` type-safe: the values object and reader fields are checked against the event's schema.

### Lifecycle

Events are cleared at the start of `world.update()` via `store.clear_events()`, which resets every channel's length and column arrays. This means events are only visible within the frame they were emitted.

---

## World facade

**File:** `src/world.ts`

World composes Store, Schedule, and SystemContext into a single public API. It:

1. **Delegates data operations** to Store (create_entity, add_component, etc.)
2. **Owns the query cache** — implements `QueryResolver` so queries created via `query()`, `QueryBuilder`, and `Query.and()/not()/or()` all share the same cache
3. **Manages system lifecycle** — registration, scheduling, startup, update, dispose
4. **Hides internals** — the Store and Schedule instances are private. Systems interact only through the SystemContext they receive as `ctx`

### Convenience methods

World exposes several methods that delegate to internal APIs, keeping common operations simple:

- `get_field(def, entity, field)` — reads a single field value by looking up the entity's archetype and row
- `emit(def, values?)` — emits events outside of systems, delegating to `store.emit_event` or `store.emit_signal`
- `remove_components(entity, ...defs)` — batch remove delegating to `store.remove_components`

### System registration flow

```
world.register_system(fn, query_fn):
  1. query_fn(new QueryBuilder(this)) → resolves a Query at registration time
  2. Wraps fn into a SystemConfig: { fn: (_ctx, dt) => fn(query, ctx, dt) }
  3. Assigns SystemID, freezes into SystemDescriptor
  4. Adds to the systems set
```

The query is resolved once and captured in the closure. Each frame, the schedule calls `fn(ctx, dt)` which invokes the user's function with the pre-resolved query.

---

## Type primitives

**Directory:** `src/type_primitives/`

### Brand

`Brand<T, Name>` adds a phantom symbol property to type `T`, creating nominal typing. Used for `EntityID`, `ComponentID`, `ArchetypeID`, `SystemID`, `EventID` — all are `number` at runtime but incompatible at compile time.

### BitSet

`number[]`-backed bit set with auto-grow. Each 32-bit word holds 32 component bits. Operations:

| Operation          | Complexity     | Method            |
| ------------------ | -------------- | ----------------- |
| Has bit            | O(1)           | `has(bit)`        |
| Set bit            | O(1) amortized | `set(bit)`        |
| Clear bit          | O(1)           | `clear(bit)`      |
| Superset check     | O(words)       | `contains(other)` |
| Intersection check | O(words)       | `overlaps(other)` |
| Equality           | O(words)       | `equals(other)`   |
| Hash (FNV-1a)      | O(words)       | `hash()`          |
| Iterate set bits   | O(set bits)    | `for_each(fn)`    |

**Bit extraction in `for_each`:**

```ts
const t = word & (-word >>> 0); // isolate lowest set bit
const bit_pos = 31 - Math.clz32(t); // find its position
word ^= t; // clear it
```

`-word >>> 0` computes the two's complement negation as an unsigned 32-bit integer. AND-ing with the original isolates the lowest set bit. `Math.clz32` counts leading zeros to find the bit position.

**Hash normalization:** The hash skips trailing zero words so that `[0x1, 0, 0, 0]` and `[0x1, 0]` produce the same hash — important because BitSets can have different array lengths but represent the same set of bits.

### SparseSet and SparseMap

O(1) integer-keyed containers using the sparse/dense pattern:

- **Dense array** — packed values at `0..size-1` for cache-friendly iteration
- **Sparse array** — maps `key → dense index` for O(1) random access
- **Membership verification** — `dense[sparse[key]] === key` cross-reference, so stale sparse entries are harmless

Deletion uses swap-and-pop to keep the dense array contiguous.

### GrowableTypedArray

TypedArrays have fixed length. `GrowableTypedArray<T>` wraps one with a separate logical length and doubles the backing buffer on overflow (amortized O(1) append). Named subclasses (`GrowableFloat32Array`, etc.) exist for each numeric type, and `TypedArrayFor` maps tag strings to classes.

---

## Dev guards

The codebase uses compile-time `__DEV__` flag. Dev-only code is wrapped in `if (__DEV__) { ... }` blocks.

**During development** (Vite dev server, tests): `__DEV__` is statically replaced with `true`, so all guards are active.

**In the library build**: `__DEV__` is replaced with `process.env.NODE_ENV !== "production"`. This defers the decision to the consumer's bundler — in production builds, the expression evaluates to `false` and the bundler tree-shakes the dead branches. In development, the guards remain active.

What's guarded:

- Entity ID range validation
- Branded type construction validation
- Archetype bounds checking
- Dead entity access detection
- Duplicate system detection
- Circular dependency detection in topological sort

Production builds contain zero validation overhead.
