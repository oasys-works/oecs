/***
 * Plugin. An optional subsystem a world installs at construction.
 *
 * Relations, events, snapshots and observers are not part of every world. Each
 * one is a plugin: a module that builds its own service, wires it into the
 * store through a narrow seam, and hands back the facade it adds to the world.
 *
 * The world core never imports a plugin module. That is the whole point. A
 * class method cannot be removed by a bundler, so while `ECS` declared
 * `relations` and `snapshots` as members, every program shipped the relation
 * and snapshot code whether or not it named them. A plugin that the
 * construction site imports is a reference the bundler can follow, and one it
 * can drop.
 *
 * The type side follows the same rule. `ECS.create` returns the world
 * intersected with the facades its plugins contribute, so a world that
 * installed no relation plugin has no `relations` member to reach for, and
 * the mistake is a compile error rather than a fault at run time.
 *
 * The change feed is the one seam several plugins share. `ChangeFeed`
 * below names it. `Store` implements it, so the host hands the store itself,
 * typed narrowly, and the narrowing costs nothing at run time.
 *
 * Cold path throughout. A plugin is installed once, at construction.
 ***/

import type { ArchetypeView } from "./archetype";
import type { ComponentHandle } from "./component";
import type { EntityID } from "./entity";
import type { DrainResult, ObservationFlags, StructuralObserverEvents, Store } from "./store";
import type { SystemContext } from "./system_context";
import type { ECS } from "./ecs";
import type { ObserverRegistry } from "./observer";
import type { ParallelRoute } from "./schedule";
import type { SystemConfig } from "./system";
import { ECSError, ECS_ERROR } from "./utils/error";

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
	isAlive(id: EntityID): boolean;
	isDisabled(id: EntityID): boolean;
	hasComponent(entityId: EntityID, def: ComponentHandle): boolean;
}

/** What the world calls into a worker pool it did not build.
 *
 * Both hooks are cold. `plan` runs at registration, and only for a system that
 * declares `parallel`. `dispose` runs once, with the world. */
export interface WorkerHooks {
	/** Build what one parallel dispatch reads. The world freezes the result
	 * onto the descriptor as `parallelPlan` and never looks inside it, so the
	 * plan's shape belongs to the plugin. The plugin also validates the
	 * `parallel` config here, which is why a world without the plugin
	 * validates none. */
	plan(config: SystemConfig): object;
	/** Stop the workers. A live worker holds the store bytes and keeps the
	 * process alive, so it ends with the world. */
	dispose(): void;
}

/** What a worker pool reads from the world it runs on.
 *
 * The bytes, where the header sits inside them, and the one call that routes
 * every parallel system. Nothing else crosses. The pool derives its own row
 * ranges from the published row counts, so the world hands it no plan and no
 * archetype. */
export interface WorkerWorld {
	/** The bytes a worker reaches: the `WebAssembly.Memory` on the wasm
	 * backing, the `SharedArrayBuffer` on the shared backing, `null` on any
	 * other. The memory travels and not its current buffer, because the two
	 * grow differently and a worker survives both. Read at attach. */
	readonly backing: SharedArrayBuffer | WebAssembly.Memory | null;
	/** What `memory.backing` resolved to. The refusal on a backing no worker
	 * can reach names it. */
	readonly backingSource: string;
	/** The byte offset of the store header inside the backing. */
	readonly storeBase: number;
	/** Tell the store that a component's row ticks changed outside the dirty
	 * list, so the next entity-level drain scans the plane. A pool stamps a
	 * whole archetype at the join, which no dirty list saw. */
	noteScan(componentId: number): void;
	/** Route every parallel system through `pool`, or with `null` back to the
	 * sequential body. */
	route(pool: ParallelRoute | null): void;
}

/** An optional subsystem, and the facade surface it contributes.
 *
 * `install` receives the store because that is where the seams live: a
 * plugin builds its service from a host record the store hands out, gives
 * the service back through an install method, and returns its facade.
 *
 * `out X` (declared covariance) is what lets a plugin list be typed
 * `readonly Plugin<object>[]`: `X` appears only in `install`'s return, so
 * covariance is the honest direction and a concrete plugin is usable where
 * any plugin is expected. Left unannotated, the compiler measures `X` from
 * the whole interface and the list bound rejects every real plugin. */
