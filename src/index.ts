/**
 * # oecs, archetype Entity Component System for TypeScript
 *
 * Re-derived from the oasys engine ECS. A determinism-capable archetype ECS
 * with a topo-sorted scheduler, system sets + run conditions, per-component
 * observers, relations (with wildcards), sparse storage, templates, and a
 * typed host→ECS write seam.
 *
 * Storage runs over a backing-neutral column store (`ColumnStore`). The default
 * profile is **pure-TS heap**, a plain fixed `ArrayBuffer`, so no
 * `SharedArrayBuffer` and no cross-origin isolation (COOP and COEP) are required.
 * The opt-in `SharedArrayBuffer` + WASM profile lives at `@oasys/oecs/shared`.
 *
 * This entry is the **stable public API**: every name below is an explicit
 * semver commitment (additions to the internal barrel do not auto-publish).
 * Codecs, ABI constants, memory inspectors, and dev singletons live at
 * `@oasys/oecs/internal`, which carries no semver guarantees.
 *
 * @module oecs
 */

// ECS
export { ECS, type ECSOptions } from "./core/ecs";
export type { ECSResources, ECSSnapshots } from "./core/ecs";

// The plugin seam. These are type-only. Each plugin module ships on its own
// subpath, and a plugin outside this package implements these types.
// `PluginsOf` computes the world type a plugin list builds.
export type { Plugin, PluginHost, PluginsOf, ChangeFeed } from "./core/ecs";
export type {
	SystemRoutePlanner,
	RouteControl,
	RouteDispatch,
	PluginMemory
} from "./core/ecs";

// The change feed a plugin drains. `ChangeFeed` above names the seam.
// These are the records that cross it.
export type { ObservationFlags, DrainResult, StructuralObserverEvents } from "./core/ecs";

// ECS memory sizing, the intent surface a consumer sizes an ECS
// through (`ECSOptions.memory`). The resolver + derivation constants are
// tooling, at `@oasys/oecs/internal`.
export type { ECSMemoryOptions, MemoryBacking, WasmMemoryArm } from "./core/ecs";

// The one memory helper a consumer runs, and not an inspector: it reads a
// module's `__heap_base` and gives back a `memory.storeBase` that clears it.
export { storeBaseAbove } from "./core/ecs";

// Template and direct create, the opaque archetype template from
// `ECS.template`, consumed by `ECS.spawn` and `ECS.spawnMany`.
export type { Template, TemplateOverrides } from "./core/ecs";

// SAB layout subscription, generic hook for any consumer (e.g. a compute
// backend) that needs to know when SAB layout changes.
export type { StoreLayoutListener } from "./core/ecs";

// Compute backend, the generic, opt-in plug point a consumer attaches
// via `ECS.attachBackend`.
export type { ComputeBackend, BackendSystemHandle } from "./core/ecs";

// Schedule
export {
	SCHEDULE,
	// Phases. The built-in seven spell a `SCHEDULE` member. `ecs.addPhase` adds
	// one more slot to a loop and hands back a `Phase` handle.
	type Phase,
	type PhaseConfig,
	type PhaseLoop,
	type PhaseName,
	type SchedulePhase,
	type SystemEntry,
	type SystemOrdering,
	type SystemOrderingTarget,
	// System sets, a named group sharing a run condition + ordering.
	systemSet,
	type SystemSet,
	type SystemSetConfig
} from "./core/ecs";

// Run conditions, per-tick gates for a scheduled system or system set.
export {
	type RunCondition,
	type ConditionContext,
	runIfResourceEq,
	runEveryNTicks,
	runIfAnyMatch,
	runIfNot,
	runIfAll,
	runIfAny
} from "./core/ecs";

