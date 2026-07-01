/***
 * Resource — Typed singleton key-value storage.
 *
 * Resources are global singletons that don't belong to any entity.
 * Think: time, input state, camera config, game settings.
 *
 * Each resource is identified by a unique symbol (ResourceKey<T>) and
 * stores an arbitrary typed value. The key carries the value type as a
 * phantom type parameter, so reads are type-safe at compile time.
 *
 * Lifecycle (#798). A resource is register-once *until removed*: a second
 * `registerResource` for a live key throws RESOURCE_ALREADY_REGISTERED, but
 * `removeResource(key)` drops it (failing closed on a missing key) and frees the
 * key to be registered again — the present → absent → present axis. Removal is
 * access-checked as a *write* (a system must declare the key in `resourceWrites`),
 * and resources stay out of `stateHash` and snapshot/resume regardless, so a
 * lifecycle change never perturbs the determinism hash.
 *
 * Usage:
 *
 *   const TimeRes = resourceKey<{ delta: number; elapsed: number }>("Time");
 *   world.registerResource(TimeRes, { delta: 0, elapsed: 0 });
 *   const time = world.resource(TimeRes);
 *   // time.delta → number, time.elapsed → number
 *   world.removeResource(TimeRes);                             // present → absent
 *   world.registerResource(TimeRes, { delta: 0, elapsed: 0 }); // → present again
 *
 ***/

import { unsafeCast } from "../../type_primitives";

export type ResourceKey<T> = symbol & { readonly __phantom: T };

export function resourceKey<T>(name: string): ResourceKey<T> {
	return unsafeCast<ResourceKey<T>>(Symbol(name));
}
