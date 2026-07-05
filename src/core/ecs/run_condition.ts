/***
 * RunCondition — per-tick gates for scheduled systems (#576, bucket B2 of #542).
 *
 * A run condition is a pure predicate evaluated by the Schedule *before* a
 * system (or every member of a SystemSet) runs in its phase. A `false` verdict
 * skips the system body **and** its deferred-op flush contribution that tick —
 * nothing is enqueued, and the schedule does not advance the system's last-run
 * tick, so a skipped tick is indistinguishable from the system being absent
 * that tick (acceptance: `stateHash` identical to manually removing it).
 *
 * Two hard rules make conditions safe under deterministic lockstep:
 *
 *  1. **Deterministic.** `evaluate` MUST be a pure function of world state — no
 *     wall-clock, no RNG, no external I/O — so a `stateHash` replay reproduces
 *     the same skip decisions on every peer. The built-ins below are all pure:
 *     `runEveryNTicks` keys off the deterministic ECS tick (NOT a private
 *     eval-counter, which would be replication state the digest must carry).
 *
 *  2. **Read-only.** The predicate receives a `ConditionContext` — the read-only
 *     subset of `SystemContext` (`ecsTick` + resource reads) — never the
 *     mutation surface. Component reads are expressed by capturing a `Query` in
 *     the closure (e.g. `runIfAnyMatch`); the query's component defs are
 *     declared on `reads` so `accessCheck` and a future parallel scheduler see
 *     them as read edges. The only access a condition can perform *through* the
 *     context is a resource read, which `accessCheck.enterCondition` validates
 *     against the declared `resourceReads` in `DEV`.
 *
 * Attach a condition to a single system via `SystemEntry.runIf`, or to a whole
 * group via `configureSet(set, { runIf })`; a set member's effective gate is
 * the AND of its own conditions and every set it belongs to (see schedule.ts).
 ***/

import type { ComponentDef } from "./component";
import type { ResourceKey } from "./resource";
import type { Query } from "./query";
import { DEV } from "../../dev_flag";
import { ECSError, ECS_ERROR } from "./utils/error";

/**
 * The read-only slice of `SystemContext` a run condition is handed. Deliberately
 * narrow — a condition can read the ECS tick and resources, but has no path to
 * mutate the world or read component columns directly (component reads go
 * through a captured `Query`). `SystemContext` structurally satisfies this, so
 * the schedule passes the live context unchanged.
 */
export interface ConditionContext {
	/** Current ECS tick — the deterministic clock built-ins key off. */
	readonly ecsTick: number;
	/** Read a resource value (checked against `resourceReads` in `DEV`). */
	resource<T>(key: ResourceKey<T>): T;
	/** Membership probe for a resource — unchecked, mirrors `hasComponent`. */
	hasResource<T>(key: ResourceKey<T>): boolean;
}

/**
 * A per-tick gate. `evaluate` returns `true` to run the gated system(s), `false`
 * to skip them this tick. `reads` / `resourceReads` declare the predicate's
 * read surface for `accessCheck` (dev) and the future parallel scheduler's
 * read-edge graph; both are optional (absent reads as empty).
 */
export interface RunCondition {
	/** Human-readable label, surfaced in dev access-violation diagnostics. */
	readonly name: string;
	/** Pure, deterministic predicate. See the two hard rules in the file header. */
	readonly evaluate: (ctx: ConditionContext) => boolean;
	/** Components the predicate reads (via a captured query). Forward-looking
	 *  metadata — `ConditionContext` exposes no direct column read, so this is
	 *  not runtime-checkable today, but it is the read-edge a parallel scheduler
	 *  will consume. */
	readonly reads?: readonly ComponentDef[];
	/** Resources the predicate reads. Validated at runtime in `DEV` when the
	 *  condition evaluates inside `accessCheck.enterCondition`. */
	readonly resourceReads?: readonly ResourceKey<any>[];
}

/**
 * Run the gated system(s) only while a resource equals `expected` (strict `===`,
 * so reference identity for objects). The canonical "feature flag / game phase"
 * gate — flip `ecs.resources.set(key, …)` and the whole group toggles.
 */
export function runIfResourceEq<T>(key: ResourceKey<T>, expected: T): RunCondition {
	if (DEV && typeof expected === "object" && expected !== null) {
		// `===` is reference identity for objects: unless the caller later sets
		// the resource to THIS exact object, the gate never fires. Usually the
		// intent was a primitive (enum string/number) — warn, don't throw.
		console.warn(
			`runIfResourceEq('${(key as unknown as symbol).description ?? "?"}'): 'expected' is an object — comparison is by reference identity (===), so the gate only fires when the resource is set to this exact instance. Prefer a primitive phase value.`
		);
	}
	return {
		name: `runIfResourceEq(${(key as unknown as symbol).description ?? "?"})`,
		resourceReads: [key],
		evaluate: (ctx) => ctx.resource(key) === expected
	};
}

