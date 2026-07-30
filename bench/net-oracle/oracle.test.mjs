/**
 * A small part of the interaction-net oracle, with the size for CI.
 *
 * The complete harness is in this directory, and `README.md` describes it. `run.mjs`
 * is the entry point for a long run, and `mutants.mjs` shows that the oracle finds a
 * bug. This file exists to give the most important coverage to the normal `pnpm test`
 * run, in a few seconds: the answers in a closed form, the invariant of the
 * confluence, and a short run with much change.
 *
 * This file runs against the live TypeScript sources, and not against a bundle.
 * vitest resolves those sources, and it defines `__DEV__ = true`. Therefore the
 * access checker of the development build and each internal assertion are active.
 *
 * This file has the extension `.mjs`, and it is outside `src/`. This is intentional.
 * `tsconfig.json` includes only `src`, and therefore no tool type-checks the harness.
 * The default glob of vitest still finds `**` and `*.test.mjs`.
 */
import { describe, expect, it } from "vitest";
import { ECS, SCHEDULE } from "../../src/index";
import { assertRulesLinear } from "./spec.mjs";
import { confluence, lockstep, refOnly, runCase } from "./driver.mjs";
import { assertNetSpecValid, dupTree, erasureTree, randomNet } from "./nets.mjs";

const lib = { ECS, SCHEDULE };

