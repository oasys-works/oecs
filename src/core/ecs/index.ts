// ECS
export { ECS, type ECSOptions } from "./ecs";
// Grouped facades (H3 phase 2) — type-only: consumers reach the instances
// via `ecs.relations` / `ecs.events` / `ecs.resources` / `ecs.snapshots`,
// never construct them.
export type { ECSRelations, ECSEvents, ECSResources, ECSSnapshots } from "./facades";

// ECS memory sizing (#682) — the single surface a consumer sizes an ECS
// through (`ECSOptions.memory`). `resolveECSMemory` is exported so tests
// and tooling can inspect what an intent resolves to without constructing an
// ECS; the constants document the budget arm's derivation inputs.
export {
	resolveECSMemory,
	DEFAULT_ECS_CAP_BYTES,
	BUDGET_GROWTH_HEADROOM,
	BUDGET_DEFAULT_BYTES_PER_ENTITY,
	BUDGET_DEFAULT_ARCHETYPES,
	type ECSMemoryOptions,
	type ResolvedECSMemory,
	type ECSMemoryCapContext,
	type EntityBudget,
	type WasmMemoryArm
} from "./ecs_memory";

// Template / direct-create (#462) — opaque archetype template from `ECS.template`,
// consumed by `ECS.spawn` / `ECS.spawnMany`.
export type { Template, TemplateOverrides } from "./store";

// SAB layout subscription — generic hook for any consumer (e.g. a compute
// backend) that needs to know when SAB layout changes. The engine has no
// concept of what subscribes; consumer-level call surfaces live in consumer
// code.
export type { StoreLayoutListener } from "./store_layout_listener";

// Compute backend (#622) — the generic, opt-in plug point a consumer attaches
// via `ECS.attachBackend` to execute a system's body (a compiled WASM module,
// etc.) instead of its TS closure. Default = none (pure-TS). `BackendSystemHandle`
// is the opaque, backend-minted token carried on `SystemConfig.backendHandle`.
export type { ComputeBackend, BackendSystemHandle } from "./compute_backend";

// Schedule
export {
	SCHEDULE,
	type SystemEntry,
	type SystemOrdering,
	type SystemOrderingTarget,
	// System sets (#576) — a named group sharing a run condition + ordering.
	systemSet,
	type SystemSet,
	type SystemSetConfig
} from "./schedule";

// Run conditions (#576) — per-tick gates for scheduled systems / sets. The
// predicate type + ConditionContext, plus the shipped built-ins.
export {
	type RunCondition,
	type ConditionContext,
	runIfResourceEq,
	runEveryNTicks,
	runIfAnyMatch,
	not,
	allOf,
	anyOf
} from "./run_condition";

// Systems
export { SystemContext } from "./query";
export type {
	SystemFn,
	SystemConfig,
	SystemDescriptor,
	SystemAccessConfig,
	SystemAccessDeclaration,
	SystemTransition
} from "./system";
// Compile-time access typing (§typestate) — the config-form `registerSystem`
// narrows `ctx` to the declared access surface; these are the public names a
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
export type { DeclaredBundleOrDef } from "./query";

// Access check (Phase B of issue #213) — dev-mode validation singleton.
export { accessCheck } from "./access_check";

// Component observers (#517 §1 / ADR-0013) — onAdd / onRemove fire at the
// structural-flush boundary in canonical order; onSet is change detection
// surfaced as a callback (archetype-granular = free change tick; per-entity =
// opt-in dirty list). Registered via `ECS.observe`; the `ObserverRegistry`
// substrate stays internal.
export type {
	ObserverConfig,
	ObserverHandle,
	ObserverFn,
	ArchetypeObserverFn,
	StructuralObserverConfig,
	EntitySetObserverConfig,
	ArchetypeSetObserverConfig
} from "./observer";

