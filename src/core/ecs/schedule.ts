/***
 * Schedule — System execution lifecycle with topological ordering.
 *
 * Systems are organized into 7 phases:
 *   PRE_STARTUP  → STARTUP → POST_STARTUP  (run once via ecs.startup())
 *   FIXED_UPDATE                            (run at fixed timestep via ecs.update(dt))
 *   PRE_UPDATE   → UPDATE  → POST_UPDATE   (run every frame via ecs.update(dt))
 *
 * Within each phase, systems are topologically sorted using Kahn's
 * algorithm, respecting before/after ordering constraints. Insertion
 * order is used as a stable tiebreaker for deterministic execution.
 *
 * After all systems in a phase complete, SystemContext.flush() is called
 * automatically, applying deferred structural changes before the next phase.
 *
 * The sort result is cached per phase and invalidated when systems are
 * added or removed.
 *
 * Run conditions / system sets. A system (via `SystemEntry.runIf`) or a
 * whole `SystemSet` (via `configureSet`) can carry a `RunCondition` evaluated
 * each tick in canonical order; a `false` verdict skips the body — and leaves
 * the system's last-run tick unadvanced, so a skipped tick is indistinguishable
 * from the system being absent that tick. A `SystemSet` also carries shared
 * `before`/`after` ordering its members inherit (expanded to per-member edges at
 * sort time). A member's effective gate is the AND of its own conditions and
 * every set it belongs to. See `run_condition.ts`.
 *
 * Usage:
 *
 *   ecs.addSystems(SCHEDULE.UPDATE, moveSys, {
 *     system: renderSys,
 *     ordering: { after: [moveSys] },
 *     runIf: runIfResourceEq(PausedRes, false),
 *   });
 *
 ***/

import { topologicalSort } from "../../type_primitives";
import type { SystemContext } from "./query";
import type { SystemDescriptor } from "./system";
import type { ComputeBackend } from "./compute_backend";
import type { RunCondition } from "./run_condition";
import { ECS_ERROR, ECSError } from "./utils/error";
import { STARTUP_DELTA_TIME } from "./utils/constants";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

export enum SCHEDULE {
	PRE_STARTUP = "PRE_STARTUP",
	STARTUP = "STARTUP",
	POST_STARTUP = "POST_STARTUP",
	FIXED_UPDATE = "FIXED_UPDATE",
	PRE_UPDATE = "PRE_UPDATE",
	UPDATE = "UPDATE",
	POST_UPDATE = "POST_UPDATE"
}

const STARTUP_LABELS = [SCHEDULE.PRE_STARTUP, SCHEDULE.STARTUP, SCHEDULE.POST_STARTUP] as const;

const UPDATE_LABELS = [SCHEDULE.PRE_UPDATE, SCHEDULE.UPDATE, SCHEDULE.POST_UPDATE] as const;

/**
 * An opaque handle for a named group of systems. A set carries a shared
 * run condition and shared ordering that every member inherits. Sets are
 * identified by **object identity**, not by name — create one with
 * `systemSet(name)`, hold the handle, and reuse it across `addSystems`
 * (`SystemEntry.set`) and `Schedule.configureSet`. The `name` is for
 * diagnostics only.
 */
export interface SystemSet {
	readonly name: string;
}

/** Create a `SystemSet` handle. Two calls with the same name are two
 * distinct sets — keep the returned handle and pass it around. */
export function systemSet(name: string): SystemSet {
	return Object.freeze({ name });
}

/** A `before`/`after` ordering target: either a concrete system or a whole set
 * (expanded to its members within the same phase at sort time). */
export type SystemOrderingTarget = SystemDescriptor | SystemSet;

/** Shared configuration applied to a `SystemSet` via `configureSet`.
 * Accumulates across calls — conditions AND together, ordering targets union. */
export interface SystemSetConfig {
	/** Condition(s) every member is gated by (ANDed with each member's own). */
	runIf?: RunCondition | readonly RunCondition[];
	/** Every member runs before each of these targets. */
	before?: readonly SystemOrderingTarget[];
	/** Every member runs after each of these targets. */
	after?: readonly SystemOrderingTarget[];
}

export interface SystemOrdering {
	before?: readonly SystemOrderingTarget[];
	after?: readonly SystemOrderingTarget[];
}

