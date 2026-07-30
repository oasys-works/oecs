/**
 * A short run of the interaction-net oracle, against the LIVE TypeScript sources.
 *
 * The complete harness is in this directory, and `README.md` describes it. `run.mjs`
 * is the entry point for a long run, and `mutants.mjs` shows that the oracle finds a
 * bug. This file gives the most important coverage in a few seconds: the answers in a
 * closed form, the invariant of the confluence, a short run with much change, and each
 * layer for the change detection, the row partition, the write seam and the deep walks.
 *
 * THIS FILE IS NOT A PART OF `pnpm test`, AND IT IS NOT A PART OF THE RELEASE GATE.
 * The root `vitest.config.ts` collects `src/**` and nothing else, and a file outside
 * the `include` list of a configuration cannot run, not even by its name. Run this
 * file through the configuration next to it:
 *
 *   pnpm exec vitest run --config bench/net-oracle/vitest.config.ts
 *
 * The reason to keep a vitest file at all, beside `run.mjs`: vitest resolves the
 * sources in `src/` directly, and it defines `__DEV__ = true`. Therefore this file
 * tests the CODE IN THE TREE, with the access checker and each internal assertion
 * active. `run.mjs` tests a BUNDLE, which is what `mutants.mjs` needs.
 *
 * This file has the extension `.mjs`, and it is outside `src/`. This is intentional.
 * `tsconfig.json` includes only `src`, and therefore no tool type-checks the harness.
 *
 * The harness reads the COMPLETE public entry, and not two names from it, because the
 * layers now use the write seam, the events, the resources, the run conditions, the
 * sparse components and the command log. Therefore the import below is a namespace.
 */
