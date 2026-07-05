/***
 * Schedule — System execution lifecycle with topological ordering.
 *
 * Systems are organized into 7 phases:
 *   PRE_STARTUP  → STARTUP → POST_STARTUP  (run once via world.startup())
 *   FIXED_UPDATE                            (run at fixed timestep via world.update(dt))
 *   PRE_UPDATE   → UPDATE  → POST_UPDATE   (run every frame via world.update(dt))
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
 * Run conditions / system sets (#576). A system (via `SystemEntry.runIf`) or a
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
 *   world.addSystems(SCHEDULE.UPDATE, moveSys, {
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
 * An opaque handle for a named group of systems (#576). A set carries a shared
 * run condition and shared ordering that every member inherits. Sets are
 * identified by **object identity**, not by name — create one with
 * `systemSet(name)`, hold the handle, and reuse it across `addSystems`
 * (`SystemEntry.set`) and `Schedule.configureSet`. The `name` is for
 * diagnostics only.
 */
export interface SystemSet {
	readonly name: string;
}

/** Create a `SystemSet` handle (#576). Two calls with the same name are two
 * distinct sets — keep the returned handle and pass it around. */
export function systemSet(name: string): SystemSet {
	return Object.freeze({ name });
}

/** A `before`/`after` ordering target: either a concrete system or a whole set
 * (expanded to its members within the same phase at sort time). */
export type SystemOrderingTarget = SystemDescriptor | SystemSet;

