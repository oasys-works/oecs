// ECS
export { ECS, type ECSOptions } from "./ecs";
// The core facades, type-only: a consumer reaches the instances via
// `ecs.resources` and `ecs.snapshots`, never constructs them. `ECSRelations`
// and `ECSEvents` belong to their plugin now, and each plugin entry exports
// its own.
export type { ECSResources, ECSSnapshots } from "./facades";

// ECS memory sizing, the single surface a consumer sizes an ECS
// through (`ECSOptions.memory`). `resolveECSMemory` is exported so tests
// and tooling can inspect what an intent resolves to without constructing an
// ECS. The constants document the budget arm's derivation inputs.
export {
	resolveECSMemory,
	DEFAULT_ECS_CAP_BYTES,
	WASM_STORE_BASE_BYTES,
	storeBaseAbove,
	BUDGET_GROWTH_HEADROOM,
	BUDGET_DEFAULT_BYTES_PER_ENTITY,
	BUDGET_DEFAULT_ARCHETYPES,
	type ECSMemoryOptions,
	type ResolvedECSMemory,
	type ECSMemoryCapContext,
	type MemoryBacking,
	type WasmMemoryArm
} from "./ecs_memory";

// Template and direct create, the opaque archetype template from
// `ECS.template`, consumed by `ECS.spawn` and `ECS.spawnMany`.
export type { Template, TemplateOverrides } from "./store";

// SAB layout subscription, generic hook for any consumer (e.g. a compute
// backend) that needs to know when SAB layout changes. The engine has no
// concept of what subscribes. Consumer-level call surfaces live in consumer
// code.
export type { StoreLayoutListener } from "./store_layout_listener";

// Compute backend, the generic, opt-in plug point a consumer attaches
// via `ECS.attachBackend` to execute a system's body (a compiled WASM module,
// etc.) instead of its TS closure. Default = none (pure-TS). `BackendSystemHandle`
// is the opaque, backend-minted token carried on `SystemConfig.backendHandle`.
export type { ComputeBackend, BackendSystemHandle } from "./compute_backend";

// Phases. The seven built-ins spell a `SCHEDULE` member. `ecs.addPhase`
// adds one more slot to a loop and hands back a `Phase` handle.
export {
	SCHEDULE,
	type Phase,
	type PhaseConfig,
	type PhaseLoop,
	type PhaseName,
	type SchedulePhase
} from "./phase";

// What a caller writes into `addSystems` and `configureSet`, plus the system
// set, a named group sharing a run condition and ordering.
export {
	type SystemEntry,
	type SystemOrdering,
	type SystemOrderingTarget,
	systemSet,
	type SystemSet,
	type SystemSetConfig
} from "./system_set";

// Run conditions, per-tick gates for a scheduled system or system set. The
// predicate type + ConditionContext, plus the shipped built-ins.
export {
	type RunCondition,
	type ConditionContext,
	runIfResourceEq,
	runEveryNTicks,
	runIfAnyMatch,
	runIfNot,
	runIfAll,
	runIfAny
} from "./run_condition";

// Systems
export { SystemContext } from "./system_context";
export type {
	SystemFn,
	SystemConfig,
	SystemDescriptor,
	SystemAccessConfig,
	SystemAccessDeclaration,
	SystemTransition
} from "./system";
// Compile-time access typing (system.ts), the config-form `registerSystem`
// narrows `ctx` to the declared access surface. These are the public names a
// consumer needs to write helper signatures against a typed context.
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
	DenseAccessDecl,
	SpawnsAccessDecl,
	DespawnsAccessDecl,
	TransitionsAccessDecl,
	SparseAccessDecl,
	RelationsAccessDecl,
	ResourcesAccessDecl
} from "./system";
export type { DeclaredBundleOrDef } from "./system_context";

// Worker execution. A system that names a kernel runs across the pool a world
// attaches, and its `fn` runs everywhere else. The pool itself ships in the
// workers plugin, so `WorkerPool` and `AttachWorkersOptions` are exported from
// `@oasys/oecs/workers` and not from here. These three erase, so a program that
// never attaches a pool carries none of it.
export type { ParallelConfig, ParallelKernel, ParallelColumn } from "./system";

// Access check, dev-mode validation singleton.
export { accessCheck } from "./access_check";

// Component observers, onAdd and onRemove fire at the
// structural-flush boundary in canonical order. OnSet is change detection
// surfaced as a callback (archetype-granular = free change tick, per-entity =
// opt-in dirty list). Registered via `ecs.observe`, the member the observers
// plugin adds. The `ObserverRegistry` substrate stays internal.
export type {
	ObserverConfig,
	ObserverHandle,
	ObserverFn,
	ArchetypeObserverFn,
	StructuralObserverConfig,
	EntitySetObserverConfig,
	ArchetypeSetObserverConfig
} from "./observer";