import { describe, expect, it } from "vitest";
import * as lib from "../../src/index";
import { assertRulesLinear } from "./spec.mjs";
import { confluence, lockstep, refOnly, runCase } from "./driver.mjs";
import { assertNetSpecValid, dupTree, erasureTree, randomNet } from "./nets.mjs";
import { PROBES } from "./surface.mjs";

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
	// The quarantine draws from its OWN generator for this reason: a shared stream
	// would give the two runs different reduction orders.
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
		expect(stats.ticks).toBe(stats.rewrites + stats.idleTicks);
		expect(stats.snapshots).toBeGreaterThan(0);
	});

	// ── the change detection ────────────────────────────────────────────────
	// `driver.changeCheck` runs at every tick of every case above, and it holds the
	// assertions. These two tests assert that the layer is not INERT. An `onSet`
	// observer that never fired, and a `changed()` query that always gave nothing,
	// would pass every assertion in `changeCheck` except the ones below.
	it("onSet fires for every write, at both granularities", () => {
		const spec = assertNetSpecValid(dupTree(6));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 0,
			steps: 100000,
		});
		// The exact per-tick set equality is inside `changeCheck`. This is the floor:
		// the layer really did fire, many times, at both granularities.
		expect(stats.setEntityCalls).toBeGreaterThan(500);
		expect(stats.setArchCalls).toBeGreaterThan(50);
	});

	it("the change detection goes quiet on a tick that writes no column", () => {
		// The idle tail runs after the net reaches its normal form. It applies no
		// rewrite, so `onSet` and `changed(Touch)` must report nothing, while
		// `changed(Age)` must stay busy. `changeCheck` asserts all of that; this test
		// asserts the tail RAN, because a tail of zero ticks proves nothing.
		const spec = assertNetSpecValid(erasureTree(6));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 0,
			steps: 100000,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.idleTicks).toBeGreaterThanOrEqual(4);
	});

	// ── the row partition, and the host write seam ──────────────────────────
	it("the quarantine disables and enables rows through the write seam", () => {
		const spec = assertNetSpecValid(randomNet(3, 30, 18, 20));
		const stats = runCase(lib, spec, {
			seed: 3,
			label: spec.name,
			maxBatch: 16,
			verifyEvery: 2,
			snapEvery: 32,
			steps: 4000,
		});
		// `quarantineCheck` holds the exact set equality, and `compare` holds the
		// strongest assertion: a disabled row that `eachChunk` still visits gives the
		// wrong `Age.ticks` at the next tick. These are the floors.
		expect(stats.disableCalls).toBeGreaterThan(100);
		expect(stats.enableCalls).toBeGreaterThan(50);
		expect(stats.peakDisabled).toBeGreaterThan(2);
		// The observers fire for a DEFERRED toggle alone, so every one of these calls
		// came through the host write seam.
		expect(stats.disableCalls).toBeGreaterThanOrEqual(stats.enableCalls);
		// A row that is both `Fresh` and DISABLED. The promotion of `Fresh` runs in
		// UPDATE, which is one phase after the flush where a deferred `disable` lands,
		// so the state occurs — and `promoteFresh` must then keep `Fresh` on the row,
		// which `compare()` reads at each tick. With the promotion in PRE_UPDATE the
		// count is always zero and that assertion is unreachable.
		expect(stats.freshDisabledTicks).toBeGreaterThan(10);
		expect(stats.peakFreshDisabled).toBeGreaterThan(1);
	});

	it("the recorded host command log survives a round trip through JSON", () => {
		// `commandLogCheck` compares the count of the logged commands against the count
		// that the harness enqueued, and it compares the log with the log that came back
		// from JSON. The recorder keeps the complete run, so this case is small.
		const spec = assertNetSpecValid(erasureTree(6));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 8,
			verifyEvery: 2,
			snapEvery: 8,
			steps: 100000,
			record: true,
		});
		expect(stats.normalised).toBe(true);
	});

	// ── the deep walk ───────────────────────────────────────────────────────
	it("the chain of records reaches a depth that maxDepth can truncate", () => {
		// `world._assertRecordChain` compares `ancestorsOf`, `rootOf`, the order of the
		// walk and the truncation by `maxDepth` against the model. It needs a chain with
		// more than one edge, and this floor is the proof that it had one.
		const spec = assertNetSpecValid(dupTree(7));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: spec.name,
			maxBatch: 16,
			verifyEvery: 1,
			snapEvery: 0,
			steps: 100000,
			prov: { epochEvery: 8, retain: 4 },
		});
		expect(stats.peakChainDepth).toBeGreaterThan(8);
	});

	// ── the profiles ────────────────────────────────────────────────────────
	it("runs over an f64 column in a world with no determinism", () => {
		// A deterministic world REJECTS a float column, so this arm is the only cover
		// for one. It gives up `stateHash`, `capture` and `restore`, which all need
		// determinism, so `snapEvery` is 0.
		const spec = assertNetSpecValid(dupTree(5));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: `f64 ${spec.name}`,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 0,
			steps: 100000,
			float: true,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.hashable).toBe(false);
		// `compare` compares `Age.fticks` against the same integer that `Age.ticks`
		// holds, so the float column is checked and not merely present.
		expect(stats.rewrites).toBeGreaterThan(0);
	});

	it("runs over the SharedArrayBuffer backing with every layer on", () => {
		const spec = assertNetSpecValid(dupTree(5));
		const stats = runCase(lib, spec, {
			seed: 1,
			label: `sab ${spec.name}`,
			maxBatch: 8,
			verifyEvery: 1,
			snapEvery: 8,
			steps: 100000,
			sab: true,
		});
		expect(stats.normalised).toBe(true);
		expect(stats.sab).toBe(true);
		expect(stats.snapshots).toBeGreaterThan(0);
	});
});

// ── the probes for the API surface ──────────────────────────────────────────
// Each probe is small, and each one has an exact expected value. They cover the
// parts of the API that a net which must keep its meaning cannot reach: a cycle in a
// relation, a named error, a replay into a second world, the batch paths, and the
// combinators for a run condition. `surface.mjs` gives the complete reason.
describe("the API surface (model-checked probes)", () => {
	it.each(PROBES)("%s", (_name, probe, floor) => {
		// The probe reports the count of the assertions that it REALLY made, as the
		// delta of a shared counter. Therefore this floor catches a probe that took an
		// early return or lost its assertions in an edit. A hand-written literal could
		// not: it stays above zero however little the probe did.
		expect(probe(lib)).toBeGreaterThanOrEqual(floor);
	});
});