export interface PluginHost {
	/** Where the subsystem seams live. A plugin builds its service from a
	 * host record the store hands out, and gives the service back through an
	 * install method. */
	readonly store: Store;
	/** The bare world, for a plugin that registers a system, reads a
	 * field, builds a cursor or reaches a resource. It carries no facade of
	 * any plugin, including the one installing. */
	readonly world: ECS;
	/** The store's change feed, typed to what a consumer of it may touch. */
	readonly changes: ChangeFeed;
	/** The one system context an observer callback receives, shared with the
	 * schedule so an observer sees the same access span a system does. */
	readonly context: SystemContext;
	/** Run `fn` at the tail of every `update()`, after every system of the
	 * frame. `run` is the change tick of the detection point, above every
	 * stamp the frame made. Hooks run in install order. */
	onSettle(fn: (run: number) => void): void;
	/** Hand the world its observer registry. The world drives it once per
	 * update and at startup, so it holds the reference, not the store. */
	installObservers(registry: ObserverRegistry): void;
	/** Hand the world the hooks a worker pool needs, and take back what the
	 * pool reads. One call, because the two directions install together and a
	 * world holds one pool. */
	installWorkers(hooks: WorkerHooks): WorkerWorld;
}

export interface Plugin<out X extends object> {
	/** Names the plugin in a `PLUGIN_NOT_INSTALLED` fault. Matches the
	 * published subpath, so the message can name the import that fixes it. */
	readonly name: string;
	/** The plugins this one reads through, by name. `ECS.create` walks
	 * the plugin list in order, so a dependency has to come first in the list,
	 * and a missing one is a fault at construction. */
	readonly requires?: readonly string[];
	install(host: PluginHost): X;
}

/** The facade surface of one plugin, or `never` for a non-plugin. */
type SurfaceOf<E> = E extends Plugin<infer X> ? X : never;

/** Turn a union into an intersection. A plugin list is a tuple, so its element
 * type is the union of the plugins in it, and a world carries all of them
 * at once. The inference site is contravariant, which is what performs the
 * conversion. */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
	k: infer I
) => void
	? I
	: never;

/** The combined facade surface of a plugin list. `ECS.create` intersects this
 * with the world, so `ecs.relations` exists exactly when `relations()` is in
 * the list. */
// `& object` clamps the empty case: `UnionToIntersection<never>` is `unknown`,
// which does not satisfy the `Plugins` bound on `ECS`. An empty plugin list must
// mean "no extra surface", not "unknown surface".
export type PluginsOf<P extends readonly unknown[]> = UnionToIntersection<SurfaceOf<P[number]>> &
	object;

/** A host for a bare `Store`, with no world around it.
 *
 * Every plugin that only needs store seams installs through this, which is
 * what a test driving a raw store uses. `store` and `changes` are both the
 * store, so the change feed works here. Every world-level member throws: a
 * bare store has no world, no system context, no schedule tail and nowhere to
 * keep an observer registry, so reaching for one is a mistake worth naming
 * rather than a case to silently support. */
export function storeOnlyHost(store: Store): PluginHost {
	return {
		store,
		changes: store,
		get world(): ECS {
			throw new ECSError(
				ECS_ERROR.PLUGIN_NOT_INSTALLED,
				"this plugin needs a world, and it was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [...] }) instead"
			);
		},
		onSettle(): void {
			throw new ECSError(
				ECS_ERROR.PLUGIN_NOT_INSTALLED,
				"a settle hook needs a world, and this plugin was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [...] }) instead"
			);
		},
		get context(): SystemContext {
			throw new ECSError(
				ECS_ERROR.PLUGIN_NOT_INSTALLED,
				"this plugin needs a world, and it was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [...] }) instead"
			);
		},
		installObservers(): void {
			throw new ECSError(
				ECS_ERROR.PLUGIN_NOT_INSTALLED,
				"observers need a world, and this plugin was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [observers()] }) instead"
			);
		},
		installWorkers(): WorkerWorld {
			throw new ECSError(
				ECS_ERROR.PLUGIN_NOT_INSTALLED,
				"workers need a world, and this plugin was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [workers()] }) instead"
			);
		}
	};
}
