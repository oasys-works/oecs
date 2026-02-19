# OECS Design Notes

Optimization rationale for performance-sensitive design decisions.
Code sites are marked with `// optimization*N` (single-line) or `// optimization*N start/end` (multi-line blocks).

---

## [opt:1] Packed generational entity ID

**Files:** `entity/entity.ts`, `store/store.ts`

Every entity is represented as a single 32-bit integer with two packed fields:

```
Bits:  [31 ........... 20][19 ........... 0]
        generation (12)     index (20)
```

- **index** — which slot in the entity arrays (seat number). 20 bits → up to ~1 million concurrent entities.
- **generation** — how many times that slot has been reused. 12 bits → wraps after 4 096 reuses per slot,
  sufficient to catch virtually all stale references in practice.

Packing both into one number yields a copy-friendly, trivially-comparable (`===`) identifier that guards
against the "dangling pointer" problem: holding an old ID after the slot was recycled returns `false` from
`is_alive()` because the baked-in generation no longer matches.

The `>>> 0` coercion at pack time forces the result to an unsigned 32-bit integer so that large generation
values (high bit set) are not misinterpreted as negative by JS bitwise operators.

---

## [opt:2] Entity membership: dense list in Archetype + sparse row map in Store

**Files:** `archetype/archetype.ts`, `store/store.ts`

Entity membership is split across two structures:

- **`entity_ids: EntityID[]`** (in `Archetype`, dense) — a plain JS array holding packed EntityIDs at
  positions 0..N-1. JS arrays use V8's fast elements mode for integer-indexed values, giving O(1)
  `push` / `pop` / indexed write with no GC pressure for numeric content.

- **`entity_row: Int32Array`** (in `Store`, sparse) — maps `entity_index → row` within the entity's
  current archetype. The sentinel `UNASSIGNED = -1` marks either recycled slots or newly created entities
  that have not yet received their first component. `Int32Array` is used for compact memory and fast
  indexed reads — one cache-line-friendly integer per entity slot.

Swap-and-pop on removal applies to `entity_ids` and all component columns simultaneously:
`remove_entity(row)` moves the last entity's data into `row`, pops the last slot, and returns the entity
index of the entity that was moved (so Store can update its `entity_row` entry for that entity).

---

## [opt:3] Archetype graph edge cache: sparse array instead of Map

**Files:** `archetype/archetype.ts`, `archetype/archetype_registry.ts`

Each `Archetype` stores a sparse `ArchetypeEdge[]` array where an edge records:

```ts
{ add: ArchetypeID | null, remove: ArchetypeID | null }
```

ComponentIDs are sequential integers starting from 0, making them ideal as direct array indices. Array
slot access (`this.edges[component_id]`) is a single bounds check + memory read. A `Map<ComponentID, ...>`
would require hashing the integer key, looking it up in a hash table, and allocating an entry object —
all avoidable overhead on the hot path of every `add_component` / `remove_component`.

Edges are lazily populated by `ArchetypeRegistry` the first time a transition is resolved. On a cache
miss, the registry builds the target mask, gets-or-creates the target archetype, and then writes **both
directions** of the edge atomically (`cache_edge`). Subsequent transitions for the same component are
O(1) array reads with no mask arithmetic.

---

## [opt:4] `get_matching`: smallest-set-first intersection + inlined bit-scan

**Files:** `archetype/archetype_registry.ts`

`get_matching` finds all archetypes whose mask is a superset of a query mask. Rather than iterating all
archetypes, it uses a component index (`ComponentID → Set<ArchetypeID>`) and starts from the component
with the fewest archetypes (smallest set). This minimises the number of `contains` calls.

The bit-scan over the query mask is inlined rather than delegated to `BitSet.for_each`. Avoiding the
`for_each` closure eliminates a function allocation per call on the hot query path.

---

## [opt:5] Write-once archetype masks

**Files:** `archetype/archetype_registry.ts`

