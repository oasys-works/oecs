/***
 * Built-in relations — named presets over the generic relation primitive.
 *
 * flecs ships `IsA` / `ChildOf` as builtin relationships the core special-cases
 * (component inheritance, name-scoping). We deliberately do NOT: our relations
 * carry no engine-integrated semantics (ADR-0011 — the SoA/WASM hot loop
 * disfavours traversal-per-read), so these are *thin* — each is just
 * `ecs.relations.register(...)` with a chosen cardinality + cleanup policy, and
 * the generic relation surface (`targetOf` / `sourcesOf` / `ancestorsOf` /
 * `cascadeOf` / cleanup) does the rest. They live here as free functions — a
 * convention layer over the primitive — rather than as `ECS` methods, so the
 * world facade stays the mechanism surface and this module is the home for
 * future built-ins.
 *
 * Both are **exclusive** (one direct target per source): an instance is-a one
 * direct exemplar, a child has one parent — which forms a chain/tree and is what
 * makes the exclusive-only traversal helpers (#474) available. `multi` is
 * intentionally not offered (it'd break traversal and isn't the IsA/ChildOf
 * shape). `onDeleteTarget` is overridable; the defaults follow flecs.
 *
 * Resolves #517-adjacent #477 (IsA); ChildOf is the sibling slice of the
 * relations epic #463. No live inheritance is introduced (see #478).
 ***/

import type { ECS } from "./ecs";
import type { OnDeleteTarget, RelationDef } from "./relation";

/** Options for a built-in relation. `exclusive` / `multi` are fixed (always
 * exclusive — required for the chain/tree traversal helpers), so only the
 * target-deletion cleanup policy is tunable. */
export interface BuiltinRelationOptions {
	/** What happens to a relation's sources when a target is destroyed.
	 * Defaults per relation (see each registrar). */
	readonly onDeleteTarget?: OnDeleteTarget;
}

/**
 * Register an **`IsA(instance → exemplar)`** relation — a thin instance-of link.
 *
 * - "all instances of exemplar E" is `ecs.relations.sourcesOf(E, IsA)`.
 * - the IsA chain (`instance → exemplar → …`) is walked with
 *   `ecs.relations.ancestorsOf(instance, IsA)` / `rootOf` / `cascadeOf(exemplar, IsA)`.
 * - **No component inheritance** — IsA records the link only; materialization of
 *   an instance from its exemplar stays a spawn-time copy (the template path,
 *   #462), deliberately decoupled (#477 / #478). An exemplar is a real entity,
 *   not a `Template` (a non-entity template can't be a relation target).
 *
 * Default `onDeleteTarget: "clear"` — destroying an exemplar drops its
 * instances' IsA link but leaves the instances alive (the thin analog of
 * flecs's `IsA`-remove, since there is no inherited data to strip). Pass
 * `"delete"` for strong instance-of (exemplar death cascade-destroys instances).
 */
export function registerIsA(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef<"exclusive"> {
	return ecs.relations.register({
		exclusive: true,
		onDeleteTarget: opts?.onDeleteTarget ?? "clear"
	});
}

/**
 * Register a **`ChildOf(child → parent)`** relation — a thin hierarchy link.
 *
 * - a parent's children are `ecs.relations.sourcesOf(parent, ChildOf)`.
 * - the hierarchy is walked with `ecs.relations.ancestorsOf(child, ChildOf)` (up to the
 *   root), `rootOf`, and `cascadeOf(root, ChildOf)` (down, breadth-first,
 *   parents before children).
 * - unlike flecs's `ChildOf`, this does **not** scope names/lookup — the engine
 *   has no name registry; it is purely the structural parent link.
 *
 * Default `onDeleteTarget: "delete"` — destroying a parent cascade-destroys
 * its whole subtree (flecs's default). Pass `"clear"` to let children survive as
 * roots, or `"orphan"` to leave a dangling `targetOf`.
 */
export function registerChildOf(ecs: ECS, opts?: BuiltinRelationOptions): RelationDef<"exclusive"> {
	return ecs.relations.register({
		exclusive: true,
		onDeleteTarget: opts?.onDeleteTarget ?? "delete"
	});
}
