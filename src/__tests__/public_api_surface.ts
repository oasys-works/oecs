/**
 * The published runtime surface, as one checked-in list per entry point.
 *
 * Two tests read this file. `public_api.test.ts` compares it against the
 * sources, and `dist_artifact.test.ts` compares it against the bundle that the
 * package ships. The lists live here so a widening of the surface cannot pass
 * one test and fail the other, and so a rename shows up as one diff.
 *
 * Type-only exports have no runtime presence and are absent. The explicit
 * export list in each entry file is its review surface.
 *
 * Every published entry has a list here: the root, `/internal`, `/primitives`,
 * `/shared`, `/worker` and one per plugin. A plugin subpath is public API the
 * same way the root is, so a symbol it gains shows up as a diff in review.
 *
 * Keep every list sorted. The tests compare against a sorted key list.
 */

export const ROOT_EXPORTS: readonly string[] = [
	"ANY_RELATION",
	"ChangedQuery",
	"ChunkColumns",
	"Commands",
	"ECS",
	"ECSError",
	"ECSRestoreError",
	"ECS_ERROR",
	"ECS_SNAPSHOT_VERSION",
	"FrameStepper",
	"FrameTraceRecorder",
	"HIERARCHY_UNBOUNDED",
	"HostCommandQueue",
	"HostCommandRecorder",
	"Query",
	"QueryBuilder",
	"SCHEDULE",
	"SabUnavailableError",
	"SparseRestoreError",
	"StoreRestoreError",
	"SystemContext",
	"VERSION",
	"and",
	"applyHostCommand",
	"bundle",
	"deserializeCommandLog",
	"eventKey",
	"getEntityIndex",
	"installHostCommandSeam",
	"isEcsError",
	"not",
	"or",
	"replayCommandLog",
	"resourceKey",
	"runEveryNTicks",
	"runIfAll",
	"runIfAny",
	"runIfAnyMatch",
	"runIfNot",
	"runIfResourceEq",
	"serializeCommandLog",
	"signalKey",
	"spawnEntry",
	"storeBaseAbove",
	"systemSet",
	"uninstallHostCommandSeam"
];

export const INTERNAL_EXPORTS: readonly string[] = [
	"BUDGET_DEFAULT_ARCHETYPES",
	"BUDGET_DEFAULT_BYTES_PER_ENTITY",
	"BUDGET_GROWTH_HEADROOM",
	"DEFAULT_ECS_CAP_BYTES",
	"HOST_COMMAND_PAYLOAD_BYTES",
	"HostCommandDispatcher",
	"MAX_ENTITY_ID",
	"MAX_GENERATION",
	"MAX_INDEX",
	"MAX_LIVE_GENERATION",
	"RETIRED_GENERATION",
	"WASM_STORE_BASE_BYTES",
	"accessCheck",
	"componentDebugName",
	"componentLabel",
	"createEntityId",
	"dispatchTrace",
	"getEntityGeneration",
	"pluginInstalledTwiceError",
	"pluginMissingError",
	"resolveECSMemory",
	"ringDespawnCodec",
	"ringDisableCodec",
	"ringEnableCodec",
	"ringRemoveComponentCodec",
	"ringSetFieldCodec",
	"setComponentDebugName",
	"storeOnlyHost"
];

/** `@oasys/oecs/primitives`, the data structures the engine is built on. */
export const PRIMITIVES_EXPORTS: readonly string[] = [
	"BinaryHeap",
	"BitSet",
	"GrowableFloat32Array",
	"GrowableFloat64Array",
	"GrowableInt16Array",
	"GrowableInt32Array",
	"GrowableInt8Array",
	"GrowableTypedArray",
	"GrowableUint16Array",
	"GrowableUint32Array",
	"GrowableUint8Array",
	"SparseMap",
	"SparseSet",
	"topologicalSort"
];

/** `@oasys/oecs/shared`, the allocators of the shared and WASM backings. */
export const SHARED_EXPORTS: readonly string[] = [
	"DEFAULT_SAB_ALLOCATOR",
	"SabUnavailableError",
	"fixedSabAllocator",
	"growableSabAllocator",
	"wasmMemoryAllocator"
];

/** `@oasys/oecs/worker` starts the worker loop on import and exports nothing.
 * A symbol here would ship in every worker bundle, so the list stays empty. */
export const WORKER_EXPORTS: readonly string[] = [];

/** One list per plugin, keyed by the plugin name, which is also its subpath
 * and its emitted file under `dist/plugins`. */
export const PLUGIN_EXPORTS: Readonly<Record<string, readonly string[]>> = {
	editor: ["Editor", "TransactionBuilder", "fieldHandle"],
	events: ["ECSEvents", "events"],
	observers: ["ObserverRegistry", "observers"],
	relations: ["ECSRelations", "registerChildOf", "registerIsA", "relations"],
	snapshots: ["ECSSnapshotsFull", "snapshots"],
	solid: ["solid"],
	workers: ["DEFAULT_JOIN_TIMEOUT_MS", "ECSWorkers", "WorkerPool", "workers"]
};