// Host → ECS write seam, the write-symmetric counterpart to the Solid
// plugin's read side. A host, UI or editor enqueues typed `HostCommand`s
// off-schedule into a `HostCommandQueue`. A blessed `exclusive` apply system
// drains them at the schedule head through `applyHostCommand` into the existing
// deferred buffers. `installHostCommandSeam(world)` wires it and returns the
// queue. The SAB `command_ring` is the second transport: a
// `HostCommandDispatcher` and `ring*Codec` decode cross-thread and wire bytes into
// the same `applyHostCommand`.
export {
	installHostCommandSeam,
	uninstallHostCommandSeam,
	applyHostCommand,
	HostCommandQueue,
	HostCommandDispatcher,
	spawnEntry,
	ringSetFieldCodec,
	ringDespawnCodec,
	ringDisableCodec,
	ringEnableCodec,
	ringRemoveComponentCodec,
	HOST_COMMAND_PAYLOAD_BYTES
} from "./host_commands";
export type {
	HostCommand,
	SpawnEntry,
	SpawnEntryFor,
	SpawnEntries,
	HostCommandSeamOptions,
	HostCommandSink,
	RingCommandApplier
} from "./host_commands";

// Record and replay over the host command log, part of the write seam.
// Wire `HostCommandRecorder` via `installHostCommandSeam(world, { recorder })`
// to log the applied `HostCommand`s + per-tick `dt` + seed. `replayCommandLog`
// re-applies a `CommandLog` against a fresh world (per-tick `stateHash` matches
// under the determinism opt-in). `serializeCommandLog` and
// `deserializeCommandLog` round-trip it through JSON.
export {
	HostCommandRecorder,
	serializeCommandLog,
	deserializeCommandLog,
	replayCommandLog
} from "./command_log";
export type { CommandLog, RecordedTick, ReplayResult, ReplayOptions } from "./command_log";

// Per-world frame-trace seam, attach a `FrameTraceSink` via
// `ECS.setTrace(sink)` and the engine fires structured per-frame events
// (systems, flushes, `ctx.commands.*`, observer firings, events) during
// `update()`, so a consumer can reconstruct what travelled through the ECS each
// frame. `DEV`-gated end to end (zero prod cost). `FrameTraceRecorder` is the
// in-tree sink. Not the same as the global, count-aggregating `dispatchTrace`.
export { FrameTraceRecorder } from "./frame_trace";
export type {
	FrameTraceSink,
	FrameTrace,
	FrameTraceEvent,
	StructuralOp,
	ObserverOp
} from "./frame_trace";

// Host-side frame driver, optional convenience over the authoritative
// `ECS.update(dt)` primitive: play and pause on rAF (injectable for tests and
// non-browser hosts), explicit `step()` and `stepFrames()` for debuggers, editors,
// and rollback playback, and a `maxDt` clamp so a resumed background tab
// doesn't feed the whole suspension into the accumulator as one delta.
export { FrameStepper } from "./frame_stepper";
export type { FrameStepperOptions } from "./frame_stepper";

// World resume, `ECSRestoreError` is thrown by `ecs.snapshots.restore` when a
// snapshot's shape, field-identity and index-bounds checks fail closed before overwriting the
// live backing. `ECS_SNAPSHOT_VERSION` tags the combined snapshot framing.
export { ECSRestoreError } from "./utils/error";
export { ECS_SNAPSHOT_VERSION } from "./snapshot";

// Ref.
// The `Readonly*` types exported from this barrel (ReadonlyComponentRef,
// ReadonlyColumn, ReadonlyUint32Array, and the EventReader columns) are
// *advisory* compile-time barriers, not runtime safety boundaries, each wraps
// the live mutable backing store, so a deliberate cast can still write
// through. Mutation-default accessors are unsuffixed (`ctx.ref`,
// `Archetype.getColumnMut`). The read-only variants carry an explicit `_read`
// suffix (`ctx.refRead`, `Archetype.getColumnRead`).
//
// The column-cursor family shares this convention in a second spelling: the
// forEachColumns cursors `cols.mut(def)` and `cols.read(def)` are the
// explicit-verb pair, and `ctx.ref` and `ctx.refRead` are their
// outside-iteration single-entity analog. All are def-first (`ref(Pos, e)`,
// `cols.mut(Pos)`), a cursor is named for what it points at, deliberately
// unlike the entity-first `getField(e, def, field)` reader family.
// `cursor` and `cursorRead` complete the family in a third spelling: the
// single-entity accessor that is created once and repointed, rather than minted
// per entity like a ref. Same rules again, def-first, mutable by default, and a
// `Read` suffix on the read-only form.
export type {
	ComponentCursor,
	ComponentRef,
	CursorSeek,
	ReadonlyComponentCursor,
	ReadonlyComponentRef
} from "./ref";

// Queries
export { Query, QueryBuilder } from "./query";
export { ChangedQuery } from "./changed_query";
export { HIERARCHY_UNBOUNDED, and, or, not } from "./query_terms";
export type { ArchetypeTerm, ArchetypeExpr, HierarchyTerm, QueryTerms } from "./query_terms";
// forEachColumns cursor (cols.mut/read) + the ctx.commands deferred facade.
export { ChunkColumns } from "./chunk_columns";
export { Commands } from "./system_context";