After a new archetype's `BitSet` mask is built and the archetype is created, the mask is never mutated.
All mask operations that produce a new state (`copy_with_set`, `copy_with_clear`, `copy`) return a new
`BitSet`. This write-once invariant means the mask object's V8 hidden class never changes shape after
construction. V8 can treat it as a stable monomorphic hidden class throughout its lifetime, avoiding
de-optimisation to megamorphic IC sites that occur when V8 observes property additions or shape changes.

---

## [opt:6] `World.query()` scratch mask + `arguments` iteration

**Files:** `world.ts`

`World.query()` maintains a single reusable `scratch_mask: BitSet` on the World object. On each call
the mask is cleared (words filled to zero) and bits are set for each argument. A fresh copy is made
before passing the mask downstream to `_resolve_query`.

Using `arguments` instead of a rest parameter (`...defs`) avoids allocating a temporary array for the
arguments on every call — rest parameters always materialise a new `Array` even when the callee is
inlined. This matters because `World.query()` is also invoked internally by `QueryBuilder.every()`.

---

## [opt:7] Query method overloads

**Files:** `query/query.ts`, `world.ts`

`World.query()` and `QueryBuilder.every()` are declared with explicit typed overloads for 1–4 components
in addition to the variadic signature. This gives TypeScript callers precise phantom-typed return types
(`Query<[Pos, Vel]>` rather than `Query<ComponentDef<ComponentSchema>[]>`) without a rest-parameter
array allocation at the call site for the common case of querying a small fixed number of components.

---

## [opt:8] Kahn's algorithm for topological sort

**Files:** `schedule/schedule.ts`

Systems within a phase are sorted by a topological sort that respects `before`/`after` ordering
constraints. Kahn's algorithm processes nodes by in-degree (edges satisfied = eligible to emit), using
insertion order as a tiebreaker for deterministic output when multiple systems are simultaneously ready.

The ready queue is maintained as a plain array and sorted by insertion order each time new nodes become
eligible. This is correct and efficient for the typical case of a small number of systems per phase
(V is small). If `V` systems remain after the sort, all edges have been satisfied. If nodes remain after
the algorithm completes, a cycle exists — an error is thrown immediately at sort time (not at runtime
during a frame update), giving a fast feedback loop during development.

Sorted order is cached per phase and only recomputed when the system list for that phase changes.

---

## [opt:9] Geometrically-grown arrays for entity slot maps

**Files:** `store/store.ts`

`Store` maintains two parallel `Int32Array`s indexed by entity slot index:

- `entity_archetype: Int32Array` — which archetype the entity is in
- `entity_row: Int32Array` — which row within that archetype

Both start at 256 capacity and double when `ensure_entity_capacity` needs a larger index. Geometric
doubling amortises the cost of copying to O(1) per entity slot appended, while keeping the arrays
compact for small worlds. `Int32Array` is used rather than a plain `number[]` for its predictable
memory layout and fast integer read/write without boxing.

Archetype column arrays (`number[][]`) and `entity_ids: EntityID[]` use native JS array `push` / `pop`
directly. V8's fast elements mode handles growth automatically for arrays containing only numbers.

---

## [opt:10] Skip empty archetype bounce on `create_entity()`

**Files:** `store/store.ts`

When a new entity is created, it has no components yet. Previously the entity was immediately added to
the empty archetype (an archetype with no components, used as the starting point for all transitions).
This wasted one archetype transition for every entity that would immediately receive components.

The current design uses the `UNASSIGNED = -1` sentinel in `entity_row` to represent "this entity exists
but has no archetype row yet". On the first `add_component` call:

- `entity_row[index] === UNASSIGNED` → skip `copy_shared_from` (nothing to copy) and skip `remove_entity`
  (not in any archetype's dense list).
- Just add to the target archetype and write fields directly.

`entity_archetype[index]` is still set to `empty_archetype_id` at creation so that `has_component` and
`get_entity_archetype` work correctly before any components are added.

This eliminates one wasted membership write and one wasted swap-and-pop per entity creation, which is
measurable in benchmarks that create and destroy large numbers of entities per frame.
