import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

/** Spin up an ECS and a handful of live entities for relation wiring. */
function makeWorld(n: number): { ecs: ECS; ents: EntityID[] } {
	const ecs = new ECS();
	const ents: EntityID[] = [];
	for (let i = 0; i < n; i++) ents.push(ecs.createEntity());
	return { ecs, ents };
}

describe("relations wildcard — (R, *) over an exclusive relation", () => {
	it("enumerates no pairs for an empty relation", () => {
		const ecs = new ECS();
		const targets = ecs.registerRelation();
		expect(ecs.pairsOf(targets)).toEqual([]);
	});

	it("enumerates every (source, target) pair", () => {
		const { ecs, ents } = makeWorld(4);
		const targets = ecs.registerRelation();
		ecs.addRelation(ents[0], targets, ents[3]);
		ecs.addRelation(ents[1], targets, ents[2]);
		ecs.addRelation(ents[2], targets, ents[3]);
		expect(ecs.pairsOf(targets)).toEqual([
			[ents[0], ents[3]],
			[ents[1], ents[2]],
			[ents[2], ents[3]]
		]);
	});

	it("orders sources canonically regardless of insertion order", () => {
		const { ecs, ents } = makeWorld(3);
		const targets = ecs.registerRelation();
		// Add out of order; canonical (entity-index ascending) order must win.
		ecs.addRelation(ents[2], targets, ents[0]);
		ecs.addRelation(ents[0], targets, ents[1]);
		expect(ecs.pairsOf(targets)).toEqual([
			[ents[0], ents[1]],
			[ents[2], ents[0]]
		]);
	});

	it("reflects only the current target after a re-target (one-per-source)", () => {
		const { ecs, ents } = makeWorld(3);
		const targets = ecs.registerRelation();
		ecs.addRelation(ents[0], targets, ents[1]);
		ecs.addRelation(ents[0], targets, ents[2]); // overwrites
		expect(ecs.pairsOf(targets)).toEqual([[ents[0], ents[2]]]);
	});

	it("drops a pair once the source's relation is removed", () => {
		const { ecs, ents } = makeWorld(3);
		const targets = ecs.registerRelation();
		ecs.addRelation(ents[0], targets, ents[1]);
		ecs.addRelation(ents[1], targets, ents[2]);
		ecs.removeRelation(ents[0], targets);
		expect(ecs.pairsOf(targets)).toEqual([[ents[1], ents[2]]]);
	});
});

describe("relations wildcard — (R, *) over a multi relation", () => {
	it("enumerates no pairs for an empty relation", () => {
		const ecs = new ECS();
		const likes = ecs.registerRelation({ multi: true });
		expect(ecs.pairsOf(likes)).toEqual([]);
	});

	it("expands a source's whole target set, targets ascending", () => {
		const { ecs, ents } = makeWorld(4);
		const likes = ecs.registerRelation({ multi: true });
		ecs.addRelation(ents[0], likes, ents[3]);
		ecs.addRelation(ents[0], likes, ents[1]);
		ecs.addRelation(ents[0], likes, ents[2]);
		expect(ecs.pairsOf(likes)).toEqual([
			[ents[0], ents[1]],
			[ents[0], ents[2]],
			[ents[0], ents[3]]
		]);
	});

	it("enumerates pairs across multiple multi-target sources, canonically", () => {
		const { ecs, ents } = makeWorld(4);
		const likes = ecs.registerRelation({ multi: true });
		// Source ents[2] added first; sources must still come out index-ascending.
		ecs.addRelation(ents[2], likes, ents[0]);
		ecs.addRelation(ents[2], likes, ents[3]);
		ecs.addRelation(ents[0], likes, ents[1]);
		expect(ecs.pairsOf(likes)).toEqual([
			[ents[0], ents[1]],
			[ents[2], ents[0]],
			[ents[2], ents[3]]
		]);
	});

	it("drops a source from enumeration once its last target is removed", () => {
		const { ecs, ents } = makeWorld(3);
		const likes = ecs.registerRelation({ multi: true });
		ecs.addRelation(ents[0], likes, ents[1]);
		ecs.addRelation(ents[1], likes, ents[2]);
		ecs.removeRelation(ents[0], likes, ents[1]); // empties ents[0]'s set
		expect(ecs.pairsOf(likes)).toEqual([[ents[1], ents[2]]]);
	});
});

