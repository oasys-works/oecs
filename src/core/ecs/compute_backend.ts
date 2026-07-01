/**
 * ComputeBackend — the engine's generic, opt-in compute-backend seam (#622).
 *
 * A `ComputeBackend` is a pluggable implementation that can execute a
 * registered system's body *instead of* its TypeScript closure. The engine
 * stays totally ignorant of what the backend is or computes: it only ever
 * (a) republishes the SAB layout to it (via the inherited `StoreLayoutListener`)
 * and (b) asks it to run a system identified by an **opaque** handle the
 * backend itself minted. There is **no** game vocabulary on this surface — no
 * `tick_*`, no component names, no opcodes.
 *
 * "No backend attached" is the default, first-class state: a bare `ECS` runs
 * pure-TS systems and pays nothing for this seam. A backend is attached opt-in
 * via `ECS.attachBackend(...)`, and a system opts a *single* system into
 * backend execution by carrying a `backendHandle` on its `SystemConfig`
 * (`packages/engine/src/core/ecs/system.ts`). When a backend is attached and a
 * scheduled system carries a handle, the `Schedule` dispatches
 * `backend.run(handle)`; otherwise it runs the system's `fn` closure (the
 * default / fallback path).
 *
 * Prior art — this is descriptor-level routing with a default fallback, the
 * shape every mature system in this space converges on:
 *   - flecs `ecs_system_desc_t.run` (`NULL` ⇒ the default runner is used) — the
 *     near-exact analog: an optional override on the system descriptor.
 *   - Unity DOTS `ISystem` (Burst-native) vs `SystemBase` (managed) — the
 *     backend is a property of the system; the scheduler routes.
 *   - ONNX Runtime execution providers / PyTorch's dispatcher boxed fallback —
 *     the framework owns routing and a default guarantees completeness.
 * See `docs/reports/bench/` for the dispatch microbench that picked the explicit
 * `backend === null` fast-path branch over a Null-Object default (the latter
 * needlessly taxes the no-backend common case).
 */

import { Brand } from "../../type_primitives";
import type { StoreLayoutListener } from "./store_layout_listener";

/**
 * An opaque token identifying one of a backend's entry points (one
 * "backend-system"). The engine **never interprets** it — the backend mints it
 * and is the only thing that maps it back to a concrete computation. Carried on
 * `SystemConfig.backendHandle` and handed verbatim to `ComputeBackend.run`.
 *
 * Branded so a stray `number` can't be mistaken for a handle; consumers mint
 * one by casting (the backend owns the id space, like flecs's `run` function
 * pointer or a small index into the backend's entry table).
 */
export type BackendSystemHandle = Brand<number, "backend_system_handle">;

/**
 * The engine-side contract a compute backend implements. Composes
 * `StoreLayoutListener` (the already-clean SAB handshake — `setLayout` is called
 * once on attach to seed the layout and again after every SAB grow/extend) with
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
	 * `accessCheck` span — so the system's declared `writes` authorise whatever
	 * shared-memory columns the backend mutates, exactly as a TS body that calls
	 * out to the backend would be authorised today.
	 *
	 * `handle` is opaque to the engine; it is one the backend minted and the
	 * engine merely round-trips from `SystemConfig.backendHandle`.
	 */
	run(handle: BackendSystemHandle): void;
}
