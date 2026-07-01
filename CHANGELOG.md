# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-06-24

Major release. oecs is **re-derived from the upstream oasys engine ECS** — its modern descendant — and
gains whole subsystems while staying pure-TS and zero-dependency by default. The public API moves to
the engine's surface, so **every consumer touches breaking changes** — chiefly a global
`snake_case` → `camelCase` rename. See [docs/MIGRATION-0.3-to-0.4.md](docs/MIGRATION-0.3-to-0.4.md).

### Changed (breaking)

- **The entire public API is now `camelCase`.** Every method, property, parameter, and field renamed
  from `snake_case` (`create_entity` → `createEntity`, `add_component` → `addComponent`, `get_field` →
  `getField`, `is_alive` → `isAlive`, `register_system` → `registerSystem`, …). Types and handles stay
  PascalCase and SCREAMING_SNAKE constants are unchanged. A `vitest` casing guard prevents regressions.
- **Renamed query/context verbs.** `QueryBuilder.every` → `with`; `query.not` → `without`;
  `query.any_of` → `anyOf`; `query.for_each` → `forEach`; `archetype.get_column` → `getColumnRead`;
  `event_key` / `signal_key` / `resource_key` → `eventKey` / `signalKey` / `resourceKey`;
  `is_ecs_error` → `isEcsError`; `destroy_entity_deferred` → `destroyEntity` (still deferred).
- **Ref mutability flipped on the unsuffixed name.** `ctx.ref` is now the **mutable** default (was
  read-only in 0.3); the read-only variant is `ctx.refRead` (was `ctx.ref_mut` for the mutable one).
  Same rule for columns: mutable `getColumn` (internal) vs read-only `getColumnRead`.
- **`WorldOptions` → `ECSOptions`; `fixed_timestep` → `fixedTimestep`.**
- **`initial_capacity` removed** — replaced by the `memory` surface (`memory: { budget }` /
  `{ maxBytes }` / `{ columnCapacity }` pin / `{ shared }` / `{ wasm }` / `{ allocator }`). Passing the
  old option keys throws at construction, pointing at `memory`.
- **Component-touching systems must declare `reads` / `writes`.** A new `__DEV__` access checker
  (tree-shaken from production) validates every column / ref / field / resource access against a
  system's declared surface. The bare `(ctx, dt)` and `(q, ctx, dt)` + query-builder `registerSystem`
  overloads declare no access, so a system that touches ECS data through them throws in dev — move it
  to the config form (`registerSystem({ reads, writes, fn })`). `exclusive: true` systems bypass the
  checker. A registration-time lint (`QUERY_ACCESS_UNDECLARED`) additionally checks any declared
  `queries ⊆ reads ∪ writes`.
- **`removeComponents` takes an array, not varargs** (`removeComponents(e, [A, B])`);
  `batchAddComponent` / `batchRemoveComponent` key on `ArchetypeID` instead of an `Archetype` object.
- **Event schema shape.** `eventKey`'s type parameter is now a field → value-type record
  (`eventKey<{ target: EntityID; amount: number }>("Damage")`) rather than a tuple of field names, so
  branded fields round-trip through `emit` / `read`. `registerEvent(key, [...fieldNames])` unchanged
  otherwise.

### Added

- **Two storage profiles over one backing-neutral `ColumnStore`.** Default is pure-TS **heap** (a plain
  resizable `ArrayBuffer`) — no `SharedArrayBuffer`, no cross-origin isolation. Opt-in
  `@oasys/oecs/shared` (`memory: { shared: {} }`) uses a `SharedArrayBuffer` for worker offload / a WASM
  compute backend. Same code path; identical state hash.
- **Determinism** (opt-in `deterministic: true`): a state hash over column bytes + `snapshot()` /
  `restoreInto()` (and `snapshotSparse` / `restoreSparse`), **backing-agnostic** — a heap world and a
  shared world with identical history agree. `WorldRestoreError` / `SparseRestoreError` fail closed
  before overwriting live backing.
- **Observers** — `world.observe(def, { onAdd, onRemove, onSet, onDisable, onEnable })`, structural +
  per-entity.
- **Relations** — `(relation, target)` pairs, `ChildOf` / `IsA` presets (`registerChildOf` /
  `registerIsA`), `(R,*)` / `(*,T)` wildcard queries (`withRelation`, `forEachRelatedTo`,
  `ANY_RELATION`), hierarchy queries (`query.hierarchy`), traversal (`ancestorsOf` / `rootOf` /
  `cascadeOf`), and on-delete cleanup policies.