// Archetype, only the read-only view + opaque id are public. The concrete
// `Archetype` (with structural mutators) stays internal.
export type { ArchetypeView, ArchetypeID } from "./archetype";

// Entities
export type { EntityID, ReadonlyEntityIDArray } from "./entity";
// `getEntityIndex` decodes the dense 20-bit slot index out of a packed
// EntityID, needed by replication's entity-index-keyed state store
// (services and server diff). The generational guard stays the caller's job.
export { getEntityIndex } from "./entity";

// The rest of the packed-EntityID codec + its bounds. Exposed for consumers
// that mint or bounds-check handles outside the normal `spawn` and `spawnMany`
// paths: snapshot and replication decode (paired with
// `getEntityIndex`), and adversarial harnesses that forge an out-of-range, a
// `RETIRED_GENERATION` or a stale handle to prove `isAlive` and the mutators
// read them dead. `createEntityId` is the inverse of
// `getEntityIndex` and `getEntityGeneration`. Like `getEntityIndex` it does no
// aliveness check, the generational guard stays the caller's job.
export {
	createEntityId,
	getEntityGeneration,
	MAX_INDEX,
	MAX_GENERATION,
	MAX_LIVE_GENERATION,
	RETIRED_GENERATION,
	MAX_ENTITY_ID
} from "./entity";

// Components
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
} from "./component";
// Callable bundles, `bundle(Pos, {x,y})` pairs a def with values for the
// unified varargs spawn and add path (`spawnBundle`, `ctx.commands.spawn/add`).
export { bundle } from "./component";
export type { Bundle, BundleOrDef, StrictBundle, StrictBundles, DefsOf } from "./component";

// Sparse storage class, out-of-identity components. The
// handle type is public. The `SparseComponentStore` substrate stays internal.
// `SparseRestoreError` is thrown by `ecs.snapshots.restoreSparse` on a shape,
// field-identity, index-bounds, or trailing-bytes mismatch, so it's part
// of the public determinism surface.
export type { SparseComponentDef, SparseComponentID, SparseSchemaOf } from "./sparse_store";
export { SparseRestoreError } from "./sparse_store";

// Relations, (relation, target) pairs on the sparse storage class.
// The handle type + registration options are public. The
// `RelationStore` substrate stays internal (mutate via `ECS.addRelation` etc.).
export type {
	RelationDef,
	RelationID,
	RelationCardinality,
	RelationOptions,
	OnDeleteTarget
} from "./relation";
// `(*, T)` wildcard query access sentinel, list in `relationReads` to
// authorise `Query.forEachRelatedTo`, which reads every relation's reverse index.
export { ANY_RELATION } from "./relation";

// Events, the schema is a field → value-type record (`EventSchema`), so a
// field declared as a branded number (e.g. `EntityID`) round-trips the brand
// through emit/read. `SignalKey` is the distinct zero-payload key type.
export type {
	EventReader,
	EventKey,
	EventSchema,
	EventShape,
	EventFieldsCover,
	EmptyEventSchema,
	SignalKey
} from "./event";
export { eventKey, signalKey } from "./event";

// Resources
export type { ResourceKey, ResourceValueOf } from "./resource";
export { resourceKey } from "./resource";

// Dispatch trace (dev-mode only, gated by DEV + VISUAL_INTEL_TRACE)
export {
	dispatchTrace,
	type DispatchTraceSnapshot,
	type DispatchTraceEntry
} from "./dispatch_trace";

// Error taxonomy, every ECS-thrown error is an `ECSError` tagged with an
// `ECS_ERROR` category (`STORE_CAP_EXCEEDED`, `EID_MAX_INDEX_OVERFLOW`, …).
// Exposed so a consumer can catch and branch on the category instead of
// string-matching the message: e.g. a host distinguishing a recoverable
// validation throw from a fatal cap hit, or an adversarial harness asserting
// each fail-closed path throws its exact category. `SparseRestoreError`
// (a plain `Error`, not an `ECSError`) stays exported separately above.
export { ECSError, ECS_ERROR, isEcsError } from "./utils/error";

// The plugin seam `ECS.create` drives. These are type-only at the
// root. A third-party plugin needs the shape of the host it installs
// through and the surface it contributes. `PluginsOf` types the world a plugin
// list builds. `storeOnlyHost` is a value, and it stays on `/internal` with the
// rest of the tooling surface.
export type { Plugin, PluginHost, PluginsOf, ChangeFeed } from "./plugin";
// The route seam a plugin implements. Structural, and exported so a plugin author
// can name what `installRoute` takes and hands back.
export type { SystemRoutePlanner, RouteControl, PluginMemory } from "./plugin";
export type { RouteDispatch } from "./schedule";
export { storeOnlyHost } from "./plugin";

// The change feed a plugin drains: what it asks the store to record, what
// one drain hands back, and the structural batch a hook takes. Type-only, and
// the store implements every one of them.
export type { ObservationFlags, DrainResult, StructuralObserverEvents } from "./store";
