/**
 * # oecs — archetype Entity Component System for TypeScript
 *
 * Re-derived from the oasys engine ECS. A determinism-capable archetype ECS
 * with a topo-sorted scheduler, system sets + run conditions, per-component
 * observers, relations (with wildcards), sparse storage, templates, and a
 * typed host→ECS write seam.
 *
 * Storage runs over a backing-neutral column store (`ColumnStore`). The default
 * profile is **pure-TS heap** — a plain resizable `ArrayBuffer`, so no
 * `SharedArrayBuffer` and no cross-origin isolation (COOP/COEP) are required.
 * The opt-in `SharedArrayBuffer` + WASM profile lives at `@oasys/oecs/shared`.
 *
 * @module oecs
 */
export * from "./core/ecs";
