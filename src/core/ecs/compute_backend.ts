/**
 * ComputeBackend, the engine's generic, opt-in compute-backend seam.
 *
 * A `ComputeBackend` is a pluggable implementation that can execute a
 * registered system's body *instead of* its TypeScript closure. The engine
 * stays totally ignorant of what the backend is or computes: it only ever
 * (a) republishes the SAB layout to it (via the inherited `StoreLayoutListener`)
 * and (b) asks it to run a system identified by an **opaque** handle the
 * backend itself minted. There is **no** game vocabulary on this surface, no
 * `tick_*`, no component names, no opcodes.
 *
 * "No backend attached" is the default, first-class state: a bare `ECS` runs
 * pure-TS systems and pays nothing for this seam. A backend is attached opt-in
 * via `ECS.attachBackend(...)`, and a system opts a *single* system into
 * backend execution by carrying a `backendHandle` on its `SystemConfig`
 * (see `system.ts`). When a backend is attached and a
 * scheduled system carries a handle, the `Schedule` dispatches
 * `backend.run(handle, deltaTime, tick)`. Otherwise it runs the system's `fn`
 * closure (the default and fallback path).
 *
 * Prior art. This is descriptor-level routing with a default fallback, the
 * shape every mature system in this space converges on:
 *   - flecs `ecs_system_desc_t.run` (`NULL` ⇒ the default runner is used), the
 *     near-exact analog: an optional override on the system descriptor.
 *   - Unity dots `ISystem` (Burst-native) vs `SystemBase` (managed), the
 *     backend is a property of the system. The scheduler routes.
 *   - ONNX Runtime execution providers and PyTorch's dispatcher boxed fallback,
 *     the framework owns routing and a default guarantees completeness.
 * The dispatch keeps an explicit `backend === null` fast-path branch, and not a
 * Null-Object default. A Null-Object default makes the no-backend common case
 * slower, and that case gains nothing in return.
 */

import { Brand } from "../../type_primitives";
import type { StoreLayoutListener } from "./store_layout_listener";

/**
 * An opaque token identifying one of a backend's entry points (one
 * "backend-system"). The engine **never interprets** it, the backend mints it
 * and is the only thing that maps it back to a concrete computation. Carried on
 * `SystemConfig.backendHandle` and handed verbatim to `ComputeBackend.run`.
 *
 * Branded so a stray `number` can't be mistaken for a handle. Consumers mint
 * one by casting (the backend owns the id space, like flecs's `run` function
 * pointer or a small index into the backend's entry table).
 */
export type BackendSystemHandle = Brand<number, "backend_system_handle">;

/**
 * The engine-side contract a compute backend implements. Composes
 * `StoreLayoutListener` (the already-clean SAB handshake, `setLayout` is called
 * once on attach to seed the layout and again after every SAB grow and extend) with
 * a single generic `run` entry point.
 *
 * A backend is attached opt-in via `ECS.attachBackend(backend)`, which also
 * subscribes it as a layout listener, so a backend re-walks the layout on attach
 * and republish for free.
 */
export interface ComputeBackend extends StoreLayoutListener {
	/**
	 * Execute the backend-system identified by `handle`. Called by the
	 * `Schedule` in place of the system's `fn` closure, inside the same
	 * `accessCheck` span, so the system's declared `writes` authorise whatever
	 * shared-memory columns the backend mutates, exactly as a TS body that calls
	 * out to the backend would be authorised today.
	 *
	 * `handle` is opaque to the engine. It is one the backend minted and the
	 * engine merely round-trips from `SystemConfig.backendHandle`.
	 *
	 * `deltaTime` is the seconds the phase runs with, the same value a TS body
	 * receives. A module body needs it, and it is not in the store bytes, so it
	 * travels as a call argument. `tick` is the world's frame tick, the count of
	 * `update()` calls so far, and it is not in the bytes either. A backend that
	 * stamps its own frame state reads it here rather than counting calls, which
	 * would drift on a frame that runs the phase more than once.
	 *
	 * The engine publishes the descriptor row counts before this call when a
	 * mutation left them stale, so a module that walks the descriptors sees the
	 * live row count of every archetype.
	 */
	run(handle: BackendSystemHandle, deltaTime: number, tick: number): void;
}
