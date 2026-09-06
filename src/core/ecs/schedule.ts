/***
 * Schedule. System execution lifecycle with topological ordering.
 *
 * A world starts with seven phases:
 *   PRE_STARTUP  → STARTUP → POST_STARTUP  (run once via ecs.startup())
 *   FIXED_UPDATE                            (run at fixed timestep via ecs.update(dt))
 *   PRE_UPDATE   → UPDATE  → POST_UPDATE   (run every frame via ecs.update(dt))
 *
 * The set is open. `ecs.addPhase(name, { loop, before, after })` adds one more
 * slot to a loop and hands back a `Phase` handle. A plugin owns its own slot
 * that way, instead of contending for insertion order inside a phase the
 * application also writes to. Phases of one loop are topologically sorted the
 * same way systems inside a phase are, with declaration order as the
 * tiebreaker, and the order is resolved once per `addPhase` rather than once
 * per frame.
 *
 * Within each phase, systems are topologically sorted using Kahn's
 * algorithm, respecting before and after ordering constraints. Insertion
 * order is used as a stable tiebreaker for deterministic execution.
 *
 * After all systems in a phase complete, SystemContext.flush() is called
 * automatically, applying deferred structural changes before the next phase.
 *
 * The sort result is cached per phase and invalidated when systems are
 * added or removed.
 *
 * Run conditions and system sets. A system (via `SystemEntry.runIf`) or a
 * whole `SystemSet` (via `configureSet`) can carry a `RunCondition` evaluated
 * each tick in canonical order. A `false` verdict skips the body, and leaves
 * the system's last-run tick unadvanced, so a skipped tick is indistinguishable
 * from the system being absent that tick. A `SystemSet` also carries shared
 * `before` and `after` ordering its members inherit (expanded to per-member edges at
 * sort time). A member's effective gate is the and of its own conditions and
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
import type { SystemContext } from "./system_context";
import type {
	SystemFn, SystemDescriptor } from "./system";
import type { ComputeBackend } from "./compute_backend";
import type { RunCondition } from "./run_condition";
import { ECS_ERROR, ECSError } from "./utils/error";
import { STARTUP_DELTA_TIME } from "./utils/constants";
import { accessCheck } from "./access_check";
import { DEV } from "../../dev_flag";

/** What the schedule needs of a worker pool, and nothing more.
 *
 * The pool ships in the workers plugin, so a class reference here would pull
 * the pool, the plan builder and the node threads shim into every program.
 * This interface is structural, and it erases, so the core graph reaches none
 * of them. `run` answers false below the row threshold, before the kernel is
 * loaded, and after a failed join. Then the sequential body runs. */
export interface RouteDispatch {
	/** `plan` is the opaque value the descriptor carries. The schedule loads
	 * it and passes it on, and only the route reads inside it. Answering false
	 * puts this dispatch back on the system's own `fn`. */
	run(plan: object, ctx: SystemContext, deltaTime: number, runTick: number): boolean;
}

export enum SCHEDULE {
	PRE_STARTUP = "PRE_STARTUP",
	STARTUP = "STARTUP",
	POST_STARTUP = "POST_STARTUP",
	FIXED_UPDATE = "FIXED_UPDATE",
	PRE_UPDATE = "PRE_UPDATE",
	UPDATE = "UPDATE",
	POST_UPDATE = "POST_UPDATE"
}

/** Which drive runs a phase.
 *
 * `startup` runs once, from `ecs.startup()`. `fixed` runs once per fixed step,
 * inside the accumulator loop. `update` runs once per `ecs.update(dt)`. A
 * phase belongs to one loop for its life, because the loop decides the delta
 * time it receives and how often it runs. */
export type PhaseLoop = "startup" | "fixed" | "update";

/**
 * An opaque handle for one slot in the schedule, returned by `ecs.addPhase`.
 *
 * A phase is identified by **object identity**, not by name, exactly like a
 * `SystemSet`. Two `addPhase` calls with the same name are two phases. The
 * handle belongs to the world that made it, so passing one to another world's
 * `addSystems` is a fault and not silent cross-world scheduling.
 *
 * The seven built-ins have no handle. `SCHEDULE.UPDATE` names one directly,
 * and every place that takes a `SchedulePhase` takes either spelling. A string
 * enum member is already a string, so the built-in needs no wrapper object,
 * and a plugin author reads `after: [SCHEDULE.PRE_UPDATE]` without an import
 * of a handle table.
 */
export interface Phase {
	readonly name: string;
	readonly loop: PhaseLoop;
}

/** Where a new phase sits. `before` and `after` order it against other phases
 * of the same loop, and a target in another loop is dropped. A phase with
 * neither runs after every phase declared before it, so an unordered plugin
 * phase lands at the tail of its loop. */
export interface PhaseConfig {
	readonly loop: PhaseLoop;
	readonly before?: readonly SchedulePhase[];
	readonly after?: readonly SchedulePhase[];
}

/** Either spelling of a phase: a built-in `SCHEDULE` member, or the handle
 * `addPhase` returned. */
export type SchedulePhase = SCHEDULE | Phase;

/** The name a trace event carries for a phase. A built-in spells its `SCHEDULE`
 * member. A phase from `addPhase` spells the name it was given, so the set of
 * values is open and a consumer switching on it needs a default arm. */
export type PhaseName = SCHEDULE | (string & {});

/** The loop that drives either spelling of a phase.
 *
 * A handle from `addPhase` carries its loop. A built-in is one of seven, and
 * its loop is fixed at construction. Pure and cold, so a caller outside the
 * schedule classifies a phase without holding the world. `installHostCommandSeam`
 * is that caller. It refuses a recorder on a fixed-loop phase, and `addPhase`
 * can put a phase of any name in that loop. */
