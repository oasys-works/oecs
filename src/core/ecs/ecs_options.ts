/***
 * ECS options and the world's configuration guards.
 *
 * What this file owns: the shape a caller hands `new ECS(...)`, the key set the
 * constructor's typo tripwire reads, and the three validators that refuse a
 * configuration the frame loop cannot survive.
 *
 * What it refuses: any world state. Every function here is pure over its
 * arguments, so it holds no reference to a store, a schedule or a context.
 *
 * Cold path. The constructor calls two of these once per world, and `spawn`
 * calls the third only under a `__DEV__` build. `ecs.ts` keeps the frame loop,
 * so nothing a system runs reaches this module.
 ***/

import type { StoreRegionSpec } from "../store";
import type { Template } from "./store";
import type { ECSMemoryOptions } from "./ecs_memory";
import { ECSError, ECS_ERROR } from "./utils/error";

/** Every key `ECSOptions` accepts, the constructor's dev-mode typo tripwire
 * checks unknown keys against this (kept adjacent so additions stay in sync). */
export const ECS_OPTION_KEYS: ReadonlySet<string> = new Set([
	"fixedTimestep",
	"maxFixedSteps",
	"onWarn",
	"memory",
	"regions",
	"bindingsRegionBytes",
	"deterministic",
	// `ECS.create` forwards its whole options record to the constructor, and
	// the plugin list rides in it.
	"plugins"
]);

export interface ECSOptions {
	fixedTimestep?: number;
	maxFixedSteps?: number;
	/** Sink for dev-mode engine diagnostics (currently the schedule's
	 * dropped-ordering-edge warning). Defaults to `console.warn`. Mirrors the
	 * `FrameTraceSink` seam's injectable style, no global logger. */
	onWarn?: (message: string) => void;
	/** How the world's memory is sized and backed. Two independent axes, two
	 * independent fields, every combination of them is legal.
	 *
	 * How big: `entities` (with optional `archetypes` and `bytesPerEntity` to
	 * shape the derivation) or `maxBytes`, or both. Give both when you know
	 * both: the count sizes the columns and the entity index, the cap is yours.
	 *
	 * What backs it: `backing`, `"heap"` (default, a plain fixed ArrayBuffer),
	 * `"shared"` (a SharedArrayBuffer, for worker offload or a WASM backend),
	 * `{ wasm }` (the buffer is a WebAssembly.Memory) or `{ allocator }` (the
	 * expert escape hatch, in-place-typed).
	 *
	 * `columnCapacity` pins the rows per archetype column on any combination.
	 * Omitted ⇒ heap backing, a fixed 256 MiB reservation and 1024-row columns.
	 * The resolved plan is exposed as `ECS.memoryPlan`. */
	memory?: ECSMemoryOptions;
	/** Consumer-declared SAB regions, forwarded to `Store`. Each
	 * `StoreRegionSpec` carries an opaque `region_id`, a precomputed byte size,
	 * and an `init` closure. The engine lays them out generically and exposes
	 * them through `regionHandle(id)` and `regionOffset(id)`. A consumer
	 * supplies the specs. The engine ships no region of its own. Replaces the
	 * eight game-named region options
	 * (`terrain_map_radius`, `spatial_grid_*`, `army_*`, `flow_field_*`,
	 * `actionRingCapacitySlots`) the ECS used to carry. */
	regions?: readonly StoreRegionSpec[];
	/** Byte size of the opt-in bindings region, forwarded to `Store`.
	 * A consumer that attaches a WASM `ComputeBackend` passes its own size,
	 * computed from its own binding manifest, so the host can publish the
	 * `(component_id, field_id)` ids the accelerated systems read. Omitted or
	 * 0 ⇒ no region, and a pure-TS world pays
	 * nothing for the WASM seam. The size is a runtime input, not an engine ABI
	 * constant. It is de-welded from the generated ABI. */
	bindingsRegionBytes?: number;
	/** Opt into the **determinism surface**, forwarded to
	 * `Store`. Default `false`. When `false`, the canonical-ordering methods
	 * (`stateHash`, `snapshotSparse`, `restoreSparse`) throw
	 * `DETERMINISM_DISABLED`. When `true`, today's replay and hash behavior is
	 * reproduced bit-for-bit. Determinism is the implementer's choice. A host
	 * that verifies a replay opts in. A host that rolls back with diffs, and
	 * never re-runs the frame, leaves it off. The flag gates only that
	 * surface: memory-safety
	 * invariants (the in-place SAB allocator) and the `enabled_count`
	 * partition are always-on regardless. */
	deterministic?: boolean;
}

