/**
 * The production ECS→UI reactive bridge.
 *
 * Drains the engine's own change detection (component observers, riding
 * the per-row dirty list) into a `reactiveMap` — publishing O(changed),
 * not O(all), each tick. Declarative selection + closure projection (the Bevy
 * `ExtractComponent` / WatermelonDB `observeWithColumns` shape):
 *   - `syncComponentToMap(def, project)` — one component, grain `"entity"`/`"column"`.
 *   - `syncFieldsToMap(def, [fields])` — field-list sugar with auto `shallow` eq.
 *   - `syncJoinToMap([defs], project)` — multi-component join (subscribes all defs).
 *
 * For singleton/ephemeral UI state (net status+latency, FPS/mem, wave timer), model
 * it as a component on a reserved singleton entity and read it keyless via per-field
 * channels — NOT a separate reactive-resource subsystem:
 *   - `syncSingletonToStruct(def, eid, [fields])` — one singleton entity → `reactiveStruct`.
 *   - `syncSingletonToArray(def, eid, [fields])` — one singleton entity → `reactiveArray` (ordered slots).
 *
 * The framework-agnostic counterpart to the Solid leaf: pair the map entry points
 * with `@oasys/oecs/solid`'s `fromKernelMap`, the singleton struct with
 * `fromKernelStruct`, and the singleton array with `fromKernelArray`, to render.
 */
export {
	syncComponentToMap,
	syncFieldsToMap,
	syncJoinToMap,
	syncSingletonToStruct,
	syncSingletonToArray,
	batchedUpdate,
	shallow,
	type Projection,
	type JoinProjection,
	type RowReader,
	type JoinReader,
	type SyncGrain,
	type EcsMapSync,
	type EcsMapSyncOptions,
	type SingletonStructSync,
	type SingletonSyncOptions,
	type SingletonArraySync,
	type SingletonArraySyncOptions
} from "./ecs_sync";
