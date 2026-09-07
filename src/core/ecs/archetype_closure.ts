/***
 * Archetype closure for the startup prewarm.
 *
 * What this file owns: the walk from a descriptor set to every archetype mask
 * those descriptors can produce. `ECS.startup` plants the whole set in one
 * store call, so a spawn or a transition that follows finds its archetype
 * already there.
 *
 * What it refuses: any world state. The walk reads descriptors and returns
 * masks, so it holds no store, no schedule and no context.
 *
 * Cold path. One call per `startup()`, and none per frame.
 ***/

import { BitSet } from "../../type_primitives";
import type { ComponentDef } from "./component";
import type { SystemDescriptor } from "./system";

/** Archetype closure from a descriptor set.
 *
 * Each descriptor is a system or an observer's synthesized `SystemDescriptor`.
 * Both carry `spawns` + `transitions`. Seeds the worklist with every
 * descriptor's `spawns`. Iteratively applies every descriptor's `transitions`
 * to every discovered mask whose components cover the transition's `whenHas`.
 * Returns the union of seeds + reachable targets, deduplicated by hash-bucketed
 * mask equality.
 *
 * Termination: every transition either monotonically grows the mask (add
 * outpacing remove), monotonically shrinks it, or returns a mask the
 * `seen` map already holds. Because the universe of masks is bounded by
 * `2^|components|` (and in practice the in-tree spawn and transition set is
 * tiny, ~20 masks at most), the worklist is finite and we exit when it
 * empties.
 *
 * Liberal `whenHas`, over-approximation is fine. An
 * unreachable transition target costs one descriptor row at the SAB tail,
 * not column bytes. Empty `spawns` + `transitions` short-circuit to zero.
 */
export function computeArchetypeClosure(descriptors: Iterable<SystemDescriptor>): BitSet[] {
	const seen = new Map<number, BitSet[]>();
	const work: BitSet[] = [];

	const tryPush = (mask: BitSet): void => {
		const h = mask.hash();
		const bucket = seen.get(h);
		if (bucket !== undefined) {
			for (let i = 0; i < bucket.length; i++) if (bucket[i].equals(mask)) return;
			bucket.push(mask);
		} else {
			seen.set(h, [mask]);
		}
		work.push(mask);
	};

	const maskFromDefs = (defs: readonly ComponentDef[]): BitSet => {
		const m = new BitSet();
		for (let i = 0; i < defs.length; i++) m.set(defs[i].id);
		return m;
	};

	// Pre-compute every transition's `whenHas` BitSet once. The
	// worklist below tests `mask.contains(whenHas)` per (popped mask ×
	// system × transition), so building the BitSet inside that loop
	// allocated O(W × S × T) throwaway sets per `startup()`. `whenHas`
	// depends only on the (system, transition) pair, hoisting it makes
	// allocation O(sum of transition counts). Sharing the cached BitSet
	// across iterations is safe because `mask.contains(when)` only reads
	// `when`.
	const cachedTransitions: {
		readonly whenHas: BitSet;
		readonly add?: readonly ComponentDef[];
		readonly remove?: readonly ComponentDef[];
	}[] = [];
	for (const desc of descriptors) {
		const transitions = desc.transitions;
		for (let i = 0; i < transitions.length; i++) {
			const t = transitions[i];
			cachedTransitions.push({
				whenHas: maskFromDefs(t.whenHas),
				add: t.add,
				remove: t.remove
			});
		}
	}

	// Seed from spawns. Each spawn entry is the full component set a
	// spawned entity carries at flush time.
	for (const desc of descriptors) {
		const spawns = desc.spawns;
		for (let i = 0; i < spawns.length; i++) tryPush(maskFromDefs(spawns[i]));
	}

	// Walk transitions until quiescent. A worklist iteration per discovered
	// mask × declared transition. Cheap because both factors are small in
	// the in-tree system set.
	while (work.length > 0) {
		const mask = work.pop()!;
		for (let i = 0; i < cachedTransitions.length; i++) {
			const t = cachedTransitions[i];
			if (!mask.contains(t.whenHas)) continue;
			const next = mask.copy();
			if (t.add !== undefined) {
				for (let j = 0; j < t.add.length; j++) {
					next.set(t.add[j].id);
				}
			}
			if (t.remove !== undefined) {
				for (let j = 0; j < t.remove.length; j++) {
					next.clear(t.remove[j].id);
				}
			}
			tryPush(next);
		}
	}

	const out: BitSet[] = [];
	for (const bucket of seen.values()) for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
	return out;
}