export function phaseLoopOf(phase: SchedulePhase): PhaseLoop {
	if (typeof phase !== "string") return phase.loop;
	switch (phase) {
		case SCHEDULE.PRE_STARTUP:
		case SCHEDULE.STARTUP:
		case SCHEDULE.POST_STARTUP:
			return "startup";
		case SCHEDULE.FIXED_UPDATE:
			return "fixed";
		case SCHEDULE.PRE_UPDATE:
		case SCHEDULE.UPDATE:
		case SCHEDULE.POST_UPDATE:
			return "update";
	}
}

/** The name either spelling of a phase carries, for a diagnostic and for a
 * system name. Pure and cold. */
export function phaseNameOf(phase: SchedulePhase): PhaseName {
	return typeof phase === "string" ? phase : phase.name;
}

/** One phase's whole state: its systems, its cached plan and its ordering.
 *
 * The handle a caller holds **is** this object, so `addSystems` reaches the
 * system list with a field read and no lookup. `plan` is a field and not a
 * `Map` entry, which is what lets the drive loops read a phase's plan by array
 * index instead of by a string-keyed `Map.get` once per phase per frame. */
class PhaseNode implements Phase {
	public readonly nodes: SystemNode[] = [];
	/** The sorted plan, or `null` when a system was added or removed since. */
	public plan: PhasePlan | null = null;
	public readonly before: SchedulePhase[] = [];
	public readonly after: SchedulePhase[] = [];

	constructor(
		/** The schedule that made this phase. A handle from another world is a
		 * fault, so the owner travels with the handle. */
		public readonly owner: object,
		public readonly name: string,
		public readonly loop: PhaseLoop,
		/** Declaration order, the tiebreaker when two phases are both ready. */
		public readonly insertionOrder: number
	) {}
}

/**
 * An opaque handle for a named group of systems. A set carries a shared
 * run condition and shared ordering that every member inherits. Sets are
 * identified by **object identity**, not by name, create one with
 * `systemSet(name)`, hold the handle, and reuse it across `addSystems`
 * (`SystemEntry.set`) and `Schedule.configureSet`. The `name` is for
 * diagnostics only.
 */
export interface SystemSet {
	readonly name: string;
}

/** Create a `SystemSet` handle. Two calls with the same name are two
 * distinct sets, keep the returned handle and pass it around. */
export function systemSet(name: string): SystemSet {
	return Object.freeze({ name });
}

/** A `before` and `after` ordering target: either a concrete system or a whole set
 * (expanded to its members within the same phase at sort time). */
export type SystemOrderingTarget = SystemDescriptor | SystemSet;

/** Shared configuration applied to a `SystemSet` via `configureSet`.
 * Accumulates across calls, conditions and together, ordering targets union. */
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
	/** Run condition(s) gating only this system. ANDed with any set conditions
	 * it inherits. A `false` verdict skips the body that tick. */
	runIf?: RunCondition | readonly RunCondition[];
	/** Set membership, the system inherits each set's shared condition and
	 * ordering. */
	set?: SystemSet | readonly SystemSet[];
}

/** A phase's execution plan: its topologically sorted systems and, index-aligned,
 * each one's `_lastRunTicks` slot. Cached as a unit and invalidated together. */
interface PhasePlan {
	readonly sorted: SystemDescriptor[];
	readonly slots: Int32Array;
}

interface SystemNode {
	descriptor: SystemDescriptor;
	insertionOrder: number;
	before: Set<SystemOrderingTarget>;
	after: Set<SystemOrderingTarget>;
	/** This system's own run conditions (set conditions are resolved live from
	 * `_conditionsBySet` at run time so a later `configureSet` is honored). */
	conditions: readonly RunCondition[];
	/** Sets this system belongs to. */
	sets: readonly SystemSet[];
}

/** A `SystemOrderingTarget` is a set iff it is not a system descriptor. A
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

/**
 * The one call site through which every system body runs.
 *
 * Why it exists: V8 decides what to inline from the feedback of the call site.
 * When every system in a world comes from one function literal, a factory
 * such as `makeMover(component)`, or a world with a single system, the
 * dispatch site in `_runPhase` sees one target and TurboFan inlines the system
 * body, with its `forEachChunk` callback and its hot loop, into the scheduler's
 * own loop over the systems. Measured, that inlined loop runs slower than the
 * same loop compiled on its own: the scheduler keeps many values live across
 * it, and the loop code pays for that. A world whose systems come from two or
 * more literals never hits this, because the site is then megamorphic and
 * nothing is inlined. So the factory case ran slower than the plain case, and
 * nothing in the user's code said why.
 *
 * What the effect is worth, from a later run. It is a per-system cost in each
 * phase, so it shows up when the scheduler's own work is a visible share of the
 * frame: a small world, or many systems with short bodies. It disappears once
 * the system body dominates the frame. It appears on V8 and not on
 * JavaScriptCore. Twenty closures made from one literal are already enough
 * targets to keep the site polymorphic, so the seed guards the single-system
 * world and the true factory, and not every world that looks repetitive.
 *
 * The remedy is to give the site many targets on purpose. `seedDispatchSite`
 * calls this trampoline with several distinct no-op literals when the module
 * loads, enough times for the engine to allocate the feedback and record them.
 * From then on the site is megamorphic for the life of the process, every
 * system body is compiled on its own, and the factory case runs at the speed
 * of the plain case. A megamorphic call costs a few nanoseconds more than an
 * inlined one for each system in each phase. A system body that does any work
 * repays that many times over.
 *
 * The seed is observed engine behaviour and not a guarantee. If an engine
 * ignores it, the dispatch is exactly the plain call it always was.
 */
function invokeSystem(fn: SystemFn, ctx: SystemContext, deltaTime: number): void {
	fn(ctx, deltaTime);
}

function seedDispatchSite(): void {
	// Distinct literals, so each is a different target at the call site above.
	const seeds: SystemFn[] = [
		function seedA() {},
		function seedB() {},
		function seedC() {},
		function seedD() {},
		function seedE() {}
	];
	// The engine allocates feedback for a function lazily, after it has run for
	// a while, so one call for each seed is not enough to be recorded. The
	// count below is far past that point and costs microseconds one time.
	const none = null as unknown as SystemContext;
	for (let round = 0; round < 500; round++) {
		for (let i = 0; i < seeds.length; i++) invokeSystem(seeds[i], none, 0);
	}
}