describe("interaction-net oracle (deterministic simulation, lockstep vs reference)", () => {
	it("the rule table is linear — the precondition for every confluence claim", () => {
		expect(() => assertRulesLinear()).not.toThrow();
	});

	// The erasure tree's rewrite count is derivable by hand, so this is the one
	// assertion in the harness that neither implementation can influence: both can
	// be wrong together and still fail it.
	it.each([1, 4, 8, 11])(
		"erasure tree depth %i reduces in exactly 2^(depth+1) rewrites",
		(depth) => {
			const spec = assertNetSpecValid(erasureTree(depth));
			const stats = runCase(lib, spec, {
				seed: 1,
				label: spec.name,
				maxBatch: 16,
				// Per-tick verification is O(live agents); at depth 11 that is 4098 of
				// them, so the big case verifies less often to stay CI-sized. `--soak`
				// is where duration lives, not here.
				verifyEvery: depth <= 8 ? 1 : 8,
				snapEvery: 8,
				steps: 100000,
			});
			expect(stats.normalised).toBe(true);
			expect(stats.rewrites).toBe(spec.expectRewrites);
			expect(stats.live).toBe(spec.expectAgents);
			expect(stats.loops).toBe(spec.expectLoops);
			// Non-vacuity: rows really did move between archetypes, and the redex queue
			// really was maintained by observer callbacks.
			expect(stats.archetypes.size).toBeGreaterThanOrEqual(5);
			expect(stats.observerAdds).toBeGreaterThan(0);
			expect(stats.observerRemoves).toBeGreaterThan(0);
		}
	);

	// Commutation is the only rule that grows the net, so these carry the
	// spawn/allocation pressure.
	it.each([5, 7])("duplication tree depth %i grows, then normalises cleanly", (depth) => {
		const spec = assertNetSpecValid(dupTree(depth));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 16,
			verifyEvery: 1,
			snapEvery: 8,
			steps: 100000,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.peakAgents).toBeGreaterThan(spec.types.length);
		expect(stats.archetypes.size).toBeGreaterThanOrEqual(8);
	});

	// Unstructured churn — and the only generator that produces CON~CON / DUP~DUP.
	it.each([1, 3, 6])("random net seed %i churns without diverging", (seed) => {
		const spec = assertNetSpecValid(randomNet(seed, 30, 18, 20));
		const stats = runCase(lib, spec, {
			seed,
			label: spec.name,
			maxBatch: 16,
			verifyEvery: 4,
			snapEvery: 64,
			steps: 4000,
		});
		expect(stats.rewrites).toBeGreaterThan(0);
		expect(stats.observerAdds).toBeGreaterThan(0);
	});

	// The deepest oracle: strong confluence means the rewrite count and the normal
	// form are order-invariant. If the ECS's storage loses a link or mis-migrates a
	// row under one reduction order and not another, these part company — and no
	// reference implementation is needed to see it.
	it.each([
		["erasureTree(6)", () => erasureTree(6)],
		["dupTree(4)", () => dupTree(4)],
		["dupTree(6)", () => dupTree(6)],
		["randomNet(11,20,10,14)", () => randomNet(11, 20, 10, 14)],
	])("%s reaches the same normal form in the same rewrite count under 3 orders", (_n, make) => {
		const spec = assertNetSpecValid(make());
		const r = confluence(lib, spec, {
			orders: 3,
			batch: 8,
			steps: 100000,
			verifyEvery: 8,
			snapEvery: 0,
			label: spec.name,
		});
		expect(r.checked).toBe(true);
		expect(r.orders).toBe(3);
	});

	// A reference reduced alone and the same reference reduced inside the lockstep
	// tick loop must agree exactly — a check on the harness rather than the ECS.
	it("the tick loop does not perturb the reference model", () => {
		const spec = assertNetSpecValid(dupTree(6));
		const pre = refOnly(spec, 1, 100000);
		const stats = lockstep(lib, spec, {
			seed: 1,
			batch: 7,
			steps: 100000,
			verifyEvery: 1,
			snapEvery: 0,
			label: spec.name,
		});
		expect(stats.rewrites).toBe(pre.rewrites);
		expect(stats.canonical.form).toBe(pre.canonical.form);
		expect(stats.loops).toBe(pre.loops);
	});

	// ── the provenance layer ────────────────────────────────────────────────
	// Every case above already runs it (it is on by default) and the deep
	// assertions live in `world.assertProvenance` / `driver.compactCheck`. These two
	// tests assert the layer is not INERT — that the cascade, the multi sets, and
	// the orphan reclaim actually happened rather than silently doing nothing.
	it("cascade-destroys records transitively, firing onRemove for every victim", () => {
		const spec = assertNetSpecValid(erasureTree(8));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 8,
			steps: 100000,
			prov: { epochEvery: 4, retain: 3 },
			compactEvery: 8,
		});
		const p = stats.provStats;
		expect(p.recordsCreated).toBe(stats.rewrites);
		expect(p.epochsPruned).toBeGreaterThan(2);
		expect(p.recordsCascaded).toBeGreaterThan(100);
		// Records are destroyed ONLY by the cascade — nothing ever despawns one
		// directly — so this equality is the assertion that a `"delete"` cascade fires
		// `onRemove` for every entity it transitively destroys.
		expect(stats.recordRemoves).toBe(p.recordsCascaded);
		expect(stats.recordAdds).toBe(p.recordsCreated);
		// `compact()` reclaimed real orphaned reverse-index keys, checked against an
		// exact prediction inside `compactCheck`.
		expect(stats.compactions).toBeGreaterThan(0);
		expect(stats.compactReclaimed).toBeGreaterThan(0);
	});

	it("multi target sets reach full width and shrink as their targets die", () => {
		// Commutation is the only rule that creates four agents at once, so it is the
		// only way to get a 4-wide `Produced` set.
		const spec = assertNetSpecValid(dupTree(6));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 8,
			steps: 100000,
			prov: { epochEvery: 4, retain: 3 },
			compactEvery: 8,
		});
		expect(stats.provStats.maxProducedSet).toBe(4);
		expect(stats.provStats.recordsCascaded).toBeGreaterThan(0);
	});

	it("runs with the provenance layer omitted", () => {
		const spec = assertNetSpecValid(dupTree(5));
		const stats = lockstep(lib, spec, {
			seed: 1,
			batch: 4,
			steps: 100000,
			verifyEvery: 1,
			snapEvery: 8,
			label: spec.name,
			prov: null,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.provStats).toBeNull();
	});

	// Every structural mutation goes through `ctx.commands` at batch=1, which puts
	// one rewrite per flush and so the tightest possible observer/migration cadence.
	it("survives per-rewrite flushing (batch=1)", () => {
		const spec = assertNetSpecValid(dupTree(5));
		const stats = lockstep(lib, spec, {
			seed: 2,
			batch: 1,
			steps: 100000,
			verifyEvery: 1,
			snapEvery: 16,
			label: spec.name,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.ticks).toBe(stats.rewrites);
		expect(stats.snapshots).toBeGreaterThan(0);
	});
});
