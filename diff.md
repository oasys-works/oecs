---

## Core Architecture: Surprisingly Similar

Both OECS and piecs are **archetype-based ECS with globally-indexed SoA storage and zero-cost archetype transitions**. The fundamental data model is the same: component data lives in flat arrays indexed by entity ID, archetypes are metadata-only membership trackers, and moving an entity between archetypes never copies component data.

The differences are in **how lean the hot path is**.

---

## Key Differences

### 1. piecs doesn't manage component data at all

This is the biggest difference. In piecs, a "component" is just an integer ID. The library never touches component data — users bring their own typed arrays:

```js
// piecs: user manages storage directly
const Pos = { id: world.createComponentId(), x: new Float32Array(N), y: new Float32Array(N) }

// system receives a dense entity array, user indexes directly
(entities) => {
  for (let i = 0; i < entities.length; i++) {
    Pos.x[entities[i]] += Vel.vx[entities[i]]
  }
}
```

In OECS, the library owns the storage via `ComponentRegistry`, with `ComponentStore`, `field_index` Map, `columns` array, capacity management, poison values on clear, and `get_column()` / `get_field()` / `set_field()` APIs.

**Performance impact:** Every layer of abstraction you add between "system code" and "typed array read" is overhead. piecs has **zero** abstraction — the system directly indexes a typed array it already holds a reference to. OECS has:

- `get_column(def, field)` → `stores[componentId]` → `field_index.get(fieldName)` → `columns[colIndex]` — done once per system per frame (fine)
- But the `ComponentRegistry` infrastructure (capacity tracking, auto-growth, poison values) adds code complexity that the JIT must reason about

### 2. BitSet vs sorted-array archetype identity

|                    | piecs                                                 | OECS                                             |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------ |
| **Identity**       | `Uint32Array` bitmask                                 | `ComponentID[]` sorted array                     |
| **Query match**    | Bitwise `&` across words                              | Set intersection with smallest-set-first         |
| **Has component?** | `mask[id >>> 5] & (1 << (id & 0x1f))` — 1 instruction | Binary search on sorted array — O(log n)         |
| **Transition key** | `mask.xor(componentId)` — 1 instruction               | Build new sorted array, FNV-1a hash, bucket scan |

BitSet operations are fundamentally cheaper. Checking "does archetype A match query Q?" is a few bitwise ANDs across `Uint32Array` words vs. a multi-step set intersection algorithm. This matters during query resolution and when new archetypes are created.

### 3. SparseSet implementation: plain arrays vs TypedArrays

piecs uses **plain JS arrays** (`number[]`) for both the dense and sparse arrays in its SparseSet. OECS uses `Uint32Array` (dense) and `Int32Array` (sparse).

This is counterintuitive — you'd think TypedArrays are faster. But:

- Plain JS arrays with V8's SMI (Small Integer) optimization are **faster for push/pop** (no bounds checking, no reallocation copy needed — V8 grows them internally)
- `values.pop()!` on a plain array is a single V8 internal operation; on a TypedArray you must manually track length and do `this.len--`
- piecs exposes `sparseSet.values` directly to systems — it's the raw `number[]` that gets iterated. No `.subarray()` view needed.

### 4. Archetype graph: array vs Map

piecs indexes adjacency by component ID using a **plain array**:

```js
archetype.adjacent[componentId]; // O(1) array index
```

OECS uses `Map<ComponentID, ArchetypeEdge>`:

```js
archetype.edges.get(componentId); // Map lookup
```

Array index is faster than Map lookup. Since component IDs are small sequential integers, a sparse array works perfectly here.

### 5. `Object.freeze()` on everything

piecs freezes all archetypes, queries, sparse sets, and bitsets. This tells V8 the object shape is **permanently fixed**, enabling:

- Monomorphic inline caches (V8 never needs to check if the shape changed)
- Potential hidden-class sharing
- The JIT can treat property accesses as constant offsets

OECS uses class instances, which are generally well-optimized by V8 too, but frozen plain objects can be slightly faster for property access patterns.

### 6. No generational entity IDs

piecs uses plain incrementing `number` with recycling — no generation bits, no pack/unpack. OECS packs generation + index into 32 bits.

On the hot path, OECS does `get_entity_index(list[i])` which is `id & 0xFFFFF` on **every entity in every system**. piecs just uses `entities[i]` directly — the entity ID _is_ the index.

This is a small cost per entity (~1 extra bitwise op), but it adds up across 100k entities × 100 systems.

### 7. Query cache fingerprinting vs static resolution

piecs resolves queries **once at init** and incrementally adds new archetypes as they appear. The matching archetype list is a plain array that's always ready.

OECS has a more sophisticated cache with FNV-1a hashing and fingerprint invalidation. This is more flexible (queries can be created dynamically) but adds overhead on every query call — even cache hits require computing the fingerprint sum and comparing it.

---

## What piecs gets right that you could adopt

### Low-hanging fruit:

1. **BitSet for archetype signatures** — Replace sorted `ComponentID[]` with a `Uint32Array` bitmask. This makes `has_component()`, query matching, and transition computation all constant-time bitwise ops instead of array operations.

2. **Plain array indexed adjacency** — Replace `Map<ComponentID, ArchetypeEdge>` with `adjacent: Archetype[]` indexed by component ID. Array index > Map lookup.

3. **Expose raw entity arrays without index extraction** — If you can avoid packing generation into the entity ID used for component indexing (e.g., keep generation in a side table, use raw index as the iteration key), you eliminate the per-entity `& 0xFFFFF` on the hot path.

4. **Static query resolution** — Pre-resolve queries at init time and maintain the archetype list incrementally. Drop the fingerprint validation on every `ctx.query()` call.

### Harder / design-level:

5. **Consider making component storage opt-in** — Your `ComponentRegistry` provides nice ergonomics (schema-based typed storage, automatic growth, field access by name) but it's overhead that piecs avoids entirely. You could offer a "raw" path where systems get direct typed array access without going through the registry.

6. **`Object.freeze` on archetypes and queries** — Cheap to add, signals immutability to V8.

---

## What you have that piecs doesn't

- **Generational entity IDs** — piecs has no ABA protection. Stale entity references silently alias new entities. Your design is safer.
- **Managed component storage** — Schema validation, automatic growth, typed field access, poison values for debugging. Better DX.
- **Scheduling with topological sort** — piecs has no system ordering beyond insertion order.
- **Dev-mode assertions** — piecs has minimal validation.
- **Deferred structural changes with proper phase flushing** — piecs has a basic `defer()` callback queue; yours is structured with typed buffers.

The core takeaway: piecs wins on raw speed by being **radically minimal** — it pushes complexity to the user and keeps the library's hot path to the absolute minimum number of JS operations. Your architecture has the same fundamental design (global SoA + metadata-only archetypes) but wraps it in more infrastructure that adds overhead on the critical path.
