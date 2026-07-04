# Fix plans — architecture-report.md (High + Medium)

One plan per issue; IDs match the report. Completed plans are deleted after their commit lands on `seam-fixes` — only the still-open ones remain here. Critical items (C1, C2) were never planned here — C1 is a direct fix, C2 needs a design decision first (see report § Suggested sequencing).

## Open

*(none — all sixteen findings are closed; the only carried-forward note is H1's
second-pass suggestion: the sections still in `Store` — component registration,
immediate component ops, template/spawn, enable/disable, sparse storage, query
support — may warrant another decomposition pass someday.)*

## Completed (2026-07-05)

H1 (Store god-object decomposition — all six extractions: RelationService, Event/ResourceRegistry, EntityAllocator dd8d1f8, DeferredCommandBuffer 3bf0b71, SnapshotService ad155c0, ArchetypeGraph 7918733; steps 3/4/6 bench-gated via the revived `oecs_compare`/`oecs_bench` A/B workflow, every ratio within identical-code control bands — methodology + lessons in `oecs_compare/EXPERIMENTS.md`), H3 (ECS facade slimming — phase 1: pass-through band + AST guard a38e9c2; phase 2: grouped `ecs.relations`/`ecs.events`/`ecs.resources`/`ecs.snapshots` facades mirroring the typestate cardinality surface, flat forms @deprecated until 0.6.0, shipped with the 0.5.0 bump).

## Completed (2026-07-04, branch `seam-fixes`)

H2 (RelationService — plus restoring the docs a prior extraction stripped), H4 (orphan utils deleted), H5 (grow/extend consolidated into `layout_ops.ts`, pinned by the golden differential fixture `src/core/store/__tests__/layout_golden.json`), M1 (ObserverHost/QueryHost typed seams), M2 (QueryCache), M3 (`src/reactive` move), M4 (`vendored_abi/` rename), M5 (`ECSOptions.onWarn`, `src/log` deleted), M6 (curated root exports + `@oasys/oecs/internal`; **version 0.4.1 staged, not published**), M7 (`AssertionError`), M8 (`isColumnStoreInternal` guard — option (b), because `restoreColumnStore` legitimately returns the public type), M9 (strategy-parameterized allocator factory), M10 (casing codemod retired, no lint replacement per user decision), M11 (JSR `__tests__` exclude).
