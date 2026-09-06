/***
 * `ecs.relations`, the world surface the relations plugin adds.
 *
 * One hop onto the service the plugin built. The facade holds the service and
 * not the store, because the store types its relation slot as the narrow
 * `RelationHooks` seam the core declares, and the facade offers more than the
 * core calls.
 *
 * Constructed once per world. Holds no state of its own.
 ***/

import type { EntityID } from "../../core/ecs/entity";
import type { OnDeleteTarget, RelationDef, RelationOptions } from "../../core/ecs/relation";
import type { RelationService } from "./relation_service";

/** Relations, sparse `(relation, target)` pairs and hierarchy traversal.
 * Add, remove and re-target cause no archetype
 * transition. Ops are immediate and safe mid-tick. Traversal and wildcard
 * reads are cold-path. */
export class ECSRelations {
	private readonly _service: RelationService;
	/** @internal constructed by the relations plugin. */
	constructor(service: RelationService) {
		this._service = service;
	}

	/** Register a relation kind. Exclusive (default) stores one target per
	 * source. `{ multi: true }` stores a target set per source.
	 * `{ onDeleteTarget: "delete" | "clear" | "orphan" }` selects target-death
	 * cleanup (default `orphan`).
	 *
	 * The overloads stamp the cardinality into the handle type, exactly like
	 * the flat `registerRelation`:
	 * the exclusive-only surfaces (`targetOf`, `ancestorsOf` and `rootOf`/
	 * `cascadeOf`, `Query.hierarchy`) accept only `RelationDef<"exclusive">`,
	 * so passing a `{ multi: true }` relation is a compile error. A
	 * dynamically-built options value falls to the erased overload and keeps
	 * the runtime check as its only guard. */
	public register(opts?: {
		readonly exclusive?: true;
		readonly multi?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"exclusive">;
	public register(opts: {
		readonly multi: true;
		readonly exclusive?: false;
		readonly onDeleteTarget?: OnDeleteTarget;
	}): RelationDef<"multi">;
	public register(opts?: RelationOptions): RelationDef;
	public register(opts?: RelationOptions): RelationDef {
		return this._service.registerRelation(opts);
	}

	/** Count of registered relations. */
	public get count(): number {
		return this._service.count;
	}

	/** Add a `(R, tgt)` pair to `src`. Exclusive replaces the existing target
	 * multi adds to the set. No archetype transition. */
	public add(src: EntityID, def: RelationDef, tgt: EntityID): this {
		this._service.addRelation(src, def, tgt);
		return this;
	}

	/** Remove a `(R, tgt)` pair from `src`. For multi, omitting `tgt` removes
	 * all of `src`'s targets. No archetype transition. */
	public remove(src: EntityID, def: RelationDef, tgt?: EntityID): this {
		this._service.removeRelation(src, def, tgt);
		return this;
	}

	/** Whether `src` holds any pair under `R`. */
	public has(src: EntityID, def: RelationDef): boolean {
		return this._service.hasRelation(src, def);
	}

	/** The single target of `src` under an exclusive relation, or `undefined`. */
	public targetOf(src: EntityID, def: RelationDef<"exclusive">): EntityID | undefined {
		return this._service.targetOf(src, def);
	}

	/** All targets of `src` under `R`, ascending by id. */
	public targetsOf(src: EntityID, def: RelationDef): EntityID[] {
		return this._service.targetsOf(src, def);
	}

	/** Sources pointing at `tgt` under `R` (the reverse index), ascending by id.
	 * `(entity, def)` order, matching `targetOf` / `targetsOf`. */
	public sourcesOf(tgt: EntityID, def: RelationDef): EntityID[] {
		return this._service.sourcesOf(tgt, def);
	}

	/** All `(source, target)` pairs of relation `R`, the `(R, *)` wildcard.
	 * Sources in canonical entity-index order. Cold path. */
	public pairsOf(def: RelationDef): readonly (readonly [EntityID, EntityID])[] {
		return this._service.pairsOf(def);
	}

	/** Every `(relation, source)` pointing at `tgt`, across all relation kinds,
	 * the `(*, T)` wildcard. Ordered by relation id then source id. */
	public sourcesOfAny(tgt: EntityID): readonly (readonly [RelationDef, EntityID])[] {
		return this._service.sourcesOfAny(tgt);
	}

	/** Walk relation `R` up from `src` to its chain root, returning
	 * `[src, parent, …, root]` (nearest-ancestor-first). Exclusive only. */
	public ancestorsOf(src: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this._service.ancestorsOf(src, def);
	}

	/** The root of `src`'s `R`-chain (`src` itself when it has no target).
	 * Exclusive only. */
	public rootOf(src: EntityID, def: RelationDef<"exclusive">): EntityID {
		return this._service.rootOf(src, def);
	}

	/** Walk relation `R` down from `root` over the reverse index, returning the
	 * subtree (including `root`) breadth-first, parents before children (the
	 * `cascade` order). Exclusive only. */
	public cascadeOf(root: EntityID, def: RelationDef<"exclusive">): EntityID[] {
		return this._service.cascadeOf(root, def);
	}

	/** Reclaim relation reverse-index memory: drop every reverse entry whose
	 * target has been destroyed, returning the total dropped. Purely
	 * cold-path, no observable state change, call at a scene or snapshot
	 * boundaries. */
	public compact(): number {
		return this._service.compactRelations();
	}
}