seedDispatchSite();

export class Schedule {
	// Every phase this world has, built-in and added, in declaration order. The
	// drive loops never read this one, they read the three resolved arrays below.
	private readonly _phases: PhaseNode[] = [];
	// The built-in seven, keyed by their `SCHEDULE` spelling, so `addSystems`
	// resolves a string to the node. Cold path, one lookup per add.
	private readonly _builtins: Map<string, PhaseNode> = new Map();
	// The phases of one loop, already sorted. Resolved in `addPhase`, which is a
	// setup call, so a drive walks a plain array and reads each phase's plan as a
	// field. The `Map<SCHEDULE, PhasePlan>` this replaced cost one string-keyed
	// `Map.get` per phase per frame, which a dispatch-bound tick pays for.
	private _startupOrder: PhaseNode[] = [];
	private _fixedOrder: PhaseNode[] = [];
	private _updateOrder: PhaseNode[] = [];
	private readonly _phaseBySystem: Map<SystemDescriptor, PhaseNode> = new Map();
	// Previous-run tick per scheduled system, a packed array, not a `Map` keyed
	// on the descriptor. `_runPhase` reads it and writes it back once per system
	// per phase. A profile of a dispatch-bound schedule shows that those two `Map`
	// operations, and not the system bodies, are where most of the phase loop goes.
	// They hash an object identity twice for each system in each frame.
	//
	// Indexed by a `Schedule`-local slot, not by `SystemDescriptor.id`. Ids come
	// from a per-world counter, so two descriptors registered with two different
	// worlds both get id 0, scheduling them into a third world would alias them
	// onto one slot and let the system that runs more often overwrite the other's
	// last-run tick (silently widening its `changed()` window). Slots are handed
	// out per Schedule, so identity comes from this schedule's own numbering.
	private readonly _lastRunTicks: number[] = [];
	// Descriptor → its `_lastRunTicks` slot. Consulted only by `addSystems` and
	// `removeSystem`. The run loop never touches it (the slot travels in the
	// phase plan).
	//
	// `removeSystem` must delete from this map. It is the only strong reference
	// the Schedule keeps to a descriptor once its node is gone. A descriptor
	// closes over whatever its `fn` captured, so leaving the entry behind pins
	// that for the world's lifetime. The `Map` this replaced was deleted on
	// remove. Forgetting to do the same here leaked every descriptor ever
	// scheduled.
	private readonly _slotBySystem: Map<SystemDescriptor, number> = new Map();
	// Slots freed by `removeSystem`, handed back out by `_assignLastRunSlot`.
	// Without reuse the array would grow by one per `addSystems` call, unbounded
	// under a workload that toggles systems on and off each frame.
	private readonly _freeSlots: number[] = [];
	// Nesting depth of a drive (`runStartup`, `runUpdate` or `runFixedUpdate`).
	// Non-zero means a phase plan is live and `_runPhase`'s loop may still write
	// `_lastRunTicks` through the `slots` array it captured, which is what makes
	// recycling a freed slot unsafe right now, see `_assignLastRunSlot`.
	private _driveDepth = 0;
	// Only systems carrying a run condition or set membership. The hot
	// loop skips the per-system gate probe entirely when this is empty, so a
	// schedule that uses no conditions runs byte-for-byte the original path.
	private readonly _gatedSystems: Map<SystemDescriptor, SystemNode> = new Map();
	// Live set configuration, read at sort time (ordering) and run time
	// (conditions) so `configureSet` is order-independent w.r.t. `addSystems`.
	private readonly _conditionsBySet: Map<SystemSet, RunCondition[]> = new Map();
	private readonly _orderingBySet: Map<
		SystemSet,
		{ before: Set<SystemOrderingTarget>; after: Set<SystemOrderingTarget> }
	> = new Map();
	private _nextInsertionOrder = 0;
	// The opt-in compute backend, or null (the default, pure-TS). When
	// set, a scheduled system carrying a `backendHandle` runs `backend.run(...)`
	// instead of its `fn`. `null` is the byte-for-byte no-backend path: `_runPhase`
	// hoists this to a local and only reads `desc.backendHandle` when non-null,
	// so a no-backend ECS never touches the routing field.
	private _backend: ComputeBackend | null = null;
	// The attached system dispatch route, or null (the default). One typed
	// slot, not a keyed registry: a keyed read on the dispatch path is far
	// slower on a schedule of short bodies, and `bench/` holds the comparison.
	// Hoisted in `_runPhase` exactly as the backend is: `null` means
	// `desc.routePlan` is never read.
	private _route: RouteDispatch | null = null;

	/** Dev-diagnostic sink (`ECSOptions.onWarn`). Defaults to `console.warn`.
	 * The only schedule diagnostic today is `_warnDroppedEdge`. */
	private readonly _onWarn: (message: string) => void;

	// How many systems sit in a `fixed`-loop phase, for `hasFixedSystems`.
	// `ECS.update` asks once per frame before any phase runs, so the answer is a
	// field compare. A count and not a list length, because the fixed loop is
	// open and may hold more than one phase.
	private _fixedSystemCount = 0;

	// Declaration order for the next phase, the phase sort's tiebreaker.
	private _nextPhaseOrder = 0;

