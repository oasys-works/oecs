# OECS — System Overview

A guided tour from first principles to implementation detail.
Each section opens with a plain-English summary, then digs into how the code actually works.
Cross-references to optimization rationale are in `DESIGN.md` as `[opt:N]`.

---

## Table of contents

1. [What is an ECS?](#1-what-is-an-ecs)
2. [Entities](#2-entities)
3. [Components](#3-components)
4. [Archetypes](#4-archetypes)
5. [BitSet — the component fingerprint](#5-bitset--the-component-fingerprint)
6. [ArchetypeRegistry — bookkeeping and transitions](#6-archetyperegistry--bookkeeping-and-transitions)
7. [Store — the single source of truth](#7-store--the-single-source-of-truth)
8. [Queries](#8-queries)
9. [Systems and Scheduling](#9-systems-and-scheduling)
10. [End-to-end data flow](#10-end-to-end-data-flow)

---

## 1. What is an ECS?

**Plain English:** Most game engines model things as objects — a `Player` object knows its position, its health, and how to move. This feels natural but is slow at scale: thousands of players means thousands of scattered objects in memory, and every frame the CPU has to jump around to find the data it needs.

An Entity Component System flips this around:

- **Entity** — a meaningless ID number. It represents "a thing" but knows nothing about itself.
- **Component** — a plain data bag (position, health, velocity). No methods, just numbers.
- **System** — a function that runs every frame and operates on *all* entities that have a particular set of components.

The gain: all position data for entities with the same component set lives in one contiguous array, all velocity data in another. A movement system reads through them linearly. The CPU's cache prefetcher loves this.

---

## 2. Entities

**Plain English:** An entity is a ticket stub. The number on the stub tells you which slot to look in. When an entity is destroyed, the slot gets recycled — but the old stub becomes invalid so nobody can use a stale reference accidentally.

### ID layout `[opt:1]`

Every entity is a single 32-bit integer with two packed fields:

```
Bits:  [31 ........... 20][19 ........... 0]
        generation (12)     index (20)
```

| Field | Bits | Max value | Purpose |
|-------|------|-----------|---------|
| index | 20 | ~1 million | Which slot in the entity arrays |
| generation | 12 | 4,095 | How many times this slot has been reused |

```typescript
// entity.ts
export const create_entity_id = (index: number, generation: number): EntityID =>
  unsafe_cast<EntityID>(((generation << INDEX_BITS) | index) >>> 0);
```

The `>>> 0` coercion is critical — it forces the result to an **unsigned** 32-bit integer so that high-bit generation values are not misinterpreted as negative by JS bitwise operators.

### Why generations?

Say entity with index 5 is created, used, then destroyed. The next entity allocated to slot 5 gets `generation + 1`. Any old code that kept a reference to the first entity (generation 0) runs `is_alive(old_id)` — the stored generation doesn't match, so it correctly returns `false`. This is the ECS equivalent of a dangling pointer check, at zero memory cost.

### Entity management in Store

Entity lifecycle state lives directly in `Store`:

- `entity_generations: number[]` — current generation for each slot index. Checked against the ID's baked-in generation by `is_alive()`.
- `entity_free_indices: number[]` — recycled slot indices, popped on `create_entity()` and pushed on `destroy_entity()`.
- `entity_high_water: number` — the next fresh slot if the free list is empty.

---

## 3. Components

**Plain English:** A component is a description of what data an entity carries. You define it as a schema — field names and their numeric type (`"f32"`, `"u8"`, etc.). Actual values are stored in flat arrays inside archetypes, not as JS objects, keeping data compact and iteration cache-friendly.

### Defining a component

```typescript
const Position = { x: "f32", y: "f32" } as const;
const Pos = world.register_component(Position);
// Pos is a ComponentDef<{ x: "f32", y: "f32" }>
```

### ComponentDef — phantom typing

`ComponentDef<S>` is a **phantom type**: at runtime it's just a number (the component's sequential ID), but at compile time it carries the full schema `S`. This means:

```typescript
arch.get_column(Pos, "x")   // → number[]   ✓
arch.get_column(Pos, "z")   // TypeScript error  ✓
```

No runtime casts, no `as any`. The type information is erased in the output JS but enforced at development time.

### TypeTag — logical types

Schema values specify TypeTags (`"f32"`, `"u8"`, etc.) which document the intended numeric precision and range:

| TypeTag | Intended range |
|---------|---------------|
| `"f32"` | 32-bit float |
| `"f64"` | 64-bit float |
| `"u8"`  | 0–255 |
| `"u16"` | 0–65535 |
| `"u32"` | 0–2³²−1 |
| `"i8"`  | −128–127 |
| `"i16"` | −32768–32767 |
| `"i32"` | −2³¹–2³¹−1 |

All archetype columns are plain `number[]` arrays regardless of TypeTag. The TypeTag is metadata only — it provides documentation and could be used for future typed storage.

### Component metadata in Store

`Store` holds a `component_metas: ComponentMeta[]` array (indexed by component ID):

```typescript
interface ComponentMeta {
  field_names: string[];
  field_index: Record<string, number>; // field name → column index, O(1)
}
```

### Tag components

A component with an empty schema (`{}`) is a **tag** — it carries no data, only presence. It contributes a bit to the archetype mask and enables filtering (`not(Static)`) without any column storage.

---

## 4. Archetypes

**Plain English:** An archetype is a table. Every entity that has the exact same set of components sits in the same table row. All position data for those entities is in one array, all velocity data in another — tightly packed, row-aligned. Iterating 10,000 entities with [Pos, Vel] is a single forward pass through two arrays. No object lookups, no pointer chasing.

### The table structure

```
Archetype [Pos, Vel]
  entity_ids:   [ e1,  e2,  e3, ... ]   ← dense EntityID[], row-ordered
  Pos.x:        [ 1.0, 5.0, 3.0, ... ]  ← number[]
  Pos.y:        [ 2.0, 6.0, 4.0, ... ]  ← number[]
  Vel.vx:       [ 0.1, 0.0, 0.2, ... ]  ← number[]
  Vel.vy:       [ 0.0, 0.3, 0.0, ... ]  ← number[]
```

Row `i` holds all data for the `i`-th entity in this archetype. All arrays grow and shrink together.

Column groups are stored in a sparse array indexed by `ComponentID`:

```typescript
readonly column_groups: (ArchetypeColumnGroup | undefined)[]
```

Each `ArchetypeColumnGroup` holds the column arrays for one component. The sparse indexing gives O(1) access by component ID with no hashing.

### Entity membership `[opt:2]`

Entity membership uses two parallel structures:

- **`entity_ids: EntityID[]`** (in `Archetype`, dense) — holds entity IDs at rows 0..N-1. Append-only with swap-and-pop on removal.
- **`entity_row: Int32Array`** (in `Store`, sparse) — maps `entity_index → row`. The sentinel `UNASSIGNED = -1` marks either unoccupied slots or newly created entities that have not yet received their first component.

This gives O(1) "which row is entity X in?" from Store, and the Archetype manages its own dense list.

### Swap-and-pop removal

When entity at row `r` is removed, the entity at the *last* row is moved into row `r`. No gaps, no shifting — O(1) regardless of table size. All component columns are updated in the same operation. `remove_entity()` returns the entity_index of the entity that was swapped, so Store can update `entity_row` for that entity.

### Archetype graph edges `[opt:3]`

When an entity gains a component, it must move to a different archetype. Rather than recomputing the target mask every time, archetypes cache transitions in a sparse array:

```typescript
// edges: ArchetypeEdge[] — sparse array, indexed by ComponentID
{ add: ArchetypeID | null, remove: ArchetypeID | null }
```

ComponentIDs are sequential integers starting from 0, making them ideal sparse array indices — no hashing, no hidden class overhead, just a direct array slot read.

First transition for a given component: O(mask arithmetic + hash lookup). Every subsequent transition for the same component: O(1) indexed array access.

Edges are always cached **bidirectionally**: caching `[Pos] → [Pos, Vel]` simultaneously caches `[Pos, Vel] → [Pos]`.

---

## 5. BitSet — the component fingerprint

**Plain English:** Every archetype has a fingerprint — a sequence of bits, one per component type. Bit 3 is set? This archetype has component 3. Comparing two fingerprints tells you instantly whether an archetype matches a query, without looking at any lists.

### Implementation

`BitSet` is backed by a `Uint32Array`, packing 32 component bits per word. Default capacity is 4 words (128 components); it auto-grows as needed.

```typescript
// "Does archetype have all required components?"
contains(other: BitSet): boolean  // superset check: (this & other) === other

// "Does archetype have any excluded/or components?"
overlaps(other: BitSet): boolean  // intersection check: (this & other) !== 0

// "Are two masks identical?"
equals(other: BitSet): boolean

// FNV-1a hash (used as Map key)
hash(): number
```

### Write-once masks `[opt:5]`

After an archetype is created, its `BitSet` mask is never mutated. All mask operations that produce a new state (`copy_with_set`, `copy_with_clear`, `copy`) return a new `BitSet`. This write-once invariant lets the V8 JIT treat the mask object's shape as permanently stable — a monomorphic hidden class — avoiding de-optimisation to megamorphic IC sites that can occur when object properties change.

---

## 6. ArchetypeRegistry — bookkeeping and transitions

**Plain English:** The archetype registry is the librarian. It keeps a catalogue of every archetype that exists, makes sure no two archetypes have the same component set, and maintains an index so queries can find matching archetypes fast.

### Deduplication

Archetypes are stored in a `Map<hash, ArchetypeID[]>`. Creating an archetype with mask `{Pos, Vel}`:
1. Compute `mask.hash()` — the FNV-1a hash of the BitSet words.
2. Look up the hash bucket. If any stored archetype has `.mask.equals(new_mask)`, return its ID.
3. Otherwise allocate a new `Archetype`, store it, update the component index.

Hash collisions are resolved by full `equals()` comparison within the bucket.

### Component index

```typescript
component_index: Map<ComponentID, Set<ArchetypeID>>
```

Every archetype is registered in the sets of all its components. This powers the query matching optimization.

### Query matching `[opt:4]`

`get_matching(include, exclude?, any_of?)` uses the component index to avoid scanning all archetypes:

1. Find the component in the include mask with the **fewest** archetypes in the index.
2. Iterate only those archetypes (smallest set).
3. For each, check: `arch.mask.contains(include) && !overlaps(exclude) && overlaps(any_of)`.

The worst case is the rarest component's archetype count, not the total archetype count.

The bit-scan over the query mask is inlined (not delegated to `BitSet.for_each`) to avoid a closure allocation on this hot path.

### Push-based query updates

Registered queries are stored as:

```typescript
{ include_mask, exclude_mask, any_of_mask, result: Archetype[] }
```

When a new archetype is created, the registry loops through every registered query and pushes the archetype into `result` if it matches. The `result` array is the **same array reference** held by the `Query` object — so all live queries auto-update with zero re-registration.

---

## 7. Store — the single source of truth

**Plain English:** The Store is the central hub. It owns all entity and component state and is the only code that knows "entity 5 is currently in archetype 3, row 7". All entity and component operations route through it.

### What it owns

| Field | Type | Purpose |
|-------|------|---------|
| `entity_generations` | `number[]` | generation per slot (alive check) |
| `entity_free_indices` | `number[]` | free-list of recycled slot indices |
| `component_metas` | `ComponentMeta[]` | schema info per component ID |
| `archetype_registry` | `ArchetypeRegistry` | archetypes, queries, transitions |
| `entity_archetype` | `Int32Array` | `entity_index → ArchetypeID`, O(1) lookup |
| `entity_row` | `Int32Array` | `entity_index → row within archetype`, `UNASSIGNED=-1` |

Both `entity_archetype` and `entity_row` start at 256 capacity and double geometrically as more entity slots are needed `[opt:9]`.

### add_component flow

```
1.  Assert entity alive
2.  current_arch = archetypes[entity_archetype[entity_index]]
3.  If current_arch already has component → write fields in-place, return
4.  target_arch_id = archetype_registry.resolve_add(current_arch_id, component_id)
     → edge cache hit → O(1) indexed array read
     → cache miss   → build new mask, get_or_create archetype, cache bidirectional edge
5.  dst_row = target_arch.add_entity(entity_id)        ← append to dense entity_ids
6.  src_row = entity_row[entity_index]
7.  if src_row !== UNASSIGNED:                          ← skip for newly created entity [opt:10]
      target_arch.copy_shared_from(current_arch, src_row, dst_row)   ← copy shared field data
      swapped_idx = current_arch.remove_entity(src_row)              ← swap-and-pop
      if swapped_idx !== -1: entity_row[swapped_idx] = src_row       ← fix swapped entity's row
8.  target_arch.write_fields(dst_row, component_id, values)          ← write new component data
9.  entity_archetype[entity_index] = target_arch_id
10. entity_row[entity_index] = dst_row
```

### add_components — batch transition

`add_components(entity, [...])` resolves the final archetype in a single pass through all add-edges, then performs one transition. This avoids creating intermediate archetypes when adding multiple components at once.

### Deferred structural changes

Systems run inside `ctx.flush()` boundaries. Calling `ctx.add_component()` or `ctx.remove_component()` during a system does **not** immediately mutate archetype membership — it pushes to flat parallel buffers (`pending_add_ids`, `pending_add_defs`, `pending_add_values`). After every phase, `flush_structural()` applies them in order (adds before removes), then `flush_destroyed()` runs entity destructions.

This guarantees systems in the same phase see a consistent snapshot of the world, and prevents iterator invalidation mid-`each()`.

---

## 8. Queries

**Plain English:** A query is a standing subscription: "give me all archetypes matching these filters, now and in the future". You declare it at system registration time — it's resolved once and live-updated as new archetypes are created. Inside the system, you iterate at full speed over raw arrays.

### The primary API — co-located query builder

```typescript
world.register_system(
  (q, ctx, dt) => {
    q.each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i] * dt;
        pos.y[i] += vel.vy[i] * dt;
      }
    });
  },
  qb => qb.every(Pos, Vel)    // resolved once at registration
);
```

`qb.every(Pos, Vel)` builds the include mask and calls `_resolve_query` immediately. The resulting `Query` object is closed over by the system function — zero per-frame overhead.

### Setup-time queries

For queries created outside system registration (e.g. setup code):

```typescript
const q = world.query(Pos);          // all archetypes with Pos
  .and(Vel)                          // + must have Vel
  .not(Static)                       // must NOT have Static
  .or(Damaged, Burning);             // must have at least one of these
```

`world.query()` uses the same cache as `register_system`, so duplicate queries share the same `Query` instance.

### Three-mask semantics

| Mask | Built by | Archetype passes when |
|------|----------|-----------------------|
| `include` | `qb.every()` / `.and()` | `arch.mask.contains(include)` |
| `exclude` | `.not()` | `!arch.mask.overlaps(exclude)` |
| `any_of` | `.or()` | `arch.mask.overlaps(any_of)` |

### Caching

Every `Query` is cached on `World` by a combined hash of all three masks:

```typescript
const key = ((inc_hash ^ Math.imul(exc_hash, 0x9e3779b9))
                         ^ Math.imul(any_hash, 0x517cc1b7)) | 0;
```

Cache hit → same `Query` reference returned, O(1), zero allocation.
Cache miss → `store.register_query()` called once, live array registered, `Query` stored.

`.and()` and `.not()` and `.or()` chain by building new masks from the current ones and calling `_resolve_query()`. Order is irrelevant — same component set produces the same BitSet hash.

### `World.query()` scratch mask `[opt:6]`

`World.query()` reuses a single `scratch_mask: BitSet` on the World object rather than allocating a new one each call. It fills the scratch mask in-place, calls `mask.copy()` before passing it downstream, then the scratch is ready for the next call. The `arguments` object is used instead of rest parameters (`...defs`) to avoid materialising a temporary `Array` on every call.

### `Query.each()` — the hot path

```typescript
each(fn: EachFn<Defs>): void {
  for (let ai = 0; ai < archs.length; ai++) {
    const arch = archs[ai];
    const count = arch.entity_count;
    if (count === 0) continue;
    // fill pre-allocated args buffer with column records + count
    (fn as (...a: unknown[]) => void).apply(null, buf);
  }
}
```

`fn` is called **once per archetype**, not once per entity. Inside `fn`, the user's loop runs over raw `number[]` column slices — no boxing, no GC, no per-entity dispatch. The args buffer (`_args_buf`) is pre-allocated at `Query` construction time and reused on every `each()` call.

For maximum throughput, you can bypass `each()` entirely and iterate `q.archetypes` directly:

```typescript
const archs = q.archetypes;
for (let a = 0; a < archs.length; a++) {
  const col = archs[a].get_column(Pos, "x");
  const n = archs[a].entity_count;
  for (let i = 0; i < n; i++) { col[i] *= 2; }
}
```

---

## 9. Systems and Scheduling

**Plain English:** A system is just a function. You register it with a query builder, tell the scheduler which phase it belongs to (and optionally what it must run before or after), and the engine calls it every frame. Between systems in a phase, deferred changes are buffered. Between phases, they flush.

### Registration — fn + query builder

```typescript
const sys = world.register_system(
  (q, ctx, dt) => {
    // q: pre-resolved Query, ctx: SystemContext for deferred ops, dt: delta time
  },
  qb => qb.every(Pos, Vel)
);

world.add_systems(SCHEDULE.UPDATE, sys);
```

The system fn receives `(q, ctx, dt)` — not `(ctx, dt)` as in a raw `SystemFn`. The wrapping happens inside `register_system`.

### Lifecycle hooks (config form)

For systems that need setup or teardown, use the `SystemConfig` form:

```typescript
world.register_system({
  fn: (ctx, dt) => { ... },
  on_added: (store) => { /* pre-computation at registration time */ },
  on_removed: () => { /* cleanup when system is unregistered */ },
  dispose: () => { /* world teardown */ },
});
```

### SystemContext

`SystemContext` is the interface available to system code for deferred and immediate operations:

| Method | Behaviour |
|--------|-----------|
| `create_entity()` | Immediate — returns new EntityID |
| `add_component(e, Def, values)` | Deferred until end of phase |
| `remove_component(e, Def)` | Deferred until end of phase |
| `destroy_entity(e)` | Deferred until end of phase |
| `get_field(Def, e, field)` | Immediate single-entity read |
| `set_field(Def, e, field, value)` | Immediate single-entity write |

`world.ctx` exposes the same `SystemContext` for use outside system functions (e.g. setup code).

### Phases

```
PRE_STARTUP → STARTUP → POST_STARTUP    (once on world.startup())
PRE_UPDATE  → UPDATE  → POST_UPDATE     (every world.update(dt))
```

Each phase runs all its systems in topological order, then calls `ctx.flush()`.
`flush()` applies deferred structural changes (add/remove component) then deferred destructions.

### Ordering constraints `[opt:8]`

Systems within a phase can declare ordering:

```typescript
world.add_systems(SCHEDULE.UPDATE,
  { system: PhysicsSystem, ordering: { before: [RenderSystem] } },
  RenderSystem,
);
```

The `Schedule` resolves these with **Kahn's algorithm**:
1. Build a directed acyclic graph from `before`/`after` constraints.
2. Track a `ready` queue of systems with in-degree 0, sorted by insertion order for deterministic tiebreaking.
3. If any nodes remain after the sort, a cycle exists — an error is thrown at sort time, not at runtime.

Sorted order is cached per-phase; re-sort only happens when the system list changes.

---

## 10. End-to-end data flow

### Startup

```
world.startup()
  └── schedule.run_startup(ctx)
        ├── PRE_STARTUP:  systems run, ctx.flush()
        ├── STARTUP:      systems run, ctx.flush()
        └── POST_STARTUP: systems run, ctx.flush()
```

### Frame update

```
world.update(dt)
  └── schedule.run_update(ctx, dt)
        ├── PRE_UPDATE:  systems run, ctx.flush()
        ├── UPDATE:      systems run, ctx.flush()
        └── POST_UPDATE: systems run, ctx.flush()
```

### Inside a system

```typescript
world.register_system(
  (q, _ctx, dt) => {
    q.each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i] * dt;   // number[] direct write
        pos.y[i] += vel.vy[i] * dt;
      }
    });
  },
  qb => qb.every(Pos, Vel).not(Static)
);
```

### add_component across a phase boundary

```
Frame N, system A:
  ctx.add_component(e, Vel, {vx:1, vy:0})
    → pushed to store.pending_add buffers

End of phase (ctx.flush()):
  store.flush_structural()
    └── store.add_component(e, Vel, {vx:1, vy:0})
          ├── resolve_add: [Pos] + Vel → [Pos, Vel]  (edge O(1))
          ├── [Pos, Vel].add_entity(e)               (append row)
          ├── copy_shared_from([Pos], src_row)       (copy Pos column data)
          ├── write_fields(dst_row, Vel, {vx:1})     (write Vel column data)
          ├── [Pos].remove_entity(src_row)           (swap-and-pop)
          └── matching registered queries auto-updated (live array reference)

Frame N+1, system B:
  q.archetypes  // same live array, now includes [Pos,Vel] archetype
```

---

## File map

```
src/
  world.ts                    ← public API facade, QueryResolver, query cache
  store/store.ts              ← orchestrator: entity IDs, component metas, archetype transitions
  entity/
    entity.ts                 ← packed ID layout, bit helpers
  component/
    component.ts              ← ComponentDef phantom type, schema types, TypeTag
  archetype/
    archetype.ts              ← dense table: column_groups, entity_ids, edges
    archetype_registry.ts     ← dedup, component index, query registration, transitions
  query/query.ts              ← Query<Defs>, QueryBuilder, QueryResolver, SystemContext
  system/
    system.ts                 ← SystemFn, SystemConfig, SystemDescriptor types
    system_registry.ts        ← assigns SystemIDs, calls lifecycle hooks
  schedule/schedule.ts        ← phases, Kahn sort, flush boundaries
  type_primitives/
    bitset/bitset.ts          ← Uint32Array-backed BitSet, hash, contains, overlaps
    brand.ts                  ← Brand<T, Tag> phantom type utility
```
