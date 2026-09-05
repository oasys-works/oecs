import { AppError } from "../../../utils/error";

export enum ECS_ERROR {
	EID_MAX_INDEX_OVERFLOW = "EID_MAX_INDEX_OVERFLOW",
	EID_MAX_GEN_OVERFLOW = "EID_MAX_GEN_OVERFLOW",
	COMPONENT_NOT_REGISTERED = "COMPONENT_NOT_REGISTERED",
	COMPONENT_LIMIT_EXCEEDED = "COMPONENT_LIMIT_EXCEEDED",
	ENTITY_NOT_ALIVE = "ENTITY_NOT_ALIVE",
	CIRCULAR_SYSTEM_DEPENDENCY = "CIRCULAR_SYSTEM_DEPENDENCY",
	DUPLICATE_SYSTEM = "DUPLICATE_SYSTEM",
	ARCHETYPE_NOT_FOUND = "ARCHETYPE_NOT_FOUND",
	RESOURCE_NOT_REGISTERED = "RESOURCE_NOT_REGISTERED",
	RESOURCE_ALREADY_REGISTERED = "RESOURCE_ALREADY_REGISTERED",
	EVENT_ALREADY_REGISTERED = "EVENT_ALREADY_REGISTERED",
	EVENT_NOT_REGISTERED = "EVENT_NOT_REGISTERED",
	FIELD_NOT_REGISTERED = "FIELD_NOT_REGISTERED",
	RELATION_NOT_REGISTERED = "RELATION_NOT_REGISTERED",
	RELATION_MODE_INVALID = "RELATION_MODE_INVALID",
	RELATION_MODE_MISMATCH = "RELATION_MODE_MISMATCH",
	RELATION_CYCLE = "RELATION_CYCLE",
	SPARSE_CACHE_KEY_OVERFLOW = "SPARSE_CACHE_KEY_OVERFLOW",
	SPARSE_QUERY_DENSE_PATH = "SPARSE_QUERY_DENSE_PATH",
	HIERARCHY_ALREADY_SET = "HIERARCHY_ALREADY_SET",
	HIERARCHY_INVALID_MAX_DEPTH = "HIERARCHY_INVALID_MAX_DEPTH",
	OBSERVER_NON_CONVERGENT = "OBSERVER_NON_CONVERGENT",
	OBSERVER_INVALID_CONFIG = "OBSERVER_INVALID_CONFIG",
	OBSERVER_ONSET_EMIT = "OBSERVER_ONSET_EMIT",
	ROW_TICKS_NOT_TRACKED = "ROW_TICKS_NOT_TRACKED",
	INVALID_FIXED_TIMESTEP = "INVALID_FIXED_TIMESTEP",
	INVALID_MAX_FIXED_STEPS = "INVALID_MAX_FIXED_STEPS",
	INVALID_RECORDER_SCHEDULE = "INVALID_RECORDER_SCHEDULE",
	EMPTY_ARCHETYPE_MATERIALIZE = "EMPTY_ARCHETYPE_MATERIALIZE",
	COMPONENT_INDEX_INVARIANT = "COMPONENT_INDEX_INVARIANT",
	/** An Archetype's row bookkeeping is inconsistent with its backing columns:
	 * a reserve that did not deliver the capacity it was asked for, a restore
	 * handed an out-of-range partition boundary, or a cached row plane
	 * (`_bufs` and `_eids`) left pointing at a stale buffer. Dev-only, and an
	 * internal-invariant failure rather than a caller error, distinct from
	 * `STORE_CAP_EXCEEDED`, which is the allocator refusing a legitimate grow. */
	ARCHETYPE_ROW_INVARIANT = "ARCHETYPE_ROW_INVARIANT",
	OPTIONAL_TERM_NOT_DECLARED = "OPTIONAL_TERM_NOT_DECLARED",
	QUERY_ACCESS_UNDECLARED = "QUERY_ACCESS_UNDECLARED",
	/** A system touched a component, sparse, relation and resource it didn't declare
	 * in its access surface, distinct from *_NOT_REGISTERED (which means the
	 * thing was never registered with the world at all). */
	ACCESS_UNDECLARED = "ACCESS_UNDECLARED",
	/** `Query.singleEntity` found 0 or >1 matches (dev-only assertion). */
	QUERY_NOT_SINGLETON = "QUERY_NOT_SINGLETON",
	/** A run-condition factory was given invalid arguments (dev-only). */
	INVALID_RUN_CONDITION = "INVALID_RUN_CONDITION",
	SYSTEM_FN_ARITY = "SYSTEM_FN_ARITY",
	PARTITION_APPEND_NEEDS_ENTITY_ROW = "PARTITION_APPEND_NEEDS_ENTITY_ROW",
	PARTITION_BULK_INTO_DISABLED = "PARTITION_BULK_INTO_DISABLED",
	ENTITY_NOT_DISABLED = "ENTITY_NOT_DISABLED",
	STRUCTURAL_DURING_ITERATION = "STRUCTURAL_DURING_ITERATION",
	BACKEND_ALREADY_ATTACHED = "BACKEND_ALREADY_ATTACHED",
	DETERMINISM_DISABLED = "DETERMINISM_DISABLED",
	NON_DETERMINISTIC_COLUMN_TYPE = "NON_DETERMINISTIC_COLUMN_TYPE",
	INVALID_MEMORY_OPTIONS = "INVALID_MEMORY_OPTIONS",
	STORE_CAP_EXCEEDED = "STORE_CAP_EXCEEDED",
	REGION_NOT_DECLARED = "REGION_NOT_DECLARED",
	COMMAND_LOG_TAG_COLLISION = "COMMAND_LOG_TAG_COLLISION",
	INVALID_FRAME_STEP = "INVALID_FRAME_STEP",
	/** `spawn` or `spawnMany` got a value that is not a template. A component
	 * definition and a bundle are the two usual mistakes. Dev-only. Without this
	 * check, the value goes to the store. Then the store fails with a `TypeError`
	 * about an internal field. That error names the wrong place. */
	INVALID_TEMPLATE = "INVALID_TEMPLATE",
	/** An optional subsystem was used on a world that never installed it.
	 * Distinct from `*_NOT_REGISTERED`, which means the world has the
	 * subsystem but not that particular component, event or relation. */
	PLUGIN_NOT_INSTALLED = "PLUGIN_NOT_INSTALLED",
	/** One plugin reached an install seam twice. The second service would
	 * replace the first, and every handle the caller took from the first would
	 * then address state the world no longer reads. */
	PLUGIN_ALREADY_INSTALLED = "PLUGIN_ALREADY_INSTALLED",
	/** A plugin's facade names a member the world already carries.
	 * `Object.assign` would overwrite it without a word, and the world would
	 * lose a method it needs. Dev-only. */
	PLUGIN_SURFACE_COLLISION = "PLUGIN_SURFACE_COLLISION",
	/** `workers.attach` ran on a world that already holds a pool. One pool per
	 * world, because one control buffer carries one barrier. */
	WORKERS_ATTACHED = "WORKERS_ATTACHED",
	/** `workers.attach` ran on a world whose bytes a worker cannot reach. A
	 * worker needs a `SharedArrayBuffer` or a shared `WebAssembly.Memory`. */
	WORKERS_NEED_SHARED_BACKING = "WORKERS_NEED_SHARED_BACKING",
	/** The host cannot block on `Atomics.wait`, so it cannot park while the
	 * workers run. A browser main thread is the case. */
	WORKERS_HOST_CANNOT_PARK = "WORKERS_HOST_CANNOT_PARK",
	/** `workers.attach` was given a number outside its range. The worker count,
	 * the join timeout and the kernel stack size are the three, and the message
	 * names which. */
	WORKERS_COUNT_INVALID = "WORKERS_COUNT_INVALID",
	/** A worker's script did not load, so the worker answered nothing. A
	 * `workerUrl` that points at no file is the case, and a bundled app that
	 * kept the default is where that happens. */
	WORKERS_ENTRY_UNREACHABLE = "WORKERS_ENTRY_UNREACHABLE",
	/** A parallel system declares access a worker cannot serve, or a query a
	 * worker cannot resolve from the archetype masks. Dev-only, at
	 * registration. */
	PARALLEL_ACCESS = "PARALLEL_ACCESS",
	/** A parallel system names a `wasm` kernel whose module the pool cannot
	 * serve: an import the workers do not supply, a missing memory import, or an
	 * export that is missing or is not a function. Dev-only, at registration. */
	PARALLEL_KERNEL_MODULE = "PARALLEL_KERNEL_MODULE",
	/** A kernel would not load, it threw inside a pass, or a worker missed the
	 * join inside `joinTimeoutMs`. The message names the kernel export, and the
	 * worker index when a worker reported the fault itself. A module that cannot
	 * be given one stack region for each worker fails to load here. */
	PARALLEL_KERNEL_FAILED = "PARALLEL_KERNEL_FAILED"
}

export class ECSError extends AppError {
	constructor(
		public readonly category: ECS_ERROR,
		message?: string,
		context?: Record<string, unknown>
	) {
		super(message ?? category, true, context);
		this.name = "ECSError";
	}
}

export function isEcsError(error: unknown): error is ECSError {
	return error instanceof ECSError;
}

/** Thrown by `Store.restore` (and the helpers here) when a combined snapshot
 * is malformed, carries the wrong magic and version, or targets a world whose
 * archetype and component registration doesn't match the snapshot. Mirrors
 * `StoreRestoreError` / `SparseRestoreError` so callers see one error class per
 * restore failure mode. */
export class ECSRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ECSRestoreError";
	}
}
