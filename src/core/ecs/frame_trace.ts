/**
 * Per-world, per-frame structured trace seam.
 *
 * A `FrameTraceSink` is a push interface the engine fires at well-defined points
 * inside one `ecs.update(dt)` so a consumer can reconstruct exactly what
 * travelled through the ECS that single frame: which systems ran (per phase, in
 * topo order), the structural commands each queued (`ctx.commands.*`), the flush
 * boundaries, the per-phase settle points (`phaseBoundary`, the safe seam for an
 * in-frame `stateHash`), which observers fired in response, and
 * which events emitted/read.
 *
 * Unlike the global, callsite-keyed, count-aggregating `dispatchTrace` (this
 * dir), a `FrameTraceSink` is **per-world** and **ordered**: it captures the
 * causal sequence of one frame, not a population of dispatch counts. The two
 * answer different questions.
 *
 * Cost model: every call site is `if (DEV) store._trace?.…`, so a production
 * build dead-code-eliminates the whole branch — byte-identical to the existing
 * `if (DEV) accessCheck.enter(desc)` wrap it sits beside. The only un-gated
 * residue is the one nullable `Store._trace` field (a pointer, like
 * `_structuralObserverHook`). The seam only *reads*; it never perturbs
 * `stateHash`, ordering, or any observable behaviour.
 *
 * In-memory only — no `node:fs` / `node:path`. This module is transitively
 * reachable from the browser bundle (via core/ecs), so it must stay free of
 * Node built-ins, exactly like `dispatch_trace.ts`.
 */
import type { EntityID } from "./entity";
import type { SystemDescriptor } from "./system";
import type { SCHEDULE } from "./schedule";

/** A deferred structural command issued through `ctx.commands.*` (`query.ts`).
 * `spawn`/`despawn`/`enable`/`disable` carry a `null` component; `add`/`remove`
 * carry the affected component's id. */
export type StructuralOp = "spawn" | "despawn" | "add" | "remove" | "enable" | "disable";

/** An observer edge that fired at a flush (`add`/`remove`/`enable`/`disable`) or
 * at the post-update onSet detection point (`set`). */
export type ObserverOp = "add" | "remove" | "set" | "enable" | "disable";

/**
 * The push sink. All callers are `DEV`-gated, so the methods receive raw ids
 * and descriptor references (no string-building on the hot path); the recorder
 * decides what to retain. Implementations must be side-effect-free with respect
 * to the ECS — they observe, never mutate.
 */
export interface FrameTraceSink {
	/** Opens a frame. Fired first in `ecs.update`, before any phase runs. */
	tickBegin(tick: number, dt: number): void;
	/** Closes the frame opened by `tickBegin` (after onSet + `clearEvents`). */
	tickEnd(tick: number): void;
	/** A scheduled system is about to run, in the given phase. */
	systemStart(system: SystemDescriptor, phase: SCHEDULE): void;
	/** The system that last `systemStart`'d has returned. */
	systemEnd(system: SystemDescriptor): void;
	/** A deferred structural command was enqueued (applied at the next flush). */
	commandQueued(op: StructuralOp, entity: EntityID, component: number | null): void;
	/** The deferred command buffer is about to drain for this phase. */
	flushBegin(phase: SCHEDULE): void;
	/** The deferred command buffer (and any observer cascade) has settled. */
	flushEnd(phase: SCHEDULE): void;
	/**
	 * A schedule phase has fully settled — every system in `phase` ran and the
	 * deferred command buffer (plus any observer cascade) flushed — so the live
	 * world sits at a consistent, fingerprint-able point WITHIN the frame. Fired
	 * once per phase that runs (each startup phase, each fixed step, and each
	 * update phase), immediately after `flushEnd(phase)`.
	 *
	 * This is the blessed seam for a consumer to read `stateHash()` between the
	 * phases of one `update()` and bisect a divergence to the exact phase that
	 * introduced it. `flushEnd` marks the same instant, but it
	 * is an observation of the flush *mechanism*, not a "safe to read consistent
	 * state" contract — so per-phase fingerprinting binds to this method, not to a
	 * flush-internal name. Like every sink method the call is read-only w.r.t. the
	 * ECS: reading `stateHash()` here cannot perturb the per-tick hash or ordering.
	 *
	 * Caveat: the POST_UPDATE boundary fires BEFORE the tick-tail onSet-observer
	 * dispatch + `clearEvents`, so for a world with onSet observers the final
	 * per-tick `stateHash` (after `update()` returns) may differ from the
	 * POST_UPDATE phase hash. A world with no onSet observers reconciles exactly.
	 */
	phaseBoundary(phase: SCHEDULE): void;
	/** An observer callback fired for one entity (`entity === -1` for an
	 * archetype-granular onSet, which has no per-entity id). */
	observerFired(op: ObserverOp, component: number, entity: number, observer: SystemDescriptor): void;
	/** A system emitted an event on `key` (the channel's symbol description). */
	eventEmitted(key: string): void;
	/** A system read an event channel; `count` is how many events it saw. */
	eventRead(key: string, count: number): void;
}

