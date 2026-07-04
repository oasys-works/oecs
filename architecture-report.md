# oecs Architecture Review

**Scope:** full `src/` tree (~24.5k lines non-test) plus packaging (`package.json`, `jsr.json`, build configs) and docs spot-checks, as of branch `seam-fixes` (2026-07-04). Produced by four parallel deep-dive analyses (core ECS, store/primitives layers, reactive/extensions, public API/packaging), with the highest-severity claims independently re-verified.

---

## Executive summary

The codebase is in better architectural shape than its file sizes suggest. Layering is almost entirely one-directional and clean: `type_primitives` → `core/store` → `core/ecs` → `extensions`, with no runtime import cycles anywhere, zero production dependencies, correct optional-peer isolation of solid-js, and extensions that consume core exclusively through the public barrel. Several suspected problems turned out not to exist (command_log/host_commands share one apply path; sparse_store doesn't duplicate core/store).

The real improvement opportunities cluster in five areas:

1. **A shipping packaging bug** — the JSR publish is broken for the dev-assertion path (`__DEV__` is undeclared at runtime for JSR consumers).
2. **Two god objects** — `Store` (4,881 lines, ~18 concerns) mirrored by a 111-method `ECS` pass-through facade.
3. **A fragmented error taxonomy** that contradicts the documented "every error is an `ECSError`" invariant.
4. **Mechanical duplication** — a dead duplicate utils tree, ~200 duplicated lines of grow/extend logic, near-duplicate allocators.
5. **Convention-only boundaries** — underscore-prefixed "private" members as the cross-module contract, plus a `__generated__/` directory that has no generator.

Findings below are ordered by priority, not by subsystem.

---

## Critical

### C1. JSR publish ships `__DEV__` with no runtime declaration → `ReferenceError` for Deno/JSR consumers

`jsr.json` publishes raw `src/*.ts` (all `exports` point at source files) and its `publish.exclude` explicitly removes `src/vite-env.d.ts:12` — the **only** declaration of `__DEV__` in the package. `__DEV__` is a Vite `define` substitution (`vite.config.ts`); it has no runtime value. 22 shipped source files reference it bare (e.g. `src/type_primitives/assertions.ts:26,38,51`, `src/core/ecs/ecs.ts:1340`). The npm artifact is fine (`files: ["dist"]`, Vite folds `__DEV__` to `false`), but any JSR consumer that executes a `__DEV__`-guarded path hits `ReferenceError: __DEV__ is not defined`, and JSR type-checking sees an undefined identifier.

**Fix:** replace the bare global with something that survives unbundled — e.g. a real module (`export const __DEV__ = ...` derived from `globalThis`/`import.meta.env?.DEV`), or `globalThis.__DEV__ ?? false` behind one helper. This is the single most impactful item in this report and is independent of any refactoring.

### C2. Error taxonomy contradicts its own documented invariant

`src/core/ecs/index.ts:252` and `docs/api/errors.md:1` both assert "every ECS-thrown error is an `ECSError`". In reality **14 error classes extend plain `Error`** and bypass `ECSError`/`isEcsError` entirely: `SparseRestoreError`, `WorldRestoreError`, `CommandRingError`, `StoreColumnOverflowError`, `RegionRegistryError`, `StoreRestoreError`, `StoreCapExceededError`, `SabUnavailableError`, `EventRingError`, `StoreLayoutOverflowError`, `ActionRingError`, `StoreGrowError`, `EntityIndexError`, `StoreExtendError`.

Boundary translation is inconsistent: `StoreCapExceededError` *is* wrapped into `ECSError(STORE_CAP_EXCEEDED)` (`src/core/ecs/store.ts:686,714,1428`), but the other ring/grow/extend/region errors can leak raw — and most aren't exported from the root barrel, so consumers can't even catch them by type. There's also a duplicate encoding of the same condition (`StoreCapExceededError` class *and* `ECS_ERROR.STORE_CAP_EXCEEDED` category).

**Fix:** pick one of two consistent designs — (a) store errors extend `ECSError` with a category, making `isEcsError` a true invariant, or (b) the ECS boundary systematically wraps every store error the way it already wraps cap-exceeded. Then update `docs/api/errors.md` (which currently lists only 2 of the ~14 non-`ECSError` classes) to match.

---

## High

### H1. `Store` is a god object: one class, ~120 methods, ~18 distinct concerns

`src/core/ecs/store.ts` (4,881 lines, single `class Store` at L343) holds, as mapped section by section: the archetype graph (L1218–1584), entity lifecycle (L1585–1627), template/spawn (L1628–2068), enable/disable (L2069–2172), deferred destruction (L2173–2398), deferred structural changes (L2399–2700), component observers (L2701–2857), component registration (L2858–2924), sparse storage (L2925–3145), snapshot/resume (L3146–3351), relations + hierarchy traversal (L3352–4105), immediate component ops (L4106–4590), query support (L4603–4709), event channels (L4710–4798), and resource storage (L4799–4881).

**Fix:** decompose into collaborators that `Store` *coordinates* rather than implements: `EntityAllocator` (id/generation/free-list), `ArchetypeGraph`, `DeferredCommandBuffer` (the `pending*` buffers at L439–452 plus flush/drain), `SnapshotService`, `RelationService` (see H2), and `EventRegistry`/`ResourceRegistry`. This can proceed incrementally, one extraction at a time, without changing the public API.

### H2. Relation traversal (~750 lines) lives in the god object, split away from relation storage

`relation.ts` holds only the storage substrate (`RelationStore` at `src/core/ecs/relation.ts:155`), while all graph algorithms — `targetsOf`, `sourcesOf`, `pairsOf`, `ancestorsOf`, `rootOf`, `cascadeOf`, hierarchy matching, purge/compaction — live in `store.ts` L3352–4105. Moving them into a `RelationService` next to `RelationStore` is the single largest low-risk cut to `store.ts` (~15% of the file) and the natural first step of H1.

### H3. `ECS` is a second god object: a 111-method facade mirroring `Store` 1:1

`src/core/ecs/ecs.ts` (`class ECS`, L203) declares 111 methods; 83 lines are pure `this.store.<x>` pass-throughs (`regionOffset` L348, `snapshot` L561, `addRelation` L913, `ancestorsOf` L977, …). Every new `Store` capability requires a parallel `ECS` method — the maintenance surface is doubled by construction.

**Fix:** once `Store` is decomposed (H1), expose the extracted services (or narrow typed facades over them) from `ECS` instead of re-declaring each method. Until then, consider consolidating the pure pass-through band.

### H4. Dead duplicate utils tree

`src/utils/{arrays,constants}.ts` are byte-level near-duplicates of `src/core/ecs/utils/{arrays,constants}.ts` (arrays differ only in whitespace; constants differ by one comment word). All 23 live importers resolve to the `core/ecs/utils` copies; the root copies have **zero non-test importers** — orphans from a past move. Only `src/utils/error.ts` (`AppError`, the base both error hierarchies extend) is genuinely shared.

**Fix:** delete `src/utils/arrays.ts` and `src/utils/constants.ts` (and their tests); keep `src/utils/error.ts` as the sole root util. Cheap, zero-risk, removes a confusing "which utils?" trap.

### H5. Growth logic duplicated between `grow.ts` and `extend.ts`

Both the in-place fast paths (`growColumnStoreInPlace`, `src/core/store/grow.ts:128–260`; `extendColumnStoreInPlace`, `src/core/store/extend.ts:506–625`) and the realloc slow paths (grow.ts:362–408 vs extend.ts:420–473) are structurally parallel: same tail-cursor `alignUp` layout, same `STORE_MAX_BYTE_OFFSET` guard (identical comments), same allocator/`bufferRefChanged`/view-stamp/header-patch sequence, same snapshot-restore choreography. The type-only `grow ↔ extend` cross-import confirms they're one module split in two.

**Fix:** extract shared `layoutColumnsAtTail(...)` and `reallocAndRepublish(...)` helpers; grow/extend become thin spec-builders. Cuts ~200 lines and — more importantly — leaves **one** place where the 2³¹ offset cap, `bufferRefChanged`, and view-stamp invariants are maintained.

---

## Medium

### M1. Cross-module contracts are underscore conventions, not types

`Store` exposes convention-private members consumed across modules: `ecs.ts` reaches `_noteSet`, `_forEachSparseMatch`, `_forEachRelationTargetMatch`, `_forEachHierarchyMatch`, `_devBufferedEventCount`; `observer.ts` reaches `_configureComponentObservation`, `_takeDirty`, `_forEachChangedArchetype`, `_collectEntitiesWithComponent`, plus the mutable public field `_structuralObserverHook` (`store.ts:493`). The `_` prefix is the only boundary marker — nothing is compiler-enforced.

**Fix:** define narrow per-consumer interfaces (`ObserverHost`, `QueryHost`, …) that `Store` implements, so each consumer sees only its slice and the boundary is type-checked. Pairs naturally with H1.

### M2. `QueryResolver` leaks 12 mutable cache Maps as public fields

The `QueryResolver` interface (`src/core/ecs/query.ts:86`) declares 12 public cache maps (`_andSingleCache`, `_notSingleCache`, …, L102–133), which live as `public readonly` fields on `ECS` (`ecs.ts:232–243`) and are mutated directly by `Query` (`query.ts:526,553,...`). Cache ownership is split across two modules.

**Fix:** extract a `QueryCache`/`QueryEngine` that owns the maps and the `_resolveQuery`/`_forEach*` methods; hand `Query` that object. Removes 12 underscore fields from the `ECS` contract.

### M3. `core/reactive` is misfiled — nothing in core uses it

No `core/*` file imports `core/reactive`; the kernel's only consumers are `extensions/reactive/ecs_sync.ts` and `extensions/solid/kernel_solid.ts`. It's a self-contained, zero-dependency signal kernel + reactive collections that exists purely to serve extensions and downstream UI — a sibling framework, not core infrastructure. The internal layering itself (kernel / ECS-bridge / solid-adapter) is clean and well documented.

**Fix:** move it to `src/reactive/` so the directory tree matches the story ("core = ECS, reactive = independent primitive, extensions = bridges"). It already ships at its own `./reactive` subpath, so the public API doesn't change — only dist paths.

### M4. `__generated__/abi.ts` has no generator — the directory name is an architecture lie

`src/core/store/__generated__/abi.ts:6–10` admits it: there is no Zig source or codegen step in this package; the file is a hand-maintained snapshot of an upstream engine ABI, guarded only by round-trip tests that check TS-internal self-consistency, not agreement with the real ABI. A `__generated__/` name signals "don't hand-edit, re-run the generator" — the exact inverse of reality.

**Fix:** rename to `abi/` or `vendored_abi/` and reframe the comments as "vendored snapshot of upstream ABI, version X"; or actually check in the generator. Either restores the convention's meaning.

### M5. `src/log` is a hard-wired global singleton serving one call site, unreachable by consumers

`logger.ts:82` exports a module-level singleton; `core/ecs/schedule.ts:39` hard-imports it for exactly one diagnostic (`schedule.ts:623`) — the only logger consumer in the entire tree. Meanwhile the full machinery (256-entry ring buffer, sink subscription, `consoleSink`, a one-member `LOG_CATEGORY` enum) has no package `exports` subpath, so none of it is reachable by consumers. It's the worst middle ground: core coupled to a global, and the logging API dead weight.

**Fix:** either (a) collapse it — replace with an injectable `onWarn?` callback on `ECSOptions` (default `console.warn`) — or (b) commit to it: inject a `LogSink` through `ECSOptions` (like the existing `FrameTraceSink` seam) and export a `./log` subpath. (a) is the right size for current usage.

### M6. Root entry over-exposes internals as semver-stable API

`src/index.ts:16` is `export * from "./core/ecs"`, flattening ~100 symbols to the package root — including entity packed-ID codecs (`createEntityId`, `MAX_GENERATION`, `RETIRED_GENERATION`, …), ring/wire codecs (`ringSetFieldCodec`, `HOST_COMMAND_PAYLOAD_BYTES`, …), memory internals exported "so tests and tooling can inspect" (`resolveECSMemory`, `BUDGET_GROWTH_HEADROOM`, …), and dev-mode singletons (`accessCheck`, `dispatchTrace`). Every one is now a semver commitment. The `export *` also means any future addition to the core barrel silently widens the public API.

**Fix:** curate the root with explicit named exports; move codec/ABI/test-harness surfaces behind a dedicated subpath (`@oasys/oecs/codec` or `/internal`).

### M7. Custom `TypeError` shadows the global

`src/type_primitives/error.ts:21` declares `class TypeError extends AppError`. Inside `type_primitives`, a bare `new TypeError(...)` now silently constructs the custom class — `topological_sort.ts:92` already has to write `globalThis.TypeError` to escape it. Not publicly exported, so a rename (`TypePrimitiveError`/`AssertionError`) is internal and cheap.

### M8. `ColumnStoreInternal` recovered via unchecked structural casts on the resize hot path

`ColumnStoreInternal` (`column_store.ts:400–413`) carries `_regionBytes`/`_allocator`/`_reservedDescriptorBytes` that the public `ColumnStore` omits; grow/extend recover them by casting the public type (six sites: `extend.ts:115,362,382`, `grow.ts:351,359`, plus allocator sniffing via `as { isInPlace?: boolean }`). A `ColumnStore` that isn't actually internal (e.g. from `restoreColumnStore`, `snapshot.ts:141`) passes the cast; safety is by runtime `typeof` guards — convention, not types.

**Fix:** make grow/extend accept `ColumnStoreInternal` explicitly (callers hold the richer type), or model internals as a discriminated optional on `ColumnStore`.

### M9. Near-duplicate allocators

`growableSabAllocator` (`allocator.ts:204–258`) and `heapArraybufferAllocator` (`allocator.ts:281–323`) are structurally identical apart from `SharedArrayBuffer.grow()` vs `ArrayBuffer.resize()`. Parameterize one factory over the buffer strategy so the cap and `isInPlace` semantics can't diverge.

### M10. Naming consistency held by a bespoke codemod

The camelCase-over-snake_case re-derive is enforced by a 246-line hand-maintained segmenter (`src/__tests__/casing_codemod.ts` with a manual `FORCE` map) run from a guard test — and it covers comments only; error-message strings are explicitly out of scope. Architecture that needs a custom codemod to keep names consistent signals the rename isn't source-of-truth. Long-term: make camelCase canonical (or replace with a standard lint rule) so the guard can be retired.

### M11. JSR publish includes `__tests__` helper files

`jsr.json` excludes `**/*.test.ts` and `**/*.bench.ts` but not plain helpers under `__tests__` — so `casing_codemod.ts` (which imports `node:fs`) and `test_helpers.ts` ship to JSR and are subject to its type-checking. Add `**/__tests__/**` to `publish.exclude`.

---

## Low

- **L1.** `radixSortByIndex` (generic sort) is defined in `observer.ts:631` and value-imported by `store.ts:94` — an inverted store→observer edge. Move it to `core/ecs/utils/arrays.ts`.
- **L2.** `_setIterAllRows` (`archetype.ts:1406–1411`) is a mutable module-global toggled with save/restore from four sites in `query.ts`; correctness rests on a commented single-thread assumption. Thread it as an explicit iteration parameter instead.
- **L3.** `schedule.ts:39` is the only core module importing `log` — resolved by M5.
- **L4.** Dead export `_planLayout` (`column_store.ts:302`): its comment documents an integration with extend's fast path that doesn't exist (nothing imports it). Delete or actually use it (fold into H5).
- **L5.** `AnyTypedArray` is declared twice, identically (`column_store.ts:116–124` and `typed_arrays.ts:19–27`). Store should import from `type_primitives`.
- **L6.** FNV-1a constants live in three places; `BitSet.hash()` (`bitset.ts:24–25,157–164`) hand-rolls what `store/state_hash.ts` exports. Layering means the shared helper belongs in `type_primitives`.
- **L7.** `type_primitives/` fuses public data structures with internal assertion/brand/error plumbing; `primitives.ts` re-splits them with an "intentionally NOT re-exported" caveat. Splitting into `data_structures/` + `type_primitives/` would make the entry-point curation structural.
- **L8.** Three hand-synced lists define the 7 subpaths (`package.json` exports, `vite.config.ts` lib entries, `jsr.json` exports), and the dir-alias block is duplicated verbatim in `vite.config.ts`/`vitest.config.ts`. Derive from one manifest.
- **L9.** Identical four-trap field proxy implemented twice (`core/reactive/struct.ts:55–77` and `extensions/solid/kernel_solid.ts:77–85`, which even comments "Mirror the kernel struct proxy"). Extract `createFieldProxy(keys, read)` in the reactive barrel.
- **L10.** Reactive collections use three different absence encodings (array: private `ABSENT` symbol; map: overloaded `undefined` with a documented footgun; struct: none) — note for a future v1 API pass.
- **L11.** `Store`'s constructor still accepts a documented "legacy form" (`arg?: number | StoreOptions`, `store.ts:746`) and `query.ts:1322` keeps a legacy `ctx.addComponent` path "for now". Track both for removal.
- **L12.** Shipped doc comments reference upstream-monorepo artifacts that don't exist in this package (`workbench/reactive/*`, `PATTERNS §85`, internal issue/ADR numbers). Strip or footnote as "refers to the upstream engine".
- **L13.** No dependency-direction guard exists (e.g. nothing prevents a future `solid-js` import in core). A lint or dependency-cruiser rule would make the currently-clean layering enforceable.

---

## What's already good (verified, not assumed)

- **Layering is one-directional and clean**: `core/store` never imports `core/ecs`; `type_primitives` never imports `core`; no runtime import cycles anywhere (only benign type-only back-references). The lone exceptions are L1 and L3 above.
- **One command apply path**: `command_log.ts` and `host_commands.ts` both funnel through a single `applyHostCommand` (`host_commands.ts:117`) — "one apply path, two transports" holds as documented.
- **No storage duplication**: `sparse_store.ts` is a genuinely distinct storage class that reuses `core/store` primitives (shared FNV hashing) rather than reimplementing them.
- **Extensions consume core through the public barrel only** — zero deep imports, zero underscore reach-through, no `as any` at the seam. The observer-based ECS↔reactive bridge is the model seam in the codebase.
- **solid-js isolation is correct**: optional peer dependency, imported by exactly one file, `sideEffects: false` + per-subpath exports keep it out of every non-solid consumer's graph.
- **Zero production dependencies**, dual ESM+CJS, tree-shaking-viable packaging.
- **Very low tagged debt**: zero TODO/FIXME/HACK markers across the entire source tree; `as any` essentially absent from core.

---

## Suggested sequencing

1. **Now (independent, small, shipping-facing):** C1 (`__DEV__` fix), M11 (JSR excludes), H4 (delete orphan utils), L4 (dead export), M7 (`TypeError` rename).
2. **Next (design decision, then mechanical):** C2 (error taxonomy — decide extend-vs-wrap, then apply and fix `docs/api/errors.md`), M6 (curate root exports before more consumers pin to internals — this is the semver-sensitive one).
3. **Incremental refactor track:** H2 (RelationService — biggest low-risk `store.ts` cut) → M1/M2 (typed host interfaces + QueryCache) → remaining H1 extractions → H3 (`ECS` facade slimming) falls out.
4. **Store-layer consolidation:** H5 (grow/extend helpers), M8, M9 together — they touch the same files.
5. **Housekeeping batch:** M3 (move reactive), M4 (rename `__generated__`), M5 (logger), and the remaining Low items, plus L13 (add a dependency-direction guard) to lock in the clean layering once the moves settle.