// Host → ECS write seam (#681) — the write-symmetric counterpart to the
// reactive read bridge (ADR-0022). A host/UI/editor enqueues typed `HostCommand`s
// off-schedule into a `HostCommandQueue`; a blessed `exclusive` apply system
// drains them at the schedule head through `applyHostCommand` into the existing
// deferred buffers. `installHostCommandSeam(world)` wires it and returns the
// queue. The SAB `command_ring` is the second transport (#700): a
// `HostCommandDispatcher` + `ring*Codec` decode cross-thread / wire bytes into
// the SAME `applyHostCommand`. See `docs/ideas/host-ecs-write-seam.md`.
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

// Record / replay over the host command log (#702) — slice 5 of the write seam.
// Wire `HostCommandRecorder` via `installHostCommandSeam(world, { recorder })`
// to log the applied `HostCommand`s + per-tick `dt` + seed; `replayCommandLog`
// re-applies a `CommandLog` against a fresh world (per-tick `stateHash` matches
// under the determinism opt-in, ADR-0020). `serializeCommandLog` /
// `deserializeCommandLog` round-trip it through JSON.
export {
	HostCommandRecorder,
	serializeCommandLog,
	deserializeCommandLog,
	replayCommandLog
} from "./command_log";
export type { CommandLog, RecordedTick, ReplayResult, ReplayOptions } from "./command_log";

// Per-world frame-trace seam (ADR-0030) — attach a `FrameTraceSink` via
// `ECS.setTrace(sink)` and the engine fires structured per-frame events
// (systems, flushes, `ctx.commands.*`, observer firings, events) during
// `update()`, so a consumer can reconstruct what travelled through the ECS each
// frame. `DEV`-gated end to end (zero prod cost). `FrameTraceRecorder` is the
// in-tree sink. NOT the same as the global, count-aggregating `dispatchTrace`.
export { FrameTraceRecorder } from "./frame_trace";
export type {
	FrameTraceSink,
	FrameTrace,
	FrameTraceEvent,
	StructuralOp,
	ObserverOp
} from "./frame_trace";

// Host-side frame driver — optional convenience over the authoritative
// `ECS.update(dt)` primitive: play/pause on rAF (DI-able for tests and
// non-browser hosts), explicit `step()`/`stepFrames()` for debuggers, editors,
// and rollback playback, and a `maxDt` clamp so a resumed background tab
// doesn't feed the whole suspension into the accumulator as one delta.
export { FrameStepper } from "./frame_stepper";
export type { FrameStepperOptions } from "./frame_stepper";

// World resume (#789) — `ECSRestoreError` is thrown by `ECS.restoreInto` when a
// snapshot's shape/field-identity/index-bounds fail closed BEFORE overwriting the
// live backing; `ECS_SNAPSHOT_VERSION` tags the combined snapshot framing.
export { ECSRestoreError, ECS_SNAPSHOT_VERSION } from "./resume";

// Ref.
// NOTE: the `Readonly*` types exported from this barrel (ReadonlyComponentRef,
// ReadonlyColumn, ReadonlyUint32Array, and the EventReader columns) are
// *advisory* compile-time barriers, NOT runtime safety boundaries — each wraps
// the live mutable backing store, so a §10c-policed cast can still write
// through. Mutation-default accessors are unsuffixed (`ctx.ref`,
// `Archetype.getColumn`); the read-only variants carry an explicit `_read`
// suffix (`ctx.refRead`, `Archetype.getColumnRead`). See PATTERNS §10c.
//
// The column-cursor family shares this convention in a second spelling: the
// eachChunk cursors `cols.mut(def)` / `cols.read(def)` are the explicit-verb
// pair, and `ctx.ref` / `ctx.refRead` are their outside-iteration single-entity
// analog. All are DEF-FIRST (`ref(Pos, e)`, `cols.mut(Pos)`) — a cursor is named
// for what it points at — deliberately unlike the entity-first `getField(e, def,
// field)` reader family. See docs/api/refs.md and queries.md.
export type { ComponentRef, ReadonlyComponentRef } from "./ref";