/**
 * Run the gated system(s) once every `n` ticks — on ticks congruent to `offset`
 * mod `n`. Keyed off the deterministic ECS tick, so it carries no private
 * state and replays bit-identically. `offset` is a **phase shift taken mod `n`**
 * (default `0` ⇒ fires on tick 0, n, 2n, …; `offset` and `offset + n` are the
 * same phase, and a negative offset wraps), normalized once here into `[0, n)`.
 * `n` must be a positive integer and `offset` an integer.
 *
 * The normalization isn't cosmetic: `(ecsTick - offset) % n` with a raw
 * `offset ≥ n` (or negative) leans on JS's signed `%` yielding `-0` for a
 * negative multiple (and `-0 === 0`) to stay congruent — correct, but load-
 * bearing on a quirk. Folding `offset` into `[0, n)` up front makes the phase
 * explicit: the per-tick dividend `ecsTick - phase` may still be negative
 * (when `ecsTick < phase`), but with `phase ∈ [0, n)` it is never a *negative
 * multiple* of `n` — it lands in `[-(n-1), -1]`, which holds no multiple of `n`
 * — so `%` never produces `-0` and the check needs no signed-zero reliance.
 */
export function runEveryNTicks(n: number, offset = 0): RunCondition {
	if (DEV && (!Number.isInteger(n) || n < 1)) {
		throw new ECSError(
			ECS_ERROR.INVALID_RUN_CONDITION,
			`runEveryNTicks: n must be a positive integer, got ${n}`
		);
	}
	if (DEV && !Number.isInteger(offset)) {
		throw new ECSError(
			ECS_ERROR.INVALID_RUN_CONDITION,
			`runEveryNTicks: offset must be an integer, got ${offset}`
		);
	}
	// Fold the phase into [0, n) once at construction (handles offset ≥ n and
	// negative offset); the per-tick check then never relies on signed-zero.
	const phase = ((offset % n) + n) % n;
	return {
		name: `runEveryNTicks(${n}${phase !== 0 ? `, +${phase}` : ""})`,
		evaluate: (ctx) => (ctx.ecsTick - phase) % n === 0
	};
}

/**
 * Run the gated system(s) only when a query matches at least one (enabled)
 * entity — flecs `runIf` over a query. The query is captured at config time;
 * its component defs are declared as `reads`. `count()` is a membership sum over
 * matching archetypes (no column reads), so it trips no `accessCheck` read.
 *
 * The query must be **dense-only**: `entityCount` asserts this in `DEV`
 * (`_assertDenseOnly`), so pass a plain `ecs.query(...)` — a query carrying
 * `.optional(...)` or sparse terms throws. Gate on sparse membership with a
 * custom predicate over `forEachEntity` instead.
 */
export function runIfAnyMatch(query: Query<readonly ComponentDef[]>): RunCondition {
	return {
		name: "runIfAnyMatch",
		reads: query._defs,
		evaluate: () => query.entityCount > 0
	};
}

// ── Combinators (POLISH_AUDIT batch 4) ─────────────────────────────────────
// Compose conditions without hand-rolled closures. Each combinator merges the
// operands' declared read surfaces (`reads` / `resourceReads`) so accessCheck
// and the future parallel scheduler still see every edge, and derives its
// `name` from the operands for legible diagnostics. Evaluation order is the
// argument order, short-circuiting like `&&` / `||` — safe because conditions
// are pure by contract (rule 1 in the file header), so a skipped evaluate has
// no observable effect.

/** Merge the declared read surfaces of composed conditions. */
function mergeDeclares(conds: readonly RunCondition[]): {
	reads?: readonly ComponentDef[];
	resourceReads?: readonly ResourceKey<any>[];
} {
	const reads: ComponentDef[] = [];
	const resourceReads: ResourceKey<any>[] = [];
	for (const c of conds) {
		if (c.reads) reads.push(...c.reads);
		if (c.resourceReads) resourceReads.push(...c.resourceReads);
	}
	return {
		...(reads.length > 0 ? { reads } : {}),
		...(resourceReads.length > 0 ? { resourceReads } : {})
	};
}

/** Invert a condition: run exactly when `cond` would skip. */
export function not(cond: RunCondition): RunCondition {
	return {
		name: `not(${cond.name})`,
		...mergeDeclares([cond]),
		evaluate: (ctx) => !cond.evaluate(ctx)
	};
}

/** Run only when EVERY condition passes (`&&`, short-circuit). */
export function allOf(...conds: RunCondition[]): RunCondition {
	return {
		name: `allOf(${conds.map((c) => c.name).join(", ")})`,
		...mergeDeclares(conds),
		evaluate: (ctx) => conds.every((c) => c.evaluate(ctx))
	};
}

/** Run when ANY condition passes (`||`, short-circuit). */
export function anyOf(...conds: RunCondition[]): RunCondition {
	return {
		name: `anyOf(${conds.map((c) => c.name).join(", ")})`,
		...mergeDeclares(conds),
		evaluate: (ctx) => conds.some((c) => c.evaluate(ctx))
	};
}
