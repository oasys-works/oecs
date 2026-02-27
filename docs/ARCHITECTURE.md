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
11. [Resources](#resources)
12. [Refs](#refs)
13. [World facade](#world-facade)
14. [Type primitives](#type-primitives)
15. [Dev/Prod guards](#devprod-guards)

---

## Overview

```
ECS (public API facade)
  ├── Store (data orchestrator)
  │     ├── Entity slot allocator (generational IDs)
  │     ├── Component metadata registry
  │     ├── Archetype graph (BitSet masks, edge cache)
  │     ├── Entity → archetype/row mapping
  │     ├── Deferred operation buffers
  │     ├── Event channels
  │     └── Resource channels
  ├── Schedule (system execution)
  │     └── Per-phase topological sort (Kahn's algorithm)
  └── SystemContext (system interface)
        └── Deferred add/remove/destroy + event emit/read + resources + refs
```

External code talks to **ECS** (the world facade). Systems receive a **SystemContext**. The Store and Schedule are never exposed outside ECS.

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

A component is defined by a schema mapping field names to typed array tags:

```ts
// Record syntax — per-field type control
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });

// Array shorthand — uniform type, defaults to "f64"
const Vel = world.register_component(["vx", "vy"] as const);
```

At registration, the Store assigns a `ComponentID` (sequential integer) and records the field metadata:

```ts
interface ComponentMeta {
  field_names: string[];               // ["x", "y"]
  field_index: Record<string, number>; // { x: 0, y: 1 }
  field_types: TypedArrayTag[];        // ["f64", "f64"]
}
```

### Phantom typing

`ComponentDef<S>` is a branded number at runtime, but carries the schema `S` at compile time via a phantom symbol property:

```ts
type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;
type ComponentDef<S extends ComponentSchema> = ComponentID & { readonly [__schema]: S };
```

This means `ComponentDef<{x:"f64",y:"f64"}>` and `ComponentDef<{vx:"f64",vy:"f64"}>` are incompatible types even though both are just numbers. The phantom type flows through the entire API:

- `arch.get_column(Pos, "x")` — TypeScript knows `"x"` is valid for `Pos` and returns `Float64Array`
- `arch.get_column(Health, "current")` — returns `Int32Array` based on the `"i32"` tag
- `world.add_component(e, Pos, { x: 1, y: 2 })` — the values object is type-checked

### Tag components

Tags are components with an empty schema. They participate in archetype matching but store no data:

```ts
const IsEnemy = world.register_tag(); // ComponentDef<Record<string, never>>
```

Tags get special handling in archetype operations — see [Tag-only optimization](#tag-only-optimization).

---

## Archetypes

**File:** `src/archetype.ts`

An archetype groups all entities that share the exact same set of components. Its identity is a `BitSet` mask where each set bit corresponds to a `ComponentID`.

### Data layout (Structure-of-Arrays)

Each archetype stores component data in SoA layout using **typed arrays** (e.g. `Float64Array`, `Int32Array`):

```
Archetype [Position{x:"f64",y:"f64"}, Velocity{vx:"f64",vy:"f64"}] (3 entities)
┌──────────────────────────────────────────────────────────────────┐
│ entity_ids:  GrowableUint32Array [ e0,  e1,  e2 ]                │
│                                                                  │
│ Position columns:                                                │
│   x: Float64Array [ 10,  20,  30 ]  ← entity i's x at index i  │
│   y: Float64Array [ 15,  25,  35 ]                               │
│                                                                  │
│ Velocity columns:                                                │
│   vx: Float64Array [ 1,   2,   3 ]                               │
│   vy: Float64Array [ 4,   5,   6 ]                               │
└──────────────────────────────────────────────────────────────────┘
```

Each field is a `GrowableTypedArray` wrapping the appropriate typed array (determined by the field's tag in the component schema). Entity data at index `i` spans all column arrays at position `i`. This layout is cache-friendly for systems that iterate one or two fields across many entities.

### Flat column storage

Internally, all columns across all components are stored in a single flat array (`_flat_columns`). Several sparse arrays indexed by `ComponentID` provide O(1) lookup:

```ts
// Dense array of ALL columns across all components in this archetype
_flat_columns: GrowableTypedArray<AnyTypedArray>[] = [];
// Sparse by ComponentID → starting index into _flat_columns
_col_offset: number[] = [];
// Sparse by ComponentID → number of fields for that component
_field_count: number[] = [];
// Sparse by ComponentID → field_index record (field name → offset within component)
_field_index: Record<string, number>[] = [];
```

For `create_ref` compatibility, `ArchetypeColumnGroup` objects are also maintained in a sparse array:

```ts
interface ArchetypeColumnGroup {
  layout: ArchetypeColumnLayout; // component_id, field_names, field_index, field_types
  columns: GrowableTypedArray<AnyTypedArray>[]; // indexed by field_index
}

column_groups: (ArchetypeColumnGroup | undefined)[] = [];
// column_groups[componentId] → group or undefined if not present
```

A separate dense `_column_ids: number[]` array holds only the IDs of components that have columns, used for iteration in `copy_shared_from`.

### Swap-and-pop membership

Entities are packed contiguously at indices `0..length-1`. When entity at row `i` is removed:

1. The last entity (row `length-1`) is swapped into row `i` — both its `entity_ids` entry and all column values.
2. The last slot is popped.
3. The swapped entity's `entity_row` in the Store is updated to `i`.

This keeps data dense with no holes, at the cost of unstable ordering.

### Tag-only optimization

If an archetype has `has_columns === false` (all its components are tags), the `add_entity_tag` / `remove_entity_tag` methods skip all column operations. Only the `entity_ids` array is maintained. This is a significant speedup when archetypes consist entirely of marker tags.

### Graph edges

Each archetype caches add/remove transitions to other archetypes, along with pre-computed column transition maps:

```ts
interface ArchetypeEdge {
  add: ArchetypeID | null;        // "add component X" → target archetype
  remove: ArchetypeID | null;     // "remove component X" → target archetype
  add_map: Int16Array | null;     // pre-computed column mapping for add direction
  remove_map: Int16Array | null;  // pre-computed column mapping for remove direction
}
```

The transition maps (`add_map`/`remove_map`) are `Int16Array` where `map[dst_col_idx]` stores the source column index, or `-1` for new columns that need zero-initialization. These maps enable `move_entity_from()` to copy columns in a single pass without field-name lookups.

Edges are stored in a sparse array indexed by `ComponentID`. Once an edge is resolved, subsequent transitions for the same component are O(1) lookups instead of hash-map searches.

---

## The Store

**File:** `src/store.ts`

The Store is the internal data orchestrator. It owns:

1. **Entity slot allocator** — generational ID allocation and recycling
2. **Component metadata** — field names, indices, and typed array tags per ComponentID
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
     a. Check cached edge → hit? return target + transition map
     b. Miss? create archetype for (current_mask | component_bit),
        build transition map via build_transition_map(), cache edge
  4. move_entity_from(src, src_row, entity_id, transition_map):
     a. Push entity into target (using transition map for branchless column copy)
     b. Swap-remove entity from source archetype
  5. Write new component's values into target row
  6. Update entity_archetype and entity_row
```

For tag-only transitions (both source and target have no data columns), `move_entity_from_tag` is used instead, which only moves entity IDs without any column operations.

### Batch add / remove

`add_components` walks the archetype graph through all component additions to find the final target, then does a single entity move via `move_entity_from` with a freshly-built transition map. This avoids intermediate archetype transitions when adding multiple components at once.

`remove_components` works the same way via `arch_resolve_remove` — it walks through all removals to reach the final target archetype, then performs one transition with `move_entity_from`. If no components were actually present (target equals source), it's a no-op.

### Bulk operations

`batch_add_component` and `batch_remove_component` move ALL entities in an archetype at once using `bulk_move_all_from`, which copies columns via `TypedArray.set()` for O(columns) performance instead of O(N×columns). After the bulk move, the source archetype is emptied and all entity-to-archetype/row mappings are updated.

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
4. Build transition maps via `build_transition_map()` for both add and remove directions
5. Cache the edge (target archetype + transition maps) in both directions

After the first transition, all subsequent identical transitions are a single sparse-array lookup, and the pre-computed transition map eliminates field-name lookups during column copy.

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
- The component defs it was created with
- The include/exclude/any_of BitSet masks (for composing new queries via `and`/`not`/`or`)

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

### `for..of` iteration

Queries implement `Symbol.iterator`, yielding non-empty archetypes:

```ts
for (const arch of query) {
  const px = arch.get_column(Pos, "x");
  const py = arch.get_column(Pos, "y");
  const vx = arch.get_column(Vel, "vx");
  const vy = arch.get_column(Vel, "vy");
  const n = arch.entity_count;
  for (let i = 0; i < n; i++) {
    px[i] += vx[i];
    py[i] += vy[i];
  }
}
```

The iterator skips archetypes with zero entities. Systems access columns via `arch.get_column(def, field)` (which returns the appropriate typed array, e.g. `Float64Array`, `Int32Array`), then write the inner loop over `arch.entity_count`.

### `count()`

`Query.count()` sums `entity_count` across all matching archetypes, giving a total entity count without iteration.

### Query composition

Queries compose immutably via chaining:

- `q.and(Health)` — copies the include mask, sets the Health bit, resolves a new (cached) query
- `q.not(Dead)` — copies the exclude mask, sets the Dead bit, resolves a new query
- `q.any_of(Fire, Ice)` — copies the any_of mask, sets both bits, resolves a new query

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
1. if FIXED_UPDATE has systems:
     accumulator += dt
     clamp accumulator to max_fixed_steps * fixed_timestep
     while accumulator >= fixed_timestep:
       run FIXED_UPDATE (fixed_timestep)
       accumulator -= fixed_timestep
2. run PRE_UPDATE  (dt)
3. run UPDATE      (dt)
4. run POST_UPDATE (dt)
5. clear events
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

Events are fire-and-forget messages that systems emit within a frame and other systems can read during the same frame. They are auto-cleared at the end of each `world.update()` cycle, after all phases have run.

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

Events are cleared at the end of `world.update()` via `store.clear_events()`, which resets every channel's length and column arrays. This means events emitted during a frame are visible to all subsequent systems in the same frame, then discarded before the next frame begins.

---

## Resources

**File:** `src/resource.ts`

Resources are typed global singletons — time, input state, camera config. Unlike events (which are growable SoA channels), a resource is a single row of SoA columns.

### ResourceChannel

```ts
class ResourceChannel {
  field_names: string[];
  columns: number[][];    // each column has exactly 1 element (index 0)
  reader: ResourceReader; // property getters on column[0]
}
```

The `reader` object has `Object.defineProperty` getters on each field name. `reader.delta` calls `get() { return col[0]; }`, returning a scalar number — not an array. This makes reads zero-copy and immediately reflect writes.

### Write path

`ResourceChannel.write(values)` iterates field names and writes `columns[i][0] = values[fieldName]`. Changes are immediate (not deferred).

### Per-field access

---

## Refs

**File:** `src/ref.ts`

A `ComponentRef<S>` provides typed get/set properties that read and write directly into SoA typed array columns. The archetype + row + column lookup is performed once at creation; subsequent field access is a single `typedArray[row]` operation.

### Prototype caching

Prototypes are cached per column group via a `WeakMap<RefColumnGroup, object>`:

```ts
const ref_proto_cache = new WeakMap<RefColumnGroup, object>();
```

When `create_ref(group, row)` is called:

1. Check cache for existing prototype
2. If miss: build prototype with `Object.defineProperty` for each field — getters/setters read `this._columns[col_idx][this._row]`
3. Cache the prototype keyed by column group identity
4. `Object.create(proto)` + extract raw typed array buffers from `GrowableTypedArray` instances + set `_columns` and `_row`

Creating a ref is just `Object.create(proto) + buffer extraction + 2 property writes` — no closure allocation, no defineProperty loop per call.

### RefInternal

The internal shape of a ref instance:

```ts
interface RefInternal {
  _columns: AnyTypedArray[];  // raw typed array buffers extracted from GrowableTypedArray
  _row: number;               // entity's row in the archetype
}
```

### Safety

Refs are safe inside systems because structural changes are deferred. The entity cannot move archetypes until `ctx.flush()`. Do not hold refs across flush boundaries.

---

## World facade

**File:** `src/ecs.ts`

ECS composes Store, Schedule, and SystemContext into a single public API. It:

1. **Delegates data operations** to Store (create_entity, add_component, etc.)
2. **Owns the query cache** — implements `QueryResolver` so queries created via `query()`, `QueryBuilder`, and `Query.and()/not()/or()` all share the same cache
3. **Manages system lifecycle** — registration, scheduling, startup, update, dispose
4. **Delegates resource operations** — `register_resource`, `resource()`, `set_resource()` forward to Store's resource channels
5. **Hides internals** — the Store and Schedule instances are private. Systems interact only through the SystemContext they receive as `ctx`

### Convenience methods

World exposes several methods that delegate to internal APIs, keeping common operations simple:

- `get_field(entity, def, field)` / `set_field(entity, def, field, value)` — reads/writes a single field value by looking up the entity's archetype and row
- `emit(def, values?)` — emits events outside of systems, delegating to `store.emit_event` or `store.emit_signal`
- `remove_components(entity, ...defs)` — batch remove delegating to `store.remove_components`
- `batch_add_component(arch, def, values)` / `batch_remove_component(arch, def)` — bulk operations on entire archetypes

### System registration flow

Three overloads:

```
world.register_system(fn):                  // bare function — wraps as { fn }
world.register_system(fn, query_fn):        // resolves query at registration time
world.register_system(config: SystemConfig) // full config with lifecycle hooks
```

For the query overload:
1. `query_fn(new QueryBuilder(this))` → resolves a Query at registration time
2. Wraps fn into a SystemConfig: `{ fn: (_ctx, dt) => fn(query, ctx, dt) }`
3. Assigns SystemID, freezes into SystemDescriptor
4. Adds to the systems set

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

TypedArrays have fixed length. `GrowableTypedArray<T>` wraps one with a separate logical length and doubles the backing buffer on overflow (amortized O(1) append). Named subclasses (`GrowableFloat32Array`, `GrowableUint32Array`, etc.) exist for each numeric type, and `TypedArrayFor` maps tag strings (`"f64"`, `"i32"`, etc.) to the corresponding growable class.

Archetype columns, entity ID arrays, and transition maps all use these growable typed arrays. The `.buf` property exposes the raw typed array buffer for direct indexed access in inner loops, while `.push()`, `.pop()`, `.swap_remove()`, `bulk_append()`, and `bulk_append_zeroes()` manage the logical length and handle resizing.

---

## Dev guards

The codebase uses compile-time `__DEV__` flag. Dev-only code is wrapped in `if (__DEV__) { ... }` blocks.

**During development** (Vite dev server, tests): `__DEV__` is statically replaced with `true`, so all guards are active.

**In the library build**: `__DEV__` is replaced with `process.env.NODE_ENV !== "production"`. This defers the decision to the consumer's bundler — in production builds, the expression evaluates to `false` and the bundler tree-shakes the dead branches. In development, the guards remain active.

What's guarded by `__DEV__`:

- Entity ID range validation
- Branded type construction validation
- Archetype bounds checking
- Dead entity access detection
- Duplicate system detection
- Resource not-registered detection

**Always active** (not tree-shaken):

- Circular dependency detection in topological sort

Production builds contain zero overhead for `__DEV__`-guarded checks.
