# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] — 2026-07-06

### Changed (breaking) — one attach grammar

`addComponents` and `template` now take the same callable-bundle varargs as `spawnBundle`
and `ctx.commands.spawn` / `add`, replacing the `{ def, values }[]` entry-object array — one
grammar across every authoring surface:

```ts
// before
ecs.addComponents(e, [{ def: Pos, values: { x, y } }, { def: Vel, values: { vx } }]);
const Bullet = ecs.template([{ def: Pos, values: { x: 0, y: 0 } }]);
// after
ecs.addComponents(e, Pos({ x, y }), Vel({ vx }));
const Bullet = ecs.template(Pos({ x: 0, y: 0 }));
```

To migrate: drop the array brackets, wrap a valued entry in its def's call
(`{ def: X, values: V }` → `X(V)`), and leave a bare entry bare (`{ def: X }` → `X`).

- Each item is schema-checked against its **own** def via the `StrictBundles` mapped tuple
  (`{ [K in keyof Items]: … }`) — a misspelled or cross-component field, including a
  hand-written raw `{ def, values }` literal, is a compile error. `spawnBundle` gains this
  per-item checking (it previously had none).
- `ctx.commands.spawn` / `ctx.commands.add` now schema-check their bundle values in
  declared-access systems as well (the `DeclaredBundleOrDef` type distributes over the
  declared add set); a permissive / `exclusive` context stays loose, as before.
- The `TemplateEntry` / `TemplateEntries` public types are removed (they encoded the retired
  entry-object grammar). The host command seam (`HostCommandQueue.spawn` — the record/replay
  and editor-undo transport) deliberately keeps its entry-object + complete-values shape.

### Changed — API vocabulary consistency

Cheap alignments from a public-API vocabulary audit that followed the grammar unification:

- `removeComponents(e, ...defs)` is now varargs, mirroring `addComponents` (was
  `removeComponents(e, defs[])`).
- `HostCommandQueue.pending()` is now a `pending` getter (matching every other count accessor).
- `ReadonlyEntityIdArray` → `ReadonlyEntityIDArray` (acronym casing, matching `EntityID`).
- The entity-id parameter is now uniformly `entityId` across the core surface (ECS lifecycle,
  host-command queue, `ObserverFn`); the `HostCommand` wire-format field stays `eid`.
- Source-compatible widenings: `ecs.despawn`, `ecs.removeSystem`, and the `HostCommandQueue`
  mutators now return `this` for chaining.

The `ref` / `refRead` argument order was reviewed and **deliberately kept** def-first
(`ctx.ref(def, entityId)`): these are the outside-iteration members of the `cols.mut` /
`cols.read` column-cursor family, so def-first is the cursor convention, not an inconsistency
to fix — flipping it would align with `getField` while breaking alignment with `cols.mut`.
Documented as such (`refs.md`, `queries.md`) rather than flipped.

### Changed (breaking) — host-write-seam verb grammar

The host-write-seam handles are namespaced command buffers, so they drop the component noun
to match `ctx.commands.add` / `remove` — and their own already-bare
`spawn`/`despawn`/`disable`/`enable`/`setField`:

- `HostCommandQueue.addComponent` / `removeComponent` → `add` / `remove`.
- `Editor` and `TransactionBuilder` `.addComponent` / `.removeComponent` → `add` / `remove`
  (the two surfaces are designed to match, so they move together).
- The editor extension's entity-id parameters and its `FieldReader` type now read `entityId`,
  completing the core's `eid` → `entityId` pass.

The wire-format `kind` discriminants (`"add_component"` / `"remove_component"`), the ring
codecs, and the `HostCommand` record's `eid` field are unchanged — transport vocabulary.

### Changed (breaking) — `ctx.getResource`

The in-system resource getter is now `ctx.getResource(key)` (was the verb-less `ctx.resource(key)`),
matching its flat-surface siblings `setResource` / `removeResource` / `hasResource` and the
`getField` / `setField` / `hasComponent` convention. The rule is now explicit: the flat `ctx`
surface verbs every accessor; the grouped `ecs.resources` facade drops the noun (`get` / `set` /
`remove` / `has`) because its receiver already names it. `ConditionContext` (run-condition
predicates) moves in lockstep.

