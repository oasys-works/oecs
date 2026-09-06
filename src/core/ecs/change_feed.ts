/***
 * The change feed, as a type.
 *
 * A leaf. It names the store shapes and the archetype window, and nothing that
 * builds one. `Store` implements it, several plugins drain it, and the observer
 * seam extends it, so every one of those files would otherwise import
 * `plugin.ts` and land in the same import component as the world itself.
 *
 * `plugin.ts` re-exports the name, so a caller outside the package sees no
 * move. `src/__tests__/import_graph.test.ts` pins what is left.
 ***/

import type { ArchetypeView } from "./archetype_types";
import type { ComponentHandle } from "./component";
import type { EntityID } from "./entity";
import type { DrainResult, ObservationFlags, StructuralObserverEvents } from "./store_types";

/** The store's record of what changed, opened to more than one consumer.
 *
 * A plugin asks the store to record a grain, then drains what the store
 * recorded. Several plugins share the feed. The store merges every
 * consumer's ask by OR, and the drains are memoized on their run, so one
 * consumer never takes a record away from another.
 *
 * Two costs a consumer plans around. Asking for the row grain of a component
 * turns on its row tick plane and its dirty list, which every by-id write to
 * that component then pays. Draining hands back store-owned arrays that the
 * next drain reuses, so a consumer copies whatever it keeps past the call. */
export interface ChangeFeed {
	/** Record what this consumer wants collected for `cid`. `consumer` is the
	 * plugin name, and it keys the record the store merges. All-false is
	 * the same as never asking. Cold path. */
	configureObservation(consumer: string, cid: number, flags: ObservationFlags): void;
	/** The sparse form: the entity grain of sparse component `sid`, on or off
	 * for this consumer. Cold path. */
	configureSparseObservation(consumer: string, sid: number, hasSet: boolean): void;
	/** The rows of `cid` recorded since the last drain. `run` is the change
	 * tick of this pass, and it memoizes the drain: two calls at one run give
	 * the same object. Once per run per component. */
	drainSet(cid: number, run: number): DrainResult;
	/** The members of sparse component `sid` recorded since the last drain,
	 * alive and enabled, in member order. Memoized on `run` like `drainSet`,
	 * and the array is store-owned. */
	drainSparseSet(sid: number, run: number): EntityID[];
	/** Visit every non-empty archetype whose `cid` column changed after
	 * `baseline`, in canonical order. The archetype grain. Costs one compare
	 * per archetype that holds `cid`, and no write path pays for it. */
	forEachChangedArchetype(cid: number, baseline: number, cb: (arch: ArchetypeView) => void): void;
	/** Every live enabled entity that holds `cid`, for a consumer seeding
	 * itself with what already exists. Allocates, and walks every row. Cold
	 * path. */
	collectEnabledWith(cid: number): EntityID[];
	/** Take one round's structural events. Every hook runs, in install order,
	 * on each round of the observed flush. The batch is store-owned scratch
	 * that the next round overwrites. Cold path to install, hot per round. */
	addStructuralHook(fn: (ev: StructuralObserverEvents) => void): void;
	/** Tell the store that a component's row ticks changed outside the dirty
	 * list, so the next entity-level drain scans the plane. A consumer that
	 * stamps a whole archetype at once calls it, because no dirty list saw
	 * those rows. */
	noteScan(componentId: number): void;
	isAlive(id: EntityID): boolean;
	isDisabled(id: EntityID): boolean;
	hasComponent(entityId: EntityID, def: ComponentHandle): boolean;
}
