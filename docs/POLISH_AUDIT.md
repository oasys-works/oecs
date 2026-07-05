# oecs 0.4.0 — End-User Polish Audit (Types & Ergonomics)

Date: 2026-07-04 · Scope: everything published to npm/JSR (all seven entry points), docs, packaging, and error experience. Findings verified against source; several were reproduced with `tsc`/`node` where noted. Prioritized by end-user impact.

Updated 2026-07-05: findings already fixed on `seam-fixes` removed (#2, #3, #5, #6, #7, #8, M5, the internal-`TypeError` nit, and the JSR `__tests__` exclusion). Original numbering kept for the survivors so existing references stay valid.

**Second update, 2026-07-05 (fix session):** the following are now FIXED on `seam-fixes` —
#1 (guarded `DEV` flag, JSR-safe), #4 (component debug names + `ENTITY_NOT_ALIVE` context +
key-name interpolation), #9 (total `has*` + `tryGetField`), M6 (`ACCESS_UNDECLARED`),
M7 (`ecs.refRead`), M8 (`firstEntity`/`singleEntity`), M9 (`EventShape` bound),
M10 (`onChange`/`canUndo`/`canRedo`), M11 (optional `read`), M12 (`shallow` → `/reactive`),
M13 (kernel dev warns), M14 (narrow fix: `_txn` behind a WeakMap — blanket `stripInternal`
breaks the deliberate `/internal` re-exports), M15 (`uninstall`/`off`/`clear`),
M16 (`StoreRestoreError` export), M17/M18 (message sweeps), M19 (`.d.cts` + specifier fixups +
`typesVersions`; attw fully green), M20 (`engines` + README note), M21 (`./package.json` +
`VERSION`), and from the low-priority list: `Symbol.dispose`, `SabUnavailableError`/
`TypedArrayTag` root exports, `RelationOptions` union, combinators + `ECSError` validation,
`runIfResourceEq` warn, `ResourceKey` symbol phantom, `_caches` `@internal`, optional
`SystemConfig.fn`, readonly tuples, `Eq` export, zero-arg `signal()`, `SingletonSyncOptions.eq`,
`snapshotLog()`, `ECSOptions` unknown-key warn, CHANGELOG in the tarball, stale docstrings,
`fromKernelMap.cell` caveat documented.

**Still open:** Batch 5 design items (M1 immediate-vs-deferred facade, M2 partial-values
`addComponent`, M3 `sourcesOf` arg order, M4 seam `Bundle` acceptance, M22 `world`-vs-`ecs` docs
sweep), M23 (JSDoc/@example coverage), and low-priority leftovers that are API-design calls:
`count()` vs getters naming, `createEntities` overrides, `TemplateOverrides` flattening, the
`WorldRestoreError`/`WORLD_SNAPSHOT_VERSION` naming, `fromKernelMap.cell` memoization.

---

## Executive summary

The library's foundations are unusually strong for a 0.4: the README quick-start **compiles verbatim under strict TS**, docs are signature-accurate, brands (`EntityID`, `EventKey`, `SignalKey`) round-trip cleanly, solid-js is a correctly-optional peer, and the `ECSError` taxonomy is genuinely catchable. The type-discipline gaps found on 0.4.0 (untyped `addComponents`, unchecked `registerEvent` fields, unconstrained query column accessors, invisible relation cardinality, mutable-typed struct proxies) have since been closed on `seam-fixes`. The remaining polish gaps cluster into three themes:

1. **One real breakage:** the JSR distribution ships raw source that references the bare `__DEV__` Vite global — Deno/JSR consumers get type errors and a runtime `ReferenceError` on the reactive collections' hottest path.
2. **Errors know less than they could:** components are named only by numeric id, the most common newcomer error (`ENTITY_NOT_ALIVE`) is thrown with no message at all, and messages reference pre-0.4 snake_case names and private tracker issue numbers.
3. **Small packaging/DX debt:** no `.d.cts` for CJS TS consumers, no `engines` field despite requiring Node ≥ 20, no `./package.json` export, no `VERSION`, and a `world` vs `ecs` naming split across docs.