### Fixed

- The immediate host spawn family (`spawn` / `spawnBundle` / `spawnMany`) now throws in DEV
  when called from inside a system body — redirecting to `ctx.commands.spawn` — like every
  other immediate host structural mutator. Previously it was silently unguarded (the archetype
  iteration guard does not cover the append path), a live mid-iteration footgun; its guard
  docstring's "one rule for every host mutator" claim is now true.
- Added explicit public `QueryCache` cache-map type annotations so JSR publish passes
  slow-type validation and can generate package declarations cleanly.

## [0.5.0] — 2026-07-06

### Changed (breaking) — lifecycle & naming unification

One vocabulary across host, commands, and access declarations; the receiver now implies the
timing (host = immediate, `ctx.commands` = deferred). Hard renames, no deprecation aliases —
see [docs/MIGRATION-0.4-to-0.5.md](docs/MIGRATION-0.4-to-0.5.md) for the complete
rename/removal map:

| 0.4 | 0.5 |
| --- | --- |
| `ecs.createEntity()` / `ecs.createEntity(template, overrides?)` | `ecs.spawn()` / `ecs.spawn(template, overrides?)` |
| `ecs.createEntities(template, count)` | `ecs.spawnMany(template, count, overrides?)` |
| `ecs.destroyEntity(e)` *(deferred)* | `ecs.despawn(e)` — **now immediate** |
| `ctx.createEntity()` | `ctx.commands.spawn()` |
| `ctx.destroyEntity(e)` | `ctx.commands.despawn(e)` |
| `ctx.addComponent(e, def, values?)` | `ctx.commands.add(e, def, values)` or `ctx.commands.add(e, def({ … }))` |
| `ctx.removeComponent(e, def)` | `ctx.commands.remove(e, def)` |
| `ctx.disable(e)` / `ctx.enable(e)` | `ctx.commands.disable(e)` / `ctx.commands.enable(e)` |
| `sourcesOf(def, tgt)` | `sourcesOf(tgt, def)` — matches `targetOf` / `targetsOf` |
| `query.count()` | `query.entityCount` (getter, beside `archetypeCount`) |
| `WorldRestoreError` / `WORLD_SNAPSHOT_VERSION` | `ECSRestoreError` / `ECS_SNAPSHOT_VERSION` |

- **Host `despawn` is immediate** — `ecs.despawn(e); ecs.isAlive(e)` is `false` on the next
  line, closing the audit's M1 finding (host `addComponent` immediate but destroy buffered).
  **Observer note:** like every immediate op, host `despawn` fires no *structural* observers —
  `onRemove` no longer sees host-despawned entities (it did at 0.4, when host destroy was
  deferred). Observer-driven consumers, including the `reactive-sync` map bridges, only see
  despawns that go through `ctx.commands.despawn` or the host-command seam. (`onSet` is
  receiver-blind — derived change detection sees host `setField` writes as always.)
- **Every immediate host structural mutator throws in dev when called from inside a system
  body** — `despawn`, `addComponent`/`addComponents`, `removeComponent`/`removeComponents`,
  `batchAddComponent`/`batchRemoveComponent`, `disable`/`enable` — each error pointing at its
  `ctx.commands` equivalent. Mid-system these ops can move rows a running query is walking and
  are invisible to observers; previously only `despawn` was guarded wholesale (the others were
  caught only when they touched the archetype being iterated). Cross-world host mutation from
  another world's system (#785) is unaffected — the guard is scoped to the mutated world.
- **The bare deferred duplicates on `ctx` are removed** — `ctx.addComponent`,
  `ctx.removeComponent`, `ctx.disable`, `ctx.enable` join the already-removed
  `ctx.createEntity` / `ctx.destroyEntity`. `ctx.commands` is now the *only* deferred surface,
  completing the receiver-implies-timing rule with zero exceptions. `ctx.commands.add` gains
  the explicit complete-values shape (`ctx.commands.add(e, Pos, { x: 0, y: 0 })`) the removed
  `ctx.addComponent` carried, so compile-checked complete attaches survive the move.
  `ctx.isDisabled` stays (immediate read), as do the immediate sparse/relation ops.
