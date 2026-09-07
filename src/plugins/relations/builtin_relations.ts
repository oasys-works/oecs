/***
 * Built-in relations, named presets over the generic relation primitive.
 *
 * flecs ships `IsA` and `ChildOf` as builtin relationships the core special-cases
 * (component inheritance, name-scoping). This engine special-cases neither. A
 * relation here carries no engine-integrated semantics, because the SoA and
 * WASM hot loop disfavours traversal-per-read. So these are *thin*, each is
 * only `ecs.relations.register(...)` with a chosen cardinality and cleanup
 * policy, and
 * the generic relation surface does the rest, through `targetOf`, `sourcesOf`,
 * `ancestorsOf`, `cascadeOf` and cleanup. They live here as free functions, a
 * convention layer over the primitive, rather than as `ECS` methods, so the
 * world facade stays the mechanism surface and this module is the home for
 * future built-ins.
 *
 * Both are **exclusive** (one direct target per source): an instance is-a one
 * direct exemplar, a child has one parent, which forms a chain and tree and is what
 * makes the exclusive-only traversal helpers available. `multi` is
 * intentionally not offered (it'd break traversal and isn't the IsA or ChildOf
 * shape). `onDeleteTarget` is overridable. The defaults follow flecs.
 *
 * Neither relation introduces live inheritance.
 ***/

import type { ECS } from "../../core/ecs/ecs";
import type { OnDeleteTarget, RelationDef } from "../../core/ecs/relation";
import type { RelationsPlugin } from "./index";

/** A world with the relations plugin installed. These helpers register a
 * relation, so they need it. */
type RelationalWorld = ECS<RelationsPlugin> & RelationsPlugin;

/** Options for a built-in relation. `exclusive` and `multi` are fixed (always
 * exclusive, required for the chain and tree traversal helpers), so only the
 * target-deletion cleanup policy is tunable. */
export interface BuiltinRelationOptions {
	/** What happens to a relation's sources when a target is destroyed.
	 * Defaults per relation (see each registrar). */
	readonly onDeleteTarget?: OnDeleteTarget;
}

/**
 * Register an **`IsA(instance → exemplar)`** relation, a thin instance-of link.
 *
 * - "all instances of exemplar E" is `ecs.relations.sourcesOf(E, IsA)`.
 * - the IsA chain (`instance → exemplar → …`) is walked with
 *   `ecs.relations.ancestorsOf(instance, IsA)`, `rootOf` and `cascadeOf(exemplar, IsA)`.
 * - **No component inheritance**. IsA records the link only. Materialization of
 *   an instance from its exemplar stays a spawn-time copy on the template path,
 *   deliberately decoupled. An exemplar is a real entity and not a `Template`,
 *   because a non-entity template cannot be a relation target.
 *
 * Default `onDeleteTarget: "clear"`, destroying an exemplar drops its
 * instances' IsA link but leaves the instances alive (the thin analog of
 * flecs's `IsA`-remove, since there is no inherited data to strip). Pass
 * `"delete"` for strong instance-of (exemplar death cascade-destroys instances).
 */
export function registerIsA(ecs: RelationalWorld, opts?: BuiltinRelationOptions): RelationDef<"exclusive"> {
	return ecs.relations.register({
		exclusive: true,
		onDeleteTarget: opts?.onDeleteTarget ?? "clear"
	});
}

/**
 * Register a **`ChildOf(child → parent)`** relation, a thin hierarchy link.
 *
 * - a parent's children are `ecs.relations.sourcesOf(parent, ChildOf)`.
 * - the hierarchy is walked with `ecs.relations.ancestorsOf(child, ChildOf)` (up to the
 *   root), `rootOf`, and `cascadeOf(root, ChildOf)` (down, breadth-first,
 *   parents before children).
 * - unlike flecs's `ChildOf`, this does **not** scope names or lookup, the engine
 *   has no name registry. It is purely the structural parent link.
 *
 * Default `onDeleteTarget: "delete"`, destroying a parent cascade-destroys
 * its whole subtree (flecs's default). Pass `"clear"` to let children survive as
 * roots, or `"orphan"` to leave a dangling `targetOf`.
 */
export function registerChildOf(ecs: RelationalWorld, opts?: BuiltinRelationOptions): RelationDef<"exclusive"> {
	return ecs.relations.register({
		exclusive: true,
		onDeleteTarget: opts?.onDeleteTarget ?? "delete"
	});
}
