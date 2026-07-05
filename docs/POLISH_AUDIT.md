# oecs — End-User Polish Audit (Types & Ergonomics)

Date: 2026-07-04 · Scope: everything published to npm/JSR (all eight entry points), docs, packaging, and error experience. Findings verified against source. Prioritized by end-user impact.

Updated 2026-07-05: this document now lists only the **open** findings. Everything else from the original audit — the JSR `__DEV__` breakage (#1), the error-experience batch (#4, M6, M17, M18), total `has*` + `tryGetField` (#9), the API additions (M7, M8, M10, M15), the type-level closures (M9, M14, M16, `RelationOptions`, `ResourceKey`), the packaging batch (M19, M20, M21), and the low-priority quick wins — was fixed on `seam-fixes` and is recorded in the 0.5.0 CHANGELOG entry. Original numbering kept so existing references stay valid.

One deliberate deviation from the original recommendations: M14 suggested `"stripInternal": true`; that was tried and rejected because it breaks the deliberate `/internal` entry re-exports — the fix landed narrowly (the leaking member moved behind a module-scoped WeakMap).

---

## Open — needs design discussion (potentially breaking)

| # | Finding | Where | Suggestion |
|---|---|---|---|
| M1 | Immediate vs deferred split on the same facade: host `addComponent` is immediate but `destroyEntity` is buffered (`ecs.destroyEntity(e); ecs.isAlive(e) // true`), signaled only by docs | `ecs.ts` | Finish the declared migration to `ctx.commands.*`; make host `destroyEntity` immediate or rename to signal buffering |
| M2 | `addComponent` demands complete `FieldValues<S>` while bundles/templates zero-fill partials — two mental models for one operation | `ecs.ts` vs `component.ts` | Accept `Partial<FieldValues<S>>`, or the bundle overload `ecs.addComponent(e, Pos({ x: 1 }))` |
| M3 | `sourcesOf(def, tgt)` inverts the `(entity, def)` convention used by `targetOf`/`targetsOf` — the one outlier, mirrored on `SystemContext` | `facades.ts`, `query.ts` | Canonicalize `(tgt, def)` — 0.5.0's hard-removal window is the moment to do it |
| M4 | Host seam spells "def + values" as `spawnEntry(Pos, {x,y})` while core spells it `bundle(Pos, {x,y})` / `Pos({x,y})` — same concept, two names, docs never explain the split | `host_commands.ts` | Accept `Bundle` in `queue.spawn` (zero-fill at apply), or document why not |
| M22 | `world` vs `ecs` receiver split across docs: README/GETTING_STARTED use `world` (82×), api reference uses `ecs` (63×), `wasm.md` mixes both in one page | docs tree | Pick one and sweep |

## Open — docs/DX debt

| # | Finding | Where | Suggestion |
|---|---|---|---|
| M23 | JSDoc coverage is inverted: `update`, `startup`, `query`, `registerComponent`, `addComponent`, `emit`/`read`, event/resource registration have **no JSDoc** while niche APIs get multi-paragraph docs; zero `@example` tags anywhere in the secondary entry points (the good examples live only in docs/, invisible to hover/JSR) | `ecs.ts` passim; all extension entry points | Document the ten most-called methods with `@example`; port existing doc examples into `@example` blocks |

## Open — low priority (API-design calls, not mechanical fixes)

- **`count()` method vs `archetypeCount`/`entityCount` getters** on the same class (`query.ts`) — naming consistency decision.
- **`createEntities(template, count)` is schema-erased and takes no overrides**, unlike `createEntity` (`ecs.ts`); lifecycle vocabulary spans create/spawn/destroy/despawn.
- **`TemplateOverrides` flattens field names across defs** — two components sharing a field name make overrides ambiguous, last wins silently (`store.ts`).
- **`WorldRestoreError`/`WORLD_SNAPSHOT_VERSION`** are the last `World*` names on an otherwise `ECS*` surface — rename would be breaking; 0.5.0 is the natural window if wanted.
- **`fromKernelMap.cell()` mints a fresh subscription per call** — the "call once per row" caveat is now documented on the type; memoizing per key remains an option if it bites in practice.

---

## What's already excellent (keep)

- README quick-start compiles verbatim under `tsc --strict`; docs are signature-accurate; no stale/renamed APIs in README or CHANGELOG.
- Branded `EntityID`/`ComponentID` with zero cast burden; callable-def bundles (`Pos({x,y})`) unifying attach shapes; `registerComponent` overloads inferring precise column types end-to-end; event schemas round-tripping branded numbers.
- `syncFieldsToMap` and friends infer fully (`const` type params reject unknown fields); Solid integration follows Solid idioms with a correctly-optional peer dep.
- `ECSError` design: `category` from the error enum, `context`, `isEcsError`, and docs distinguishing dev-only vs always-on throws — and as of the fix session, the message quality bar (component names, decoded entity ids, actionable hints) is met across the board, enforced by `error_messages.test.ts`.
- No `any`/`unknown` leaks found in any public signature across the secondary entry points; `readonly` discipline consistently strong; the casing guard test enforces the 0.4 rename.