- **`sourcesOf` canonicalized to `(entity, def)`** on `ecs.relations` and `SystemContext` —
  it was the one arg-order outlier on the relation surface (M3).
- **The package root is now a curated, explicit export list** — `export *` no longer flattens the
  whole core barrel, so future barrel additions cannot silently widen the public API. A checked-in
  public-API snapshot test makes any surface change an explicit diff in review.
- **Internal/tooling symbols moved to `@oasys/oecs/internal`** (explicitly **unstable — no semver
  guarantees**): the packed-EntityID codec (`createEntityId`, `getEntityGeneration`, `MAX_INDEX`,
  `MAX_GENERATION`, `MAX_LIVE_GENERATION`, `RETIRED_GENERATION`, `MAX_ENTITY_ID`), the SAB
  command-ring transport (`HostCommandDispatcher`, `ring*Codec`, `HOST_COMMAND_PAYLOAD_BYTES`),
  memory-sizing internals (`resolveECSMemory`, `DEFAULT_ECS_CAP_BYTES`, `BUDGET_*`), and the
  dev-mode singletons (`accessCheck`, `dispatchTrace`). `getEntityIndex` stays at the root.

### Added

- **`addComponent` bundle overload** — `ecs.addComponent(e, Pos({ x: 1 }))` accepts a bundle
  with the usual zero-fill semantics (M2); the explicit `(e, def, values)` form stays
  complete-values, so a typo'd or missing field is still a compile error.
- **`spawnMany` typed template + shared overrides** — bulk spawn takes the same typed
  `Template<Defs>` as `spawn` plus one optional `TemplateOverrides<Defs>` object applied to
  every row (contiguous batches use one `fill` per overridden column).
- **JSDoc `@example` on the core surface** — `registerComponent`, `spawn`, `addComponent`,
  `query`, `registerSystem`, `startup`, `update`, `ctx.emit` / `ctx.read`,
  `events.register`, `resources.register` now carry hover-visible examples (M23).
- **Component debug names** — `registerComponent(schema, { name: "Pos" })` (and the sparse
  sibling) records a diagnostic label, so access-violation and liveness errors read
  `'Pos' (component 5)` instead of leaving you to count registration order
  (`ComponentRegisterOptions`).
- **Total probes + `tryGetField`** — `hasComponent` / `hasSparse` / `relations.has` now return
  `false` for a dead entity instead of dev-throwing (a "has" probe is exactly the call made to
  avoid dead entities); `ecs.tryGetField(e, def, field)` returns `undefined` for a dead entity or
  missing component, and `ctx.tryGetField` mirrors it inside systems (declared-read checked).
- **Plural host mutators chain** — `addComponents`, `removeComponents`, `batchAddComponent`,
  `batchRemoveComponent` return `this` (previously `void`), matching their singular siblings.
- **`Query.firstEntity()` / `Query.singleEntity()`** — singleton reads (player, camera) without a
  hand-rolled `forEach` + capture; `singleEntity` dev-throws `QUERY_NOT_SINGLETON` on 0 or >1.
- **Host-side `ecs.refRead(def, e)`** — whole-component read-only view, parity with
  `ctx.refRead`.
- **Run-condition combinators** — `not()` / `allOf()` / `anyOf()`, merging the operands' declared
  read surfaces.
- **Editor change notification** — `editor.onChange(cb)` (fires on commit/undo/redo/clear) plus
  `canUndo` / `canRedo` getters; no more per-frame `depths()` polling.
- **`using` support** — `ObserverHandle` implements `Symbol.dispose`.
- **Write-seam lifecycle** — `uninstallHostCommandSeam(world, queue)`,
  `HostCommandQueue.clear()`, `HostCommandDispatcher.off(opCode)`,
  `HostCommandRecorder.snapshotLog()` (stable deep copy).
