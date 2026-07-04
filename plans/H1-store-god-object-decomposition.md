# H1 — Decompose the `Store` god object

**Severity:** High
**Source:** architecture-report.md § H1
**Depends on:** none to start, but H2 is the designated first extraction. M1 (typed host interfaces) pairs naturally.

## Problem

`src/core/ecs/store.ts` is 4,881 lines with a single `class Store` (L343) holding ~120 methods across ~18 distinct concerns: archetype graph (L1218–1584), entity lifecycle (L1585–1627), template/spawn (L1628–2068), enable/disable (L2069–2172), deferred destruction (L2173–2398), deferred structural changes (L2399–2700), component observers (L2701–2857), component registration (L2858–2924), sparse storage (L2925–3145), snapshot/resume (L3146–3351), relations + hierarchy traversal (L3352–4105), immediate component ops (L4106–4590), query support (L4603–4709), event channels (L4710–4798), and resource storage (L4799–4881).

## Goal

`Store` becomes a coordinator that owns and delegates to focused collaborators, each independently testable, without changing the public `ECS`/`Store` API or observable behavior.

## Target decomposition

Extract in this order (lowest risk / highest payoff first):

1. ~~**`RelationService`** — relations + hierarchy traversal (~750 lines). Covered by H2.~~ **DONE** (commit 355df97).
2. ~~**`EventRegistry`** — event channels and **`ResourceRegistry`** — resource storage.~~ **DONE** (commit 189e666).
3. ~~**`EntityAllocator`** — id/generation/free-list from entity lifecycle plus the allocation state fields.~~ **DONE** (2026-07-04, bench-gated — see "Step 3 outcome" below).
4. ~~**`DeferredCommandBuffer`** — the `pending*` buffers plus deferred destruction and deferred structural changes, with their flush/drain logic.~~ **DONE** (2026-07-05, bench-gated). Boundary note: the collaborator owns the pending buffers, enqueue API, and the *drain policy* (no-observer fast path, observed fixed-point loop with its adds/removes → destroys → toggles ordering, `OBSERVER_MAX_ROUNDS` guard, re-entrancy flag) behind a closure host; the four batch **appliers** (`_flushAdds` / `_flushRemoves` / `_flushToggles` / `_drainDestroyed`) deliberately stayed on `Store` — they are archetype-transition logic entangled with the graph, the 0-crossing dirty bookkeeping, and observer event collection, so they move (if ever) with step 6's ArchetypeGraph work, not with the queue. A/B: `deferred_flush` bench 0.99–1.00x vs control 1.01x; entity_alloc/frame_loop groups match the control band. Logged in `oecs_compare/EXPERIMENTS.md`.
5. **`SnapshotService`** — snapshot/resume. Needs read access to the other collaborators' state; define an explicit snapshot interface per collaborator rather than letting it reach into their fields.
6. **`ArchetypeGraph`** — archetype graph management. Most entangled with hot paths; do last, benchmark before/after.

> Line numbers in this file describe the pre-H2 store.ts (4,881 lines); after
> steps 1–2 it is 4,333 lines and all sections have shifted — re-grep before
> each extraction.

## Findings from steps 1–2 (2026-07-04 session)

- **Step 3 is riskier than it reads.** The allocation state is
  `entityHighWater` / `entityFreeIndices` / `entityAliveCount` /
  `_entityIndexCapacity` / `_entityIndexLengthView` **plus** the SAB-backed
  views `entityGenerations` / `entityArchetype` / `entityRow` — and those
  views are **replanted on snapshot restore** (`store.ts` constructor + the
  restore path both reassign them from `buildEntityIndexViews`). Any
  collaborator holding them must re-read per call (the closure-accessor
  pattern `RelationServiceHost` uses) or be rewired on restore.
- **Step 3 reverses documented perf decisions — bench first.**
  `createEntity` and `_allocEntity` are *deliberately duplicated* "so that
  hot path stays inline (#368)", and the index-recycle logic
  (generation bump / `RETIRED_GENERATION` tombstone / free-list push) is
  hand-inlined inside `flushDestroys`' inner loop with a cached `entGens`
  local. Consolidating these into one `EntityAllocator.alloc()/recycle()`
  is exactly the kind of change the plan's bench gate exists for. No
  entity-alloc benchmark exists in `oecs_bench` today — add one before
  extracting (the golden-fixture technique from H5 —
  `src/core/store/__tests__/layout_scenarios.ts` + captured JSON — is a
  good model for pinning behavior, but only a bench catches the inline→call
  regression).
- **The host-seam pattern is established.** Constructor-injected narrow
  interfaces now exist as templates: `RelationServiceHost`
  (relation_service.ts, closure accessors for replanted views),
  `ObserverHost` (observer.ts), `QueryHost` (query.ts). New collaborators
  should follow them, and per M1's step 6 the existing seams should be
  retargeted at collaborators as they extract (e.g. `QueryHost`'s three
  `_forEach*Match` members belong to whichever collaborator ends up owning
  the query-match paths).
- **Step 2's registries were fully self-contained** (zero Store
  reach-back) — that's why they were cheap. Steps 3–6 all reach back;
  expect each to need a host interface.