- **Sparse component storage** (`registerSparseComponent` / `addSparse` / `query.withSparse`),
  **run conditions / system sets** (`systemSet` + `configureSet`; `runIfResourceEq` / `runEveryNTicks`
  / `runIfAnyMatch`), **entity enable/disable** (row-partitioned; `disable` / `enable` /
  `includeDisabled`), and **templates** (`world.template([...])` + `createEntity(template, overrides)`
  / `createEntities(template, count)` for zero-transition spawns).
- **Typed host→ECS write seam** — `installHostCommandSeam(world)` + `applyHostCommand` + a
  `HostCommandQueue` drained by a blessed `exclusive` apply system; a cross-thread ring transport
  (`HostCommandDispatcher`); record/replay (`HostCommandRecorder`, `replayCommandLog`,
  `serializeCommandLog`); and an undo/redo + field-handle layer at `@oasys/oecs/editor`.
- **Frame trace** — `world.setTrace(sink)` + `FrameTraceRecorder` emit a structured per-frame event
  stream (`__DEV__`-gated). **Compute backend seam** — `world.attachBackend(backend)` runs a system's
  body on a compiled backend instead of its TS closure.
- **Reactive UI seam (optional):** zero-dependency kernel at `@oasys/oecs/reactive`; ECS→reactive
  bridge at `@oasys/oecs/reactive-sync` (publish-only-dirty, O(changed)); SolidJS adapter at
  `@oasys/oecs/solid` with `solid-js` as an **optional** peer dependency.
- **`memory` sizing surface** on the constructor: `budget` (by expected `entities`) / `maxBytes` /
  `columnCapacity` / `shared` / `wasm` / `allocator` arms; `resolveECSMemory(...)` exported to inspect
  what an intent resolves to.
- **Hot-path iteration ergonomics:**
  - **`query.eachChunk((cols, count) => …)`** — the mutable per-archetype iterator. `cols.mut(def)` /
    `cols.read(def)` resolve a whole component's field columns at once into a destructurable group
    (`const { x, y } = cols.mut(Pos)`), stamping the change tick once inside `mut` and handing back
    `count` (= `entityCount`). The only mutable column accessor reachable through iteration (the
    `ArchetypeView` from `forEach` stays read-only). Honours `includeDisabled()`; dense-only like `forEach`.
  - **`ctx.commands`** — a Bevy-`Commands`-style facade namespacing the **deferred** structural ops
    (`spawn` / `add` / `remove` / `despawn` / `disable` / `enable`), unambiguously deferred vs the
    immediate `world.addComponent`.
  - **Callable bundles** — `bundle(def, values)` pairs a def with field values (omitted fields
    zero-fill); `world.spawnBundle(...)` (immediate) and `ctx.commands.spawn` / `.add` (deferred)
    accept a `bundle(...)` or a bare def (tag / all-zero), unifying the attach shapes.
  - **`ctx.updateField` / `ctx.markChanged`**, and optional-component queries (`query.optional(...)` +
    `getOptionalColumnRead`).
- **Composable change-detection queries** — `query.changed(...)` returns a `ChangedQuery` that now
  mirrors the dense query verbs (`and` / `without` / `anyOf` / `optional`), so
  `q.changed(Pos).without(Dead)` works (refining *after* `changed()`, previously a dead end).
- **New public exports** — entity-ID codec (`createEntityId` / `getEntityIndex` / `getEntityGeneration`
  + `MAX_*` bounds) for snapshot/replication decode; the error taxonomy (`ECSError`, `ECS_ERROR`,
  `isEcsError`) for catch-and-branch; and `@oasys/oecs/primitives` (`BitSet`, `SparseSet`, `SparseMap`,
  growable typed arrays, `BinaryHeap`, `topologicalSort`).

### Packaging

- **Multi-entry build** → `dist/` emits ESM + CJS + `.d.ts` for every subpath (`.`, `/primitives`,
  `/shared`, `/reactive`, `/reactive-sync`, `/editor`, `/solid`); `sideEffects:false` + tree-shaking
  keep core consumers from pulling SAB / Solid. `solid-js` is an optional peer dependency. `jsr.json`
  exports updated.

## [0.3.3] — 2026-04-30

Release-process and packaging hygiene. No runtime changes.

### Changed

- **JSR bundle slimmed.** `.github/` and `docs/` are now excluded from the published JSR package. Consumers download less; build/CI artefacts stay on GitHub.
- **Tag-driven publish workflow.** `.github/workflows/publish.yml` now triggers on `v*` tag pushes instead of every push to `main`, and creates a GitHub Release alongside the JSR publish. Cuts a release by tagging.

## [0.3.2] — 2026-04-30

Documentation-only release. No runtime changes.

### Added

- **Module overview on `src/index.ts`.** A `@module` block now renders as the JSR Overview tab.
- **JSDoc on the full public surface.** `ECS` and its public methods, `Query` / `QueryBuilder` / `SystemContext` / `ChangedQuery`, all type aliases and interfaces, the event/resource key minters, and the `SCHEDULE` phases are now documented in-source.
- **`@internal` tags on internal-but-public TS members** (e.g. `_resolve_query`, `Query._include`, `SystemContext.store`) so JSR hides them from the rendered docs.

