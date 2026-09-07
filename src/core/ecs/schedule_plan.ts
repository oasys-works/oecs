/***
 * Plan build. One phase's system list turned into the arrays the frame loop
 * reads.
 *
 * Cold. `Schedule._runPhase` reads `phase.plan` as a field and lands here only
 * when an add, a remove or a `configureSet` nulled it. That is why these are
 * free functions with explicit arguments and not methods on a host object: the
 * three pieces of schedule state the sort reads, the set ordering table, the
 * scheduled-system table and the warn sink, travel as parameters, and nothing
 * here holds a `Schedule`.
 *
 * `PhasePlan` is the shape `_runPhase` walks. Its two fields are index
 * aligned, and the loop reads `sorted[i]` and `slots[i]` under one loop guard.
 * Change one field and change the other.
 *
 * `scheduledSystems` maps to an unknown value on purpose. Only membership is
 * read, so the phase node type stays in `schedule.ts` and this file makes no
 * cycle with it.
 ***/

import { topologicalSort } from "../../type_primitives";
import { isSystemSet } from "./system_set";
import type { SystemOrderingTarget, SystemSet } from "./system_set";
import type { SystemDescriptor } from "./system";
import type { RunCondition } from "./run_condition";
import { ECS_ERROR, ECSError } from "./utils/error";
import { DEV } from "../../dev_flag";

/** A phase's execution plan: its topologically sorted systems and, index-aligned,
 * each one's `_lastRunTicks` slot. Cached as a unit and invalidated together. */
export interface PhasePlan {
	readonly sorted: SystemDescriptor[];
	readonly slots: Int32Array;
}

export interface SystemNode {
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

/** One set's accumulated ordering, as `configureSet` builds it. A `Set` and not
 * an array, so a target named twice still adds one edge. */
export interface SetOrdering {
	before: Set<SystemOrderingTarget>;
	after: Set<SystemOrderingTarget>;
}

/**
 * Delegates to the shared topologicalSort utility.
 * Builds the dependency edge map from before and after constraints, then
 * catches any cycle TypeError and re-throws as ECSError.
 */
export function sortSystems(
	nodes: SystemNode[],
	phase: string,
	orderingBySet: ReadonlyMap<SystemSet, SetOrdering>,
	scheduledSystems: ReadonlyMap<SystemDescriptor, unknown>,
	onWarn: (message: string) => void
): SystemDescriptor[] {
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
		resolveEdges(
			node.descriptor,
			node.before,
			"before",
			nodeSet,
			setMembers,
			edges,
			phase,
			scheduledSystems,
			onWarn
		);
		resolveEdges(
			node.descriptor,
			node.after,
			"after",
			nodeSet,
			setMembers,
			edges,
			phase,
			scheduledSystems,
			onWarn
		);
		for (let s = 0; s < node.sets.length; s++) {
			const ord = orderingBySet.get(node.sets[s]);
			if (ord === undefined) continue;
			resolveEdges(
				node.descriptor,
				ord.before,
				"before",
				nodeSet,
				setMembers,
				edges,
				phase,
				scheduledSystems,
				onWarn
			);
			resolveEdges(
				node.descriptor,
				ord.after,
				"after",
				nodeSet,
				setMembers,
				edges,
				phase,
				scheduledSystems,
				onWarn
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
function resolveEdges(
	source: SystemDescriptor,
	targets: Iterable<SystemOrderingTarget>,
	direction: "before" | "after",
	nodeSet: Set<SystemDescriptor>,
	setMembers: Map<SystemSet, SystemDescriptor[]>,
	edges: Map<SystemDescriptor, SystemDescriptor[]>,
	phase: string,
	scheduledSystems: ReadonlyMap<SystemDescriptor, unknown>,
	onWarn: (message: string) => void
): void {
	for (const target of targets) {
		if (isSystemSet(target)) {
			const members = setMembers.get(target);
			if (members === undefined) continue; // no members in this phase
			for (let i = 0; i < members.length; i++) {
				const member = members[i];
				if (member === source) continue; // skip self
				addDirectedEdge(source, member, direction, edges);
			}
			continue;
		}
		if (!nodeSet.has(target)) {
			if (DEV) warnDroppedEdge(source, target, direction, phase, scheduledSystems, onWarn);
			continue;
		}
		addDirectedEdge(source, target, direction, edges);
	}
}

/** Push one directed edge into the adjacency map. Both endpoints are known to
 * be in this phase (callers guard), so `edges.get(...)` is non-null. */
function addDirectedEdge(
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
function warnDroppedEdge(
	source: SystemDescriptor,
	target: SystemDescriptor,
	relation: "before" | "after",
	phase: string,
	scheduledSystems: ReadonlyMap<SystemDescriptor, unknown>,
	onWarn: (message: string) => void
): void {
	// Registered in some other phase → deliberate cross-phase skip, stay quiet.
	if (scheduledSystems.has(target)) return;

	const name = (d: SystemDescriptor) => d.name ?? `system_${d.id}`;
	onWarn(
		`Schedule[${phase}]: \`${name(source)}\` declares \`${relation}\` ordering against ` +
			`\`${name(target)}\`, which is not registered in any phase, the constraint is ignored. ` +
			`Check for a typo or a missing addSystems() call.`
	);
}