	constructor(onWarn?: (message: string) => void) {
		this._onWarn = onWarn ?? ((message) => console.warn(message));
		// The seven built-ins, declared in the order they run and chained with the
		// same `after` edges a user phase gets. The chain is what keeps a phase
		// added `before: [SCHEDULE.UPDATE]` from also jumping ahead of PRE_UPDATE.
		const preStartup = this._declarePhase(SCHEDULE.PRE_STARTUP, "startup");
		const startup = this._declarePhase(SCHEDULE.STARTUP, "startup");
		startup.after.push(preStartup);
		const postStartup = this._declarePhase(SCHEDULE.POST_STARTUP, "startup");
		postStartup.after.push(startup);
		this._declarePhase(SCHEDULE.FIXED_UPDATE, "fixed");
		const preUpdate = this._declarePhase(SCHEDULE.PRE_UPDATE, "update");
		const update = this._declarePhase(SCHEDULE.UPDATE, "update");
		update.after.push(preUpdate);
		const postUpdate = this._declarePhase(SCHEDULE.POST_UPDATE, "update");
		postUpdate.after.push(update);
		for (const node of this._phases) this._builtins.set(node.name, node);
		this._resolveOrder("startup");
		this._resolveOrder("fixed");
		this._resolveOrder("update");
	}

	/**
	 * Add one phase to a loop and hand back its handle. Cold path, setup only.
	 *
	 * `before` and `after` order it against the other phases of the same loop.
	 * A target in another loop is dropped, the way a system ordered against a
	 * system in another phase is dropped. With neither, the phase runs after
	 * every phase declared before it, so it lands at the tail of its loop.
	 *
	 * The handle is this world's. Two calls with one name make two phases, the
	 * rule `systemSet` already follows, so hold the handle rather than the name.
	 */
	public addPhase(name: string, config: PhaseConfig): Phase {
		const node = this._declarePhase(name, config.loop);
		for (const target of config.before ?? EMPTY_ARRAY) {
			node.before.push(this._checkPhase(target));
		}
		for (const target of config.after ?? EMPTY_ARRAY) {
			node.after.push(this._checkPhase(target));
		}
		this._resolveOrder(config.loop);
		return node;
	}

	private _declarePhase(name: string, loop: PhaseLoop): PhaseNode {
		const node = new PhaseNode(this, name, loop, this._nextPhaseOrder++);
		this._phases.push(node);
		return node;
	}

	/** Check that a phase belongs to this schedule, and hand it back unchanged.
	 * Not a dev guard: a handle from another world would push systems into that
	 * world's list, and a production build that scheduled them into nothing is
	 * worse than a named fault on a setup call. */
	private _checkPhase(phase: SchedulePhase): SchedulePhase {
		this._resolvePhase(phase);
		return phase;
	}

	/** The node behind either spelling of a phase. Cold path. */
	private _resolvePhase(phase: SchedulePhase): PhaseNode {
		if (typeof phase === "string") {
			const found = this._builtins.get(phase);
			if (found !== undefined) return found;
			throw new ECSError(
				ECS_ERROR.UNKNOWN_PHASE,
				`${phase} is not a phase of this world. Pass a SCHEDULE member, or the handle addPhase returned`
			);
		}
		const node = phase as PhaseNode;
		if (node.owner !== this) {
			throw new ECSError(
				ECS_ERROR.UNKNOWN_PHASE,
				`phase ${node.name} belongs to another world. Call addPhase on the world you are scheduling into`
			);
		}
		return node;
	}

	/** Sort one loop's phases and cache the result. Kahn's algorithm with
	 * declaration order as the tiebreaker, the same rule the systems inside a
	 * phase follow. Cold path, once per `addPhase`. */
	private _resolveOrder(loop: PhaseLoop): void {
		const members: PhaseNode[] = [];
		for (let i = 0; i < this._phases.length; i++) {
			if (this._phases[i].loop === loop) members.push(this._phases[i]);
		}
		const edges = new Map<PhaseNode, PhaseNode[]>();
		for (const node of members) edges.set(node, []);
		const inLoop = new Set(members);
		for (const node of members) {
			for (const target of node.before) {
				const other = this._resolvePhase(target);
				// A target in another loop expands to nothing, the rule an ordering
				// target in another phase already follows.
				if (other !== node && inLoop.has(other)) edges.get(node)!.push(other);
			}
			for (const target of node.after) {
				const other = this._resolvePhase(target);
				if (other !== node && inLoop.has(other)) edges.get(other)!.push(node);
			}
		}
		let sorted: PhaseNode[];
		try {
			sorted = topologicalSort(
				members,
				edges,
				(a, b) => a.insertionOrder - b.insertionOrder,
				(n) => n.name
			);
		} catch (err) {
			if (err instanceof TypeError) {
				throw new ECSError(
					ECS_ERROR.CIRCULAR_PHASE_DEPENDENCY,
					`the ${loop} phases cannot be ordered: ${err.message}. Drop one before or after from addPhase`
				);
			}
			throw err;
		}
		if (loop === "startup") this._startupOrder = sorted;
		else if (loop === "fixed") this._fixedOrder = sorted;
		else this._updateOrder = sorted;
	}

	public addSystems(
		phase: SchedulePhase,
		...entries: (SystemDescriptor | SystemEntry)[]
	): void {
		const target = this._resolvePhase(phase);
		for (const entry of entries) {
			const isEntry = "system" in entry;
			const descriptor = isEntry ? entry.system : entry;
			const ordering = isEntry ? entry.ordering : undefined;
			const conditions = isEntry ? toArray(entry.runIf) : EMPTY_ARRAY;
			const sets = isEntry ? toArray(entry.set) : EMPTY_ARRAY;

			if (DEV) {
				if (this._phaseBySystem.has(descriptor)) {
					throw new ECSError(
						ECS_ERROR.DUPLICATE_SYSTEM,
						`System ${descriptor.name ?? descriptor.id} is already scheduled`
					);
				}
			}

			const node: SystemNode = {
				descriptor,
				insertionOrder: this._nextInsertionOrder++,
				before: new Set(ordering?.before ?? []),
				after: new Set(ordering?.after ?? []),
				conditions,
				sets
			};

			target.nodes.push(node);
			if (target.loop === "fixed") this._fixedSystemCount++;
			this._phaseBySystem.set(descriptor, target);
			this._assignLastRunSlot(descriptor);
			// A system is "gated" if it carries its own condition or belongs to a
			// set (the set may be, or later become, conditioned). Ungated systems
			// never enter `_gatedSystems`, preserving the no-condition fast path.
			if (conditions.length > 0 || sets.length > 0) {
				this._gatedSystems.set(descriptor, node);
			}
			target.plan = null;
		}
	}