// Systems
export { SystemContext } from "./core/ecs";
export type {
	SystemFn,
	SystemConfig,
	SystemDescriptor,
	SystemAccessConfig,
	SystemAccessDeclaration,
	SystemTransition
} from "./core/ecs";
// Worker execution. `world.workers.attach` starts the pool, and a system
// carrying a `parallel` config then runs its kernel across it. The pool ships
// in `@oasys/oecs/workers`, which is where `WorkerPool` and
// `AttachWorkersOptions` live. These three erase.
export type { ParallelConfig, ParallelKernel, ParallelColumn } from "./core/ecs";
// Compile-time access typing (system.ts): the config-form `registerSystem`
// narrows `ctx` to the declared access surface. `SystemAccess` + the
// `Declared*` guards are what helper signatures reference. `DeclaredAccess` and
// `TypedSystemConfig` are the computed shapes behind the inference.
export type {
	SystemAccess,
	DeclaredAccess,
	TypedSystemConfig,
	DeclaredRead,
	DeclaredWrite,
	DeclaredAdd,
	DeclaredRemove,
	DeclaredSparseRead,
	DeclaredSparseWrite,
	DeclaredRelationRead,
	DeclaredRelationWrite,
	DeclaredResourceRead,
	DeclaredResourceWrite,
	DespawnArg,
	DeclaredBundleOrDef,
	DenseAccessDecl,
	SpawnsAccessDecl,
	DespawnsAccessDecl,
	TransitionsAccessDecl,
	SparseAccessDecl,
	RelationsAccessDecl,
	ResourcesAccessDecl
} from "./core/ecs";

// Component observers, registered via `ECS.observe`.
export type {
	ObserverConfig,
	ObserverHandle,
	ObserverFn,
	ArchetypeObserverFn,
	StructuralObserverConfig,
	EntitySetObserverConfig,
	ArchetypeSetObserverConfig
} from "./core/ecs";

// Host → ECS write seam, a host, UI or editor enqueues typed
// `HostCommand`s off-schedule into a `HostCommandQueue`. A blessed apply
// system drains them at the schedule head through `applyHostCommand`.
// The SAB command-ring transport (`HostCommandDispatcher`, `ring*Codec`,
// `HOST_COMMAND_PAYLOAD_BYTES`) is wire and ABI surface, `@oasys/oecs/internal`.
export {
	installHostCommandSeam,
	uninstallHostCommandSeam,
	applyHostCommand,
	HostCommandQueue,
	spawnEntry
} from "./core/ecs";
export type {
	HostCommand,
	SpawnEntry,
	SpawnEntryFor,
	SpawnEntries,
	HostCommandSeamOptions,
	HostCommandSink
} from "./core/ecs";

// Record and replay over the host command log, part of the write seam.
export {
	HostCommandRecorder,
	serializeCommandLog,
	deserializeCommandLog,
	replayCommandLog
} from "./core/ecs";
export type { CommandLog, RecordedTick, ReplayResult, ReplayOptions } from "./core/ecs";

// Per-world frame-trace seam, attach a `FrameTraceSink` via
// `ECS.setTrace(sink)`. `DEV`-gated end to end (zero prod cost).
export { FrameTraceRecorder } from "./core/ecs";
export type {
	FrameTraceSink,
	FrameTrace,
	FrameTraceEvent,
	StructuralOp,
	ObserverOp
} from "./core/ecs";

// Host-side frame driver, optional convenience over `ECS.update(dt)`:
// play and pause on rAF, explicit `step()` and `stepFrames()`, `maxDt` clamp on raw
// browser-frame deltas.
export { FrameStepper } from "./core/ecs";
export type { FrameStepperOptions } from "./core/ecs";

// World resume, `ecs.snapshots.restore(bytes)` throws `ECSRestoreError`. That
// call is `Store.restore` behind the facade, and it mounts the combined
// snapshot that `ecs.snapshots.capture()` makes: the dense columns, the sparse
// stores with the relations, and the host bookkeeping. `ECS_SNAPSHOT_VERSION`
// tags that framing. `StoreRestoreError` is the failure of the dense half, which
// the same call can give. Both are exported, so a caller can name and catch them.
export { ECSRestoreError, ECS_SNAPSHOT_VERSION } from "./core/ecs";
export { StoreRestoreError } from "./core/store";