---

## Critical / High priority

### 1. JSR build is broken by the bare `__DEV__` global 🔴
`src/core/reactive/map.ts:61`, `src/core/reactive/array.ts:127`, ~200 sites across core; declared only in `src/vite-env.d.ts:12`, which `jsr.json` **excludes from publish**.

`__DEV__` is a Vite `define` — fine for the npm `dist/` build where it constant-folds, but JSR ships raw `src/*.ts`. A Deno consumer gets `TS2304: Cannot find name '__DEV__'` at type-check, and at runtime `reactiveMap.set()` / `reactiveArray.set()` throw `ReferenceError` on first use (reproduced).

**Fix:** one internal module with `const DEV = typeof __DEV__ !== "undefined" ? __DEV__ : true;` (Vite still folds the npm build), or ship a `globals.d.ts` plus a `globalThis` fallback.

### 4. Errors identify components only by numeric id; many throws carry no message
`src/core/ecs/access_check.ts:421-447`; bare `throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE)` sites remain widespread (`store.ts:1615,2602,2619,3451`, `query.ts:1615,1629,1656,1692,1715`, `ecs.ts:622,636`); `resource_registry.ts:23,30,41` ("Resource key not registered" — key name omitted though `key.description` exists); `archetype.ts:939,944` (`COMPONENT_NOT_REGISTERED`/`FIELD_NOT_REGISTERED`, no field, no component).

Access violations read `system 'move' performed read on component 5 but didn't declare it` — and there is **no way to name a component**, so users count registration order to find "component 5". `ENTITY_NOT_ALIVE` arrives with no entity id and no operation.

**Fix (highest debugging leverage in the audit):**
- Optional debug name on registration: `registerComponent(schema, { name: "Pos" })`, threaded into accessCheck/store/observer messages.
- Include packed id + decoded gen/index + calling op in every `ENTITY_NOT_ALIVE` throw; pass `context`.
- Interpolate `key.description` in every event/resource "not registered" message, with a "call ecs.registerEvent(key, fields) at world setup" hint.

### 9. `has*` probes throw on dead entities in dev
`src/core/ecs/store.ts:3450` (see the workaround at `host_commands.ts:156`)

`hasComponent(dead, Pos)` throws `ENTITY_NOT_ALIVE` in dev — but a "has" check is exactly what users reach for to *avoid* touching dead entities; even in-repo code guards with `isAlive` first. **Fix:** make `hasComponent`/`hasSparse`/`hasRelation` total (return `false` for dead ids), and/or add `tryGetField(e, def, field): number | undefined` — no `tryGet` variant exists anywhere today.

---

## Medium priority

### API-shape consistency

