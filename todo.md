## Performance related

- [x] **BitSet for archetype signatures** — Replace sorted `ComponentID[]` with a `Uint32Array` bitmask. This makes `has_component()`, query matching, and transition computation all constant-time bitwise ops instead of array operations.

- [ ] **Plain array indexed adjacency** — Replace `Map<ComponentID, ArchetypeEdge>` with `adjacent: Archetype[]` indexed by component ID. Array index > Map lookup. [won't fix, not better]

- [ ] **Expose raw entity arrays without index extraction** — If you can avoid packing generation into the entity ID used for component indexing (e.g., keep generation in a side table, use raw index as the iteration key), you eliminate the per-entity `& 0xFFFFF` on the hot path. [won't fix]

- [ ] **Static query resolution** — Pre-resolve queries at init time and maintain the archetype list incrementally. Drop the fingerprint validation on every `ctx.query()` call. [won't fix, not better]

- [ ] **Consider making component storage opt-in** — Your `ComponentRegistry` provides nice ergonomics (schema-based typed storage, automatic growth, field access by name) but it's overhead that piecs avoids entirely. You could offer a "raw" path where systems get direct typed array access without going through the registry. [won't fix]

- [ ] **`Object.freeze` on archetypes and queries** — Cheap to add, signals immutability to V8. [done]

## Maintanence related

- [ ] Move bitset, sparse-array to typed_primities as a standalone implementation as well as their tests
- [ ] move duplicated logic as util functions

https://javelin.hashnode.dev/ecs-in-js-a-closer-look-at-component-storage
