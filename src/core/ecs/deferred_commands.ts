/***
 * DeferredCommandBuffer — deferred structural-command queue + drain policy.
 *
 * Owns the flat parallel pending buffers (no per-operation object allocation)
 * and the *transaction semantics* of the phase flush: the no-observer fast
 * path, the observed fixed-point loop with its round-robin drain policy
 * (adds/removes → destroys → toggles), the convergence guard, and the
 * re-entrancy flag. The four batch *appliers* stay on `Store` (reached via
 * the closure host below): they are archetype-transition logic entangled
 * with the graph, the 0-crossing dirty bookkeeping, and observer event
 * collection — they belong with that machinery, not with the queue.
 *
 * Ordering invariants the drain policy encodes (owned here, verbatim from
 * the pre-extraction `Store.flushStructural`):
 *  - adds/removes settle before destroys, so an explicit remove's onRemove
 *    fires with the entity live (the original behavior is preserved);
 *  - destroys settle before toggles, so a toggle sees its entity's final
 *    archetype for the tick;
 *  - each observed round dispatches only effective transitions, and any
 *    structural op a callback enqueues is re-settled by a later round, up
 *    to the OBSERVER_MAX_ROUNDS runaway guard.
 */

import type { ComponentDef } from "./component";
import type { EntityID } from "./entity";
import type { StructuralObserverEvents } from "./store";
import { ECS_ERROR, ECSError } from "./utils/error";

/** Runaway guard for the observer cascade fixed point (`flushStructural`). A
 * legitimate cascade settles in a handful of rounds; exceeding this many almost
 * certainly means two observers ping-pong forever (A adds B, B's observer adds
 * A). Throws `OBSERVER_NON_CONVERGENT`. */
const OBSERVER_MAX_ROUNDS = 1 << 16;

/** What the drain policy needs from `Store` — closure-injected (the
 * `RelationServiceHost` style) so nothing new goes public on `Store`. All
 * calls are flush-granularity, never per-entity. */
export interface DeferredCommandHost {
	/** Drain + apply the pending component additions. Each applier fully
	 * drains its buffer(s) and owns its dirty/0-crossing bookkeeping. */
	readonly applyAdds: () => void;
	readonly applyRemoves: () => void;
	readonly applyDestroys: () => void;
	readonly applyToggles: () => void;
	/** Hot-path gates — live counts of observed components.
	 * While both are 0 the flush takes the byte-for-byte fast path. */
	readonly structuralObserverCount: () => number;
	readonly toggleObserverCount: () => number;
	/** The observer-registry dispatch hook, or null (ECS installs it after
	 * construction, so it is re-read per flush). */
	readonly structuralObserverHook: () => ((ev: StructuralObserverEvents) => void) | null;
}

export class DeferredCommandBuffer {
	// --- Deferred operation buffers ---
	// Flat parallel arrays: addIds[i], addDefs[i], addValues[i] describe one
	// deferred add. No per-operation object allocation. Public so the Store
	// appliers can drain them with hoisted locals; everything else goes
	// through the queue* methods.
	public readonly destroyIds: EntityID[] = [];
	public readonly addIds: EntityID[] = [];
	public readonly addDefs: ComponentDef[] = [];
	public readonly addValues: Record<string, number>[] = [];
	public readonly removeIds: EntityID[] = [];
	public readonly removeDefs: ComponentDef[] = [];
	// Deferred entity enable/disable. `true` = disable, `false` =
	// enable; entries apply in operation order at flush (idempotent if
	// redundant), so last write per entity wins.
	public readonly toggleIds: EntityID[] = [];
	public readonly toggleDisable: boolean[] = [];

	/** Re-entrancy guard for the observed fixed-point loop. An observer
	 * callback must enqueue and let the loop settle it — a nested
	 * `ctx.flush()` becomes a no-op; the outer loop drains whatever the
	 * callback queued. */
	private _flushing = false;

	private readonly host: DeferredCommandHost;
	/** Shared effective-event scratch, reset per observed round and handed to
	 * the dispatch hook. Owned by `Store` (its appliers collect into it). */
	private readonly obsEvents: StructuralObserverEvents;

	constructor(host: DeferredCommandHost, obsEvents: StructuralObserverEvents) {
		this.host = host;
		this.obsEvents = obsEvents;
	}

	public queueDestroy(id: EntityID): void {
		this.destroyIds.push(id);
	}

	public queueAdd(id: EntityID, def: ComponentDef, values: Record<string, number>): void {
		this.addIds.push(id);
		this.addDefs.push(def);
		this.addValues.push(values);
	}

	public queueRemove(id: EntityID, def: ComponentDef): void {
		this.removeIds.push(id);
		this.removeDefs.push(def);
	}