	/**
	 * Configure a `SystemSet`, its shared run conditions, or its
	 * ordering, inherited by every member. Additive and order-independent w.r.t.
	 * `addSystems`: conditions accumulate (ANDed), ordering targets union, and
	 * a member added before or after this call picks the configuration up.
	 */
	public configureSet(set: SystemSet, config: SystemSetConfig): void {
		const newConditions = toArray(config.runIf);
		if (newConditions.length > 0) {
			const existing = this._conditionsBySet.get(set);
			if (existing === undefined) {
				this._conditionsBySet.set(set, [...newConditions]);
			} else {
				existing.push(...newConditions);
			}
		}

		if (config.before !== undefined || config.after !== undefined) {
			let ord = this._orderingBySet.get(set);
			if (ord === undefined) {
				ord = { before: new Set(), after: new Set() };
				this._orderingBySet.set(set, ord);
			}
			for (const t of config.before ?? EMPTY_ARRAY) ord.before.add(t);
			for (const t of config.after ?? EMPTY_ARRAY) ord.after.add(t);
			// Ordering feeds the topo sort. Sets are configured at setup time
			// (rarely), so clear every cached order rather than tracking which
			// phases this set's members span, simpler and cheap.
			this._invalidatePlans();
		}
	}

	public removeSystem(system: SystemDescriptor): void {
		const phase = this._phaseBySystem.get(system);
		if (phase === undefined) return;

		const nodes = phase.nodes;
		const index = nodes.findIndex((n) => n.descriptor === system);
		if (index !== -1) {
			// Swap-and-pop removal
			const last = nodes.length - 1;
			if (index !== last) {
				nodes[index] = nodes[last];
			}
			nodes.pop();
			if (phase.loop === "fixed") this._fixedSystemCount--;

			// Clean up ordering references from remaining nodes
			for (const node of nodes) {
				node.before.delete(system);
				node.after.delete(system);
			}
		}

		this._phaseBySystem.delete(system);
		const removedSlot = this._slotBySystem.get(system);
		if (removedSlot !== undefined) {
			this._lastRunTicks[removedSlot] = 0;
			// Drop the descriptor reference (see `_slotBySystem`) and recycle the slot.
			// Safe to offer it back unconditionally: `_assignLastRunSlot` decides
			// whether taking it is safe *right now* (it isn't while a phase's captured
			// plan is still writing through it, see the `_driveDepth` guard there).
			this._slotBySystem.delete(system);
			this._freeSlots.push(removedSlot);
		}
		this._gatedSystems.delete(system);
		// A dangling descriptor target left inside a `_orderingBySet` entry is
		// harmless, `_sortSystems` drops any ordering target not present in the
		// phase, so it needs no per-remove sweep across every set.
		//
		// Clear every phase plan, not only this phase's: the slot only recycled is
		// about to be handed to a different descriptor, and a *cached* plan still
		// holding it would alias the two systems' last-run ticks. One phase's plan is
		// all that can hold it while a descriptor lives in exactly one phase, but
		// that invariant is only enforced under `DEV` (the duplicate-schedule throw
		// in `addSystems`), and slot reuse is not something to leave resting on a
		// check that is compiled out of production. `removeSystem` is cold and a
		// world holds few phases. Re-sorting them is not worth reasoning about.
		//
		// This only reaches cached plans. The one a currently-running phase already
		// hoisted into a local is unreachable from here, and that window is covered
		// by `_driveDepth` in `_assignLastRunSlot` instead.
		this._invalidatePlans();
	}

	/** Drop every cached plan. Cold path, and the reason each caller needs it
	 * sits at that call site. */
	private _invalidatePlans(): void {
		for (let i = 0; i < this._phases.length; i++) this._phases[i].plan = null;
	}

	/** Attach (or, with `null`, detach) the opt-in compute backend. Driven
	 * by `ECS.attachBackend`. Routes any scheduled system carrying a
	 * `backendHandle` to `backend.run(handle)` in place of its `fn`. */
	public setBackend(backend: ComputeBackend | null): void {
		this._backend = backend;
	}

	/** Attach (or, with `null`, detach) the system dispatch route. Driven by
	 * the plugin that installed it. Runs any scheduled system carrying a
	 * `routePlan` through the route in place of its `fn`. */
	public setRoute(dispatch: RouteDispatch | null): void {
		this._route = dispatch;
	}

	// The three drive entry points each bracket their phases with `_driveDepth`,
	// so `_assignLastRunSlot` will not recycle a `_lastRunTicks` slot that a phase
	// plan captured by `_runPhase`'s loop may still write to, see the guard there
	// for the hazard it closes.
	//
	// Held across the whole drive, not per phase: one `try` block per frame
	// instead of one per phase (three, for an update). The difference is
	// measurable on a dispatch-bound schedule, where the system bodies do almost
	// no work. The wider window is also the more
	// conservative one, and slots still recycle freely between frames, the only
	// property `_freeSlots` needs to stay bounded. Written out at each of
	// the three sites rather than wrapped in a helper taking a callback, which
	// would put a closure allocation and an indirect call on the per-frame path.

	public runStartup(ctx: SystemContext): void {
		this._driveDepth++;
		try {
			const order = this._startupOrder;
			for (let i = 0; i < order.length; i++) {
				this._runPhase(order[i], ctx, STARTUP_DELTA_TIME);
			}
		} finally {
			this._driveDepth--;
		}
	}

	public runUpdate(ctx: SystemContext, deltaTime: number): void {
		this._driveDepth++;
		try {
			// A plain array of phase objects, sorted at `addPhase` time. The loop
			// reads each phase's plan as a field, so opening the phase set costs the
			// frame nothing, and it drops the per-phase `Map.get` the closed set paid.
			const order = this._updateOrder;
			for (let i = 0; i < order.length; i++) {
				this._runPhase(order[i], ctx, deltaTime);
			}
		} finally {
			this._driveDepth--;
		}
	}

