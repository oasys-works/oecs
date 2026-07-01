/***
 * topologicalSort — Kahn's algorithm with a BinaryHeap ready queue.
 *
 * Accepts an arbitrary node set, a dependency edge map, and a tiebreaker
 * comparator used to order nodes that are simultaneously ready (zero in-degree).
 * This makes the output deterministic and priority-driven rather than
 * insertion-order dependent.
 *
 * Throws a built-in TypeError when a cycle is detected, listing the names of
 * the nodes that could not be scheduled.
 *
 ***/

import { BinaryHeap } from "../binary_heap/binary_heap";

/**
 * Topologically sorts `nodes` respecting the dependency edges, breaking ties
 * with the supplied comparator.
 *
 * @param nodes      - All items to sort.
 * @param edges      - Adjacency list: `edges.get(a)` = items that must come after `a`.
 * @param tiebreaker - Comparator for the ready queue (min-heap semantics: lower = higher priority).
 * @param nodeName  - Optional label function for cycle error messages. Defaults to `String(node)`.
 * @returns Sorted array in topological order.
 * @throws {TypeError} If a cycle is detected among the nodes.
 */
/**
 * Topologically sorts `nodes` respecting dependency edges, breaking ties with the comparator.
 *
 */
export function topologicalSort<T>(
	nodes: readonly T[],
	edges: Map<T, T[]>,
	tiebreaker: (a: T, b: T) => number,
	nodeName?: (node: T) => string
): T[] {
	const name = nodeName ?? ((n: T) => String(n));

	// Build in-degree map, initialised to 0 for every declared node.
	const inDegree = new Map<T, number>();
	for (let i = 0; i < nodes.length; i++) {
		inDegree.set(nodes[i], 0);
	}

	// Accumulate in-degrees from the edge list.
	for (const [, successors] of edges) {
		for (let i = 0; i < successors.length; i++) {
			const s = successors[i];
			// Only count edges whose target is a declared node.
			if (inDegree.has(s)) {
				// ! safe: checked with has() above
				inDegree.set(s, inDegree.get(s)! + 1);
			}
		}
	}

	// Seed the ready queue with all zero-in-degree nodes.
	const ready = new BinaryHeap<T>(tiebreaker);
	for (let i = 0; i < nodes.length; i++) {
		if (inDegree.get(nodes[i]) === 0) {
			ready.push(nodes[i]);
		}
	}

	const result: T[] = [];

	while (ready.size > 0) {
		// ! safe: size > 0 guarantees pop() returns a value
		const node = ready.pop()!;
		result.push(node);

		const successors = edges.get(node);
		if (successors !== undefined) {
			for (let i = 0; i < successors.length; i++) {
				const s = successors[i];
				if (!inDegree.has(s)) continue;
				// ! safe: has() checked above
				const deg = inDegree.get(s)! - 1;
				inDegree.set(s, deg);
				if (deg === 0) {
					ready.push(s);
				}
			}
		}
	}

	if (result.length !== nodes.length) {
		const remaining: string[] = [];
		for (const [node, deg] of inDegree) {
			if (deg > 0) remaining.push(name(node));
		}
		throw new globalThis.TypeError(
			`Cycle detected in topological sort. Nodes still pending: ${remaining.join(", ")}`
		);
	}

	return result;
}
