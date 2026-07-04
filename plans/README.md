# Fix plans — architecture-report.md (High + Medium)

One plan per issue; IDs match the report. Completed plans are deleted after their commit lands on `seam-fixes` — only the still-open ones remain here. Critical items (C1, C2) were never planned here — C1 is a direct fix, C2 needs a design decision first (see report § Suggested sequencing).

## Open

| ID | Plan | One-liner | Status |
|----|------|-----------|--------|
| H1 | [Store god-object decomposition](H1-store-god-object-decomposition.md) | Extract collaborators from `Store` | **All 6 steps done** (RelationService, Event/ResourceRegistry, EntityAllocator, DeferredCommandBuffer, SnapshotService, ArchetypeGraph — 3/4/6 bench-gated via the revived `oecs_compare`/`oecs_bench` A/B workflow, every ratio within identical-code control bands). Remaining Store sections (component registration, immediate ops, template/spawn, enable/disable, sparse storage, query support) — reassess per the plan's second-pass note |
| H3 | [ECS facade slimming](H3-ecs-facade-slimming.md) | Stop mirroring every `Store` method on `ECS` | Phase 1 **done** (pass-through band + AST guard test, 2026-07-04); phase 2 rides on H1 and needs a user decision on flat-vs-grouped surface |

## Completed (2026-07-04, branch `seam-fixes`)

H2 (RelationService — plus restoring the docs a prior extraction stripped), H4 (orphan utils deleted), H5 (grow/extend consolidated into `layout_ops.ts`, pinned by the golden differential fixture `src/core/store/__tests__/layout_golden.json`), M1 (ObserverHost/QueryHost typed seams), M2 (QueryCache), M3 (`src/reactive` move), M4 (`vendored_abi/` rename), M5 (`ECSOptions.onWarn`, `src/log` deleted), M6 (curated root exports + `@oasys/oecs/internal`; **version 0.4.1 staged, not published**), M7 (`AssertionError`), M8 (`isColumnStoreInternal` guard — option (b), because `restoreColumnStore` legitimately returns the public type), M9 (strategy-parameterized allocator factory), M10 (casing codemod retired, no lint replacement per user decision), M11 (JSR `__tests__` exclude).
