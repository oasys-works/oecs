/**
 * # oecs/internal — unstable tooling surface
 *
 * Codecs, ABI constants, memory inspectors, and dev-mode singletons, exported
 * for tests, tooling, and advanced integrations (replication decode,
 * cross-thread transports, adversarial harnesses).
 *
 * **No semver guarantees.** Anything here may change or disappear in any
 * release. The supported application surface is the package root.
 *
 * @module oecs/internal
 */

// ECS memory sizing internals (#682) — `resolveECSMemory` inspects what an
// `ECSOptions.memory` intent resolves to without constructing an ECS; the
// constants document the budget arm's derivation inputs.
export {
	resolveECSMemory,
	DEFAULT_ECS_CAP_BYTES,
	BUDGET_GROWTH_HEADROOM,
	BUDGET_DEFAULT_BYTES_PER_ENTITY,
	BUDGET_DEFAULT_ARCHETYPES
} from "./core/ecs";
export type { ResolvedECSMemory, ECSMemoryCapContext } from "./core/ecs";

// Access check (Phase B of issue #213) — dev-mode validation singleton.
export { accessCheck } from "./core/ecs";

// Dispatch trace (dev-mode only — gated by DEV + VISUAL_INTEL_TRACE).
// The per-world causal tracer (`FrameTraceRecorder`) is public, at the root.
export { dispatchTrace, type DispatchTraceSnapshot, type DispatchTraceEntry } from "./core/ecs";

// SAB command-ring transport (#700) — the wire/ABI half of the host→ECS write
// seam: a `HostCommandDispatcher` + `ring*Codec` decode cross-thread bytes
// into the same `applyHostCommand` the in-process queue uses. Byte layouts
// are engine ABI, not consumer contract.
export {
	HostCommandDispatcher,
	ringSetFieldCodec,
	ringDespawnCodec,
	ringDisableCodec,
	ringEnableCodec,
	ringRemoveComponentCodec,
	HOST_COMMAND_PAYLOAD_BYTES
} from "./core/ecs";
export type { RingCommandApplier } from "./core/ecs";

// Packed-EntityID codec + bounds (#723 / #778 / #781) — for consumers that
// mint or bounds-check handles outside the normal `spawn` paths:
// snapshot / replication decode (paired with the root's `getEntityIndex`) and
// adversarial harnesses forging out-of-range / retired / stale handles.
// `createEntityId` does no aliveness check — the generational guard stays the
// caller's job.
export {
	createEntityId,
	getEntityGeneration,
	MAX_INDEX,
	MAX_GENERATION,
	MAX_LIVE_GENERATION,
	RETIRED_GENERATION,
	MAX_ENTITY_ID
} from "./core/ecs";