	public runFixedUpdate(ctx: SystemContext, fixedDt: number): void {
		this._driveDepth++;
		try {
			const order = this._fixedOrder;
			for (let i = 0; i < order.length; i++) {
				this._runPhase(order[i], ctx, fixedDt);
			}
		} finally {
			this._driveDepth--;
		}
	}

	public hasFixedSystems(): boolean {
		// A counter, not a list length: `ECS.update` asks this once per frame
		// before any phase runs, the fixed loop may hold more than one phase, and
		// summing their lengths there is work the frame should not do.
		return this._fixedSystemCount > 0;
	}

	public getAllSystems(): SystemDescriptor[] {
		const all: SystemDescriptor[] = [];
		for (const phase of this._phases) {
			for (const node of phase.nodes) {
				all.push(node.descriptor);
			}
		}
		return all;
	}

	public hasSystem(system: SystemDescriptor): boolean {
		return this._phaseBySystem.has(system);
	}

	/** Hand `descriptor` its `_lastRunTicks` slot, keeping the array packed (no
	 * holes ⇒ no undefined-check on the read in `_runPhase`, which is the whole
	 * point of it not being a `Map`). Idempotent for a descriptor already in this
	 * schedule, `_getPlan` re-asks for every system it sorts. A descriptor that
	 * was removed and re-added gets a *fresh* slot starting at tick 0, which is
	 * what the previous `Map`-based bookkeeping did (`delete` on remove, `set(…, 0)`
	 * on re-add). */
	private _assignLastRunSlot(descriptor: SystemDescriptor): number {
		let slot = this._slotBySystem.get(descriptor);
		if (slot === undefined) {
			// Recycle only outside a running drive. `_runPhase` hoists its plan's
			// `slots` into a local and writes `_lastRunTicks[slots[i]] = tick` after
			// each system, so a phase already in its loop keeps writing through the
			// slots it captured even after `removeSystem` drops every cached plan. Handing
			// one of those to a system added during that same phase would let the
			// removed system's tail write land on the new system's last-run tick and
			// silently widen or shift its `changed()` window, cross-talk the `Map`
			// this replaced could not produce (it only re-added a deleted entry).
			// Reachable: an observer or a teardown helper like
			// `uninstallHostCommandSeam` removes and re-adds systems from inside a
			// phase. `_assignLastRunSlot` zeroing a reused slot only half-covers it,
			// the removed system need merely run after the re-add.
			//
			// The slot stays on the free list and is reused by the next add outside a
			// drive, so this costs at most one extra `_lastRunTicks` entry per
			// mid-drive add, bounded, and on a cold path.
			const reused = this._driveDepth === 0 ? this._freeSlots.pop() : undefined;
			if (reused !== undefined) {
				slot = reused;
				this._lastRunTicks[slot] = 0;
			} else {
				slot = this._lastRunTicks.length;
				this._lastRunTicks.push(0);
			}
			this._slotBySystem.set(descriptor, slot);
		}
		return slot;
	}

	public clear(): void {
		// The phases stay. `clear` drops the systems, and a phase a plugin added is
		// part of the world's shape, not of its system list. A phase with no
		// systems runs an empty plan and a flush, which is what an empty built-in
		// phase already does.
		for (const phase of this._phases) {
			phase.nodes.length = 0;
			phase.plan = null;
		}
		this._fixedSystemCount = 0;
		this._phaseBySystem.clear();
		// Truncating is right between drives, and it is what `clear` normally
		// does. Inside one it is not: `ECS.dispose` reaches here from a system
		// body, and the phase that called that system keeps running the plan it
		// already captured, so `_runPhase` still indexes `_lastRunTicks[slots[i]]`
		// for every system after this point. A truncated array reads `undefined`
		// there and publishes it as `ctx.lastRunTick`, which the `Map` this
		// replaced could not do (it fell back to 0). Zeroing in place keeps every
		// live slot a number and matches the tick a fresh slot would carry.
		//
		// The array then keeps its length, so the next `_assignLastRunSlot` starts
		// numbering above the dead entries. That wastes at most one entry per
		// system that existed before the clear, once, on a path that is tearing
		// the world down anyway.
		if (this._driveDepth === 0) this._lastRunTicks.length = 0;
		else this._lastRunTicks.fill(0);
		this._slotBySystem.clear();
		this._freeSlots.length = 0;
		this._gatedSystems.clear();
		this._conditionsBySet.clear();
		this._orderingBySet.clear();
	}

