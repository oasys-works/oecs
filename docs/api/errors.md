# Errors

Each error that the `ECS` throws is an **`ECSError`**. It carries a `category` from the `ECS_ERROR`
enum, which a program can read. Catch the error and select a branch on the category. Do not compare
the text of the message. A host can then tell the difference between a validation error that it can
recover from and a fatal error about a limit. A test can assert one specific path that fails
safely.

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
  readonly category: ECS_ERROR;   // the message is the category string by default
}
function isEcsError(error: unknown): error is ECSError;
```

The **package root** (`@oasys/oecs`) exports `ECSError`, `ECS_ERROR`, and `isEcsError`.

> [!IMPORTANT]
> **Most `ECSError` values are for development only.** The `__DEV__` flag controls the validation
> and access-check errors, and they are absent from a production build. There the same mistake
> fails without a signal. These errors occur in **each** build, because they are structural or
> fatal: `CIRCULAR_SYSTEM_DEPENDENCY`, `STORE_CAP_EXCEEDED`, `INVALID_MEMORY_OPTIONS`,
> `DETERMINISM_DISABLED`, `INVALID_FRAME_STEP`, and the validators that run at construction. Use a
> development error as a safety net while you develop. Do not use it as a channel for error
> handling in production. See
> [development and production](./index.md#dev-vs-prod--read-this-once).

## Categories

These are the 48 `ECS_ERROR` values, in groups by area:

**Entities and components**
`EID_MAX_INDEX_OVERFLOW` · `EID_MAX_GEN_OVERFLOW` · `ENTITY_NOT_ALIVE` · `ENTITY_NOT_DISABLED` · `COMPONENT_NOT_REGISTERED` · `COMPONENT_LIMIT_EXCEEDED` · `FIELD_NOT_REGISTERED` · `COMPONENT_INDEX_INVARIANT`

**Systems and the schedule**
`CIRCULAR_SYSTEM_DEPENDENCY` · `DUPLICATE_SYSTEM` · `SYSTEM_FN_ARITY` · `QUERY_ACCESS_UNDECLARED` · `ACCESS_UNDECLARED` · `OPTIONAL_TERM_NOT_DECLARED` · `INVALID_RUN_CONDITION` · `INVALID_FIXED_TIMESTEP` · `INVALID_MAX_FIXED_STEPS` · `INVALID_FRAME_STEP`

**Queries, archetypes, sparse storage, and relations**
`ARCHETYPE_NOT_FOUND` · `ARCHETYPE_ROW_INVARIANT` · `EMPTY_ARCHETYPE_MATERIALIZE` · `QUERY_NOT_SINGLETON` · `SPARSE_QUERY_DENSE_PATH` · `SPARSE_CACHE_KEY_OVERFLOW` · `HIERARCHY_ALREADY_SET` · `HIERARCHY_INVALID_MAX_DEPTH` · `RELATION_NOT_REGISTERED` · `RELATION_MODE_INVALID` · `RELATION_MODE_MISMATCH` · `RELATION_CYCLE` · `PARTITION_APPEND_NEEDS_ENTITY_ROW` · `PARTITION_BULK_INTO_DISABLED` · `STRUCTURAL_DURING_ITERATION`

**Resources and events**
`RESOURCE_NOT_REGISTERED` · `RESOURCE_ALREADY_REGISTERED` · `EVENT_NOT_REGISTERED` · `EVENT_ALREADY_REGISTERED`

**Observers**
`OBSERVER_NON_CONVERGENT` · `OBSERVER_INVALID_CONFIG` · `OBSERVER_ONSET_EMIT`

**Determinism, memory, and the host write path**
`DETERMINISM_DISABLED` · `NON_DETERMINISTIC_COLUMN_TYPE` · `INVALID_MEMORY_OPTIONS` · `STORE_CAP_EXCEEDED` · `REGION_NOT_DECLARED` · `BACKEND_ALREADY_ATTACHED` · `INVALID_RECORDER_SCHEDULE` · `COMMAND_LOG_TAG_COLLISION`

It is easy to confuse a small number of these with a category near them:

- `ACCESS_UNDECLARED` — A system touched a component, a sparse component, a relation, or a resource
  that it did not declare in its access surface. This is different from `*_NOT_REGISTERED`, which
  means that you never registered the item with the world. The engine also throws
  `ACCESS_UNDECLARED` when you call an immediate structural mutator on the host from inside a system
  body. Those mutators are `ecs.despawn`, `ecs.addComponent` and `ecs.removeComponent` with their
  plural forms, `ecs.disable` and `ecs.enable`, and `ecs.batchAddComponent` and
  `ecs.batchRemoveComponent`. In a system, use the deferred `ctx.commands.*` functions instead.
- `ARCHETYPE_ROW_INVARIANT` — The row bookkeeping of an archetype does not agree with its backing
  columns. There are three causes. A reserve did not give the capacity that the engine asked for. A
  restore gave a partition boundary that is out of range. Or a cached row plane points at a buffer
  that is no longer current. This is a failure of an internal invariant, and not a mistake by the
  caller. It is different from `STORE_CAP_EXCEEDED`, which is the allocator that refuses a
  legitimate grow. This assertion is in development builds only.
- `QUERY_NOT_SINGLETON` — `Query.singleEntity()` found 0 matching entities, or more than 1. This
  assertion is in development builds only.
- `INVALID_RUN_CONDITION` — A factory for a run condition, such as `runEveryNTicks`, received an
  invalid argument, for example an `n` that is not a positive integer. This is in development
  builds only.
- `STRUCTURAL_DURING_ITERATION` — An immediate structural mutation on the host reached an archetype
  that a live query walk is visiting now. The mutations are `despawn`, a transition from
  `addComponent` or `removeComponent`, and `disable` or `enable`. The walks are `forEach`,
  `eachChunk`, `forEachUntil`, and `changed(...).forEach`. The row swap would skip an entity, or
  give it two times, below the iterator. Collect the ids during the walk, and mutate after it. This
  is in development builds only.

## The errors that are *not* an `ECSError`

The restore paths throw their own classes, because a mismatch between a capture and a restore is a
different case for recovery. There are three classes, one for each layer that can fail:

```ts
class ECSRestoreError extends Error {}     // ecs.snapshots.restore — a malformed combined frame, an incorrect magic number or version, or a different registration
class StoreRestoreError extends Error {}   // the section of the dense column store — a different header, layout, or shape, reported through restore
class SparseRestoreError extends Error {}  // ecs.snapshots.restoreSparse (and the sparse section of restore) — a difference on the sparse side
```

The package root exports all three. Catch them by class, or by `err.name`. When a failure of the
byte limit of the store comes out through the `ECS`, it is an `ECSError` with
`category === ECS_ERROR.STORE_CAP_EXCEEDED`. See [determinism](./determinism.md).

## See also

- [index](./index.md#dev-vs-prod--read-this-once) — the contract for development and production
  that these errors operate under
- [determinism](./determinism.md) — `ECSRestoreError`, `SparseRestoreError`, and the restore that
  fails safely
