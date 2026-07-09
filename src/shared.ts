/**
 * `@oasys/oecs/shared` — the opt-in SharedArrayBuffer / WASM profile.
 *
 * The default `@oasys/oecs` profile runs the column store over a plain
 * fixed `ArrayBuffer` (no cross-origin isolation). This entry surfaces the
 * `SharedArrayBuffer`-backed allocators for worlds that opt into worker offload
 * or a WASM compute backend — construct with `new ECS({ memory: { shared: {} } })`,
 * or pass one of these allocators through `memory: { allocator }`.
 *
 * **Requires cross-origin isolation (COOP/COEP) in browsers** — that's the
 * whole reason it's a separate, opt-in profile.
 *
 * The WASM compute backend itself is NOT bundled here: oecs ships the
 * `ComputeBackend` *seam* (`@oasys/oecs` → `attachBackend`) plus the
 * cross-thread ring transport (`HostCommandDispatcher`). The worker entrypoint
 * and the compiled WASM module are the consumer's to provide.
 *
 * @module
 */
export {
	growableSabAllocator,
	wasmMemoryAllocator,
	DEFAULT_SAB_ALLOCATOR,
	SabUnavailableError
} from "./core/store";
export type { SharedMemoryArm } from "./core/ecs/ecs_memory";
