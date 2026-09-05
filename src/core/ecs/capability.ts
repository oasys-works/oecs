/***
 * Capability. An optional subsystem a world installs at construction.
 *
 * Relations, events, snapshots and observers are not part of every world. Each
 * one is a capability: a module that builds its own service, wires it into the
 * store through a narrow seam, and hands back the facade it adds to the world.
 *
 * The world core never imports a capability module. That is the whole point. A
 * class method cannot be removed by a bundler, so while `ECS` declared
 * `relations` and `snapshots` as members, every program shipped the relation
 * and snapshot code whether or not it named them. A capability that the
 * construction site imports is a reference the bundler can follow, and one it
 * can drop.
 *
 * The type side follows the same rule. `ECS.create` returns the world
 * intersected with the facades its plugins contribute, so a world that
 * installed no relation capability has no `relations` member to reach for, and
 * the mistake is a compile error rather than a fault at run time.
 *
 * Cold path throughout. A capability is installed once, at construction.
 ***/

import type { Store } from "./store";
import type { SystemContext } from "./system_context";
import type { ObserverRegistry } from "./observer";
import { ECSError, ECS_ERROR } from "./utils/error";

/** An optional subsystem, and the facade surface it contributes.
 *
 * `install` receives the store because that is where the seams live: a
 * capability builds its service from a host record the store hands out, gives
 * the service back through an install method, and returns its facade.
 *
 * `out X` (declared covariance) is what lets a plugin list be typed
 * `readonly Capability<object>[]`: `X` appears only in `install`'s return, so
 * covariance is the honest direction and a concrete capability is usable where
 * any capability is expected. Left unannotated, the compiler measures `X` from
 * the whole interface and the list bound rejects every real plugin. */
export interface CapabilityHost {
	/** Where the subsystem seams live. A capability builds its service from a
	 * host record the store hands out, and gives the service back through an
	 * install method. */
	readonly store: Store;
	/** The one system context an observer callback receives, shared with the
	 * schedule so an observer sees the same access span a system does. */
	readonly context: SystemContext;
	/** Hand the world its observer registry. The world drives it once per
	 * update and at startup, so it holds the reference, not the store. */
	installObservers(registry: ObserverRegistry): void;
}

export interface Capability<out X extends object> {
	/** Names the capability in a `CAPABILITY_NOT_INSTALLED` fault. Matches the
	 * published subpath, so the message can name the import that fixes it. */
	readonly name: string;
	install(host: CapabilityHost): X;
}

/** The facade surface of one capability, or `never` for a non-capability. */
type SurfaceOf<E> = E extends Capability<infer X> ? X : never;

/** Turn a union into an intersection. A plugin list is a tuple, so its element
 * type is the union of the capabilities in it, and a world carries all of them
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
// which does not satisfy the `Caps` bound on `ECS`. An empty plugin list must
// mean "no extra surface", not "unknown surface".
export type CapsOf<P extends readonly unknown[]> = UnionToIntersection<SurfaceOf<P[number]>> &
	object;

/** A host for a bare `Store`, with no world around it.
 *
 * Every capability that only needs store seams installs through this, which is
 * what a test driving a raw store uses. The two world-level members throw:
 * a bare store has no system context and nowhere to keep an observer registry,
 * so reaching for them is a mistake worth naming rather than a case to
 * silently support. */
export function storeOnlyHost(store: Store): CapabilityHost {
	return {
		store,
		get context(): SystemContext {
			throw new ECSError(
				ECS_ERROR.CAPABILITY_NOT_INSTALLED,
				"this capability needs a world, and it was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [...] }) instead"
			);
		},
		installObservers(): void {
			throw new ECSError(
				ECS_ERROR.CAPABILITY_NOT_INSTALLED,
				"observers need a world, and this capability was installed on a bare store. " +
					"Build the world with ECS.create({ plugins: [observers()] }) instead"
			);
		}
	};
}