- **Bench workflow reality:** `oecs_bench` (sibling repo) currently has
  frame_loop / mutation / query / registration benches but nothing for
  relations, entity alloc, or grow/extend specifically. The A/B procedure
  is `oecs_compare` + `oecs_bench` per `oecs_compare/EXPERIMENTS.md`.

## Step 3 outcome (2026-07-04 session)

- **Bench infra revived first.** `oecs_compare` was 36 commits stale (pre-0.4
  flat layout); refreshed via the documented rsync procedure to oecs @ a38e9c2
  (full copied suite 1558/1558). `oecs_bench` ported to the 0.4 camelCase API
  (`initial_capacity` → `ECSOptions.memory.columnCapacity`); new
  `entity_alloc.bench.ts` (alloc_fresh / destroy_realloc / churn_1comp at
  10k/100k/1M) plus an EntityID-sequence + liveness parity assertion in
  `parity.test.ts` (exact ids across alloc/destroy/flush/realloc — query
  parity alone can't catch a free-list-order or generation-bump bug).
- **Controls are mandatory.** Identical-code A/B runs show a systematic,
  group-specific B-runs-second bias: alloc_fresh 0.92–0.98, destroy_realloc
  10k 0.90–0.94, query-compose changed-only 0.86–0.96 — with **byte-identical
  code**. Judge experiments against the same-day control band, never against
  a naive 1.00.
- **The inline→call worry (#368) did not materialize.** With the extraction
  (`EntityAllocator.alloc()/recycle()/isAliveIndex()`, monomorphic receiver),
  every entity_alloc / query-compose / frame_loop / mutation ratio fell within
  or above the identical-code control band across two experiment runs. One
  destroy_realloc-1M 0.94 did not reproduce (0.99–1.00 on re-run). Logged in
  `oecs_compare/EXPERIMENTS.md`; raw tables in `oecs_bench/results/2026-07-04T*.md`.
- **Shape:** allocator owns generations view / high-water / free-list / alive
  count / length-header mirror; `Store` keeps `entityArchetype`/`entityRow`
  (membership, not allocation). SAB replant flows through
  `EntityAllocator.replantViews` (called from `_refreshEntityIndexViews`);
  hot flush loops hoist `alloc.generations`/`alloc.highWater` once per flush;
  `lastIndex` out-param replaces `_spawnIndex`.

Remaining in `Store`: component registration, immediate component ops, template/spawn, enable/disable, sparse storage, query support — reassess after steps 1–6; some may warrant a second pass.

## Method (per extraction)

1. Identify the section's methods + the fields only they touch. Move fields into the new class; `Store` holds one instance.
2. Keep `Store`'s public methods as one-line delegations initially — no call-site churn outside `store.ts`.
3. Where the collaborator needs `Store` internals, define a narrow constructor-injected interface (see M1's pattern) instead of passing `Store` whole.
4. Move the corresponding unit tests (or add them) against the collaborator directly.
5. Run the full test suite + benchmarks (`oecs_bench` per the perf workflow) after each extraction; hot-path extractions (ArchetypeGraph, DeferredCommandBuffer) must show no regression before merging.

## Constraints

- One extraction per PR. Never mix extractions with behavior changes.
- Public API (root barrel, `ECS` methods) must be byte-identical in `.d.ts` output — diff the generated types as a gate.
- Preserve monomorphic call shapes on hot paths (avoid introducing megamorphic dispatch through interfaces on per-entity inner loops; delegate at operation granularity, not per-row).

## Verification

- Full test suite green after each step.
- `oecs_bench` comparison run (see `oecs_compare/EXPERIMENTS.md` workflow) for steps 4 and 6.
- Public type surface diff is empty.

## Out of scope

- Slimming the `ECS` facade — that's H3, which becomes possible after this.
- Changing deferred-command semantics or snapshot format.
