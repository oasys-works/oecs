/**
 * The published runtime surface, as one checked-in list per entry point.
 *
 * Two tests read this file. `public_api.test.ts` compares it against the
 * sources, and `dist_artifact.test.ts` compares it against the bundle that the
 * package ships. The lists live here so a widening of the surface cannot pass
 * one test and fail the other, and so a rename shows up as one diff.
 *
 * Type-only exports have no runtime presence and are absent. The explicit
 * export lists in `src/index.ts` and `src/internal.ts` are their review surface.
 *
 * Keep both lists sorted. The tests compare against a sorted key list.
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
	"allOf",
	"anyOf",
	"applyHostCommand",
	"bundle",
	"deserializeCommandLog",
	"eventKey",
	"getEntityIndex",
	"installHostCommandSeam",
	"isEcsError",
	"not",
	"registerChildOf",
	"registerIsA",
	"replayCommandLog",
	"resourceKey",
	"runEveryNTicks",
	"runIfAnyMatch",
	"runIfResourceEq",
	"serializeCommandLog",
	"signalKey",
	"spawnEntry",
	"systemSet",
	"uninstallHostCommandSeam"
];

export const INTERNAL_EXPORTS: readonly string[] = [
	"AppError",
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
	"accessCheck",
	"capabilityInstalledTwiceError",
	"capabilityMissingError",
	"componentDebugName",
	"componentLabel",
	"createEntityId",
	"dispatchTrace",
	"getEntityGeneration",
	"resolveECSMemory",
	"ringDespawnCodec",
	"ringDisableCodec",
	"ringEnableCodec",
	"ringRemoveComponentCodec",
	"ringSetFieldCodec",
	"setComponentDebugName",
	"storeOnlyHost"
];