export interface SystemEntry {
	system: SystemDescriptor;
	ordering?: SystemOrdering;
	/** Run condition(s) gating just this system — ANDed with any set conditions
	 * it inherits. A `false` verdict skips the body that tick. */
	runIf?: RunCondition | readonly RunCondition[];
	/** Set membership — the system inherits each set's shared condition and
	 * ordering. */
	set?: SystemSet | readonly SystemSet[];
}

/** A phase's execution plan: its topologically sorted systems and, index-aligned,
 * each one's `systemLastRun` slot. Cached as a unit and invalidated together. */
interface PhasePlan {
	readonly sorted: SystemDescriptor[];
	readonly slots: Int32Array;
}

interface SystemNode {
	descriptor: SystemDescriptor;
	insertionOrder: number;
	before: Set<SystemOrderingTarget>;
	after: Set<SystemOrderingTarget>;
	/** This system's OWN run conditions (set conditions are resolved live from
	 * `setConditions` at run time so a later `configureSet` is honored). */
	conditions: readonly RunCondition[];
	/** Sets this system belongs to. */
	sets: readonly SystemSet[];
}

/** A `SystemOrderingTarget` is a set iff it is not a system descriptor; a
 * descriptor always carries `fn` (its update function), a set never does. */
function isSystemSet(target: SystemOrderingTarget): target is SystemSet {
	return !("fn" in target);
}

const EMPTY_ARRAY: readonly never[] = Object.freeze([]);

/** Normalize the `T | readonly T[] | undefined` config shape to a flat array.
 * `Array.isArray` does not narrow `readonly T[]` (TS#17002), so the two `as`
 * casts are the contained normalization boundary. */
function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
	if (value === undefined) return EMPTY_ARRAY;
	return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

export class Schedule {
	private readonly labelSystems: Map<SCHEDULE, SystemNode[]> = new Map();
	// Sorted descriptors for a phase, paired with the `systemLastRun` slot of each
	// — cached together so `runLabel` resolves both with the one `Map.get` it
	// already paid, and the per-system lookup inside the loop is array indexing.
	private readonly sortedCache: Map<SCHEDULE, PhasePlan> = new Map();
	private readonly systemIndex: Map<SystemDescriptor, SCHEDULE> = new Map();
	// Previous-run tick per scheduled system — a packed array, NOT a `Map` keyed
	// on the descriptor. `runLabel` reads it and writes it back once per system
	// per phase. A profile of a dispatch-bound schedule shows that those two `Map`
	// operations, and not the system bodies, are where most of the phase loop goes
	// — they hash an object identity twice for each system in each frame.
	//
	// Indexed by a SCHEDULE-LOCAL slot, not by `SystemDescriptor.id`. Ids come
	// from a per-world counter, so two descriptors registered with two different
	// worlds both get id 0 — scheduling them into a third world would alias them
	// onto one slot and let the system that runs more often overwrite the other's
	// last-run tick (silently widening its `changed()` window). Slots are handed
	// out per Schedule, so identity comes from this schedule's own numbering.
	private readonly systemLastRun: number[] = [];
	// Descriptor → its `systemLastRun` slot. Consulted only by `addSystems` /
	// `removeSystem`; the run loop never touches it (the slot travels in the
	// phase plan).
	//
	// `removeSystem` MUST delete from this map. It is the only strong reference
	// the Schedule keeps to a descriptor once its node is gone, and a descriptor
	// closes over whatever its `fn` captured — leaving the entry behind pins that
	// for the world's lifetime. (The `Map` this replaced was deleted on remove;
	// forgetting to do the same here leaked every descriptor ever scheduled.)
	private readonly lastRunSlots: Map<SystemDescriptor, number> = new Map();
	// Slots freed by `removeSystem`, handed back out by `_assignLastRunSlot`.
	// Without reuse the array would grow by one per `addSystems` call — unbounded
	// under a workload that toggles systems on and off each frame.
	private readonly freeLastRunSlots: number[] = [];
	// Nesting depth of a drive (`runStartup` / `runUpdate` / `runFixedUpdate`).
	// Non-zero means a phase plan is live and `runLabel`'s loop may still write
	// `systemLastRun` through the `slots` array it captured, which is what makes
	// recycling a freed slot unsafe right now — see `_assignLastRunSlot`.
	private _driveDepth = 0;
	// Only systems carrying a run condition or set membership. The hot
	// loop skips the per-system gate probe entirely when this is empty, so a
	// schedule that uses no conditions runs byte-for-byte the original path.
	private readonly gatedSystems: Map<SystemDescriptor, SystemNode> = new Map();
	// Live set configuration, read at sort time (ordering) and run time
	// (conditions) so `configureSet` is order-independent w.r.t. `addSystems`.
	private readonly setConditions: Map<SystemSet, RunCondition[]> = new Map();
	private readonly setOrdering: Map<
		SystemSet,
		{ before: Set<SystemOrderingTarget>; after: Set<SystemOrderingTarget> }
	> = new Map();
	private nextInsertionOrder = 0;
	// The opt-in compute backend, or null (the default — pure-TS). When
	// set, a scheduled system carrying a `backendHandle` runs `backend.run(...)`
	// instead of its `fn`. `null` is the byte-for-byte no-backend path: `runLabel`
	// hoists this to a local and only reads `desc.backendHandle` when non-null,
	// so a no-backend ECS never touches the routing field.
	private _backend: ComputeBackend | null = null;