/** Shared configuration applied to a `SystemSet` via `configureSet` (#576).
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
	 * it inherits (#576). A `false` verdict skips the body that tick. */
	runIf?: RunCondition | readonly RunCondition[];
	/** Set membership — the system inherits each set's shared condition and
	 * ordering (#576). */
	set?: SystemSet | readonly SystemSet[];
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
	private readonly sortedCache: Map<SCHEDULE, SystemDescriptor[]> = new Map();
	private readonly systemIndex: Map<SystemDescriptor, SCHEDULE> = new Map();
	private readonly systemLastRun: Map<SystemDescriptor, number> = new Map();
	// Only systems carrying a run condition or set membership (#576). The hot
	// loop skips the per-system gate probe entirely when this is empty, so a
	// schedule that uses no conditions runs byte-for-byte the pre-#576 path.
	private readonly gatedSystems: Map<SystemDescriptor, SystemNode> = new Map();
	// Live set configuration, read at sort time (ordering) and run time
	// (conditions) so `configureSet` is order-independent w.r.t. `addSystems`.
	private readonly setConditions: Map<SystemSet, RunCondition[]> = new Map();
	private readonly setOrdering: Map<
		SystemSet,
		{ before: Set<SystemOrderingTarget>; after: Set<SystemOrderingTarget> }
	> = new Map();
	private nextInsertionOrder = 0;
	// The opt-in compute backend (#622), or null (the default — pure-TS). When
	// set, a scheduled system carrying a `backendHandle` runs `backend.run(...)`
	// instead of its `fn`. `null` is the byte-for-byte pre-#622 path: `runLabel`
	// hoists this to a local and only reads `desc.backendHandle` when non-null,
	// so a no-backend ECS never touches the routing field.
	private _backend: ComputeBackend | null = null;

	/** Dev-diagnostic sink (`ECSOptions.onWarn`); defaults to `console.warn`.
	 * The only schedule diagnostic today is `warnDroppedEdge`. */
	private readonly onWarn: (message: string) => void;

	constructor(onWarn?: (message: string) => void) {
		this.onWarn = onWarn ?? ((message) => console.warn(message));
		for (let i = 0; i < STARTUP_LABELS.length; i++) {
			this.labelSystems.set(STARTUP_LABELS[i], []);
		}
		this.labelSystems.set(SCHEDULE.FIXED_UPDATE, []);
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
			this.systemLastRun.set(descriptor, 0);
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
	 * Configure a `SystemSet` (#576) — its shared run condition(s) and/or
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
		this.systemLastRun.delete(system);
		this.gatedSystems.delete(system);
		// A dangling descriptor target left inside a `setOrdering` entry is
		// harmless — `sortSystems` drops any ordering target not present in the
		// phase — so it needs no per-remove sweep across every set.
		this.sortedCache.delete(label);
	}

	/** Attach (or, with `null`, detach) the opt-in compute backend (#622). Driven
	 * by `ECS.attachBackend`; routes any scheduled system carrying a
	 * `backendHandle` to `backend.run(handle)` in place of its `fn`. */
	public setBackend(backend: ComputeBackend | null): void {
		this._backend = backend;
	}

	public runStartup(ctx: SystemContext, tick: number): void {
		for (const label of STARTUP_LABELS) {
			this.runLabel(label, ctx, STARTUP_DELTA_TIME, tick);
		}
	}

	public runUpdate(ctx: SystemContext, deltaTime: number, tick: number): void {
		for (const label of UPDATE_LABELS) {
			this.runLabel(label, ctx, deltaTime, tick);
		}
	}

	public runFixedUpdate(ctx: SystemContext, fixedDt: number, tick: number): void {
		this.runLabel(SCHEDULE.FIXED_UPDATE, ctx, fixedDt, tick);
	}

	public hasFixedSystems(): boolean {
		// ! safe: constructor pre-populates all SCHEDULE enum keys
		return this.labelSystems.get(SCHEDULE.FIXED_UPDATE)!.length > 0;
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

	public clear(): void {
		for (const nodes of this.labelSystems.values()) {
			nodes.length = 0;
		}
		this.sortedCache.clear();
		this.systemIndex.clear();
		this.systemLastRun.clear();
		this.gatedSystems.clear();
		this.setConditions.clear();
		this.setOrdering.clear();
	}

	private runLabel(label: SCHEDULE, ctx: SystemContext, deltaTime: number, tick: number): void {
		const sorted = this.getSorted(label);
		// Probe the gate map only when something in the whole schedule is gated.
		const hasGates = this.gatedSystems.size > 0;
		// Hoist the backend once per phase (constant across the loop). `null` is the
		// common case (no backend attached); then `backendHandle` is never read and
		// the dispatch is byte-for-byte the pre-#622 `desc.fn(ctx, dt)` path. The
		// `=== null` check is a perfectly-predicted branch (the dispatch microbench
		// in docs/reports/bench/ measured it as free vs baseline — and a Null-Object
		// default as a needless tax on this no-backend path). (#622)
		const backend = this._backend;
		// #731: a SystemSet's run conditions gate the set as a unit. Evaluate each
		// set's conditions at most once per phase and reuse the verdict for every
		// member, instead of re-evaluating per member. Run conditions are pure reads
		// and deferred changes aren't flushed until the phase ends, so the memo is
		// observationally identical within a phase while removing the N×-per-set work.
		const setVerdicts: Map<SystemSet, boolean> | undefined = hasGates
			? new Map()
			: undefined;
		for (let i = 0; i < sorted.length; i++) {
			const desc = sorted[i];
			if (hasGates) {
				const node = this.gatedSystems.get(desc);
				// #576: a false run condition skips the body in canonical order, AND
				// leaves last_run unadvanced + enqueues nothing — so a skipped tick is
				// indistinguishable from the system being absent that tick (the
				// `stateHash` equality the acceptance requires).
				if (node !== undefined && !this.shouldRun(node, ctx, setVerdicts!)) continue;
			}
			// lastRunTick exposes the system's *previous* run tick to ChangedQuery,
			// so q.changed(C) sees writes made since this system last ran (cross-tick).
			ctx.lastRunTick = this.systemLastRun.get(desc) ?? 0;
			// Route to the compute backend (#622) only when one is attached AND this
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
			this.systemLastRun.set(desc, tick);
		}
		// Flush deferred changes after each phase so the next phase sees a consistent state
		if (DEV) ctx._trace?.flushBegin(label);
		ctx.flush();
		if (DEV) ctx._trace?.flushEnd(label);
		// The phase has fully settled — systems ran, deferred buffer + observer
		// cascade flushed — so the live world is at a consistent, fingerprint-able
		// point. Fire the per-phase boundary so a consumer can read `stateHash()`
		// between the phases of one frame and bisect a divergence to this phase
		// (#797 / ADR-0032). `DEV`-gated like the rest of the seam (zero prod
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

	private getSorted(label: SCHEDULE): SystemDescriptor[] {
		const cached = this.sortedCache.get(label);
		if (cached !== undefined) return cached;

		// ! safe: constructor pre-populates all SCHEDULE enum keys
		const nodes = this.labelSystems.get(label)!;
		const sorted = this.sortSystems(nodes, label);
		this.sortedCache.set(label, sorted);
		return sorted;
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
		// set → its member descriptors *within this phase* (#576). Cross-phase
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
			// before/after of every set it belongs to (#576). Set conditions gate
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
	 * Add the topo edges for one ordering list (#576). For `"before"` the source
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