	public queueToggle(id: EntityID, disable: boolean): void {
		this.toggleIds.push(id);
		this.toggleDisable.push(disable);
	}

	public get destroyCount(): number {
		return this.destroyIds.length;
	}

	public get structuralCount(): number {
		return this.addIds.length + this.removeIds.length;
	}

	public get toggleCount(): number {
		return this.toggleIds.length;
	}

	/** Drain buffered destroys outside the structural flush. No-ops while the
	 * observed fixed point owns the flush — the loop drains destroys itself,
	 * and a re-entrant call would collect into the shared event scratch
	 * mid-dispatch and corrupt it (mirrors the `flushStructural` guard). */
	public flushDestroyed(): void {
		if (this._flushing) return;
		this.host.applyDestroys();
	}

	public flushStructural(): void {
		// Each applier owns its dirty bookkeeping — it captures
		// per-archetype pre-lengths during its loop and settles the
		// row-counts / query-epoch flags from those captures.

		// No-observer fast path — byte-for-byte the original flush. While no
		// onAdd/onRemove/onDisable/onEnable observer is registered we never
		// enter the fixed-point machinery below. The toggle counter
		// joins the gate so a toggle-only consumer still reaches the observed
		// path.
		if (this.host.structuralObserverCount() === 0 && this.host.toggleObserverCount() === 0) {
			if (this.addIds.length > 0) this.host.applyAdds();
			if (this.removeIds.length > 0) this.host.applyRemoves();
			// Toggles last: a disable/enable sees the entity's final archetype
			// for the tick (after any add/remove transition above).
			if (this.toggleIds.length > 0) this.host.applyToggles();
			return;
		}

		// Re-entrant `ctx.flush()` from inside an observer callback — defer to
		// the running fixed-point loop (it will drain whatever the callback
		// queued).
		if (this._flushing) return;

		// Observed path — commit the batch, then fire observers in canonical
		// order, looping to a fixed point so cascades settle. An
		// observer that adds/removes/destroys enqueues onto the (now-drained)
		// deferred buffers; the next round commits + observes them. Observers
		// never see a torn state — they fire only AFTER the commit.
		this._flushing = true;
		const ev = this.obsEvents;
		const hook = this.host.structuralObserverHook();
		try {
			let rounds = 0;
			// Joint fixed point over adds/removes, destroys, AND toggles.
			// Each round runs an add/remove pass; or, once those are quiescent,
			// one destroy pass; or, once destroys are quiescent too, one toggle
			// pass — never more than one kind — so an explicit remove's onRemove
			// still fires with the entity live (the original behavior), a
			// destroy is only drained after no live structural work remains, and
			// a toggle is applied LAST so it sees its entity's final archetype.
			// A destroy fans out to an onRemove per carried component
			// with the entity already freed; a net disable/enable fans
			// out to an onDisable/onEnable per carried component. Any
			// structural op or toggle a callback queues is re-settled by a later
			// round.
			while (
				this.addIds.length > 0 ||
				this.removeIds.length > 0 ||
				this.destroyIds.length > 0 ||
				this.toggleIds.length > 0
			) {
				if (++rounds > OBSERVER_MAX_ROUNDS) {
					throw new ECSError(
						ECS_ERROR.OBSERVER_NON_CONVERGENT,
						`observer cascade did not converge after ${OBSERVER_MAX_ROUNDS} rounds — two observers likely enqueue each other's structural ops forever`
					);
				}
				ev.addLen = 0;
				ev.remLen = 0;
				ev.disLen = 0;
				ev.enaLen = 0;
				if (this.addIds.length > 0 || this.removeIds.length > 0) {
					if (this.addIds.length > 0) this.host.applyAdds();
					if (this.removeIds.length > 0) this.host.applyRemoves();
				} else if (this.destroyIds.length > 0) {
					// Adds/removes quiescent — drain destroys (collects onRemove).
					// Call the applier directly: `flushDestroyed` no-ops while
					// `_flushing` is set (re-entrancy guard).
					this.host.applyDestroys();
				} else {
					// All structural work quiescent — drain toggles (collects
					// onDisable/onEnable for net transitions). Toggles strictly
					// last preserves the "toggle sees final archetype" invariant.
					this.host.applyToggles();
				}
				// Dispatch only effective transitions; a pass of pure no-ops
				// (already-has / already-lacks / dead / component-less destroy /
				// a disable+enable that nets to nothing) fires nothing. We cannot
				// `break` here — another buffer may still hold work — so let the
				// `while` re-check own termination; each pass fully drains at
				// least one buffer.
				if (hook !== null && (ev.addLen > 0 || ev.remLen > 0 || ev.disLen > 0 || ev.enaLen > 0))
					hook(ev);
			}
		} finally {
			this._flushing = false;
		}
	}
}