- **`VERSION`** export and a `"./package.json"` export; `engines: { node: ">=20" }` and a README
  runtime note (resizable `ArrayBuffer`).
- Root re-exports so failure modes are nameable without extra entry points:
  `StoreRestoreError`, `SabUnavailableError`, `TypedArrayTag`; `/reactive` now exports `Eq` and
  `shallow` (moved from `/reactive-sync`, which re-exports for compat); `signal()` gains the
  zero-arg Solid-parity overload; `SingletonSyncOptions.eq`.
- **`FrameStepper`** — optional host-side driver over the authoritative `ecs.update(dt)`:
  `play()`/`pause()`/`toggle()` on `requestAnimationFrame` (injectable `requestFrame`/`cancelFrame`
  for tests and non-browser hosts), explicit `step()`/`stepFrames()` for debuggers, editors, and
  rollback playback, and a `maxDt` clamp (default 0.25 s) so a resumed background tab doesn't feed
  the whole suspension into the accumulator as one delta. Validation throws `INVALID_FRAME_STEP`.
- **`ObserverConfig.name`** — diagnostic label surfaced as the frame trace's
  `observer_fired.observer` field (the role a system's `name` plays); observe-only, never affects
  `stateHash` or dispatch order. Unnamed observers fall back to `observer(<component debug name>)`
  when the component was registered with a name, else `observer(<cid>)`.
- **`ECSOptions.onWarn`** — injectable sink for dev-mode engine diagnostics (currently the
  schedule's dropped-ordering-edge warning and the `ECSOptions` unknown-key warning),
  defaulting to `console.warn`. Replaces the internal `src/log` singleton, which is deleted.
- **Editor `fieldHandle` `read` thunk is optional** — defaults to `Editor.committedField`.

### Fixed

- **Host iteration guard (`STRUCTURAL_DURING_ITERATION`)** — with host `despawn` now immediate,
  a host-side `forEach`/`eachChunk` callback that despawned (or transitioned/toggled) an entity of
  the archetype it was visiting silently skipped entities via the row swap-remove. Row-removing
  ops on an archetype a live dense walk is standing in now throw in dev, *before* any mutation
  lands (the transition path checks ahead of the destination append, so no dual-residency
  half-state). Collect ids during the walk and mutate after it. Mutating archetypes the walk is
  *not* currently visiting stays legal — the #431 fresh-snapshot machinery still covers those.
- **Cross-world despawn false positive** — `worldB.despawn(e)` from inside world A's system no
  longer trips the in-system despawn guard (the accessCheck span is process-global; the guard now
  also requires *this* world to be mid-schedule). Driving a second world from a system (#785)
  mutates it host-style, which is safe — B is not iterating. Unnamed systems in the guard message
  now render as `system_<id>` instead of `'?'`.
- **Frame trace records every deferred command (ADR-0030)** — the removed bare `ctx.*` deferred
  forms bypassed the `commandQueued` trace hook, so host-command-seam adds/removes/toggles (and
  any system using the bare forms) were invisible to an attached `FrameTraceSink` while their
  spawns/despawns were visible. With `ctx.commands` as the only deferred surface every queued
  command is traced, and `ctx.commands.spawn` now also traces each bundle attach it queues
  (previously only the spawn itself).
- **Stale deferred-attach docs** — `host_commands.ts` / the host-write-seam page claimed the
  deferred add path does not zero-fill omitted fields (NaN readback); every attach path
  zero-fills since #716 (`writeFields`'s `?? 0`). The complete-values requirement on
  `SpawnEntry` is documented as what it is — explicit intent in a reified, replayable record —
  and the observer docs now scope "immediate ops fire no observers" to *structural* observers
  (`onSet` is derived change detection and sees host `setField` writes).
- **`ecs.refRead` / `ctx.ref` / `ctx.refRead` on a missing component or tag def** — threw a raw
  `TypeError` from the ref internals; now a dev `ECSError` (`COMPONENT_NOT_REGISTERED`) naming the
  op and component, matching `getField`. Host `refRead`'s docstring now states the single-
  expression lifetime rule (any immediate structural mutation can row-swap under a held ref).
- **Editor: aborted transactions no longer poison undo** — `transaction(tx => …)` staged its
  `setField` shadow writes into the editor's shared map at build time, so a build callback that
  threw left phantom pending values behind and seeded the *next* edit's undo inverse with a value
  the world never held. Staging is now transaction-local and merges only on commit.
- **Editor: `pendingField` self-resolves for dead slots** — a shadow entry for a despawned entity
  (or removed component) echoed its stale value forever and leaked; the reconcile-on-read now
  prunes it and returns `undefined`.
- **JSR/Deno consumers no longer break on the `__DEV__` global** — shipped source now reads a
  guarded `DEV` flag (`src/dev_flag.ts`) that constant-folds in the npm bundle and defaults to
  dev-on for raw-source consumers (`globalThis.__DEV__ = false` opts out).
- **Error experience** — every `ENTITY_NOT_ALIVE` names the operation and decodes the packed id
  (index + generation, with context); system access violations use the new `ACCESS_UNDECLARED`
  category instead of overloading `*_NOT_REGISTERED`; resource/event "not registered" messages
  name the key and hint the registration call; messages no longer reference pre-0.4 snake_case
  option names or private tracker issue numbers.
- **Packaging** — per-entry `.d.cts` and explicit-extension declaration specifiers
  (`attw --pack` fully green: node10/node16/bundler across all eight entry points, was
  masquerading + resolution errors); `typesVersions` for `moduleResolution: node10` subpaths; npm
  tarball ships `CHANGELOG.md`; `@internal` editor internals no longer leak into published types.
- **Type-level closures** — `EventShape<S>` homomorphic bound (interface-declared event schemas
  now accepted); `RelationOptions` is a union so `{ exclusive: true, multi: true }` is a compile
  error; `ResourceKey`'s phantom is a unique symbol (no `.__phantom` in autocomplete);
  `pairsOf` / `sourcesOfAny` return readonly tuples; `SystemConfig.fn` optional when
  `backendHandle` is present.
- Dev-mode diagnostics: ownerless `computed()` / `onCleanup()` warn (kernel); ECSOptions warns on
  unknown keys; `runIfResourceEq` warns on object-valued `expected` (reference-identity `===`);
  `runEveryNTicks` validation throws `ECSError` (`INVALID_RUN_CONDITION`).
- **Docs standardized on the `ecs` receiver** — README, GETTING_STARTED, BEST_PRACTICES, the
  api reference, and every in-source JSDoc example now spell `const ecs = new ECS()`
  (M22; with the `World*` names renamed to `ECS*`, "world" survives only as prose). The
  host-write-seam docs now explain *why* `queue.spawn` takes complete-value `spawnEntry`s
  rather than zero-filling bundles (M4: commands are a reified, replayable record — complete
  values are explicit intent legible to replay, not a correctness need; the deferred add path
  zero-fills omitted fields since #716).
- **JSR publish no longer ships `__tests__` helper files** (`casing_codemod.ts`,
  `test_helpers.ts` — including a `node:fs` import subject to JSR type-checking).

### Changed (breaking) — type-level & facade surface

- **Compile-time typestate across the system, query, relation, and key seams.** The config-form
  `registerSystem` now infers your access declarations as literal types and hands `fn`/`onAdded` a
  `SystemContext<DeclaredAccess<…>>` narrowed to exactly the declared surface — undeclared access
  is a compile error naming the missing declaration, with the dev-mode runtime check remaining as
  the backstop for dynamic values. Query columns are typed by the query's terms
  (`ChunkColumns<Defs>` / `ArchetypeView<Defs>`; `.and(...)` extends the term set), relation
  handles carry their cardinality (`RelationDef<"exclusive">` vs `RelationDef<"multi">` — the
  exclusive-only traversal surfaces reject a multi handle at compile time), and
  `ResourceKey`/`EventKey`/`EventDef` are invariant so a key can no longer widen through
  `unknown`. A checked-in type battery (`typing_assertions.ts`) pins every rule.
- **Grouped facades: `ecs.relations`, `ecs.events`, `ecs.resources`, `ecs.snapshots`.** Cohesive
  secondary surfaces move off the flat namespace onto narrow typed facades —
  `ecs.relations.add(child, ChildOf, parent)`, `ecs.events.emit(Damage, {...})`,
  `ecs.resources.get(Time)`, `ecs.snapshots.capture()`. The facades mirror the typestate
  surface exactly (cardinality-stamped `relations.register`, exclusive-only traversal). Hot-path
  API (component ops, queries, spawn/destroy, sparse ops) stays flat by design. Facade classes
  are exported type-only; the runtime export list is unchanged.
- **Value arguments are schema-checked at compile time across every attach seam.** Tag defs
  reject value objects (`Frozen({ x: 1 })` no longer compiles — tags carry no data);
  `addComponents` takes schema-checked entries (`TemplateEntries<Defs>`), so a misspelled or
  cross-component field key is a compile error instead of a silent zero-fill; host-seam
  `queue.spawn` entries (`SpawnEntries<Defs>`) are checked complete against each def's own
  schema (`ValuesArg` / `CompleteFieldValues` exported); and `events.register` requires the
  field list to cover the event schema (`EventFieldsCover`) — a partial list silently dropped
  columns and read back `undefined` at runtime. Smaller closures in the same vein: `observe`
  accepts any `ComponentHandle`, `NoInfer` pins key-typed value params (`events.emit`,
  resources), and reactive-sync's `JoinReader.field` is constrained to the join's component
  set.

### Removed (breaking)

- The 29 flat forms the new facades replace (`registerRelation`/`addRelation`/`targetOf`/…,
  `registerEvent`/`registerSignal`/`emit`/`read`, `registerResource`/`resource`/`setResource`/
  `removeResource`/`hasResource`, `snapshot`/`restoreInto`/`snapshotSparse`/`restoreSparse`/
  `stateHash`/`deterministic`, `relationCount`/`compactRelations`). Each maps 1:1 onto its
  grouped replacement — `ecs.relations.add(...)`, `ecs.events.emit(...)`, `ecs.resources.get(...)`,
  `ecs.snapshots.capture()` (was `snapshot()`) / `ecs.snapshots.restore(...)` (was
  `restoreInto(...)`), `ecs.relations.count` (was `relationCount`), `ecs.relations.compact()`
  (was `compactRelations()`). System-side `ctx.*` and all `Store`-level methods are unchanged.

### Changed (internal)

- **`Store` decomposed into seven focused collaborators** (RelationService, EventRegistry +
  ResourceRegistry, EntityAllocator, DeferredCommandBuffer, SnapshotService, ArchetypeGraph) with
  `Store` as the coordinator; the hot-path extractions were A/B-benchmarked against
  identical-code controls with no regression. The `ECS` facade's pure delegations now live in a
  marker-delimited pass-through band whose logic-free invariant is enforced by an AST guard test.
- Typed per-consumer host seams (`ObserverHost`, `QueryHost`) replace underscore-convention
  reach-through on `Store`; `QueryCache` now owns all 12 query-resolution cache maps.
- Store layer consolidation: one strategy-parameterized factory behind
  `growableSabAllocator` / `heapArraybufferAllocator`; a typed `isColumnStoreInternal` guard
  replaces six structural casts; grow/extend's ~200 duplicated lines moved to a shared
  `layout_ops.ts` (bit-identical layouts pinned by a golden differential test across the
  full allocator matrix).
- `core/reactive` moved to `src/reactive` (the published `./reactive` subpath is unchanged);
  `__generated__/abi.ts` renamed to `vendored_abi/abi.ts` (it is a hand-maintained snapshot,
  not generated output).
- Deleted orphaned duplicate `src/utils/{arrays,constants}.ts`; renamed the custom `TypeError`
  (shadowed the ECMAScript global) to `AssertionError`; retired the 246-line casing codemod +
  guard test (the 0.4 rename has converged).

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
