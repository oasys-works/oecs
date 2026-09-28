/***
 * Plugin. An optional subsystem a world installs at construction.
 *
 * Relations, events, snapshots, observers, workers and solid are not part of
 * every world. Each one is a plugin: a module that builds its own service,
 * wires it into the store through a narrow seam, and hands back the facade it
 * adds to the world.
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
 * The change feed is the one seam several plugins share. `change_feed.ts`
 * names it. `Store` implements it, so the host hands the store itself,
 * typed narrowly, and the narrowing costs nothing at run time.
 *
 * `src/plugins` holds every first-party plugin, and the core imports none of
 * them. `src/core/ecs/relation.ts`, `event.ts`, `observer.ts` and
 * `snapshot.ts` hold the seam each one implements: the handle types the core
 * spells, and the interface the plugin's service satisfies.
 *
 * **What a plugin outside this package gets.** Every member of `PluginHost` is
 * open to anyone: `store`, `world`, `changes`, `context`, `memory`,
 * `onSettle`, `onPrewarm`, `onDispose`, `installRoute` and `registerStorage`.
 * A plugin registers its own components, systems and phases through `world`,
 * drains the change feed through `changes`, and publishes at the tail of
 * `update()` through `onSettle`. A plugin hands a store it keeps per entity to
 * `registerStorage`. `third_party_plugin.test.ts` and
 * `third_party_storage.test.ts` prove the seams from outside the package.
 *
 * Every hook point below is named for what it hooks, never for the plugin
 * that ships it. `onSettle` takes the tail of a frame, `onPrewarm` contributes
 * the access shapes the archetype closure reads, `onDispose` runs with the
 * world, and `installRoute` replaces the body of a system the route claims.
 * Anyone may implement any of them.
 *
 * One thing stays a single typed slot rather than a keyed registry: the system
 * dispatch route. The schedule hoists it per phase and reads one opaque plan
 * per dispatch, and a keyed read on that path is far slower on a schedule of
 * short bodies. The registration is keyed and cold, and the world caches what
 * it resolved into the field the dispatch already read, so the hot path is
 * unchanged by construction.
 *
 * Cold path throughout. A plugin is installed once, at construction.
 ***/

import type { Store } from "./store";
// The feed itself is a leaf, so a plugin and the store can name it without
// naming this file.
import type { ChangeFeed } from "./change_feed";
export type { ChangeFeed } from "./change_feed";
import type { SystemContext } from "./system_context";
import type { ECS } from "./ecs";
import type { RouteDispatch } from "./schedule";
import type { SystemConfig, SystemDescriptor } from "./system";
import type { StorageProvider } from "./storage_provider";
export type { StorageProvider, StorageHashFold } from "./storage_provider";
import { ECSError, ECS_ERROR } from "./utils/error";

/** How a plugin claims the body of a system, and builds what one dispatch of
 * it reads.
 *
 * The world asks the planner about every system it registers. A planner that
 * has nothing to say about one answers `undefined`, and the system keeps its
 * `fn`. Cold: registration only. */
export interface SystemRoutePlanner {
	/** Build what one routed dispatch reads, or `undefined` for a system this
	 * route does not claim. The world freezes the result onto the descriptor as
	 * `routePlan` and never looks inside it, so the plan's shape belongs to the
	 * plugin. The plugin validates its own config here, which is why a world
	 * without the plugin validates none. */
	plan(config: SystemConfig): object | undefined;
}

/** What a route holds back from the world after it installs.
 *
 * One call, and the world holds one route. `null` puts every claimed system
 * back on its own `fn`. Cold: an attach and a detach, never a frame. */
export interface RouteControl {
	route(dispatch: RouteDispatch | null): void;
}

/** Where the world's bytes are, for a plugin that reads them directly.
 *
 * A worker, a compute backend and a wasm module all need the same three
 * facts. The memory travels and not its current buffer, because the two grow
 * differently and a reader survives both. */
export interface PluginMemory {
	/** The bytes a foreign reader reaches: the `WebAssembly.Memory` on the
	 * wasm backing, the `SharedArrayBuffer` on the shared backing, `null` on
	 * any other. */
	readonly backing: SharedArrayBuffer | WebAssembly.Memory | null;
	/** What `memory.backing` resolved to. A refusal on a backing the reader
	 * cannot reach names it. */
	readonly backingSource: string;
	/** The byte offset of the store header inside the backing. */
	readonly storeBase: number;
}

/** What one plugin may reach during `install`, and nothing wider.
 *
 * The world hands this record out once, at construction. A member that a bare
 * store cannot answer is a method and not a field, so `storeOnlyHost` below
 * can throw on the ones a store has no answer for. */
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
	/** Contribute the access shapes `startup()` folds into the archetype
	 * closure, so a callback that spawns or transitions gets its target
	 * archetype planted rather than first-touched mid-tick. Read once, at
	 * startup. */
	onPrewarm(fn: () => readonly SystemDescriptor[]): void;
	/** Run `fn` when the world goes away. A plugin that holds a thread, a
	 * timer or a socket ends it here. Hooks run in install order. */
	onDispose(fn: () => void): void;
	/** Where the world's bytes are. A plugin that hands the bytes to a worker
	 * or to a wasm module reads the three facts here. */
	readonly memory: PluginMemory;
	/** Claim the body of the systems this plugin routes, and take back the one
	 * call that turns the route on and off. A world holds one route, so a
	 * second install is a fault. */
	installRoute(planner: SystemRoutePlanner): RouteControl;
	/** Add a store this plugin owns to the destroy purge, `stateHash` and the
	 * world snapshot. Cold. */
	registerStorage(provider: StorageProvider): void;
}

/** An optional subsystem, and the facade surface it contributes.
 *
 * `install` receives the host because that is where the seams live: a plugin
 * builds its service from a host record the store hands out, gives the service
 * back through an install method, and returns its facade.
 *
 * `out X` (declared covariance) is what lets a plugin list be typed
 * `readonly Plugin<object>[]`: `X` appears only in `install`'s return, so
 * covariance is the honest direction and a concrete plugin is usable where
 * any plugin is expected. Left unannotated, the compiler measures `X` from
 * the whole interface and the list bound rejects every real plugin. */
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

/** The one refusal every world-level hook point shares. Names what the caller
 * reached for, and the call that gives it a world. */
function worldOnly(what: string): ECSError {
	return new ECSError(
		ECS_ERROR.PLUGIN_NOT_INSTALLED,
		`${what} needs a world, and this plugin was installed on a bare store. ` +
			"Build the world with ECS.create({ plugins: [...] }) instead"
	);
}

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
		registerStorage: (provider) => store.registerStorage(provider),
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
		onPrewarm(): void {
			throw worldOnly("a prewarm hook");
		},
		onDispose(): void {
			throw worldOnly("a dispose hook");
		},
		get memory(): PluginMemory {
			throw worldOnly("the world's memory layout");
		},
		installRoute(): RouteControl {
			throw worldOnly("a system dispatch route");
		}
	};
}
