# Errors

Every error the `ECS` throws is an **`ECSError`** carrying a machine-readable `category` from the `ECS_ERROR` enum. Catch it and branch on the category instead of matching message strings — a host distinguishing a recoverable validation throw from a fatal cap hit, or a test asserting a specific fail-closed path.

```ts
import { ECSError, ECS_ERROR, isEcsError } from "@oasys/oecs";

try {
  ecs.addComponent(e, Pos, { x: 0, y: 0 });
} catch (err) {
  if (isEcsError(err)) {
    if (err.category === ECS_ERROR.ENTITY_NOT_ALIVE) { /* recover */ }
    else throw err;
  }
}
```

```ts
class ECSError extends Error {
  readonly category: ECS_ERROR;   // message defaults to the category string
}
function isEcsError(error: unknown): error is ECSError;
```

`ECSError`, `ECS_ERROR`, and `isEcsError` are exported from the **package root** (`@oasys/oecs`).

> [!IMPORTANT]
> **Most `ECSError`s are dev-only.** The validation and access-check throws are gated by `__DEV__` and gone in production, where the same mistake fails open instead. The exceptions that fire in **any** build are the structural/fatal ones: `CIRCULAR_SYSTEM_DEPENDENCY`, `STORE_CAP_EXCEEDED`, `INVALID_MEMORY_OPTIONS`, `DETERMINISM_DISABLED`, and the construction-time validators. Treat dev throws as a development safety net, not a production error-handling channel — see [dev vs prod](./index.md#dev-vs-prod--read-this-once).

## Categories

All 42 `ECS_ERROR` values, grouped by area:

**Entities & components**
`EID_MAX_INDEX_OVERFLOW` · `EID_MAX_GEN_OVERFLOW` · `ENTITY_NOT_ALIVE` · `ENTITY_NOT_DISABLED` · `COMPONENT_NOT_REGISTERED` · `COMPONENT_LIMIT_EXCEEDED` · `FIELD_NOT_REGISTERED` · `COMPONENT_INDEX_INVARIANT`

**Systems & schedule**
`CIRCULAR_SYSTEM_DEPENDENCY` · `DUPLICATE_SYSTEM` · `SYSTEM_FN_ARITY` · `QUERY_ACCESS_UNDECLARED` · `OPTIONAL_TERM_NOT_DECLARED` · `INVALID_FIXED_TIMESTEP` · `INVALID_MAX_FIXED_STEPS`

**Queries, archetypes, sparse & relations**
`ARCHETYPE_NOT_FOUND` · `EMPTY_ARCHETYPE_MATERIALIZE` · `SPARSE_QUERY_DENSE_PATH` · `SPARSE_CACHE_KEY_OVERFLOW` · `HIERARCHY_ALREADY_SET` · `HIERARCHY_INVALID_MAX_DEPTH` · `RELATION_NOT_REGISTERED` · `RELATION_MODE_INVALID` · `RELATION_MODE_MISMATCH` · `RELATION_CYCLE` · `PARTITION_APPEND_NEEDS_ENTITY_ROW` · `PARTITION_BULK_INTO_DISABLED`

**Resources & events**
`RESOURCE_NOT_REGISTERED` · `RESOURCE_ALREADY_REGISTERED` · `EVENT_NOT_REGISTERED` · `EVENT_ALREADY_REGISTERED`

**Observers**
`OBSERVER_NON_CONVERGENT` · `OBSERVER_INVALID_CONFIG` · `OBSERVER_ONSET_EMIT`

**Determinism, memory & host seam**
`DETERMINISM_DISABLED` · `NON_DETERMINISTIC_COLUMN_TYPE` · `INVALID_MEMORY_OPTIONS` · `STORE_CAP_EXCEEDED` · `REGION_NOT_DECLARED` · `BACKEND_ALREADY_ATTACHED` · `INVALID_RECORDER_SCHEDULE` · `COMMAND_LOG_TAG_COLLISION`

## Errors that are *not* `ECSError`

Two restore paths throw dedicated classes (a `snapshot`/`restore` mismatch is a distinct recovery case), and the store's cap guard throws a plain `Error`:

```ts
class WorldRestoreError extends Error {}    // restoreInto — dense-side shape/identity mismatch
class SparseRestoreError extends Error {}   // restoreSparse — sparse-side mismatch
// StoreCapExceededError is a plain Error; its ECSError-surfaced category is STORE_CAP_EXCEEDED.
```

`WorldRestoreError` and `SparseRestoreError` are exported from the package root; catch them by class (or `err.name`). See [determinism](./determinism.md).

## See also

- [index](./index.md#dev-vs-prod--read-this-once) — the dev-vs-prod contract these throws live under
- [determinism](./determinism.md) — `WorldRestoreError` / `SparseRestoreError` and the fail-closed restore