/** The fixed-timestep drives the `while (accumulator >= dt)` catch-up loop in
 * `update()`. A non-positive `dt` makes that loop non-terminating (the
 * accumulator never decreases), and a non-finite `dt` poisons `fixedAlpha`,
 * so reject both at the configuration boundary rather than hanging mid-tick. */
export function validateFixedTimestep(value: number): number {
	if (!(value > 0) || !Number.isFinite(value)) {
		throw new ECSError(
			ECS_ERROR.INVALID_FIXED_TIMESTEP,
			`fixedTimestep must be a finite number > 0, got ${value}`
		);
	}
	return value;
}

/** The spiral-of-death clamp in `update()` is `maxAcc = maxFixedSteps *
 * fixedTimestep; if (accumulator > maxAcc) accumulator = maxAcc`. A non-finite
 * `maxFixedSteps` makes `maxAcc` non-finite so the clamp never fires and a large
 * `dt` runs `while (accumulator >= fixedTimestep)` unboundedly, the exact hang
 * the clamp exists to prevent. A `0` clamps the accumulator to 0, so no fixed
 * system runs. Validate it as a finite integer ≥ 1, the way `fixedTimestep` is. */
export function validateMaxFixedSteps(value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new ECSError(
			ECS_ERROR.INVALID_MAX_FIXED_STEPS,
			`maxFixedSteps must be an integer >= 1, got ${value}`
		);
	}
	return value;
}

/**
 * DEV-only: reject a value that is not a template.
 *
 * `spawn` and `spawnMany` take a template from `ECS.template(...)`. Two
 * mistakes are usual. The caller gives a component definition (`ecs.spawn(Pos)`).
 * Or the caller gives a bundle (`ecs.spawn(Pos({ x: 0 }))`). The types reject
 * both. An untyped call site does not.
 *
 * Without this check the value goes to the store. The store then reads
 * `template.archetypeId`, which is `undefined`. The failure is a `TypeError`
 * about `materializesRows`, from a frame deep in the store. That error names
 * the wrong place, and it does not tell the caller what to do.
 *
 * A template is a plain object with a numeric `archetypeId`. A component
 * definition is a function. A bundle is an object with `values` and no
 * `archetypeId`. The test below separates all three, and it names the
 * alternative for each one.
 */
export function assertTemplate(value: unknown, op: string): void {
	if (typeof value === "object" && value !== null && typeof (value as Template).archetypeId === "number") {
		return;
	}
	const isDef = typeof value === "function";
	const isBundle =
		typeof value === "object" && value !== null && "values" in (value as Record<string, unknown>);
	const got = isDef
		? "a component definition"
		: isBundle
			? "a bundle"
			: Array.isArray(value)
				? "an array"
				: `a ${typeof value}`;
	const fix =
		isDef || isBundle
			? `Use \`ecs.spawnBundle(...)\` for components with no template, or build a template first with \`ecs.template(Pos({ x: 0 }), Vel)\`.`
			: Array.isArray(value)
				? `\`ecs.template\` takes callable bundles, not an array of entries. Write \`ecs.template(Pos({ x: 0 }), Vel)\`.`
				: `Build the template with \`ecs.template(...)\` first.`;
	throw new ECSError(
		ECS_ERROR.INVALID_TEMPLATE,
		`${op}: expected a template from ecs.template(...), but got ${got}. ${fix}`,
		{ op, got }
	);
}
