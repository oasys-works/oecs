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
> fatal: `CIRCULAR_SYSTEM_DEPENDENCY`, `CIRCULAR_PHASE_DEPENDENCY`, `UNKNOWN_PHASE`,
> `STORE_CAP_EXCEEDED`, `INVALID_MEMORY_OPTIONS`,
> `DETERMINISM_DISABLED`, `INVALID_FRAME_STEP`, `PLUGIN_NOT_INSTALLED`,
> `PLUGIN_ALREADY_INSTALLED`, `WORKERS_ATTACHED`, `WORKERS_NEED_SHARED_BACKING`,
> `WORKERS_HOST_CANNOT_PARK`, `WORKERS_COUNT_INVALID`, `WORKERS_ENTRY_UNREACHABLE`,
> `PARALLEL_KERNEL_FAILED`, and the
> validators that run at construction. Use a
> development error as a safety net while you develop. Do not use it as a channel for error
> handling in production. See
> [development and production](./index.md#dev-vs-prod--read-this-once).

## Categories

These are the 65 `ECS_ERROR` values, in groups by area:

**Entities and components**
`EID_MAX_INDEX_OVERFLOW`, `EID_MAX_GEN_OVERFLOW`, `ENTITY_NOT_ALIVE`, `COMPONENT_NOT_REGISTERED`, `COMPONENT_LIMIT_EXCEEDED`, `FIELD_NOT_REGISTERED`, `COMPONENT_INDEX_INVARIANT`, `INVALID_TEMPLATE`

**Systems and the schedule**
`CIRCULAR_SYSTEM_DEPENDENCY`, `DUPLICATE_SYSTEM`, `SYSTEM_FN_ARITY`, `INVALID_SYSTEM_ID`, `UNKNOWN_PHASE`, `CIRCULAR_PHASE_DEPENDENCY`, `QUERY_ACCESS_UNDECLARED`, `ACCESS_UNDECLARED`, `OPTIONAL_TERM_NOT_DECLARED`, `INVALID_RUN_CONDITION`, `INVALID_FIXED_TIMESTEP`, `INVALID_MAX_FIXED_STEPS`, `INVALID_FRAME_STEP`

**Queries, archetypes, sparse storage, and relations**
`ARCHETYPE_NOT_FOUND`, `ARCHETYPE_ROW_INVARIANT`, `EMPTY_ARCHETYPE_MATERIALIZE`, `QUERY_NOT_SINGLETON`, `QUERY_TERM_DENSE_PATH`, `SPARSE_QUERY_DENSE_PATH`, `SPARSE_CACHE_KEY_OVERFLOW`, `HIERARCHY_ALREADY_SET`, `HIERARCHY_INVALID_MAX_DEPTH`, `RELATION_NOT_REGISTERED`, `RELATION_MODE_INVALID`, `RELATION_MODE_MISMATCH`, `RELATION_CYCLE`, `PARTITION_APPEND_NEEDS_ENTITY_ROW`, `PARTITION_BULK_INTO_DISABLED`, `STRUCTURAL_DURING_ITERATION`

**Resources and events**
`RESOURCE_NOT_REGISTERED`, `RESOURCE_ALREADY_REGISTERED`, `EVENT_NOT_REGISTERED`, `EVENT_ALREADY_REGISTERED`, `INVALID_EVENT_ID`

**Observers**
`OBSERVER_NON_CONVERGENT`, `OBSERVER_INVALID_CONFIG`, `OBSERVER_ONSET_EMIT`, `ROW_TICKS_NOT_TRACKED`

**Plugins**
`PLUGIN_NOT_INSTALLED`, `PLUGIN_ALREADY_INSTALLED`, `PLUGIN_SURFACE_COLLISION`

**Workers and parallel systems**
`WORKERS_ATTACHED`, `WORKERS_NEED_SHARED_BACKING`, `WORKERS_HOST_CANNOT_PARK`, `WORKERS_COUNT_INVALID`, `WORKERS_ENTRY_UNREACHABLE`, `PARALLEL_ACCESS`, `PARALLEL_KERNEL_MODULE`, `PARALLEL_KERNEL_FAILED`

**Determinism, memory, and the host write path**
`DETERMINISM_DISABLED`, `NON_DETERMINISTIC_COLUMN_TYPE`, `INVALID_MEMORY_OPTIONS`, `STORE_CAP_EXCEEDED`, `REGION_NOT_DECLARED`, `BACKEND_ALREADY_ATTACHED`, `INVALID_RECORDER_SCHEDULE`, `COMMAND_LOG_TAG_COLLISION`

It is easy to confuse a small number of these with a category near them:

- `PLUGIN_NOT_INSTALLED`. The world never installed the subsystem the call needs: relations,
  events, snapshots, observers, or workers. The message names the API and the import that supplies
  it, and the remedy is at the construction site, `ECS.create({ plugins: [...] })`. This is different from
  `*_NOT_REGISTERED`, which means that the world has the subsystem and not that one component,
  event, or relation. In TypeScript the same mistake is a compile error, because a world carries
  only the members its plugins contribute.
- `PLUGIN_SURFACE_COLLISION`. A plugin's facade names a member the world already carries.
  `Object.assign` would overwrite it in silence, and the world would lose a method it needs. The
  remedy is to rename the member the plugin adds. The five slots a plugin is meant to fill,
  `relations`, `events`, `observe`, `snapshots`, and `workers`, are exempt. This check is in development builds
  only.
- `UNKNOWN_PHASE`. `addSystems` or `addPhase` was given a phase that this world does not hold: a
  string that no `SCHEDULE` member spells, or a `Phase` handle that another world made. A handle
  belongs to the world whose `addPhase` returned it. This is different from
  `CIRCULAR_PHASE_DEPENDENCY`, which means that the phases exist and that their order holds a
  cycle. Both are in each build.
- `ACCESS_UNDECLARED`. A system touched a component, a sparse component, a relation, or a resource
  that it did not declare in its access surface. This is different from `*_NOT_REGISTERED`, which
  means that you never registered the item with the world. The engine also throws
  `ACCESS_UNDECLARED` when you call an immediate structural mutator on the host from inside a system
  body. Those mutators are `ecs.despawn`, `ecs.addComponent` and `ecs.removeComponent` with their
  plural forms, `ecs.disable` and `ecs.enable`, and `ecs.batchAddComponent` and
  `ecs.batchRemoveComponent`. In a system, use the deferred `ctx.commands.*` functions instead.
- `WORKERS_ATTACHED`. `workers.attach` ran on a world that already holds a pool. There is one pool
  for each world, because one control buffer carries one barrier. Detach the first pool before you
  attach another. This is in each build.
- `WORKERS_NEED_SHARED_BACKING`. `workers.attach` ran on a world whose bytes a worker cannot reach.
  A worker reads the columns directly, and a plain `ArrayBuffer` crosses no thread boundary. Build
  the world with `memory.backing` `"shared"` or `{ wasm }`. The message names the backing you gave.
  This is in each build.
- `WORKERS_HOST_CANNOT_PARK`. The host refuses `Atomics.wait`, so it cannot park while the workers
  run. A browser main thread is the case. Host the world inside a worker, and attach the pool from
  there. This is in each build.
- `WORKERS_COUNT_INVALID`. `workers.attach` was given a number outside its range. The worker `count`,
  `joinTimeoutMs` and `stackBytes` are the three, and the message names which one and the value.
  `count` and `joinTimeoutMs` must be positive integers. `stackBytes` must be an integer, a multiple
  of the frame alignment of 16, and at least one WASM page of 65536 bytes. This is in each build.
- `WORKERS_ENTRY_UNREACHABLE`. A worker's script did not load, so the worker answered nothing. A
  bundled app that kept the default worker URL is the case, because a bundler leaves
  `@oasys/oecs/worker` out of its graph. Pass `workerUrl` with the URL your bundler emits for that
  entry. The message names the URL that failed. This is in each build.
- `PARALLEL_ACCESS`. A system declares `parallel` beside access a worker cannot serve, or a query a
  worker cannot resolve from the archetype masks. The message names the field and why. Drop the
  declaration, or run the system sequentially. This is in development builds only, and it throws at
  registration and not inside a frame.
- `PARALLEL_KERNEL_MODULE`. A system names a `wasm` kernel whose module the pool cannot serve.
  A worker instantiates the module with one import, the world memory as `env.memory`, so every
  other import is refused and the message names it. A module that imports no memory is refused as
  well, because it addresses a linear memory of its own and never reaches the store. An export name
  the module does not carry, and an export that is not a function, are the other two. This is in
  development builds only, and it throws at registration and not inside a frame.
- `PARALLEL_KERNEL_FAILED`. A kernel would not load, a kernel threw inside a pass, or a worker
  missed the join inside `joinTimeoutMs`. The message names the kernel export, and the worker index
  when a worker reported the fault itself. Fix the kernel, or raise `parallel.minRows` to keep the
  system sequential. After a join timeout the pool refuses every later pass, so detach it. This is
  in each build. Four load faults are worth naming on their own, and the message states each fact
  and its remedy:
  - the export takes the wrong number of parameters, and the message gives both counts,
  - the module exports a `__stack_pointer` and the span between its `__heap_base` and the store
    base leaves no stack region for each worker, so raise `memory.storeBase`,
  - the module exports a `__stack_pointer` and no numeric `__heap_base`, so link with
    `--export=__heap_base`,
  - the module's `__stack_pointer` is immutable, so no host can give a worker its own stack. Build
    with mutable globals, or give the kernel a body that uses no stack.
- `ARCHETYPE_ROW_INVARIANT`. The row bookkeeping of an archetype does not agree with its backing
  columns. There are three causes. A reserve did not give the capacity that the engine asked for. A
  restore gave a partition boundary that is out of range. Or a cached row plane points at a buffer
  that is no longer current. This is a failure of an internal invariant, and not a mistake by the
  caller. It is different from `STORE_CAP_EXCEEDED`, which is the allocator that refuses a
  legitimate grow. This assertion is in development builds only.
- `QUERY_NOT_SINGLETON`. `Query.singleEntity()` found 0 matching entities, or more than 1. This
  assertion is in development builds only.
- `INVALID_RUN_CONDITION`. A factory for a run condition, such as `runEveryNTicks`, received an
  invalid argument, for example an `n` that is not a positive integer. This is in development
  builds only.
- `STRUCTURAL_DURING_ITERATION`. An immediate structural mutation on the host reached an archetype
  that a live query walk is visiting now. The mutations are `despawn`, a transition from
  `addComponent` or `removeComponent`, and `disable` or `enable`. The walks are `forEach`,
  `forEachChunk`, `some`, and `changed(...).forEach`. The row swap would skip an entity, or
  give it two times, below the iterator. Collect the ids during the walk, and mutate after it. This
  is in development builds only.

## The errors that are *not* an `ECSError`

The restore paths throw their own classes, because a mismatch between a capture and a restore is a
different case for recovery. There are three classes, one for each layer that can fail:

```ts
class ECSRestoreError extends Error {}     // ecs.snapshots.restore, a malformed combined frame, an incorrect magic number or version, or a different registration
class StoreRestoreError extends Error {}   // the section of the dense column store, a different header, layout, or shape, reported through restore
class SparseRestoreError extends Error {}  // ecs.snapshots.restoreSparse (and the sparse section of restore), a difference on the sparse side
```

The package root exports all three. Catch them by class, or by `err.name`. When a failure of the
byte limit of the store comes out through the `ECS`, it is an `ECSError` with
`category === ECS_ERROR.STORE_CAP_EXCEEDED`. See [determinism](./determinism.md).

## See also

- [index](./index.md#dev-vs-prod--read-this-once), the contract for development and production
  that these errors operate under
- [determinism](./determinism.md), `ECSRestoreError`, `SparseRestoreError`, and the restore that
  fails safely