| # | Finding | Where | Suggestion |
|---|---|---|---|
| M1 | Immediate vs deferred split on the same facade: host `addComponent` is immediate but `destroyEntity` is buffered (`ecs.destroyEntity(e); ecs.isAlive(e) // true`), signaled only by docs | `ecs.ts:761-792` | Finish the declared migration to `ctx.commands.*`; make host `destroyEntity` immediate or rename to signal buffering |
| M2 | `addComponent` demands complete `FieldValues<S>` while bundles/templates zero-fill partials — two mental models for one operation | `ecs.ts:778` vs `component.ts:132` | Accept `Partial<FieldValues<S>>`, or the bundle overload `ecs.addComponent(e, Pos({ x: 1 }))` |
| M3 | `sourcesOf(def, tgt)` inverts the `(entity, def)` convention used by `targetOf`/`targetsOf` — the one outlier, mirrored on `SystemContext` | `ecs.ts:926`, `query.ts:1679` | Canonicalize `(tgt, def)` with a deprecation overload |
| M4 | Host seam spells "def + values" as `spawnEntry(Pos, {x,y})` while core spells it `bundle(Pos, {x,y})` / `Pos({x,y})` — same concept, two names, docs never explain the split | `host_commands.ts:57` | Accept `Bundle` in `queue.spawn` (zero-fill at apply), or document why not |
| M6 | Access-violation errors reuse registration categories (`COMPONENT_NOT_REGISTERED` for "didn't declare access") — breaks catch-and-branch; a `QUERY_ACCESS_UNDECLARED` category already exists in the enum | `access_check.ts:279-326,425,434` | Dedicated `ACCESS_UNDECLARED` categories |
| M7 | No host-side whole-component read: `ref`/`refRead` exist only on `SystemContext`; host/tooling/tests read field-by-field | `ecs.ts:1027-1058` | `ecs.refRead(def, e)` parity or `ecs.get(e, Pos): FieldValues<S>` |
| M8 | No `first()` / `single()` / iterator on `Query` — the singleton pattern (player, camera) hand-rolls `forEachUntil` + closure capture | `query.ts:301+` | `q.firstEntity(): EntityID \| undefined`, `q.singleEntity()` (dev-throws on 0 or >1) |
| M9 | `EventSchema` bound rejects interfaces (documented as a tip, but fixable) | `event.ts:56` | Homomorphic bound `S extends { readonly [K in keyof S]: number }` |

### Reactive / extensions

| # | Finding | Where | Suggestion |
|---|---|---|---|
| M10 | `Editor` has no change notification — undo/redo UI can only poll `depths()` (which allocates per call) | `extensions/editor/editor.ts:337` | `onChange(cb): () => void` (or kernel signals) + `canUndo`/`canRedo` |
| M11 | `fieldHandle` takes five positional args and a `read` thunk duplicating info the `Editor` already holds | `field_handle.ts:56-62` | Make `read` optional, defaulting to the editor's reader; or options object |
| M12 | `shallow` lives only in `/reactive-sync` though it has zero ECS dependency — kernel docs send kernel-only users there | `src/extensions/reactive/ecs_sync.ts:104`, `docs/api/reactive.md:59` | Move to `/reactive`, re-export for compat |
| M13 | Ownerless `onCleanup` is silently dropped; ownerless `computed` is permanently subscribed with no disposer | `kernel.ts:474,414` | Dev-mode warn, matching Solid |
| M14 | `@internal` members leak into published editor types — `_txn: MutableTxn` (a mutable escape hatch) shows in autocomplete | `editor.ts:90`, `dist/extensions/editor/editor.d.ts:36` | `"stripInternal": true` in `tsconfig.build.json` |
| M15 | `installHostCommandSeam` has no uninstall; dispatcher `on` has no `off`; queue can `pending()` but not `clear()` | `host_commands.ts:557,453,224` | Return `{ queue, dispose }`; add `off(opCode)` and `clear()` |
| M16 | `restoreInto` can throw `StoreRestoreError`, which the package doesn't export (only `WorldRestoreError`/`SparseRestoreError` are) — an unnameable failure mode | `core/store/snapshot.ts:36` | Export it, or wrap into `WorldRestoreError` |

### Errors, docs, packaging