describe("relations wildcard — (*, T) across all relation kinds", () => {
	it("returns no sources when nothing targets T", () => {
		const { ecs, ents } = makeWorld(2);
		ecs.registerRelation();
		expect(ecs.sourcesOfAny(ents[1])).toEqual([]);
	});

	it("collects sources of T from a single relation", () => {
		const { ecs, ents } = makeWorld(4);
		const targets = ecs.registerRelation();
		ecs.addRelation(ents[0], targets, ents[3]);
		ecs.addRelation(ents[1], targets, ents[3]);
		ecs.addRelation(ents[2], targets, ents[0]); // unrelated target
		expect(ecs.sourcesOfAny(ents[3])).toEqual([
			[targets, ents[0]],
			[targets, ents[1]]
		]);
	});

	it("spans every relation kind, ordered by relation id then source id", () => {
		const { ecs, ents } = makeWorld(5);
		const targets = ecs.registerRelation(); // relation id 0 (exclusive)
		const likes = ecs.registerRelation({ multi: true }); // relation id 1
		// T = ents[4]. Sources across both relations.
		ecs.addRelation(ents[2], targets, ents[4]);
		ecs.addRelation(ents[0], targets, ents[4]);
		ecs.addRelation(ents[3], likes, ents[4]);
		ecs.addRelation(ents[1], likes, ents[4]);
		expect(ecs.sourcesOfAny(ents[4])).toEqual([
			[targets, ents[0]],
			[targets, ents[2]],
			[likes, ents[1]],
			[likes, ents[3]]
		]);
	});
});

describe("relations wildcard — determinism", () => {
	// Insertion-order independence is asserted directly: edges go into a
	// SINGLE world in scrambled order, then `pairsOf` must return the
	// spec-canonical order (sources ascending by entity index; each source's
	// targets ascending by id). Comparing against an explicit sorted
	// expectation — rather than a second world built in a different order —
	// is what keeps this non-tautological: a `pairsOf` that leaked
	// insertion order would fail the expectation, whereas two
	// identically-created worlds (same EntityIDs) would still match each
	// other regardless of the fold. Cross-world + `stateHash` determinism
	// is covered by `relations_canonical_fold.test.ts`.

	it("(R, *) folds scrambled inserts to canonical source order (exclusive)", () => {
		const { ecs, ents } = makeWorld(5);
		const r = ecs.registerRelation();
		// Sources inserted out of index order: 3, 0, 4, 1.
		ecs.addRelation(ents[3], r, ents[0]);
		ecs.addRelation(ents[0], r, ents[2]);
		ecs.addRelation(ents[4], r, ents[1]);
		ecs.addRelation(ents[1], r, ents[3]);
		// Spec: sources ascending by entity index.
		expect(ecs.pairsOf(r)).toEqual([
			[ents[0], ents[2]],
			[ents[1], ents[3]],
			[ents[3], ents[0]],
			[ents[4], ents[1]]
		]);
	});

	it("(R, *) folds scrambled inserts to canonical source+target order (multi)", () => {
		const { ecs, ents } = makeWorld(5);
		const r = ecs.registerRelation({ multi: true });
		// Both source order and per-source target order scrambled.
		ecs.addRelation(ents[3], r, ents[4]);
		ecs.addRelation(ents[0], r, ents[3]);
		ecs.addRelation(ents[3], r, ents[1]);
		ecs.addRelation(ents[0], r, ents[1]);
		ecs.addRelation(ents[0], r, ents[2]);
		// Spec: sources ascending; within a source, targets ascending by id.
		expect(ecs.pairsOf(r)).toEqual([
			[ents[0], ents[1]],
			[ents[0], ents[2]],
			[ents[0], ents[3]],
			[ents[3], ents[1]],
			[ents[3], ents[4]]
		]);
	});
});