	private _runPhase(phase: PhaseNode, ctx: SystemContext, deltaTime: number): void {
		// A field read and a predicted branch, not a `Map.get`. `null` only after
		// an add, a remove or a `configureSet`, all of them setup calls.
		const cached = phase.plan;
		const plan = cached !== null ? cached : this._buildPlan(phase);
		const sorted = plan.sorted;
		const slots = plan.slots;
		// Probe the gate map only when something in the whole schedule is gated.
		const hasGates = this._gatedSystems.size > 0;
		// Hoist the backend once per phase (constant across the loop). `null` is the
		// common case, with no backend attached. Then `backendHandle` is never read and
		// the dispatch is byte-for-byte the plain `desc.fn(ctx, dt)` path. The
		// `=== null` check is a perfectly-predicted branch. A measurement of the
		// dispatch shows that this branch is free against the baseline, and that a
		// Null-Object default makes this no-backend path slower.
		const backend = this._backend;
		// Hoisted for the same reason the backend is. A world with no route never
		// reads `routePlan`.
		const route = this._route;
		// One test for both. A world with neither a backend nor a route, the
		// common case, reads neither routing field and takes one predicted branch
		// to the plain call. Two independent tests slow this loop on a schedule of
		// short bodies, which is where the dispatch is a visible share of the
		// frame. A comparison of the dispatch against the sequential baseline
		// shows it.
		const routed = backend !== null || route !== null;
		// The frame tick travels to a backend as a call argument, because it is not
		// in the store bytes. It is constant across a phase, because `ECS.update`
		// writes it once before the first phase. Read it once here, and not for
		// each dispatch. A world with no backend reads nothing.
		const frameTick = backend !== null ? ctx.ecsTick : 0;
		// A SystemSet's run conditions gate the set as a unit. Evaluate each
		// set's conditions at most once per phase and reuse the verdict for every
		// member, instead of re-evaluating per member. Run conditions are pure reads
		// and deferred changes aren't flushed until the phase ends, so the memo is
		// observationally identical within a phase while removing the N×-per-set work.
		const setVerdicts: Map<SystemSet, boolean> | undefined = hasGates
			? new Map()
			: undefined;
		// `slots` is a snapshot: a `removeSystem` from inside a system clears
		// every cached plan, but this loop keeps running, and keeps writing back through,
		// the plan it already captured. The caller, one of `runStartup`, `runUpdate`
		// and `runFixedUpdate`, holds `_driveDepth` for the whole drive, which is what
		// stops `_assignLastRunSlot` handing a slot this loop still writes to a
		// system added mid-phase.
		for (let i = 0; i < sorted.length; i++) {
			const desc = sorted[i];
			if (hasGates) {
				const node = this._gatedSystems.get(desc);
				// A false run condition skips the body in canonical order, and
				// leaves last_run unadvanced + enqueues nothing, so a skipped tick is
				// indistinguishable from the system being absent that tick (the
				// `stateHash` equality the acceptance requires).
				if (node !== undefined && !this._shouldRun(node, ctx, setVerdicts!)) continue;
			}
			// lastRunTick exposes the system's *previous* run to ChangedQuery, so
			// q.changed(C) sees stamps made since this system last ran. Each run
			// advances the change tick first, so a stamp by an earlier system this
			// frame is above the last run, and a stamp this system already saw is
			// not. One counter for the frame could not tell those apart.
			ctx.lastRunTick = this._lastRunTicks[slots[i]];
			const run = ctx.advanceChangeTick();
			if (DEV) accessCheck.enter(desc);
			if (DEV) ctx.trace?.systemBegin(desc, phase.name);
			try {
				// Route to the installed route or to the compute backend only when
				// one is attached and this system opted in. Otherwise run the TS
				// closure. The access span wraps every path identically, so the
				// system's declared `writes` authorise whatever shared memory a
				// route or a backend touches.
				if (routed) {
					// The dispatch sits inside the same access span a TypeScript body
					// gets, and the host parks on `Atomics.wait` for the length of the
					// pass. Nothing else runs on the main thread while it is parked, so
					// no spawn, no despawn and no grow can overlap the workers. A grow
					// relocates columns and a swap-remove moves rows, and a worker inside
					// a pass would see neither. The engine gives that guarantee by
					// construction. `run` answers false below the row threshold and
					// before the kernel is loaded, and then the sequential body runs.
					const plan = route !== null ? desc.routePlan : undefined;
					if (plan !== undefined && route!.run(plan, ctx, deltaTime, run)) {
						// The route ran the body and stamped what it wrote.
					} else {
						const handle = backend !== null ? desc.backendHandle : undefined;
						if (handle !== undefined) {
							// A backend body reads `row_count` and `enabled_count` out of the
							// descriptors, and those are copies. Work earlier in the phase
							// leaves them stale. Three ways in:
							//   - a host spawn before `startup()`, whose first phase has no
							//     publish ahead of it
							//   - a spawn from a run condition, which runs outside the access
							//     span
							//   - an immediate mutation from an `exclusive` system, which a
							//     dev build refuses and a production build allows
							// The phase flush publishes at its tail, too late for a system in
							// the same phase. The store gates the walk on a dirty flag, so a
							// clean world pays one flag read for each dispatch.
							ctx.publishRowCounts();
							backend!.run(handle, deltaTime, frameTick);
						} else if (desc.fn !== undefined) invokeSystem(desc.fn, ctx, deltaTime);
					}
				} else if (desc.fn !== undefined) invokeSystem(desc.fn, ctx, deltaTime);
			} finally {
				if (DEV) ctx.trace?.systemEnd(desc);
				if (DEV) accessCheck.leave();
			}
			this._lastRunTicks[slots[i]] = run;
		}
		// Flush deferred changes after each phase so the next phase sees a consistent state.
		// The flush gets its own change tick: a transition stamps the destination
		// columns, and an observer callback writes, and both must sit above the
		// last run of every system in this phase.
		ctx.advanceChangeTick();
		if (DEV) ctx.trace?.flushBegin(phase.name);
		ctx.flush();
		if (DEV) ctx.trace?.flushEnd(phase.name);
		// The phase has fully settled, systems ran, deferred buffer + observer
		// cascade flushed, so the live world is at a consistent, fingerprint-able
		// point. Fire the per-phase boundary so a consumer can read `stateHash()`
		// between the phases of one frame and bisect a divergence to this phase.
		// `DEV`-gated like the rest of the seam (zero prod
		// cost) and read-only, so it never perturbs the hash or ordering.
		if (DEV) ctx.trace?.phaseBoundary(phase.name);
	}

	/**
	 * Whether a gated system runs this tick, the and of its own conditions and
	 * every set it belongs to. A set's conditions are evaluated at most once per
	 * phase (memoized in `setVerdicts`) and the verdict gates every member of the
	 * set uniformly. A `configureSet` between phases is still honored because the
	 * memo lives only for a single `_runPhase` pass. Short-circuits on the first
	 * `false`. The system's own conditions evaluate per system, in canonical order.
	 *
	 * Semantic NOTE: this evaluates a set's conditions once-per-set-per-phase
	 * rather than once-per-member. Equivalent for pure RunConditions. Observably
	 * different only if a set condition reads state mutated earlier in the same
	 * phase (resources write immediately). That is intentional, the set gates as a
	 * unit, so all its members share one verdict for the phase.
	 */
	private _shouldRun(
		node: SystemNode,
		ctx: SystemContext,
		setVerdicts: Map<SystemSet, boolean>
	): boolean {
		if (node.conditions.length > 0 && !this._evalConditions(node.conditions, ctx)) {
			return false;
		}
		for (let s = 0; s < node.sets.length; s++) {
			const set = node.sets[s];
			let verdict = setVerdicts.get(set);
			if (verdict === undefined) {
				const setConds = this._conditionsBySet.get(set);
				verdict =
					setConds === undefined || setConds.length === 0
						? true
						: this._evalConditions(setConds, ctx);
				setVerdicts.set(set, verdict);
			}
			if (!verdict) return false;
		}
		return true;
	}