// Ref, advisory read-only views. A deliberate cast can still write through.
export type {
	ComponentCursor,
	ComponentRef,
	CursorSeek,
	ReadonlyComponentCursor,
	ReadonlyComponentRef
} from "./core/ecs";

// Queries
export { Query, QueryBuilder, ChangedQuery, HIERARCHY_UNBOUNDED, and, or, not } from "./core/ecs";
export type { ArchetypeTerm, ArchetypeExpr, HierarchyTerm } from "./core/ecs";
// forEachChunk cursor (cols.mut/read) + the ctx.commands deferred facade.
export { ChunkColumns, Commands } from "./core/ecs";

// Archetype, only the read-only view + opaque id are public.
export type { ArchetypeView, ArchetypeID } from "./core/ecs";

// Entities. `getEntityIndex` decodes the dense 20-bit slot index out of a
// packed EntityID, needed by replication-style consumers. The generational
// guard stays the caller's job. The rest of the packed-ID codec
// (`createEntityId`, the bounds constants) is `@oasys/oecs/internal`.
export type { EntityID, ReadonlyEntityIDArray } from "./core/ecs";
export { getEntityIndex } from "./core/ecs";

// Components
// `TypedArrayTag` is the column-type vocabulary `registerComponent` constrains
// on ("f64" | "i32" | ...), exported so consumers can type schema literals.
export type { TypedArrayTag } from "./type_primitives";
export type {
	ComponentDef,
	ComponentHandle,
	ComponentRegisterOptions,
	ComponentSchema,
	SchemaOf,
	DeclaredQueryTerm,
	FieldValues,
	CompleteFieldValues,
	ValuesArg,
	AttachValuesArg,
	TagToTypedArray,
	ColumnsForSchema,
	MutableColumnsForSchema,
	ReadonlyColumn,
	ReadonlyUint32Array
} from "./core/ecs";
// Callable bundles, `bundle(Pos, {x,y})` pairs a def with values for the
// unified varargs spawn and add path.
export { bundle } from "./core/ecs";
export type { Bundle, BundleOrDef, StrictBundle, StrictBundles, DefsOf } from "./core/ecs";

// Sparse storage class, out-of-identity components.
export type { SparseComponentDef, SparseComponentID, SparseSchemaOf } from "./core/ecs";
export { SparseRestoreError } from "./core/ecs";

// Relations, (relation, target) pairs on the sparse storage class.
// `ANY_RELATION` is the `(*, T)` wildcard access sentinel.
export type { RelationDef, RelationID, RelationCardinality, RelationOptions, OnDeleteTarget } from "./core/ecs";
export { ANY_RELATION } from "./core/ecs";

// The built-in relations, `registerIsA` and `registerChildOf`, ship on
// `@oasys/oecs/relations` beside the plugin they need. They register a
// relation, so a world without the plugin cannot call them, and exporting them
// here pulled the relation code into every bundle.

// Events
export type {
	EventReader,
	EventKey,
	EventSchema,
	EventShape,
	EventFieldsCover,
	EmptyEventSchema,
	SignalKey
} from "./core/ecs";
export { eventKey, signalKey } from "./core/ecs";

// Resources
export type { ResourceKey, ResourceValueOf } from "./core/ecs";
export { resourceKey } from "./core/ecs";

// Error taxonomy, every ECS-thrown error is an `ECSError` tagged with an
// `ECS_ERROR` category, so a consumer can catch and branch on the category.
export { ECSError, ECS_ERROR, isEcsError } from "./core/ecs";
// Thrown from main-entry construction when a `memory.shared` profile runs in
// an environment without SharedArrayBuffer, re-exported here so root-entry
// consumers can name it without importing `/shared`.
export { SabUnavailableError } from "./core/store";

// The installed package version, readable at runtime.
export { VERSION } from "./version";