// Queries
export { Query, QueryBuilder, ChangedQuery, HIERARCHY_UNBOUNDED } from "./query";
export type { HierarchyTerm } from "./query";
// eachChunk cursor (cols.mut/read) + the ctx.commands deferred facade.
export { ChunkColumns, Commands } from "./query";

// Archetype — only the read-only view + opaque id are public; the concrete
// `Archetype` (with structural mutators) stays internal (issue #378).
export type { ArchetypeView, ArchetypeID } from "./archetype";

// Entities
export type { EntityID, ReadonlyEntityIDArray } from "./entity";
// `getEntityIndex` decodes the dense 20-bit slot index out of a packed
// EntityID — needed by replication's entity-index-keyed state store
// (services/server diff). The generational guard stays the caller's job.
export { getEntityIndex } from "./entity";

// The rest of the packed-EntityID codec + its bounds. Exposed for consumers
// that mint or bounds-check handles outside the normal `spawn` /// `spawnMany` paths: snapshot / replication decode (paired with
// `getEntityIndex`, #723), and adversarial harnesses that forge out-of-range /
// `RETIRED_GENERATION` / stale handles to prove `isAlive` + the mutators read
// them dead (#778 / #781). `createEntityId` is the inverse of
// `getEntityIndex`/`getEntityGeneration`; like `getEntityIndex` it does no
// aliveness check — the generational guard stays the caller's job.
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
// Callable bundles — `bundle(Pos, {x,y})` pairs a def with values for the
// unified varargs spawn/add path (`spawnBundle`, `ctx.commands.spawn/add`).
export { bundle } from "./component";
export type { Bundle, BundleOrDef, StrictBundle, StrictBundles, DefsOf } from "./component";

// Sparse storage class — out-of-identity components (#468 / ADR-0011). The
// handle type is public; the `SparseComponentStore` substrate stays internal.
// `SparseRestoreError` is thrown by `ECS.restoreSparse` on a shape, field-
// identity, index-bounds, or trailing-bytes mismatch (#470, #494), so it's part
// of the public determinism surface.
export type { SparseComponentDef, SparseComponentID, SparseSchemaOf } from "./sparse_store";
export { SparseRestoreError } from "./sparse_store";

// Relations — (relation, target) pairs on the sparse storage class (#471 /
// ADR-0011). The handle type + registration options are public; the
// `RelationStore` substrate stays internal (mutate via `ECS.addRelation` etc.).
export type { RelationDef, RelationID, RelationCardinality, RelationOptions, OnDeleteTarget } from "./relation";
// `(*, T)` wildcard query access sentinel (#579) — list in `relationReads` to
// authorise `Query.forEachRelatedTo`, which reads every relation's reverse index.
export { ANY_RELATION } from "./relation";

// Built-in relations (#477 / #463) — named presets over `ECS.registerRelation`
// (flecs `IsA` / `ChildOf`, the thin no-inheritance variant). Free functions, a
// convention layer over the relation primitive.
export { registerIsA, registerChildOf, type BuiltinRelationOptions } from "./builtin_relations";

// Events — the schema is a field → value-type record (`EventSchema`), so a
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

// Dispatch trace (dev-mode only — gated by DEV + VISUAL_INTEL_TRACE)
export {
	dispatchTrace,
	type DispatchTraceSnapshot,
	type DispatchTraceEntry
} from "./dispatch_trace";

// Error taxonomy — every ECS-thrown error is an `ECSError` tagged with an
// `ECS_ERROR` category (`STORE_CAP_EXCEEDED`, `EID_MAX_INDEX_OVERFLOW`, …).
// Exposed so a consumer can catch and branch on the category instead of
// string-matching the message: e.g. a host distinguishing a recoverable
// validation throw from a fatal cap hit, or an adversarial harness asserting
// each fail-closed path throws its exact category (#781). `SparseRestoreError`
// (a plain `Error`, not an `ECSError`) stays exported separately above.
export { ECSError, ECS_ERROR, isEcsError } from "./utils/error";
