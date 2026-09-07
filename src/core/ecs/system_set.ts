/***
 * System set and ordering vocabulary. What a caller writes into `addSystems`
 * and `configureSet`.
 *
 * This file owns the `SystemSet` handle, the entry and ordering records, and
 * the one predicate that tells a set apart from a system descriptor. It owns
 * no state and no lookup. The schedule holds the tables that read these
 * records, `_conditionsBySet` and `_orderingBySet`, and `schedule_plan.ts`
 * expands the ordering into edges.
 *
 * It is separate from `system.ts` because that file owns what a system *is*,
 * its id, its access declaration and its descriptor, and this file owns how
 * several systems are grouped and ordered against each other. A set never
 * reaches the store, so it needs none of the access typing.
 ***/

import type { RunCondition } from "./run_condition";
import type { SystemDescriptor } from "./system";

/**
 * An opaque handle for a named group of systems. A set carries a shared
 * run condition and shared ordering that every member inherits. Sets are
 * identified by **object identity**, not by name, create one with
 * `systemSet(name)`, hold the handle, and reuse it across `addSystems`
 * (`SystemEntry.set`) and `Schedule.configureSet`. The `name` is for
 * diagnostics only.
 */
export interface SystemSet {
	readonly name: string;
}

/** Create a `SystemSet` handle. Two calls with the same name are two
 * distinct sets, keep the returned handle and pass it around. */
export function systemSet(name: string): SystemSet {
	return Object.freeze({ name });
}

/** A `before` and `after` ordering target: either a concrete system or a whole set
 * (expanded to its members within the same phase at sort time). */
export type SystemOrderingTarget = SystemDescriptor | SystemSet;

/** Shared configuration applied to a `SystemSet` via `configureSet`.
 * Accumulates across calls, conditions and together, ordering targets union. */
export interface SystemSetConfig {
	/** Condition(s) every member is gated by (ANDed with each member's own). */
	runIf?: RunCondition | readonly RunCondition[];
	/** Every member runs before each of these targets. */
	before?: readonly SystemOrderingTarget[];
	/** Every member runs after each of these targets. */
	after?: readonly SystemOrderingTarget[];
}

export interface SystemOrdering {
	before?: readonly SystemOrderingTarget[];
	after?: readonly SystemOrderingTarget[];
}

export interface SystemEntry {
	system: SystemDescriptor;
	ordering?: SystemOrdering;
	/** Run condition(s) gating only this system. ANDed with any set conditions
	 * it inherits. A `false` verdict skips the body that tick. */
	runIf?: RunCondition | readonly RunCondition[];
	/** Set membership, the system inherits each set's shared condition and
	 * ordering. */
	set?: SystemSet | readonly SystemSet[];
}

/** A `SystemOrderingTarget` is a set iff it is not a system descriptor. A
 * descriptor always carries `fn` (its update function), a set never does. */
export function isSystemSet(target: SystemOrderingTarget): target is SystemSet {
	return !("fn" in target);
}