	/** Dev-diagnostic sink (`ECSOptions.onWarn`); defaults to `console.warn`.
	 * The only schedule diagnostic today is `warnDroppedEdge`. */
	private readonly onWarn: (message: string) => void;

	/** The `FIXED_UPDATE` node list, held directly for `hasFixedSystems`. */
	private readonly _fixedNodes: SystemNode[] = [];

	constructor(onWarn?: (message: string) => void) {
		this.onWarn = onWarn ?? ((message) => console.warn(message));
		for (let i = 0; i < STARTUP_LABELS.length; i++) {
			this.labelSystems.set(STARTUP_LABELS[i], []);
		}
		this.labelSystems.set(SCHEDULE.FIXED_UPDATE, this._fixedNodes);
		for (let i = 0; i < UPDATE_LABELS.length; i++) {
			this.labelSystems.set(UPDATE_LABELS[i], []);
		}
	}

	public addSystems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): void {
		for (const entry of entries) {
			const isEntry = "system" in entry;
			const descriptor = isEntry ? entry.system : entry;
			const ordering = isEntry ? entry.ordering : undefined;
			const conditions = isEntry ? toArray(entry.runIf) : EMPTY_ARRAY;
			const sets = isEntry ? toArray(entry.set) : EMPTY_ARRAY;

			if (DEV) {
				if (this.systemIndex.has(descriptor)) {
					throw new ECSError(
						ECS_ERROR.DUPLICATE_SYSTEM,
						`System ${descriptor.name ?? descriptor.id} is already scheduled`
					);
				}
			}

			const node: SystemNode = {
				descriptor,
				insertionOrder: this.nextInsertionOrder++,
				before: new Set(ordering?.before ?? []),
				after: new Set(ordering?.after ?? []),
				conditions,
				sets
			};

			// ! safe: constructor pre-populates all SCHEDULE enum keys
			this.labelSystems.get(label)!.push(node);
			this.systemIndex.set(descriptor, label);
			this._assignLastRunSlot(descriptor);
			// A system is "gated" if it carries its own condition OR belongs to a
			// set (the set may be — or later become — conditioned). Ungated systems
			// never enter `gatedSystems`, preserving the no-condition fast path.
			if (conditions.length > 0 || sets.length > 0) {
				this.gatedSystems.set(descriptor, node);
			}
			this.sortedCache.delete(label);
		}
	}

	/**
	 * Configure a `SystemSet` — its shared run condition(s) and/or
	 * ordering, inherited by every member. Additive and order-independent w.r.t.
	 * `addSystems`: conditions accumulate (ANDed), ordering targets union, and
	 * a member added before or after this call picks the configuration up.
	 */
	public configureSet(set: SystemSet, config: SystemSetConfig): void {
		const newConditions = toArray(config.runIf);
		if (newConditions.length > 0) {
			const existing = this.setConditions.get(set);
			if (existing === undefined) {
				this.setConditions.set(set, [...newConditions]);
			} else {
				existing.push(...newConditions);
			}
		}

		if (config.before !== undefined || config.after !== undefined) {
			let ord = this.setOrdering.get(set);
			if (ord === undefined) {
				ord = { before: new Set(), after: new Set() };
				this.setOrdering.set(set, ord);
			}
			for (const t of config.before ?? EMPTY_ARRAY) ord.before.add(t);
			for (const t of config.after ?? EMPTY_ARRAY) ord.after.add(t);
			// Ordering feeds the topo sort. Sets are configured at setup time
			// (rarely), so clear every cached order rather than tracking which
			// labels this set's members span — simpler and cheap.
			this.sortedCache.clear();
		}
	}

	public removeSystem(system: SystemDescriptor): void {
		const label = this.systemIndex.get(system);
		if (label === undefined) return;

		// ! safe: label came from systemIndex which only stores valid SCHEDULE keys
		const nodes = this.labelSystems.get(label)!;
		const index = nodes.findIndex((n) => n.descriptor === system);
		if (index !== -1) {
			// Swap-and-pop removal
			const last = nodes.length - 1;
			if (index !== last) {
				nodes[index] = nodes[last];
			}
			nodes.pop();

			// Clean up ordering references from remaining nodes
			for (const node of nodes) {
				node.before.delete(system);
				node.after.delete(system);
			}
		}

		this.systemIndex.delete(system);
		const removedSlot = this.lastRunSlots.get(system);
		if (removedSlot !== undefined) {
			this.systemLastRun[removedSlot] = 0;
			// Drop the descriptor reference (see `lastRunSlots`) and recycle the slot.
			// Safe to offer it back unconditionally: `_assignLastRunSlot` decides
			// whether taking it is safe *right now* (it isn't while a phase's captured
			// plan is still writing through it — see the `_driveDepth` guard there).
			this.lastRunSlots.delete(system);
			this.freeLastRunSlots.push(removedSlot);
		}
		this.gatedSystems.delete(system);
		// A dangling descriptor target left inside a `setOrdering` entry is
		// harmless — `sortSystems` drops any ordering target not present in the
		// phase — so it needs no per-remove sweep across every set.
		//
		// Clear EVERY phase plan, not just this label's: the slot just recycled is
		// about to be handed to a different descriptor, and a *cached* plan still
		// holding it would alias the two systems' last-run ticks. One label's plan is
		// all that can hold it while a descriptor lives in exactly one label — but
		// that invariant is only enforced under `DEV` (the duplicate-schedule throw
		// in `addSystems`), and slot reuse is not something to leave resting on a
		// check that is compiled out of production. `removeSystem` is cold and there
		// are seven plans; re-sorting them is not worth reasoning about.
		//
		// This only reaches CACHED plans. The one a currently-running phase already
		// hoisted into a local is unreachable from here, and that window is covered
		// by `_driveDepth` in `_assignLastRunSlot` instead.
		this.sortedCache.clear();
	}

	/** Attach (or, with `null`, detach) the opt-in compute backend. Driven
	 * by `ECS.attachBackend`; routes any scheduled system carrying a
	 * `backendHandle` to `backend.run(handle)` in place of its `fn`. */
	public setBackend(backend: ComputeBackend | null): void {
		this._backend = backend;
	}

	// The three drive entry points each bracket their phases with `_driveDepth`,
	// so `_assignLastRunSlot` will not recycle a `systemLastRun` slot that a phase
	// plan captured by `runLabel`'s loop may still write to — see the guard there
	// for the hazard it closes.
	//
	// Held across the WHOLE drive, not per phase: one `try`/`finally` per frame
	// instead of one per phase (three, for an update). The difference is
	// measurable on a dispatch-bound schedule, where the system bodies do almost
	// no work. The wider window is also the more
	// conservative one, and slots still recycle freely between frames — the only
	// property `freeLastRunSlots` needs to stay bounded. Written out at each of
	// the three sites rather than wrapped in a helper taking a callback, which
	// would put a closure allocation and an indirect call on the per-frame path.

	public runStartup(ctx: SystemContext, tick: number): void {
		this._driveDepth++;
		try {
			for (const label of STARTUP_LABELS) {
				this.runLabel(label, ctx, STARTUP_DELTA_TIME, tick);
			}
		} finally {
			this._driveDepth--;
		}
	}

	public runUpdate(ctx: SystemContext, deltaTime: number, tick: number): void {
		this._driveDepth++;
		try {
			for (const label of UPDATE_LABELS) {
				this.runLabel(label, ctx, deltaTime, tick);
			}
		} finally {
			this._driveDepth--;
		}
	}

	public runFixedUpdate(ctx: SystemContext, fixedDt: number, tick: number): void {
		this._driveDepth++;
		try {
			this.runLabel(SCHEDULE.FIXED_UPDATE, ctx, fixedDt, tick);
		} finally {
			this._driveDepth--;
		}
	}

	public hasFixedSystems(): boolean {
		// Direct reference, not `labelSystems.get(FIXED_UPDATE)`: `ECS.update`
		// asks this once per frame before any phase runs, and a string-keyed
		// `Map.get` there is measurable on a dispatch-bound tick. The list object is
		// created once in the constructor and never replaced (`clear` truncates
		// it in place), so the cached reference can't go stale.
		return this._fixedNodes.length > 0;
	}

	public getAllSystems(): SystemDescriptor[] {
		const all: SystemDescriptor[] = [];
		for (const nodes of this.labelSystems.values()) {
			for (const node of nodes) {
				all.push(node.descriptor);
			}
		}
		return all;
	}

	public hasSystem(system: SystemDescriptor): boolean {
		return this.systemIndex.has(system);
	}

	/** Hand `descriptor` its `systemLastRun` slot, keeping the array packed (no
	 * holes ⇒ no undefined-check on the read in `runLabel`, which is the whole
	 * point of it not being a `Map`). Idempotent for a descriptor already in this
	 * schedule — `getSorted` re-asks for every system it sorts. A descriptor that
	 * was removed and re-added gets a *fresh* slot starting at tick 0, which is
	 * what the previous `Map`-based bookkeeping did (`delete` on remove, `set(…, 0)`
	 * on re-add). */
	private _assignLastRunSlot(descriptor: SystemDescriptor): number {
		let slot = this.lastRunSlots.get(descriptor);
		if (slot === undefined) {
			// Recycle only OUTSIDE a running drive. `runLabel` hoists its plan's
			// `slots` into a local and writes `systemLastRun[slots[i]] = tick` after
			// each system, so a phase already in its loop keeps writing through the
			// slots it captured even after `removeSystem` clears `sortedCache`. Handing
			// one of those to a system added during that same phase would let the
			// removed system's tail write land on the NEW system's last-run tick and
			// silently widen or shift its `changed()` window — cross-talk the `Map`
			// this replaced could not produce (it just re-added a deleted entry).
			// Reachable: an observer or a teardown helper like
			// `uninstallHostCommandSeam` removes and re-adds systems from inside a
			// phase. `_assignLastRunSlot` zeroing a reused slot only half-covers it —
			// the removed system need merely run AFTER the re-add.
			//
			// The slot stays on the free list and is reused by the next add outside a
			// drive, so this costs at most one extra `systemLastRun` entry per
			// mid-drive add — bounded, and on a cold path.
			const reused = this._driveDepth === 0 ? this.freeLastRunSlots.pop() : undefined;
			if (reused !== undefined) {
				slot = reused;
				this.systemLastRun[slot] = 0;
			} else {
				slot = this.systemLastRun.length;
				this.systemLastRun.push(0);
			}
			this.lastRunSlots.set(descriptor, slot);
		}
		return slot;
	}

	public clear(): void {
		for (const nodes of this.labelSystems.values()) {
			nodes.length = 0;
		}
		this.sortedCache.clear();
		this.systemIndex.clear();
		// Truncating is right between drives, and it is what `clear` normally
		// does. Inside one it is not: `ECS.dispose` reaches here from a system
		// body, and the phase that called that system keeps running the plan it
		// already captured — so `runLabel` still indexes `systemLastRun[slots[i]]`
		// for every system after this point. A truncated array reads `undefined`
		// there and publishes it as `ctx.lastRunTick`, which the `Map` this
		// replaced could not do (it fell back to 0). Zeroing in place keeps every
		// live slot a number and matches the tick a fresh slot would carry.
		//
		// The array then keeps its length, so the next `_assignLastRunSlot` starts
		// numbering above the dead entries. That wastes at most one entry per
		// system that existed before the clear, once, on a path that is tearing
		// the world down anyway.
		if (this._driveDepth === 0) this.systemLastRun.length = 0;
		else this.systemLastRun.fill(0);
		this.lastRunSlots.clear();
		this.freeLastRunSlots.length = 0;
		this.gatedSystems.clear();
		this.setConditions.clear();
		this.setOrdering.clear();
	}

	private runLabel(label: SCHEDULE, ctx: SystemContext, deltaTime: number, tick: number): void {
		const plan = this.getSorted(label);
		const sorted = plan.sorted;
		const slots = plan.slots;
		// Probe the gate map only when something in the whole schedule is gated.
		const hasGates = this.gatedSystems.size > 0;
		// Hoist the backend once per phase (constant across the loop). `null` is the
		// common case (no backend attached); then `backendHandle` is never read and
		// the dispatch is byte-for-byte the plain `desc.fn(ctx, dt)` path. The
		// `=== null` check is a perfectly-predicted branch. A measurement of the
		// dispatch shows that this branch is free against the baseline, and that a
		// Null-Object default makes this no-backend path slower.
		const backend = this._backend;
		// A SystemSet's run conditions gate the set as a unit. Evaluate each
		// set's conditions at most once per phase and reuse the verdict for every
		// member, instead of re-evaluating per member. Run conditions are pure reads
		// and deferred changes aren't flushed until the phase ends, so the memo is
		// observationally identical within a phase while removing the N×-per-set work.
		const setVerdicts: Map<SystemSet, boolean> | undefined = hasGates
			? new Map()
			: undefined;
		// `slots` is a snapshot: a `removeSystem` from inside a system clears
		// `sortedCache`, but this loop keeps running — and keeps writing back through
		// — the plan it already captured. The caller (`runStartup` / `runUpdate` /
		// `runFixedUpdate`) holds `_driveDepth` for the whole drive, which is what
		// stops `_assignLastRunSlot` handing a slot this loop still writes to a
		// system added mid-phase.
		for (let i = 0; i < sorted.length; i++) {
			const desc = sorted[i];
			if (hasGates) {
				const node = this.gatedSystems.get(desc);
				// A false run condition skips the body in canonical order, AND
				// leaves last_run unadvanced + enqueues nothing — so a skipped tick is
				// indistinguishable from the system being absent that tick (the
				// `stateHash` equality the acceptance requires).
				if (node !== undefined && !this.shouldRun(node, ctx, setVerdicts!)) continue;
			}
			// lastRunTick exposes the system's *previous* run tick to ChangedQuery,
			// so q.changed(C) sees writes made since this system last ran (cross-tick).
			ctx.lastRunTick = this.systemLastRun[slots[i]];
			// Route to the compute backend only when one is attached AND this
			// system opted in via `backendHandle`; otherwise run the TS closure. The
			// access span wraps either path identically, so the system's declared
			// `writes` authorise whatever shared memory the backend touches.
			const handle = backend !== null ? desc.backendHandle : undefined;
			if (DEV) accessCheck.enter(desc);
			if (DEV) ctx._trace?.systemStart(desc, label);
			try {
				if (handle !== undefined) backend!.run(handle);
				else desc.fn?.(ctx, deltaTime);
			} finally {
				if (DEV) ctx._trace?.systemEnd(desc);
				if (DEV) accessCheck.leave();
			}
			this.systemLastRun[slots[i]] = tick;
		}
		// Flush deferred changes after each phase so the next phase sees a consistent state
		if (DEV) ctx._trace?.flushBegin(label);
		ctx.flush();
		if (DEV) ctx._trace?.flushEnd(label);
		// The phase has fully settled — systems ran, deferred buffer + observer
		// cascade flushed — so the live world is at a consistent, fingerprint-able
		// point. Fire the per-phase boundary so a consumer can read `stateHash()`
		// between the phases of one frame and bisect a divergence to this phase.
		// `DEV`-gated like the rest of the seam (zero prod
		// cost) and read-only, so it never perturbs the hash or ordering.
		if (DEV) ctx._trace?.phaseBoundary(label);
	}

	/**
	 * Whether a gated system runs this tick — the AND of its own conditions and
	 * every set it belongs to. A set's conditions are evaluated at most once per
	 * phase (memoized in `setVerdicts`) and the verdict gates every member of the
	 * set uniformly; a `configureSet` between phases is still honored because the
	 * memo lives only for a single `runLabel` pass. Short-circuits on the first
	 * `false`. The system's own conditions evaluate per system, in canonical order.
	 *
	 * SEMANTIC NOTE: this evaluates a set's conditions once-per-set-per-phase
	 * rather than once-per-member. Equivalent for pure RunConditions; observably
	 * different only if a set condition reads state mutated earlier in the SAME
	 * phase (resources write immediately). That is intentional — the set gates as a
	 * unit, so all its members share one verdict for the phase.
	 */
	private shouldRun(
		node: SystemNode,
		ctx: SystemContext,
		setVerdicts: Map<SystemSet, boolean>
	): boolean {
		if (node.conditions.length > 0 && !this.evalConditions(node.conditions, ctx)) {
			return false;
		}
		for (let s = 0; s < node.sets.length; s++) {
			const set = node.sets[s];
			let verdict = setVerdicts.get(set);
			if (verdict === undefined) {
				const setConds = this.setConditions.get(set);
				verdict =
					setConds === undefined || setConds.length === 0
						? true
						: this.evalConditions(setConds, ctx);
				setVerdicts.set(set, verdict);
			}
			if (!verdict) return false;
		}
		return true;
	}

	/** Evaluate a condition list with AND semantics. Each predicate runs inside a
	 * reads-only `accessCheck` span (dev), so a condition that reads an
	 * undeclared resource — or attempts any mutation — throws. */
	private evalConditions(conditions: readonly RunCondition[], ctx: SystemContext): boolean {
		for (let i = 0; i < conditions.length; i++) {
			const cond = conditions[i];
			if (DEV) accessCheck.enterCondition(cond);
			let ok: boolean;
			try {
				ok = cond.evaluate(ctx);
			} finally {
				if (DEV) accessCheck.leave();
			}
			if (!ok) return false;
		}
		return true;
	}

	private getSorted(label: SCHEDULE): PhasePlan {
		const cached = this.sortedCache.get(label);
		if (cached !== undefined) return cached;

		// ! safe: constructor pre-populates all SCHEDULE enum keys
		const nodes = this.labelSystems.get(label)!;
		const sorted = this.sortSystems(nodes, label);
		const slots = new Int32Array(sorted.length);
		for (let i = 0; i < sorted.length; i++) slots[i] = this._assignLastRunSlot(sorted[i]);
		const plan: PhasePlan = { sorted, slots };
		this.sortedCache.set(label, plan);
		return plan;
	}

	/**
	 * Delegates to the shared topologicalSort utility.
	 * Builds the dependency edge map from before/after constraints, then
	 * catches any cycle TypeError and re-throws as ECSError.
	 */
	private sortSystems(nodes: SystemNode[], label: SCHEDULE): SystemDescriptor[] {
		if (nodes.length === 0) return [];

		const descriptors: SystemDescriptor[] = [];
		const insertionOrder = new Map<SystemDescriptor, number>();
		const nodeSet = new Set<SystemDescriptor>();
		// set → its member descriptors *within this phase*. Cross-phase
		// members are absent, so set ordering stays phase-local like system
		// ordering — a set referenced from another phase expands to nothing here.
		const setMembers = new Map<SystemSet, SystemDescriptor[]>();

		for (const node of nodes) {
			descriptors.push(node.descriptor);
			insertionOrder.set(node.descriptor, node.insertionOrder);
			nodeSet.add(node.descriptor);
			for (let s = 0; s < node.sets.length; s++) {
				const set = node.sets[s];
				let members = setMembers.get(set);
				if (members === undefined) {
					members = [];
					setMembers.set(set, members);
				}
				members.push(node.descriptor);
			}
		}

		// Build adjacency list: edges.get(a) = list of nodes that must come after a
		const edges = new Map<SystemDescriptor, SystemDescriptor[]>();
		for (const node of nodes) {
			edges.set(node.descriptor, []);
		}

		// ! safe: all descriptors were inserted into edges above;
		// nodeSet guards skip descriptors from other labels
		for (const node of nodes) {
			// Effective ordering = the system's own before/after PLUS the
			// before/after of every set it belongs to. Set conditions gate
			// at run time; set *ordering* expands here into per-member edges.
			this.resolveEdges(
				node.descriptor,
				node.before,
				"before",
				nodeSet,
				setMembers,
				edges,
				label
			);
			this.resolveEdges(node.descriptor, node.after, "after", nodeSet, setMembers, edges, label);
			for (let s = 0; s < node.sets.length; s++) {
				const ord = this.setOrdering.get(node.sets[s]);
				if (ord === undefined) continue;
				this.resolveEdges(
					node.descriptor,
					ord.before,
					"before",
					nodeSet,
					setMembers,
					edges,
					label
				);
				this.resolveEdges(
					node.descriptor,
					ord.after,
					"after",
					nodeSet,
					setMembers,
					edges,
					label
				);
			}
		}

		// ! safe: all descriptors were seeded into insertionOrder map above
		const tiebreaker = (a: SystemDescriptor, b: SystemDescriptor) =>
			insertionOrder.get(a)! - insertionOrder.get(b)!;

		const nodeName = (d: SystemDescriptor) => d.name ?? `system_${d.id}`;

		try {
			return topologicalSort(descriptors, edges, tiebreaker, nodeName);
		} catch (err) {
			if (err instanceof TypeError) {
				throw new ECSError(
					ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY,
					`Circular system dependency detected in ${label}: ${err.message}`
				);
			}
			throw err;
		}
	}

	/**
	 * Add the topo edges for one ordering list. For `"before"` the source
	 * runs before each target (edge source→target); for `"after"` it runs after
	 * each target (edge target→source). A `SystemSet` target expands to every
	 * member within this phase (self-edges skipped, so a member ordered against
	 * its own set is a no-op); a descriptor target absent from this phase is
	 * dropped — with a dev warning only for a concrete system, since a set
	 * legitimately expands to nothing when its members live in another phase.
	 */
	private resolveEdges(
		source: SystemDescriptor,
		targets: Iterable<SystemOrderingTarget>,
		direction: "before" | "after",
		nodeSet: Set<SystemDescriptor>,
		setMembers: Map<SystemSet, SystemDescriptor[]>,
		edges: Map<SystemDescriptor, SystemDescriptor[]>,
		label: SCHEDULE
	): void {
		for (const target of targets) {
			if (isSystemSet(target)) {
				const members = setMembers.get(target);
				if (members === undefined) continue; // no members in this phase
				for (let i = 0; i < members.length; i++) {
					const member = members[i];
					if (member === source) continue; // skip self
					this.addDirectedEdge(source, member, direction, edges);
				}
				continue;
			}
			if (!nodeSet.has(target)) {
				if (DEV) this.warnDroppedEdge(source, target, direction, label);
				continue;
			}
			this.addDirectedEdge(source, target, direction, edges);
		}
	}

	/** Push one directed edge into the adjacency map. Both endpoints are known to
	 * be in this phase (callers guard), so `edges.get(...)` is non-null. */
	private addDirectedEdge(
		source: SystemDescriptor,
		target: SystemDescriptor,
		direction: "before" | "after",
		edges: Map<SystemDescriptor, SystemDescriptor[]>
	): void {
		if (direction === "before") {
			// source runs before target → target depends on source.
			edges.get(source)!.push(target);
		} else {
			// source runs after target → source depends on target.
			edges.get(target)!.push(source);
		}
	}

	/**
	 * Dev-only diagnostic for an ordering edge that was dropped during sort.
	 *
	 * Cross-label ordering is impossible by design (`nodeSet` is per-label), so
	 * a target registered in *another* phase is skipped silently — that's the
	 * intended isolation. But a target unknown to *every* phase is almost
	 * certainly a typo or a system that was never scheduled; without this warning
	 * the constraint vanishes and the system runs in insertion-order tiebreak as
	 * if unconstrained, with nothing to distinguish mistake from intent. Compiled
	 * out of production builds by the `DEV` guards at the call sites.
	 */
	private warnDroppedEdge(
		source: SystemDescriptor,
		target: SystemDescriptor,
		relation: "before" | "after",
		label: SCHEDULE
	): void {
		// Registered in some other phase → deliberate cross-label skip, stay quiet.
		if (this.systemIndex.has(target)) return;

		const name = (d: SystemDescriptor) => d.name ?? `system_${d.id}`;
		this.onWarn(
			`Schedule[${label}]: \`${name(source)}\` declares \`${relation}\` ordering against ` +
				`\`${name(target)}\`, which is not registered in any phase — the constraint is ignored. ` +
				`Check for a typo or a missing add_systems() call.`
		);
	}
}
