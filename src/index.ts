/**
 * # oecs — archetype Entity Component System for TypeScript
 *
 * Re-derived from the oasys engine ECS. A determinism-capable archetype ECS
 * with a topo-sorted scheduler, system sets + run conditions, per-component
 * observers, relations (with wildcards), sparse storage, templates, and a
 * typed host→ECS write seam.
 *
 * Storage runs over a backing-neutral column store (`ColumnStore`). The default
 * profile is **pure-TS heap** — a plain resizable `ArrayBuffer`, so no
 * `SharedArrayBuffer` and no cross-origin isolation (COOP/COEP) are required.
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
export type { ECSRelations, ECSEvents, ECSResources, ECSSnapshots } from "./core/ecs";

// ECS memory sizing (#682) — the intent surface a consumer sizes an ECS
// through (`ECSOptions.memory`). The resolver + derivation constants are
// tooling, at `@oasys/oecs/internal`.
export type { ECSMemoryOptions, EntityBudget, WasmMemoryArm } from "./core/ecs";

// Template / direct-create (#462) — opaque archetype template from `ECS.template`,
// consumed by `ECS.createEntity` / `ECS.createEntities`.
export type { Template, TemplateEntry, TemplateEntries, TemplateOverrides } from "./core/ecs";

// SAB layout subscription — generic hook for any consumer (e.g. a compute
// backend) that needs to know when SAB layout changes.
export type { StoreLayoutListener } from "./core/ecs";

// Compute backend (#622) — the generic, opt-in plug point a consumer attaches
// via `ECS.attachBackend`.
export type { ComputeBackend, BackendSystemHandle } from "./core/ecs";

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
} from "./core/ecs";

// Run conditions (#576) — per-tick gates for scheduled systems / sets.
export {
	type RunCondition,
	type ConditionContext,
	runIfResourceEq,
	runEveryNTicks,
	runIfAnyMatch
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
// Compile-time access typing (§typestate): the config-form `registerSystem`
// narrows `ctx` to the declared access surface. `SystemAccess` + the
// `Declared*` guards are what helper signatures reference; `DeclaredAccess` /
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
	DestroyEntityArg,
	DeclaredBundleOrDef,
	DenseAccessDecl,
	SpawnsAccessDecl,
	DespawnsAccessDecl,
	TransitionsAccessDecl,
	SparseAccessDecl,
	RelationsAccessDecl,
	ResourcesAccessDecl
} from "./core/ecs";

// Component observers (#517 §1 / ADR-0013) — registered via `ECS.observe`.
export type {
	ObserverConfig,
	ObserverHandle,
	ObserverFn,
	ArchetypeObserverFn,
	StructuralObserverConfig,
	EntitySetObserverConfig,
	ArchetypeSetObserverConfig
} from "./core/ecs";

// Host → ECS write seam (#681) — a host/UI/editor enqueues typed
// `HostCommand`s off-schedule into a `HostCommandQueue`; a blessed apply
// system drains them at the schedule head through `applyHostCommand`.
// The SAB command-ring transport (`HostCommandDispatcher`, `ring*Codec`,
// `HOST_COMMAND_PAYLOAD_BYTES`) is wire/ABI surface — `@oasys/oecs/internal`.
export { installHostCommandSeam, applyHostCommand, HostCommandQueue, spawnEntry } from "./core/ecs";
export type {
	HostCommand,
	SpawnEntry,
	SpawnEntryFor,
	SpawnEntries,
	HostCommandSeamOptions,
	HostCommandSink
} from "./core/ecs";

// Record / replay over the host command log (#702) — slice 5 of the write seam.
export {
	HostCommandRecorder,
	serializeCommandLog,
	deserializeCommandLog,
	replayCommandLog
} from "./core/ecs";
export type { CommandLog, RecordedTick, ReplayResult, ReplayOptions } from "./core/ecs";

// Per-world frame-trace seam (ADR-0030) — attach a `FrameTraceSink` via
// `ECS.setTrace(sink)`. `__DEV__`-gated end to end (zero prod cost).
export { FrameTraceRecorder } from "./core/ecs";
export type {
	FrameTraceSink,
	FrameTrace,
	FrameTraceEvent,
	StructuralOp,
	ObserverOp
} from "./core/ecs";

// World resume (#789) — `WorldRestoreError` is thrown by `ECS.restoreInto`;
// `WORLD_SNAPSHOT_VERSION` tags the combined snapshot framing.
export { WorldRestoreError, WORLD_SNAPSHOT_VERSION } from "./core/ecs";

// Ref — advisory read-only views; see PATTERNS §10c.
export type { ComponentRef, ReadonlyComponentRef } from "./core/ecs";

// Queries
export { Query, QueryBuilder, ChangedQuery, HIERARCHY_UNBOUNDED } from "./core/ecs";
export type { HierarchyTerm } from "./core/ecs";
// eachChunk cursor (cols.mut/read) + the ctx.commands deferred facade.
export { ChunkColumns, Commands } from "./core/ecs";

// Archetype — only the read-only view + opaque id are public (issue #378).
export type { ArchetypeView, ArchetypeID } from "./core/ecs";

// Entities. `getEntityIndex` decodes the dense 20-bit slot index out of a
// packed EntityID — needed by replication-style consumers; the generational
// guard stays the caller's job. The rest of the packed-ID codec
// (`createEntityId`, the bounds constants) is `@oasys/oecs/internal`.
export type { EntityID, ReadonlyEntityIdArray } from "./core/ecs";
export { getEntityIndex } from "./core/ecs";

// Components
export type {
	ComponentDef,
	ComponentHandle,
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
// Callable bundles — `bundle(Pos, {x,y})` pairs a def with values for the
// unified varargs spawn/add path.
export { bundle } from "./core/ecs";
export type { Bundle, BundleOrDef } from "./core/ecs";

// Sparse storage class — out-of-identity components (#468 / ADR-0011).
export type { SparseComponentDef, SparseComponentID, SparseSchemaOf } from "./core/ecs";
export { SparseRestoreError } from "./core/ecs";

// Relations — (relation, target) pairs on the sparse storage class (#471 /
// ADR-0011). `ANY_RELATION` is the `(*, T)` wildcard access sentinel (#579).
export type { RelationDef, RelationID, RelationCardinality, RelationOptions, OnDeleteTarget } from "./core/ecs";
export { ANY_RELATION } from "./core/ecs";

// Built-in relations (#477 / #463) — named presets over `ECS.registerRelation`.
export { registerIsA, registerChildOf, type BuiltinRelationOptions } from "./core/ecs";

// Events
export type {
	EventReader,
	EventKey,
	EventSchema,
	EventFieldsCover,
	EmptyEventSchema,
	SignalKey
} from "./core/ecs";
export { eventKey, signalKey } from "./core/ecs";

// Resources
export type { ResourceKey, ResourceValueOf } from "./core/ecs";
export { resourceKey } from "./core/ecs";

// Error taxonomy — every ECS-thrown error is an `ECSError` tagged with an
// `ECS_ERROR` category, so a consumer can catch and branch on the category.
export { ECSError, ECS_ERROR, isEcsError } from "./core/ecs";
