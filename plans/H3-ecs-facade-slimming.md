# H3 — Slim the 111-method `ECS` pass-through facade

**Severity:** High
**Source:** architecture-report.md § H3
**Depends on:** [H1](H1-store-god-object-decomposition.md) extractions (at least H2 + the registry extractions) for the full fix; the pass-through consolidation can start earlier.

## Problem

`src/core/ecs/ecs.ts` (`class ECS`, L203) declares 111 methods; 83 lines are pure `this.store.<x>` pass-throughs (e.g. `regionOffset` L348, `snapshot` L561, `addRelation` L913, `ancestorsOf` L977). Every new `Store` capability requires a parallel `ECS` method — the maintenance surface is doubled by construction.

## Plan

Two phases; phase 1 is safe now, phase 2 rides on H1.

### Phase 1 — consolidate the pass-through band (no API change) — **DONE** (2026-07-04)

1. ~~Inventory the 111 methods; tag each as: pure pass-through / pass-through with argument or result adaptation / real logic.~~ Inventory result: **56 members** (61 declarations counting overloads) are pure single-delegation to `store`/`schedule`/`ctx`/`_observers`; the rest carry real logic or adaptation (dev access checks, overload normalization, key→def lookup, own state).
2. ~~Group the pure pass-throughs into one contiguous, clearly-marked section.~~ Done — the `=== BEGIN/END STORE PASS-THROUGH BAND ===` section at the tail of `class ECS`. Members were moved verbatim (AST-positioned splice), so doc comments and formatting are untouched.
3. ~~Add a guard test.~~ `src/core/ecs/__tests__/unit/ecs_passthrough_guard.test.ts` — TS-AST check that every band member is exactly one delegate call (or property read), optionally `+ return this`, args restricted to parameter forwards / inert literals, zero control flow. Negative-tested (an injected `if (__DEV__)` fails it three ways).

Verified: full suite green (1,558), `dist/core/ecs/ecs.d.ts` member-signature set identical before/after (123 = 123; order shifts, set doesn't), `dist/index.d.ts` / `dist/internal.d.ts` byte-identical, `public_api.test.ts` untouched.

### Phase 2 — expose services instead of mirroring methods (after H1)

1. For each collaborator extracted in H1 (`RelationService`, `EventRegistry`, `ResourceRegistry`, `SnapshotService`, …), decide per group:
   - **Keep flat methods** where they're the ergonomic hot-path API (component ops, spawn/destroy) — users shouldn't write `ecs.entities.spawn()`.
   - **Expose a narrow typed facade** for cohesive secondary groups (e.g. `ecs.relations.targetsOf(...)`, `ecs.events.channel(...)`) where a grouped surface reads better than 15 prefixed methods.
2. Any regrouping is a **breaking API change** — batch these behind the next minor/major, and keep the old flat methods as deprecated delegations for one release. M6 has landed (curated root exports + `@oasys/oecs/internal`, version bumped to **0.4.1, not yet published**) — if phase 2 lands before 0.4.1 ships, both breaking changes ride one semver event; after, phase 2 needs its own.
3. Update `docs/api/*.md` for any surface that moves.

## Decision — SIGNED OFF (2026-07-05)

The user approved the proposed split and mechanics:

- **Grouped facades (4):** `ecs.relations.*` (13 methods, wraps the relation surface; `register/add/remove/has/compact/count` + the traversal names unchanged), `ecs.snapshots.*` (`capture/restore/captureSparse/restoreSparse/stateHash/deterministic`), `ecs.resources.*` (`register/get/set/remove/has`), `ecs.events.*` (`register/registerSignal/emit/read`; system-side `ctx.emit` untouched).
- **Stay flat:** entity/component CRUD, sparse ops, `query`/systems/observers, enable/disable, batch ops, WASM/memory/region/backend integration surface.
- **Migration:** flat methods stay as `@deprecated` delegations for one release; removal targeted at 0.6.0.
- **Version:** phase 2 rides a **0.5.0** bump (not the staged 0.4.1 — new API groups are more than a patch).
- **Sequencing:** implementation prepared on `oecs_compare` (`exp/h3-phase2`); applied to oecs only after the concurrent typestate-access work lands on `ecs.ts`/`system.ts` (user queues the apply).
- **Perf:** no bench gate — affected groups are cold/warm host-side paths, aliases keep their existing bodies during the grace release, and the H1 A/B evidence (steps 3/4/6) already establishes monomorphic delegation as free at current V8.

## Verification

- Phase 1: zero public API diff (compare `.d.ts` output); guard test in place.
- Phase 2: docs updated; deprecation aliases tested; changelog entry for the regrouping.

## Findings from the M1/M2/M6 work (2026-07-04 session)

- **A public-API snapshot test now exists** (`src/__tests__/public_api.test.ts`,
  from M6): it pins the root and `/internal` runtime export names. Phase 2's
  regrouping will (intentionally) trip it — updating the checked-in list is
  the explicit review artifact the M6 design intends. Phase 1 must NOT trip it.
- **The pass-through inventory has a head start.** `ECS implements
  QueryResolver` (query.ts) and the store-facing underscore members it uses
  are now typed via `QueryHost` (M1); the relation/event/resource delegations
  on `Store` are already one-liner bands pointing at `RelationService` /
  `EventRegistry` / `ResourceRegistry` — so for those groups the ECS-level
  delegation is a two-hop chain (`ECS → Store → collaborator`), the natural
  first target for phase 2's grouped facades (`ecs.relations.*` etc. could
  wrap the collaborator directly).
- **`ECSOptions` gained `onWarn`** (M5) — if phase 2 regroups diagnostics,
  that's the injectable-seam style to match (no globals; `FrameTraceSink`
  and `onWarn` are the precedents).
