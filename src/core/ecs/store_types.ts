/***
 * The store shapes a consumer names without holding a `Store`.
 *
 * A leaf. Component metadata, the observation flags a plugin asks for, the
 * structural event batch one flush round collects, what a drain hands back,
 * and the resolved template a spawn takes. Each one is data, and none of them
 * needs the class that owns them.
 *
 * `store.ts` re-exports every name here, so a caller outside the package sees
 * no move. Inside, a module that only needs a shape imports this file, which
 * keeps it out of the storage import component.
 * `src/__tests__/import_graph.test.ts` pins what is left.
 ***/

import type { TypedArrayTag } from "../../type_primitives";
import type { ArchetypeID } from "./archetype_types";
import type { ComponentDef } from "./component";
import type { EntityID } from "./entity";

export interface ComponentMeta {
	/** Optional debug name from `registerComponent(schema, { name })`,
	 * diagnostic messages only, never behaviour. */
	name?: string;
	fieldNames: string[];
	fieldIndex: Record<string, number>;
	fieldTypes: TypedArrayTag[];
	/** The global name id of each field, in schema order (ref.ts). */
	fieldGid: Int32Array;
	// --- Component observers ---
	// Hot-path flags consulted by the structural flush + the field-write path.
	// All false unless `ecs.observe(...)` registered a matching observer. The
	// no-observer flush path is byte-for-byte unchanged (`_structuralObserverCount`
	// gate in `flushStructural`). See the observers plugin.
	/** Has an onAdd observer, collect effective adds for this component. */
	obsAdd: boolean;
	/** Has an onRemove observer, collect effective removes for this component. */
	obsRem: boolean;
	/** Has an onDisable observer, collect effective disables for this
	 * component at the toggle drain. */
	obsDisable: boolean;
	/** Has an onEnable observer, collect effective enables for this
	 * component at the toggle drain. */
	obsEnable: boolean;
	/** Has a row tick plane: every archetype that holds the component keeps
	 * one change tick for each row, and every write path stamps it. Turned on
	 * by `trackRows`, which an entity-level onSet implies. Never turned off. */
	rowTicks: boolean;
	/** Has a per-entity onSet observer, record dirty rows on the write path
	 * (the opt-in dirty list). Implies `rowTicks`. */
	trackDirty: boolean;
	/** The change tick below which every record was drained. A row tick at or
	 * below it is stale, so the next record of that row joins the dirty list. */
	drainTick: number;
	/** The list length above which a frame switches to the scan: past it, a
	 * by-id record stamps the row and pushes nothing, and the drain walks the
	 * plane of every stamped archetype instead. Set at each drain from the live
	 * entity count, so the switch lands where the two costs cross whatever the
	 * size of the world. */
	listCap: number;
	/** The change tick of the last `cols.ticks(def)` call. Above `drainTick`, a
	 * chunk loop stamped rows the list does not hold, so the drain scans. */
	scanTick: number;
	/** The `run` of the last `drainSet`. A second drain at the same run returns
	 * the first one's result, so several consumers of the change feed share one
	 * drain instead of taking the rows away from each other. */
	lastDrainRun: number;
}

/** What one consumer of the change feed asks the store to record for a
 * component. Each flag maps to one observer hook. `set` is the row grain:
 * it turns on the row tick plane and the dirty list. */
export interface ObservationFlags {
	readonly add: boolean;
	readonly remove: boolean;
	readonly disable: boolean;
	readonly enable: boolean;
	readonly set: boolean;
}

/**
 * Effective `(component, entity)` structural events for one fixed-point round,
 * collected during `_flushAdds` and `_flushRemoves`, then handed to the observer
 * dispatch hook. Flat parallel arrays, count-bounded (`*_len`), reused across
 * rounds, never reallocated in the flush. This is a scheduling artifact: it is
 * not part of `stateHash` or snapshot. See the observers plugin.
 */
export interface StructuralObserverEvents {
	addComp: number[];
	addEid: number[];
	addLen: number;
	remComp: number[];
	remEid: number[];
	remLen: number;
	/** Effective disable events, collected during the toggle drain
	 * (`_flushToggles`), one per `(component, entity)` of each net-disabled
	 * entity's mask. Empty on a structural (add, remove and destroy) round. */
	disComp: number[];
	disEid: number[];
	disLen: number;
	/** Effective enable events, symmetric with the disable arrays. */
	enaComp: number[];
	enaEid: number[];
	enaLen: number;
}


/** What `Store.drainSet` hands a consumer of the change feed: the rows a
 * tick-plane scan found and the rows the dirty list held.
 *
 * A `scanned` row is alive, a member and enabled by construction, so a
 * consumer fires it with no check. A `listed` entity may hold a duplicate, and
 * it may have died, left the component or been disabled since its record, so a
 * consumer checks each one.
 *
 * Both arrays belong to the store and both are reused. A consumer may sort,
 * dedupe or truncate them in place, and the observer registry does exactly
 * that. The drain is memoized on its run, so a second consumer in the same run
 * sees the arrays as the first consumer left them. Every consumer must plan
 * around that. */
export interface DrainResult {
	scanned: EntityID[];
	listed: EntityID[];
}

// Phantom slot carrying the template's def-list type so `spawn` can check
// overrides against it. Optional, and erased at runtime. Deliberately
// covariant, unlike the invariant `ResourceKey` and `EventKey` phantoms. A
// `Template<[…]>` must erase to bare `Template` in a system's `spawns` and
// `despawns` access declaration. Widening only loosens the advisory override
// check, so there is no write-direction hole to close.
declare const __templateDefs: unique symbol;

/** A resolved template, an archetype template produced by
 * `ECS.template(...)`. Opaque apart from `defs`. A caller holds it and passes
 * it to `ECS.spawn` or to `ECS.spawnMany`. A caller may also name it in a
 * system's `spawns` or `despawns` access declaration, which the scheduler
 * expands to `defs`. The remaining fields are engine-internal and may change.
 * `spawn` lands an entity directly in `archetype_id` with no archetype
 * transition, and writes `flatValues` (defaults in `_flatColumns` order) in one
 * append pass. */
export interface Template<Defs extends readonly ComponentDef[] = readonly ComponentDef[]> {
	readonly archetypeId: ArchetypeID;
	readonly flatValues: number[];
	/** `flatValues` converted one time to each column's stored bit pattern
	 * (`Archetype.widthBits`), so a single `spawn` writes them with no
	 * conversion, see `Archetype.addEntityWithBits`. */
	readonly flatBits: Float64Array;
	readonly overrideIndex: Map<string, number>;
	/** The component set this template spawns into, in entry order. */
	readonly defs: readonly ComponentDef[];
	readonly [__templateDefs]?: Defs;
}
