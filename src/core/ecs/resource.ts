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

/**
 * `T` is deliberately INVARIANT (via the function-typed phantom — an `in out`
 * annotation is not legal on an intersection alias, so the structure carries
 * the variance): a key is used for both reads (`resource`, covariant) and
 * writes (`setResource`, contravariant), so either one-sided variance is a
 * soundness hole — a covariant `T` let `ResourceKey<Cat>` widen to
 * `ResourceKey<Animal>` and `setResource` then stored a `Dog` behind a `Cat`
 * key. Invariance also makes keys with different `T` mutually unassignable,
 * which is what the typed system seam's `resourceReads`/`resourceWrites`
 * narrowing keys on (§typestate). Schema-erased positions (access checks,
 * declaration lists) must use `ResourceKey<any>` — `ResourceKey<unknown>` no
 * longer erases.
 */
export type ResourceKey<T> = symbol & { readonly __phantom: (value: T) => T };

export function resourceKey<T>(name: string): ResourceKey<T> {
	return unsafeCast<ResourceKey<T>>(Symbol(name));
}

/** Recover a key's value type: `ResourceValueOf<typeof TimeRes>` is the Time
 * shape. The typed `SystemContext` resource surface infers the KEY type (to
 * check it against the declared-access union) and recovers `T` through this,
 * instead of taking `ResourceKey<T>` directly. */
export type ResourceValueOf<K> = K extends ResourceKey<infer T> ? T : never;