// ---------------------------------------------------------------------------
// The in-tree recorder — buckets the flat event stream into one frame per tick.
// ---------------------------------------------------------------------------

/** One captured event, as plain JSON-serialisable data (string names + numeric
 * ids), so a `FrameTrace[]` streams straight to a browser renderer. */
export type FrameTraceEvent =
	| { readonly kind: "system_start"; readonly system: string; readonly phase: SCHEDULE }
	| { readonly kind: "system_end"; readonly system: string }
	| {
			readonly kind: "command_queued";
			readonly op: StructuralOp;
			readonly entity: number;
			readonly component: number | null;
	  }
	| { readonly kind: "flush_begin"; readonly phase: SCHEDULE }
	| { readonly kind: "flush_end"; readonly phase: SCHEDULE }
	| {
			readonly kind: "observer_fired";
			readonly op: ObserverOp;
			readonly component: number;
			readonly entity: number;
			readonly observer: string;
	  }
	| { readonly kind: "event_emitted"; readonly key: string }
	| { readonly kind: "event_read"; readonly key: string; readonly count: number };

/** One frame's captured internals, in causal order. */
export interface FrameTrace {
	readonly tick: number;
	readonly dt: number;
	readonly events: FrameTraceEvent[];
}

/** Resolve a descriptor to a stable, human-readable label. Named systems show
 * their name; unnamed ones fall back to a synthesized `system#<id>`. */
function labelOf(d: SystemDescriptor): string {
	return d.name ?? `system#${d.id}`;
}

/**
 * The in-tree `FrameTraceSink`. Mirrors `command_log.ts`'s `openTick` /
 * `RecordedTick` shape: `tickBegin` opens a fresh `FrameTrace`, every other
 * method appends to it, `tickEnd` closes it. Events arriving with no open
 * frame (e.g. a stray pre-`update` flush) are ignored rather than throwing —
 * the recorder is a passive observer.
 */
export class FrameTraceRecorder implements FrameTraceSink {
	private readonly _frames: FrameTrace[] = [];
	private _current: FrameTrace | null = null;

	tickBegin(tick: number, dt: number): void {
		const frame: FrameTrace = { tick, dt, events: [] };
		this._current = frame;
		this._frames.push(frame);
	}

	tickEnd(_tick: number): void {
		this._current = null;
	}

	systemStart(system: SystemDescriptor, phase: SCHEDULE): void {
		this._current?.events.push({ kind: "system_start", system: labelOf(system), phase });
	}

	systemEnd(system: SystemDescriptor): void {
		this._current?.events.push({ kind: "system_end", system: labelOf(system) });
	}

	commandQueued(op: StructuralOp, entity: EntityID, component: number | null): void {
		this._current?.events.push({ kind: "command_queued", op, entity, component });
	}

	flushBegin(phase: SCHEDULE): void {
		this._current?.events.push({ kind: "flush_begin", phase });
	}

	flushEnd(phase: SCHEDULE): void {
		this._current?.events.push({ kind: "flush_end", phase });
	}

	/** No-op. The recorder already marks this instant with
	 * `flushEnd`, and a per-phase fingerprint is a consumer concern — the recorder
	 * holds no world reference to hash. The seam exists so a consumer's OWN sink can
	 * run code (e.g. `stateHash()`) at the safe post-flush point; the in-tree
	 * event-stream recorder has nothing to add, so it stays a stream of causal
	 * events, not fingerprints. */
	phaseBoundary(_phase: SCHEDULE): void {}

	observerFired(op: ObserverOp, component: number, entity: number, observer: SystemDescriptor): void {
		this._current?.events.push({
			kind: "observer_fired",
			op,
			component,
			entity,
			observer: labelOf(observer)
		});
	}

	eventEmitted(key: string): void {
		this._current?.events.push({ kind: "event_emitted", key });
	}

	eventRead(key: string, count: number): void {
		this._current?.events.push({ kind: "event_read", key, count });
	}

	/** The captured frames, in `update()` order. */
	frames(): readonly FrameTrace[] {
		return this._frames;
	}

	/** Drop all captured frames (reuse the recorder for a fresh run). */
	reset(): void {
		this._frames.length = 0;
		this._current = null;
	}
}
