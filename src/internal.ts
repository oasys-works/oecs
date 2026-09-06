/**
 * # oecs/internal, unstable tooling surface
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

// ECS memory sizing internals, `resolveECSMemory` inspects what an
// `ECSOptions.memory` intent resolves to without constructing an ECS. The
// constants document the budget arm's derivation inputs.
export {
	resolveECSMemory,
	DEFAULT_ECS_CAP_BYTES,
	WASM_STORE_BASE_BYTES,
	BUDGET_GROWTH_HEADROOM,
	BUDGET_DEFAULT_BYTES_PER_ENTITY,
	BUDGET_DEFAULT_ARCHETYPES
} from "./core/ecs";
export type { ResolvedECSMemory, ECSMemoryCapContext } from "./core/ecs";

// Access check, dev-mode validation singleton.
export { accessCheck } from "./core/ecs";

// Dispatch trace (dev-mode only, gated by DEV + VISUAL_INTEL_TRACE).
// The per-world causal tracer (`FrameTraceRecorder`) is public, at the root.
export { dispatchTrace, type DispatchTraceSnapshot, type DispatchTraceEntry } from "./core/ecs";

// SAB command-ring transport, the wire and ABI half of the host→ECS write
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

// Packed-EntityID codec + bounds, for consumers that
// mint or bounds-check handles outside the normal `spawn` paths:
// snapshot and replication decode (paired with the root's `getEntityIndex`) and
// adversarial harnesses forging an out-of-range, a retired or a stale handle.
// `createEntityId` does no aliveness check, the generational guard stays the
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

// The plugin host for a bare `Store`, with no world around it. A test or a
// tool driving a raw store installs a store-only plugin through this. The
// two world-level members throw, because a bare store has neither.
export { storeOnlyHost } from "./core/ecs";

// The modules a plugin bundle binds to instead of copying.
//
// Each plugin ships in its own rollup graph. A module it reaches is
// compiled into it a second time. The build marks the module external to stop
// that. A second copy of a class breaks `instanceof`. A second copy of a
// registry holds none of what the core put in it. The build resolves such a
// module to one package entry. That entry has to export the module's whole
// list, which is why every name below is here. `scripts/core_boundary.ts` holds
// the mapping and fails the build on a name this entry does not carry.

// The two plugin faults. The error classes a consumer catches are at the
// package root, and these build one of them.
export {
	pluginMissingError,
	pluginInstalledTwiceError
} from "./core/ecs/utils/plugin_error";

// Component debug names, one registry per program. `registerComponent` writes
// it and a dev-mode diagnostic reads it, so an observer message can name a
// component the core registered.
export { setComponentDebugName, componentDebugName, componentLabel } from "./core/ecs/debug_names";