	/** Evaluate a condition list with and semantics. Each predicate runs inside a
	 * reads-only `accessCheck` span (dev), so a condition that reads an
	 * undeclared resource, or attempts any mutation, throws. */
	private _evalConditions(conditions: readonly RunCondition[], ctx: SystemContext): boolean {
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

	/** Sort one phase and cache its plan on the phase. Cold: the drive reads
	 * `phase.plan` and only lands here when an add or a remove nulled it. */
	private _buildPlan(phase: PhaseNode): PhasePlan {
		const sorted = this._sortSystems(phase.nodes, phase.name);
		const slots = new Int32Array(sorted.length);
		for (let i = 0; i < sorted.length; i++) slots[i] = this._assignLastRunSlot(sorted[i]);
		const plan: PhasePlan = { sorted, slots };
		phase.plan = plan;
		return plan;
	}

	/**
	 * Delegates to the shared topologicalSort utility.
	 * Builds the dependency edge map from before and after constraints, then
	 * catches any cycle TypeError and re-throws as ECSError.
	 */
	private _sortSystems(nodes: SystemNode[], phase: string): SystemDescriptor[] {
		if (nodes.length === 0) return [];

		const descriptors: SystemDescriptor[] = [];
		const insertionOrder = new Map<SystemDescriptor, number>();
		const nodeSet = new Set<SystemDescriptor>();
		// set → its member descriptors *within this phase*. Cross-phase
		// members are absent, so set ordering stays phase-local like system
		// ordering, a set referenced from another phase expands to nothing here.
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

		// ! safe: all descriptors were inserted into edges above
		// nodeSet guards skip descriptors from other phases
		for (const node of nodes) {
			// Effective ordering = the system's own before and after plus the
			// before and after of every set it belongs to. Set conditions gate
			// at run time. Set *ordering* expands here into per-member edges.
			this._resolveEdges(
				node.descriptor,
				node.before,
				"before",
				nodeSet,
				setMembers,
				edges,
				phase
			);
			this._resolveEdges(node.descriptor, node.after, "after", nodeSet, setMembers, edges, phase);
			for (let s = 0; s < node.sets.length; s++) {
				const ord = this._orderingBySet.get(node.sets[s]);
				if (ord === undefined) continue;
				this._resolveEdges(
					node.descriptor,
					ord.before,
					"before",
					nodeSet,
					setMembers,
					edges,
					phase
				);
				this._resolveEdges(
					node.descriptor,
					ord.after,
					"after",
					nodeSet,
					setMembers,
					edges,
					phase
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
					`Circular system dependency detected in ${phase}: ${err.message}`
				);
			}
			throw err;
		}
	}

	/**
	 * Add the topo edges for one ordering list. For `"before"` the source
	 * runs before each target (edge source→target). For `"after"` it runs after
	 * each target (edge target→source).
	 *
	 * A `SystemSet` target expands to every member within this phase. Self-edges
	 * are skipped, so a member ordered against its own set is a no-op. A
	 * descriptor target absent from this phase is dropped. Only a concrete
	 * system gets a dev warning for that, because a set legitimately expands to
	 * nothing when its members live in another phase.
	 */
	private _resolveEdges(
		source: SystemDescriptor,
		targets: Iterable<SystemOrderingTarget>,
		direction: "before" | "after",
		nodeSet: Set<SystemDescriptor>,
		setMembers: Map<SystemSet, SystemDescriptor[]>,
		edges: Map<SystemDescriptor, SystemDescriptor[]>,
		phase: string
	): void {
		for (const target of targets) {
			if (isSystemSet(target)) {
				const members = setMembers.get(target);
				if (members === undefined) continue; // no members in this phase
				for (let i = 0; i < members.length; i++) {
					const member = members[i];
					if (member === source) continue; // skip self
					this._addDirectedEdge(source, member, direction, edges);
				}
				continue;
			}
			if (!nodeSet.has(target)) {
				if (DEV) this._warnDroppedEdge(source, target, direction, phase);
				continue;
			}
			this._addDirectedEdge(source, target, direction, edges);
		}
	}

	/** Push one directed edge into the adjacency map. Both endpoints are known to
	 * be in this phase (callers guard), so `edges.get(...)` is non-null. */
	private _addDirectedEdge(
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
	 * Cross-phase ordering is impossible by design (`nodeSet` is per-phase), so
	 * a target registered in *another* phase is skipped silently, that's the
	 * intended isolation. But a target unknown to *every* phase is almost
	 * certainly a typo or a system that was never scheduled. Without this warning
	 * the constraint vanishes and the system runs in insertion-order tiebreak as
	 * if unconstrained, with nothing to distinguish mistake from intent. Compiled
	 * out of production builds by the `DEV` guards at the call sites.
	 */
	private _warnDroppedEdge(
		source: SystemDescriptor,
		target: SystemDescriptor,
		relation: "before" | "after",
		phase: string
	): void {
		// Registered in some other phase → deliberate cross-phase skip, stay quiet.
		if (this._phaseBySystem.has(target)) return;

		const name = (d: SystemDescriptor) => d.name ?? `system_${d.id}`;
		this._onWarn(
			`Schedule[${phase}]: \`${name(source)}\` declares \`${relation}\` ordering against ` +
				`\`${name(target)}\`, which is not registered in any phase, the constraint is ignored. ` +
				`Check for a typo or a missing add_systems() call.`
		);
	}
}