## [0.3.1] — 2026-04-23

Performance-only patch release. Two targeted allocation-elimination changes on hot paths; no API changes; full 466-test suite unchanged.

### Performance

- **Cache multi-component transition maps on `Archetype`.** `add_components` / `remove_components` on already-populated entities previously allocated a fresh `Int16Array` per call via `build_transition_map`. A per-archetype `batch_transition_maps: Map<ArchetypeID, Int16Array>` now caches the map on first use. Single-component paths unchanged. Measured: **+12–15%** throughput on `add_components` (already-populated) at 10k / 100k / 1M; **−35–42%** peak heap and **−49–61%** peak RSS on the same workload. ([#9](https://github.com/oasys-works/oecs/pull/9))
- **Per-Query composition cache for single-component composition shapes.** `q.and(X)`, `q.not(X)`, `q.any_of(X)`, and `q.changed(X)` previously allocated a BitSet copy, a defs slice (and, for `.changed`, a new `ChangedQuery`) on every call, even though the resolver already cached the resulting `Query` object. Single-component calls now short-circuit through a per-parent-`Query` Map and skip the allocation path entirely. Multi-component compositions fall through unchanged. Measured: **~6×** throughput on a 4-shape compose loop at 10k / 100k / 1M; **−40–56%** peak heap and **essentially zero RSS growth** during the workload. ([#10](https://github.com/oasys-works/oecs/pull/10))

## [0.3.0] — 2026-04-21

A substantial release focused on change detection, stricter component-access
typing, and a simpler key-based API for events and resources. Several public
entry points change shape; see the migration notes under *Breaking changes*.

### Added

#### Change detection

- Frame-based tick counter on the world. `ECS` now holds a `_tick` that
  advances once per `update()`. Systems can see it via `ctx.world_tick`,
  and each `SystemContext` receives `last_run_tick` — the tick at which that
  system last executed.
- Per-component change ticks on archetypes. Each archetype tracks
  `_changed_tick[component_id]` — the tick at which any entity in that
  archetype last had the component mutated. Maintained automatically by
  `write_fields`, `write_fields_positional`, `copy_shared_from`,
  `move_entity_from`, and `bulk_move_all_from`, all of which now accept a
  `tick` parameter.
- `ChangedQuery<Defs>` — a new query variant, produced by `query.changed(...)`,
  that restricts iteration to archetypes whose tracked components were
  modified after `last_run_tick`. Validates at construction that the named
  components are part of the parent query's include set.

#### Readonly component views

- `ReadonlyColumn<T>` and `ReadonlyUint32Array` — compile-time readonly views
  of typed-array columns. Returned by `archetype.get_column()` and the new
  `archetype.entity_ids` getter. Prevents accidental indexed writes at the
  type level; zero runtime cost.
- `ReadonlyComponentRef<S>` — readonly variant of `ComponentRef`. Returned by
  `query.ref(...)`. Use it when you only need to read component fields.
- `archetype.get_column_mut(def, field, tick)` — explicit mutable column
  accessor. Writes through `get_column_mut` update `_changed_tick`.
- `query.ref_mut(...)` — mutable sibling of `ref()`. Returns a `ComponentRef`
  and records the component as changed for the current tick.

#### Key-based Event API

- `EventKey<F>` — symbol-typed key that carries the event's field schema as
  a phantom type.
- `event_key<F>(name)` / `signal_key(name)` — factories for module-scope
  event keys. `signal_key` is a convenience wrapper for zero-field events.

#### Key-based Resource API

- `ResourceKey<T>` — symbol-typed key carrying the resource's value type as
  a phantom type.
- `resource_key<T>(name)` — factory for module-scope resource keys.
- `world.has_resource(key)` — existence check.
- Resources are now plain key→value storage. `world.resource(key)` returns
  the stored `T` directly.

#### Errors

- New `ECS_ERROR` categories: `RESOURCE_ALREADY_REGISTERED`,
  `EVENT_ALREADY_REGISTERED`, `EVENT_NOT_REGISTERED`.
- New `TYPE_ERROR` category: `ASSERTION_FAIL_NON_NULLABLE`, emitted by the
  new `assert_non_null` helper.

#### Assertions

- `assert_non_null<T>(value, message?)` in `type_primitives/assertions` —
  dev-only (`__DEV__` guarded) assertion that narrows `T` to `NonNullable<T>`
  and throws a `TypeError` with contextual info on failure.

#### New primitives

- `BinaryHeap<T>` in `type_primitives/binary_heap` — generic array-backed
  heap with a user-supplied comparator. `push`, `pop`, `peek`, `clear`,
  `size`. O(log n) push/pop, O(1) peek.
- `topological_sort<T>(nodes, edges, tiebreaker, node_name?)` in
  `type_primitives/topological_sort` — Kahn's algorithm with a
  `BinaryHeap`-backed ready queue for deterministic tie-breaking. Throws
  `TypeError` on cycles; the schedule layer re-wraps as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.

#### Public exports

- `SystemFn`, `ReadonlyComponentRef`, `ChangedQuery`, `ReadonlyColumn`,
  `ReadonlyUint32Array`, `EventKey`, `event_key`, `signal_key`,
  `ResourceKey`, `resource_key` are now part of the package surface.

### Changed

- Query iteration is callback-based. `Query` no longer implements
  `[Symbol.iterator]`. Iterate with `query.for_each((archetype) => { ... })`.
- `world.register_event`, `world.register_signal`, and `world.register_resource`
  return `void` and take an `EventKey` / `ResourceKey` as their first argument.
- `world.emit`, `world.read`, `world.resource`, and `world.set_resource`
  accept keys instead of definition objects. `world.resource(key)` returns
  the typed value `T` directly rather than a field-reader wrapper.
- Schedule execution methods take a tick. `run_startup(label, tick)`,
  `run_update(label, tick)`, and `run_fixed_update(label, tick)` require
  the current frame tick. `ECS.update()` wires this automatically.
- System ordering now uses the shared `topological_sort` primitive. Observable
  behavior is unchanged: `before`/`after` constraints respected,
  `insertion_order` remains the tie-breaker, cycles surface as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.
- Store/query wiring. The store keeps a reference to each active `Query` via
  `update_query_ref` and calls `mark_non_empty_dirty` only when structural
  changes occur, avoiding spurious query rebuilds on stable frames.
- Bit-manipulation and hash constants (`BITS_PER_WORD`, `BITS_PER_WORD_SHIFT`,
  `BITS_PER_WORD_MASK`, `FNV_OFFSET_BASIS`, `FNV_PRIME`) are exported from
  `type_primitives/bitset` rather than `utils/constants`.
- Growable-array defaults (`DEFAULT_INITIAL_CAPACITY`, `GROWTH_FACTOR`) are
  exported from `type_primitives/typed_arrays`.

### Fixed

- Query dirty propagation. `flush_destroyed` now marks affected queries dirty
  so subsequent iteration sees the correct archetype set. `flush_structural`
  skips dirty marking when no changes occurred.
- `set_field` on the world goes through `get_column_mut` with the current
  tick, so mutations via the high-level API are visible to `ChangedQuery`.

### Removed

- `ResourceChannel`, `ResourceDef<F>`, `ResourceReader<F>`, `ResourceID`,
  `as_resource_id`, and the `__resource_schema` marker symbol — the entire
  SoA column-based resource storage layer. Resources are now key→value.
- `RESOURCE_ROW` constant — unused.
- `EventDef<F>` — replaced by `EventKey<F>`.

### Breaking changes

1. **Event definitions.** Define a key at module scope, then register and use it:
   ```ts
   // before
   const damage = world.register_event({ amount: "u32" } as const);
   world.emit(damage, { amount: 5 });

   // after
   const DAMAGE = event_key<{ amount: "u32" }>("damage");
   world.register_event(DAMAGE, { amount: "u32" } as const);
   world.emit(DAMAGE, { amount: 5 });
   ```

2. **Resource registration / access.**
   ```ts
   // before
   const clock = world.register_resource({ ms: "u32" } as const, { ms: 0 });
   const ms = world.resource(clock).ms;

   // after
   const CLOCK = resource_key<{ ms: number }>("clock");
   world.register_resource(CLOCK, { ms: 0 });
   const ms = world.resource(CLOCK).ms;
   ```
   `world.resource()` returns the stored value directly; the reader wrapper
   and the SoA column storage are gone.

3. **Query iteration.**
   ```ts
   // before
   for (const arch of query) { ... }

   // after
   query.for_each((arch) => { ... });
   ```

4. **Mutable vs readonly refs.** `query.ref(...)` now returns
   `ReadonlyComponentRef`. Switch to `query.ref_mut(...)` when writing —
   this is also what enables change detection for that component.

5. **Archetype column access.** `archetype.get_column(...)` returns a
   `ReadonlyColumn`. Use `archetype.get_column_mut(def, field, tick)` for
   direct writes. Most callers should use `query.ref_mut` and won't notice.

6. **Schedule driver signatures.** If you drive the scheduler directly
   (bypassing `ECS.update()`), `run_startup`, `run_update`, and
   `run_fixed_update` now require a `tick: number` argument.

## [0.2.1] and earlier

Prior releases — see git history.