| # | Finding | Where | Suggestion |
|---|---|---|---|
| M17 | Error messages reference pre-0.4 snake_case names that no longer exist: "`fixed_timestep` must be…", "`max_fixed_steps`", "`on_set`", "`entity_index_capacity`", "`max_bytes`", `run_every_n_ticks` | `ecs.ts:188,204`, `observer.ts:336,349`, `entity_allocator.ts:98`, `allocator.ts:168`, `run_condition.ts:106` | Sweep error strings; casing_guard-style test for messages |
| M18 | Private tracker issue numbers leak into user-facing messages/JSDoc: "Phase B of issue #213", "#592", "#496", "#380", "See ./CONTEXT.md" (file doesn't exist), ADR references | `access_check.ts:310,417,427,436,445,455`, `store.ts:657`, `reactive/index.ts:3` | Replace with doc links (`docs/api/systems.md#access`) or prose |
| M19 | No `.d.cts`: `require.types` points at ESM-flavored `.d.ts` under `"type": "module"` — attw "masquerading" failure for CJS TS consumers on `node16`/`nodenext` | `package.json:9` | Emit per-entry `.d.cts`; verify with `attw --pack` |
| M20 | No `engines` field and no README runtime note, though the default heap profile requires resizable `ArrayBuffer` (Node ≥ 20, Chrome 111+, Safari 16.4+) | `allocator.ts:262`, `package.json` | `"engines": { "node": ">=20" }` + one README line |
| M21 | No `"./package.json"` export and no `VERSION` export — no way to read the installed version at runtime | `package.json:6-35` | Add both (inject `VERSION` at build) |
| M22 | `world` vs `ecs` receiver split across docs: README/GETTING_STARTED use `world` (82×), api reference uses `ecs` (63×), `wasm.md` mixes both in one page | docs tree | Pick one and sweep |
| M23 | JSDoc coverage is inverted: `update`, `startup`, `query`, `registerComponent`, `addComponent`, `emit`/`read`, `registerEvent`/`registerResource` have **no JSDoc** while niche APIs get multi-paragraph docs; zero `@example` tags anywhere in the six secondary entry points (the good examples live only in docs/, invisible to hover/JSR) | `ecs.ts` passim; all extension entry points | Document the ten most-called methods with `@example`; port existing doc examples into `@example` blocks |

---

## Low priority (quick wins & nits)

- **`ObserverHandle` lacks `Symbol.dispose`** — one method makes `using h = world.observe(...)` work (`observer.ts:128`).
- **`SabUnavailableError` thrown from main-entry construction but only exported from `/shared`** (`allocator.ts:140`) — re-export from root or fold into the taxonomy.
- **`RelationOptions` models cardinality as two booleans** — `{ exclusive: true, multi: true }` type-checks but throws (`relation.ts:133-136`); use `cardinality?: "exclusive" | "multi"` instead. (Leftover from the otherwise-fixed #7.)
- **Run-condition combinators missing** — `not()`/`allOf()`/`anyOf()` (~30 lines) remove the most common `runIf` boilerplate; run-condition validation throws plain `Error` outside the taxonomy (`run_condition.ts:105`).
- **`runIfResourceEq` uses `===`** — object-valued resources never fire; add a dev warn for non-primitive `expected` (`run_condition.ts:79`).
- **`ResourceKey` phantom leaks as `.__phantom` in autocomplete** (`resource.ts:32`) — use a `unique symbol` key like events/relations do.
- **`public readonly _caches: QueryCache` on the exported `ECS` class** pollutes autocomplete (`ecs.ts:251`; the nine Maps were consolidated but the holder is still public) — `@internal` + stripInternal, or private.
- **`SystemConfig.fn` required even for backend-executed systems** — `fn: () => {}` boilerplate (`system.ts:143`); make it optional when `backendHandle` is present.
- **`createEntities(template, count)` is schema-erased and takes no overrides**, unlike `createEntity` (`ecs.ts:739`); lifecycle vocabulary spans create/spawn/destroy/despawn.
- **`TemplateOverrides` flattens field names across defs** — two components sharing a field name make overrides ambiguous, last wins silently (`store.ts:261`).
- **`pairsOf`/`sourcesOfAny` return mutable `[EntityID, EntityID][]`** — `readonly` tuples for free (`ecs.ts:948,955`).
- **`count()` method vs `archetypeCount`/`entityCount` getters** on the same class (`query.ts:426-444`).
- **`Eq<T>` appears in public signatures but isn't exported** from `/reactive`; three inline spellings of the same type (`kernel.ts:40`).
- **`signal()` has no zero-arg overload** (Solid parity) for late-initialized values (`kernel.ts:408`).
- **`fromKernelMap.cell()` mints a fresh subscription per call** — memoize per key or document "call once per row" (`kernel_solid.ts:49`).
- **`SingletonSyncOptions` lacks `eq`** while `SingletonArraySyncOptions` has it (`ecs_sync.ts:461` vs `:589`).
- **`HostCommandRecorder.log()` returns a live view** — add `snapshotLog()` so the safe thing is the easy thing (`command_log.ts:137`).
- **`ECSOptions` migration guard catches only snake_case legacy keys** — a typo'd camelCase key (`initialCapacity`) is silently ignored (`ecs.ts:291`).
- **npm tarball drops CHANGELOG** — `files` is `["dist"]` only; add CHANGELOG. (The JSR `__tests__` exclusion half of this is done.)
- **`TypedArrayTag` not exported from root** though `registerComponent`'s constraint uses it (`ecs.ts:582`).
- **Stale source docstrings**: `system.ts:149` mentions nonexistent `ctx.query(...)`; `query.ts:9` shows `qb.every(...)` (method is `.with`) and `q.not(...)` (method is `.without`).
- **`WorldRestoreError`/`WORLD_SNAPSHOT_VERSION`** are the last `World*` names on an otherwise `ECS*` surface.

---

## What's already excellent (keep)

- README quick-start compiles verbatim under `tsc --strict`; docs are signature-accurate including the on-disk `seam-fixes` edits; no stale/renamed APIs in README or CHANGELOG.
- Branded `EntityID`/`ComponentID` with zero cast burden; callable-def bundles (`Pos({x,y})`) unifying attach shapes; `registerComponent` overloads inferring precise column types end-to-end; event schemas round-tripping branded numbers.
- `syncFieldsToMap` and friends infer fully (`const` type params reject unknown fields); Solid integration follows Solid idioms with a correctly-optional peer dep.
- `ECSError` design: `category` from a 42-value enum, `context`, `isEcsError`, and docs distinguishing dev-only vs always-on throws. Best-in-class messages exist (store-cap error, `SPARSE_QUERY_DENSE_PATH`, deterministic-f64 rejection) — the ask is to bring the rest up to that bar.
- No `any`/`unknown` leaks found in any public signature across the six secondary entry points; `readonly` discipline consistently strong; zero lingering `@deprecated` aliases (casing guard test enforces the 0.4 rename).

---

## Suggested fix order

**Batch 1 — ship-blockers & type-only fixes (non-breaking, no runtime changes):**
`__DEV__` JSR guard (#1) · `stripInternal` (M14) · export `StoreRestoreError` (M16). *(Done: EventReader `readonly length`, `Readonly<T>` struct proxies, `registerEvent` exhaustiveness, relation cardinality brands.)*

**Batch 2 — error experience (small, huge debugging payoff):**
component debug names + threaded messages (#4) · `ENTITY_NOT_ALIVE` context (#4) · snake_case/issue-number sweep (M17, M18) · `ACCESS_UNDECLARED` categories (M6).

**Batch 3 — packaging:**
`.d.cts` (M19) · `engines` + README note (M20) · `./package.json` export + `VERSION` (M21) · npm `files` list (CHANGELOG).

**Batch 4 — API additions (non-breaking conveniences):**
`tryGetField` / total `has*` (#9) · `first()`/`single()` (M8) · host `refRead` (M7) · run-condition combinators · editor `onChange` (M10) · `Symbol.dispose`. *(Done: typed `addComponents`.)*

**Batch 5 — needs design discussion (potentially breaking):**
immediate-vs-deferred facade unification (M1) · partial-values `addComponent` (M2) · `sourcesOf` argument order (M3) · seam `Bundle` acceptance (M4) · `world` vs `ecs` docs sweep (M22). *(Done: `Query<Defs>`-constrained cursors.)*
