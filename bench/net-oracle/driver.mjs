/**
 * The driver of the oracle. It holds all the code that decides if the ECS is
 * incorrect. It has no command line, and it does no build. `run.mjs` is the command
 * line for this file. `oracle.test.mjs` is the entry point with the size for CI.
 * `mutants.mjs` uses this file through `run.mjs`.
 *
 * The caller gives the ECS module as `lib`, and this file does not import it.
 * Therefore the same driver can run against a bundle from the source, against a
 * bundle with an intentional error, or against the live TypeScript sources in
 * vitest.
 *
 * The header of `run.mjs` describes each layer of the oracle. It also gives the
 * reason for this workload.
 */
import { applyRewrite, assertRulesLinear, rng, PORTS, ROOT, RULE_ID, TYPE_NAME } from "./spec.mjs";
import { RefNet } from "./ref.mjs";
import { RefProv } from "./prov.mjs";
import { EcsNet } from "./world.mjs";

/** Default provenance-layer shape: an epoch every 8 ticks, 4 retained. At the
 * suite's batch of 32 that bounds the live record population to ~1k while pruning
 * (and therefore cascade-destroying) an epoch's worth of records every 8 ticks. */
export const PROV_DEFAULT = { epochEvery: 8, retain: 4 };

/**
 * Default quarantine shape. Each tick disables about 6 % of the live agents and
 * enables about half of the agents that are already disabled. Therefore the
 * disabled population reaches a level of about 6 % and it keeps turning over,
 * instead of growing until it holds the complete net.
 *
 * `churnFrac` selects the part of the picks that go the "disable, enable, disable in
 * ONE drain" way. An observer fires one time for each NET transition, so the ECS
 * must collapse that sequence to a single `onDisable` call. Without this path the
 * collapse has no test.
 */
export const QUAR_DEFAULT = { every: 1, frac: 0.06, churnFrac: 0.25 };

/** How many ticks with no rewrite to run after the net reaches its normal form.
 * The change detection must go quiet, and the layer must not be quiet before that.
 * Refer to `changeCheck`. A write at tick T stays visible to a system whose previous
 * run was at T-1 or at T, so a write leaves the window two ticks later. The first
 * idle tick releases the quarantine and the second promotes `Fresh`, and each of
 * those moves rows. Therefore the last two ticks of five are the quiet ones. */
const IDLE_TAIL = 5;

assertRulesLinear();

// ── failure reporting ───────────────────────────────────────────────────────
export class Divergence extends Error {}

export function fail(where, msg) {
	throw new Divergence(`${where}: ${msg}`);
}

// ── one lockstep run ────────────────────────────────────────────────────────
/**
 * Reduce `spec` in lockstep. The reference plans each tick's batch (picking
 * redexes with `seed`), the ECS replays exactly that plan, and the two are
 * compared at the tick boundary.
 *
 * The reference does the picking on purpose: if the ECS chose, a discovery bug
 * would silently change the reduction sequence and the two nets would be
 * incomparable step-by-step. The ECS's own discovery is still fully checked —
 * that is what the observer-queue oracle is for.
 */
export function lockstep(
	lib,
	spec,
	{
		seed,
		batch,
		steps,
		verifyEvery,
		snapEvery,
		label,
		prov = PROV_DEFAULT,
		compactEvery = 16,
		quar = QUAR_DEFAULT,
		float = false,
		record = false,
		sab = false,
	}
) {
	const rand = rng(seed);
	// The quarantine has its OWN generator. It must not take a number from `rand`,
	// because `rand` selects the reduction order and `runCase` compares this run
	// against a run of the reference alone at the same seed. A shared stream makes the
	// two orders different, and two different orders of a BOUNDED prefix give two
	// different nets — which is correct behaviour that looks like a fault.
	const quarRand = rng((seed ^ 0x5bf03635) >>> 0);
	// The marks for the change detection have their OWN generator, for the same
	// reason. Refer to `makeMarks`.
	const markRand = rng((seed ^ 0x1d872b41) >>> 0);
	const ref = RefNet.load(spec);
	const provRef = prov === null ? null : new RefProv(prov);
	const world = new EcsNet(lib, { strict: true, prov, float, record, sab });
	world.load(spec);

	ref.assertConsistent(`${label} t0 (ref load)`);

	// The one ROOT. `nets.mjs` rejects a specification with any other number, no rule
	// makes a ROOT, and a pair that holds the ROOT is inert. Therefore this reference
	// id is fixed for the whole run, and it gives `singleEntity` an expected value.
	let rootRef = -1;
	for (const a of ref.liveAgents()) {
		if (ref.typeOf(a) === ROOT) rootRef = a;
	}
	if (rootRef < 0) fail(label, `the loaded net holds no ROOT agent`);

	const stats = {
		rewrites: 0,
		ticks: 0,
		idleTicks: 0,
		peakAgents: ref.live,
		archetypes: new Set(),
		observerAdds: 0,
		observerRemoves: 0,
		recordAdds: 0,
		recordRemoves: 0,
		snapshots: 0,
		compactions: 0,
		compactReclaimed: 0,
		normalised: false,
		ruleHits: new Map(),
		prov: provRef,
		// the new layers
		setEntityCalls: 0,
		setArchCalls: 0,
		disableCalls: 0,
		enableCalls: 0,
		peakDisabled: 0,
		peakChainDepth: 0,
		// The ticks that held a row which was both `Fresh` and disabled. The promotion
		// runs in UPDATE, one phase after the flush where a deferred `disable` lands.
		// Therefore the state occurs, and `promoteFresh` must keep `Fresh` on the row.
		freshDisabledTicks: 0,
		peakFreshDisabled: 0,
		// The spans of the `optional(Age)` query. The layer compares both, so both must
		// occur. A run that reached the span with no `Age` zero times tested `optional`
		// against a query where each archetype held the column, and there the verb
		// makes no difference. The span with no `Age` is the `Fresh` agents.
		optionalSpansWithAge: 0,
		optionalSpansWithoutAge: 0,
		// The ticks on which `forEachUntil` stopped early. A run whose query never gave
		// two archetypes would only ever walk to the end, and the early-out would have
		// no cover.
		untilStops: 0,
		// The calls of `ctx.markChanged`. A run with none of them makes the per-entity
		// layer and the archetype layer agree, and the difference between them is what
		// this mechanism tests.
		markCalls: 0,
		// The calls of `ctx.removeRelation`. Each other change to a `Produced` set comes
		// from the `"clear"` policy, so a run with none of these leaves the explicit
		// unlink from a system with no cover.
		unlinkCalls: 0,
		// The snapshot round trips that wrote one byte into the SPARSE store. The write
		// needs one agent in an active pair. Therefore a snapshot on the tick that used
		// the last active pair skips the write. Without this count, that skip is
		// silent.
		sparseScribbles: 0,
		gatedRuns: 0,
		expectedGated: 0,
		events: 0,
		hashable: world.hashable,
		sab,
	};

	while (stats.rewrites < steps) {
		// Decide whether a tick happens at all BEFORE mirroring any of its phases.
		// `promoteFresh` is the reference's stand-in for the ECS's PRE_UPDATE system,
		// so running it on an iteration that then breaks out would advance the
		// reference by half a tick that the ECS never ran — a one-tick `Fresh` skew
		// reported as a divergence. Normalisation is knowable up front because
		// `Fresh`/`Age` have no influence on which pairs are active.
		ref.settleRedex();
		if (ref.redexCount === 0) {
			stats.normalised = true;
			break;
		}

		// The quarantine. The ORDER of the two calls is a requirement. The apply system
		// of the HOST WRITE SEAM is at the HEAD of PRE_UPDATE. A `disable` command is
		// DEFERRED, so it lands at the flush at the END of that phase. `freshPromote`
		// is in UPDATE, which is one phase later. Therefore it reads the quarantine
		// AFTER the toggles of this tick. This model must apply the plan first, and
		// promote after. That order makes a row that is both `Fresh` and disabled
		// possible. `promoteFresh` must then keep `Fresh` on that row.
		const quarPlan = makeQuarantine(quarRand, ref, quar, stats.ticks);
		ref.applyQuarantine(quarPlan);

		// The state that the promotion must keep, read before the promotion changes it.
		const freshDisabled = ref.freshDisabledCount();
		if (freshDisabled > 0) {
			stats.freshDisabledTicks++;
			if (freshDisabled > stats.peakFreshDisabled) stats.peakFreshDisabled = freshDisabled;
		}

		// Mirrors the ECS's promotion in UPDATE, which runs before the rewrites.
		ref.promoteFresh();

		// Mirrors the ECS's PRE_UPDATE epoch roll, which also runs before the
		// rewrites — so a record logged below lands in the epoch the ECS just opened,
		// and a pruned epoch's records are already gone on both sides.
		let roll = null;
		if (provRef !== null) {
			const r = provRef.roll(stats.ticks);
			if (r !== null) {
				roll = {
					created: r.created,
					pruned: r.pruned,
					ancestors: provRef.epochs.get(r.created).ancestors,
				};
			}
		}

		// ── plan: the reference reduces up to `batch` pairs, recording each ──
		const plan = [];
		for (let i = 0; i < batch && stats.rewrites + plan.length < steps; i++) {
			ref.settleRedex();
			if (ref.redexCount === 0) break;
			const [a, b] = ref.pickRedex(rand);
			ref.takeCreated();
			const rule = applyRewrite(ref, a, b);
			if (rule === null) fail(label, `reference picked inert pair (${a},${b})`);
			stats.ruleHits.set(rule.name, (stats.ruleHits.get(rule.name) ?? 0) + 1);
			const made = ref.takeCreated();
			// Order mirrors the ECS exactly: the redex pair is destroyed first (which
			// is what pulls it out of every older record's `Produced` set under the
			// `"clear"` policy), and only then is this rewrite's record logged.
			let rec = null;
			if (provRef !== null) {
				provRef.onAgentDeath(a);
				provRef.onAgentDeath(b);
				rec = provRef.addRecord(RULE_ID[rule.name], made);
			}
			plan.push({ a, b, made, rule: RULE_ID[rule.name], rec });
			// Sampled per rewrite, not per tick: with a large batch the whole growth
			// phase can happen inside one tick, and a tick-boundary sample would
			// report a net that "never grew" while it had in fact quadrupled.
			stats.peakAgents = Math.max(stats.peakAgents, ref.live);
		}
		if (plan.length === 0) {
			stats.normalised = true;
			break;
		}
		ref.settleRedex();

		// ── replay on the ECS, then advance both sides' tick bookkeeping ─────
		// The phase number gates a system through `runIfResourceEq`. The driver picks
		// the number, so the driver knows the exact set of ticks that the gate permits.
		const phase = stats.ticks % 3;
		if (phase === 0) stats.expectedGated++;
		// The verification cadence, decided BEFORE the tick. `net-verify-read` runs
		// INSIDE the tick, and its sets over each agent are O(live), so it has to know
		// there whether the driver will read them.
		const deep = (stats.ticks + 1) % verifyEvery === 0;
		// The marks follow the same cadence. `makeMarks` reads the live set, which is
		// O(live), and a soak case holds hundreds of thousands of agents.
		const marks = deep ? makeMarks(markRand, ref) : [];
		stats.markCalls += marks.length;
		// The explicit unlink of one `Produced` pair, on the same cadence.
		const unlink = deep ? makeUnlink(markRand, provRef) : null;
		world.runTick(plan, roll, quarPlan, phase, deep, marks, unlink);
		if (unlink !== null) {
			// The model applies the same removal. The comparison of the `Produced` set in
			// `assertProvenance` then reads it, element by element.
			provRef.unlinkProduced(unlink.serial, unlink.targetRef);
			stats.unlinkCalls++;
		}
		ref.ageTick(); // mirrors the ECS's POST_UPDATE age bump
		stats.rewrites += plan.length;
		stats.ticks++;

		const where = `${label} tick ${stats.ticks} (rewrite ${stats.rewrites})`;

		// The set of agents that THIS tick wrote, from the reference. It must be taken
		// every tick; a tick that left it in place would give the union of two ticks.
		const touched = ref.takeTouched();
		if (ref.disabled.size > stats.peakDisabled) stats.peakDisabled = ref.disabled.size;

		// ── tier 1: cheap totals, every tick ────────────────────────────────
		if (world.loops !== ref.loops) {
			fail(where, `wire-loop count: ecs ${world.loops}, ref ${ref.loops}`);
		}
		if (world.rewritesApplied !== stats.rewrites) {
			fail(where, `ecs applied ${world.rewritesApplied} rewrites, planned ${stats.rewrites}`);
		}
		if (world.gatedRuns !== stats.expectedGated) {
			fail(
				where,
				`the gated system ran ${world.gatedRuns} times, the run condition permits ` +
					`${stats.expectedGated} (one for each tick with phase 0)`
			);
		}
		// The channel of the events, every tick. It is O(batch), and it is the check
		// that a channel clears itself at the end of each update.
		eventCheck(where, world, plan, roll, fail);
		stats.events += plan.length;
		// The change detection, every tick. A set of the ECS holds ONE tick, so this
		// cannot wait for the cadence of the deep verification. The `deep` part is the
		// comparison over each live agent, and that part follows the cadence.
		changeCheck(where, ref, world, fail, touched, { deep, quiesce: false, marked: marks });
		// The query verbs. The cheap items run at each tick, and the sets over each
		// agent follow the same cadence as the deep comparison.
		queryVerbCheck(where, ref, world, fail, { deep, phase, rootRef });
		if (world.untilStopped) stats.untilStops++;
		// `ctx.hasRelation` around the explicit unlink. It asks whether the source holds
		// ANY target, so the value after the call is "the set still holds something",
		// and the model gives that number.
		if (unlink !== null) {
			if (world.unlinkBefore !== true) {
				fail(where, `ctx.hasRelation(record ${unlink.serial}, Produced) was ${world.unlinkBefore} ` +
					`before the unlink, and the model says the set held a target`);
			}
			const wantAfter = unlink.remaining > 0;
			if (world.unlinkAfter !== wantAfter) {
				fail(where, `ctx.hasRelation(record ${unlink.serial}, Produced) is ${world.unlinkAfter} ` +
					`after the unlink, want ${wantAfter} (${unlink.remaining} targets left)`);
			}
		}

		// ── tier 2: full structure, every `verifyEvery` ticks ────────────────
		if (deep) {
			ref.assertConsistent(`${where} [ref]`);
			ref.assertRedexIndex(`${where} [ref]`);
			world.assertSelfConsistent(`${where} [ecs]`);
			compare(where, ref, world);
			quarantineCheck(where, ref, world, fail);
			sparseCheck(where, ref, world, fail);
			if (provRef !== null) world.assertProvenance(`${where} [prov]`, provRef, fail);
			for (const s of world.archetypeSignatures()) stats.archetypes.add(s);
		}

		// ── tier 3: snapshot metamorphism ───────────────────────────────────
		// A world with a float column has no determinism, and `capture`, `restore` and
		// `stateHash` all need determinism. Therefore this tier is absent from the
		// float arm, and the report says so.
		if (world.hashable && snapEvery > 0 && stats.ticks % snapEvery === 0) {
			// The result says if the round trip reached the SPARSE store. That write
			// needs one agent in an active pair. A snapshot on the tick that used the
			// last active pair finds none. The floor for non-vacuity counts the rest.
			if (snapshotRoundTrip(where, world)) stats.sparseScribbles++;
			// The partition of the rows must survive the round trip, and so must the
			// sparse store. Both are part of the state, and neither is a dense column.
			quarantineCheck(`${where} [post-restore]`, ref, world, fail);
			sparseCheck(`${where} [post-restore]`, ref, world, fail);
			// A snapshot captures sparse relations — including multi forward target
			// sets, which `stateHash` folds in — so the provenance layer has to survive
			// the round-trip too, not just the dense agent columns.
			if (provRef !== null) {
				world.assertProvenance(`${where} [prov post-restore]`, provRef, fail);
				// The restore rebuilt the reverse index from the forward links, which
				// under `"orphan"` still name dead targets — so every key a previous
				// `compact()` reclaimed is back. See `RefProv.noteRestored`.
				provRef.noteRestored();
			}
			stats.snapshots++;
		}

		// ── tier 4: orphan reclaim ──────────────────────────────────────────
		if (provRef !== null && compactEvery > 0 && stats.ticks % compactEvery === 0) {
			compactCheck(where, world, provRef, stats);
		}
	}

	// ── the idle tail: the change detection must go quiet ───────────────────
	// Each check above asks "did the ECS report the change". None of them asks "did
	// the ECS report a change that did not happen". A layer that reported EVERY
	// archetype at EVERY tick would pass each of them. These ticks close that hole.
	// They apply no rewrite, so they write no column. Therefore the `onSet`
	// observers and the `changed(Touch)` query must go quiet, and `changed(Age)` must
	// stay busy, because `ageTick` keeps asking for its mutable accessor.
	//
	// Only a run that reached a normal form can do this. A capped run still has
	// active pairs, so a tick with no rewrite would put the two sides out of step.
	if (stats.normalised) {
		for (let k = 0; k < IDLE_TAIL; k++) {
			// The first idle tick releases the complete quarantine. Two reasons. It makes
			// the tail the same for each seed, because a run can otherwise end with each
			// surviving agent disabled, and then `changed(Age)` is correctly empty and the
			// assertion about a busy `Age` layer has nothing to read. It also drives one
			// bulk `enable`, which is a path that the small per-tick plans do not reach.
			const release =
				k === 0 && ref.disabled.size > 0
					? { disable: [], enable: [...ref.disabled], churn: [], count: new Map() }
					: null;
			ref.applyQuarantine(release);
			// After the release, for the reason that the tick loop above gives: the
			// promotion is in UPDATE, so it sees the toggles of this tick.
			ref.promoteFresh();
			// The tail marks agents on each of its ticks. This tick writes no column, so
			// a mark is the only reason for a report, and the pair of assertions in
			// `changeCheck` is then exact: the per-entity layer must give exactly these
			// agents, and each archetype layer must give nothing.
			const idleMarks = makeMarks(markRand, ref);
			stats.markCalls += idleMarks.length;
			world.runTick([], null, release, -1, true, idleMarks);
			ref.ageTick();
			stats.ticks++;
			stats.idleTicks++;
			const idleTouched = ref.takeTouched();
				const iw = `${label} idle tick ${k + 1}`;
			if (idleTouched.size !== 0) {
				fail(iw, `the reference wrote ${idleTouched.size} agents on a tick with no rewrite`);
			}
			// The last two idle ticks must be quiet. The first ones may not be: a write
			// at tick T stays visible to a system whose previous run was at T, and the
			// promotion of `Fresh` on the first idle tick moves rows, which makes the
			// archetype that receives them changed.
			changeCheck(iw, ref, world, fail, idleTouched, {
				deep: true,
				quiesce: k >= IDLE_TAIL - 2,
				marked: idleMarks,
			});
			// The tail is where `firstEntity` must give `undefined`: the net reached its
			// normal form, so no active pair is left. A query that always gave its first
			// row passes each tick above and fails here.
			queryVerbCheck(iw, ref, world, fail, { deep: true, phase: -1, rootRef });
			compare(iw, ref, world);
			quarantineCheck(iw, ref, world, fail);
		}
	}

	stats.observerAdds = world.observerAdds;
	stats.observerRemoves = world.observerRemoves;
	stats.recordAdds = world.recordAdds;
	stats.recordRemoves = world.recordRemoves;
	stats.setEntityCalls = world.setEntityCalls;
	stats.setArchCalls = world.setArchCalls;
	stats.disableCalls = world.disableCalls;
	stats.enableCalls = world.enableCalls;
	stats.gatedRuns = world.gatedRuns;
	stats.optionalSpansWithAge = world.optionalSpansWithAge;
	stats.optionalSpansWithoutAge = world.optionalSpansWithoutAge;

	// Final full verification regardless of the cadence above.
	const where = `${label} final (rewrite ${stats.rewrites})`;
	ref.assertConsistent(`${where} [ref]`);
	ref.assertRedexIndex(`${where} [ref]`);
	world.assertSelfConsistent(`${where} [ecs]`);
	compare(where, ref, world);
	quarantineCheck(where, ref, world, fail);
	sparseCheck(where, ref, world, fail);
	if (world.recorder !== null) commandLogCheck(where, world, fail);
	if (provRef !== null) {
		world.assertProvenance(`${where} [prov]`, provRef, fail);
		// `compactEvery === 0` means "do not use the compact path", and the final block
		// must obey it as the tick loop above does. This call ignored the option
		// before, and thus `--compact=0` still made one `compact()` call and its
		// assertions. A run that excludes a path must exclude it completely.
		if (compactEvery > 0) compactCheck(where, world, provRef, stats);
	}
	for (const s of world.archetypeSignatures()) stats.archetypes.add(s);

	stats.canonical = world.canonical();
	stats.census = ref.census();
	stats.live = ref.live;
	stats.loops = ref.loops;
	stats.provStats = provRef === null ? null : provRef.stats;
	stats.peakChainDepth = provRef === null ? 0 : provRef.stats.maxChainDepth;
	// Release the world's backing before returning. The suite builds ~30 of these in
	// one process and the growth soak cases each hold hundreds of thousands of
	// agents; without this they all stay resident at once.
	world.redexObserver.dispose();
	world.toggleObserver.dispose();
	world.touchEntityObserver.dispose();
	world.touchArchObserver.dispose();
	world.ageArchObserver.dispose();
	world.ecs.dispose();
	return stats;
}

// ── the quarantine plan ─────────────────────────────────────────────────────
/**
 * Make one quarantine plan from the seed.
 *
 * The driver makes the plan, and it gives the SAME plan to the reference and to the
 * host queue of the ECS. Therefore the plan is an input to both sides, and it is not
 * a derivation of either one.
 *
 * Three lists come out:
 *   - `enable` — about half of the agents that are disabled now. Without this list
 *     the disabled population grows until it holds the complete net, and the enable
 *     path gets no test.
 *   - `disable` — agents that are enabled now.
 *   - `churn` — agents that are enabled now, and that the host disables, enables and
 *     disables again in ONE drain. An observer fires one time for each NET
 *     transition, so the ECS must collapse that sequence to one `onDisable` call.
 *
 * The lists do not intersect, and `count` carries the new value of the `Quar.count`
 * column for each agent that the plan disables. The value is in the plan, so both
 * sides write one number and neither one derives it two times.
 */
export function makeQuarantine(rand, ref, opts, tick) {
	if (opts === null) return null;
	if (opts.every > 1 && tick % opts.every !== 0) return null;
	const live = ref.liveAgents();
	if (live.length === 0) return null;
	const enable = [];
	for (const a of ref.disabled) if (rand() < 0.5) enable.push(a);
	const chosen = new Set(enable);
	const disable = [];
	const churn = [];
	const want = Math.min(live.length, Math.max(1, Math.round(live.length * opts.frac)));
	for (let i = 0; i < want; i++) {
		const a = live[(rand() * live.length) | 0];
		if (chosen.has(a) || ref.disabled.has(a)) continue;
		chosen.add(a);
		if (rand() < opts.churnFrac) churn.push(a);
		else disable.push(a);
	}
	const count = new Map();
	for (const a of disable) count.set(a, ((ref.quarOf(a) ?? 0) + 1) & 255);
	for (const a of churn) count.set(a, ((ref.quarOf(a) ?? 0) + 1) & 255);
	return { disable, enable, churn, count };
}

// ── set helpers ─────────────────────────────────────────────────────────────
/** Report a set as a short string, with a limit, so a failure message stays short. */
function brief(set, cap = 12) {
	const a = [...set].slice(0, cap);
	return `[${a}${set.size > cap ? `, +${set.size - cap} more` : ""}]`;
}

/** Fail unless the two sets hold the same members. */
function sameSet(where, fail, what, got, want) {
	if (got.size !== want.size) {
		fail(where, `${what}: the ECS has ${got.size} members, the model has ${want.size} ` +
			`(ecs ${brief(got)}, model ${brief(want)})`);
	}
	for (const v of want) {
		if (!got.has(v)) fail(where, `${what}: the model has ${v}, and the ECS does not`);
	}
	for (const v of got) {
		if (!want.has(v)) fail(where, `${what}: the ECS has ${v}, and the model does not`);
	}
}

/** Fail unless every member of `want` is in `got`. */
function coversSet(where, fail, what, got, want) {
	for (const v of want) {
		if (!got.has(v)) {
			fail(where, `${what}: the ECS did not report ${v}, and a write to it happened ` +
				`(reported ${brief(got)})`);
		}
	}
}

// ── the change-detection oracle ─────────────────────────────────────────────
/**
 * Change detection, against the model that `ref.mjs` keeps.
 *
 * The reference counts `Touch.seq` in its own `setLink`. Therefore the set of agents
 * that a tick wrote comes from the model. Five things get a check:
 *
 *  1. `onSet` WITH THE GRANULARITY OF AN ENTITY — exact, in both directions. The
 *     observer drains the dirty list of each row, and its dispatch drops a dead
 *     entity, an entity that lost the component, and a DISABLED entity. The model
 *     applies the same three rules, so equality is the assertion.
 *  2. `onSet` WITH THE GRANULARITY OF AN ARCHETYPE — each archetype that holds an
 *     agent that the tick wrote must be present. The set may hold more, because a
 *     row that MOVES INTO an archetype also makes its columns changed, and the
 *     documentation says that the detection is conservative on purpose. The idle
 *     tail is what bounds the report from above.
 *  3. `changed(Touch)` — the same completeness rule. The window is "at or after the
 *     last run of the system", so a write stays visible for two ticks.
 *  4. `changed(Touch).without(Fresh)` — a `ChangedQuery` composes, and the
 *     documentation says that the two orders of the verbs give one set. Both
 *     spellings must agree, and no signature in the result may hold `Fresh`.
 *  5. `changed(Age)` and the `onSet` observer on `Age` — exact, in both directions.
 *     `ageTick` asks for the mutable accessor of each archetype that its query gives,
 *     and that call sets the tick even when no write follows. `changeRead` lists the
 *     same archetypes through `forEach`. Therefore this one has an exact expected
 *     value, and it is the sharp check on the path with the granularity of an
 *     archetype.
 *
 * `opts.quiesce` turns the idle-tail assertions on: no write happened, so items 1, 2
 * and 3 must all be EMPTY, and item 5 must not be. Without that, a layer that
 * reported everything at every tick would pass items 1 to 4.
 */
/**
 * Pick the agents that this tick gives to `ctx.markChanged`.
 *
 * The driver picks them, so the model holds them, and no derivation of the ECS gives
 * the expected value.
 *
 * The generator is separate, for the reason that `makeQuarantine` gives. `rand`
 * selects the reduction order, and `runCase` compares a run against a run of the
 * reference alone at the same seed. A shared stream would give the two runs different
 * orders.
 *
 * The pick reads the live set AFTER the reference applied this tick's rewrites.
 * Therefore each agent in the result is alive at the end of the tick, as it is in the
 * ECS. A pick from before the rewrites could name an agent that a rewrite destroyed,
 * and the dispatch drops a dead row.
 */
export function makeMarks(rand, ref, cap = 8) {
	const live = ref.liveAgents();
	if (live.length === 0) return [];
	const out = new Set();
	const n = Math.min(cap, live.length);
	for (let i = 0; i < n; i++) out.add(live[Math.floor(rand() * live.length)]);
	return [...out];
}

/**
 * Pick the one `Produced` pair that this tick removes with `ctx.removeRelation`.
 *
 * The pick reads the model, so the model holds the answer before and after the call.
 * The record must be live, and its set of targets must hold something.
 *
 * The roll and the prune of the epochs happen before the rewrites of the tick.
 * Therefore a record that is live here stays live to the end of the tick.
 *
 * The generator is the same one that the marks use. Both are outside the stream that
 * selects the reduction order, which is the requirement.
 */
export function makeUnlink(rand, provRef) {
	if (provRef === null) return null;
	const serials = [];
	for (const [serial, rec] of provRef.records) {
		if (rec.produced.size > 0) serials.push(serial);
	}
	if (serials.length === 0) return null;
	const serial = serials[Math.floor(rand() * serials.length)];
	const targets = [...provRef.records.get(serial).produced];
	const targetRef = targets[Math.floor(rand() * targets.length)];
	return { serial, targetRef, remaining: targets.length - 1 };
}

export function changeCheck(where, ref, world, fail, touched, { deep, quiesce, marked = [] }) {
	// ── the expected value, from the model ──────────────────────────────────
	const wantEnts = new Set();
	// Every archetype that holds an agent that the tick wrote.
	const wantSigs = new Set();
	// The part of that set which holds at least one ENABLED agent. A DEFAULT query
	// gives the non-empty archetypes, and an archetype whose rows are all disabled is
	// empty for it. Therefore a default `changed()` query cannot report such an
	// archetype, and this smaller set is the correct expected value for it.
	const wantSigsEnabled = new Set();
	for (const a of touched) {
		const e = world.byRef.get(a);
		if (e === undefined) {
			fail(where, `the model wrote ref agent ${a}, which has no ECS entity`);
		}
		const sig = ref.refSignature(a);
		wantSigs.add(sig);
		// The dispatch of the per-entity `onSet` skips a disabled entity, and it drains
		// the entry, so the entry does not come back at a later tick.
		if (!ref.isDisabled(a)) {
			wantEnts.add(e);
			wantSigsEnabled.add(sig);
		}
	}

	// `ctx.markChanged` records a row for the per-entity observer, and it makes NO
	// change to the tick for the change on the archetype. Therefore a marked agent
	// joins the set with the granularity of an entity, and it does NOT join `wantSigs`.
	// Each archetype layer below reads `wantSigs`, so a mark cannot make one larger.
	// The dispatch drops a disabled row, and the model applies the same rule here.
	for (const a of marked) {
		if (ref.isDisabled(a)) continue;
		const e = world.byRef.get(a);
		if (e === undefined) fail(where, `the model marked ref agent ${a}, which has no ECS entity`);
		wantEnts.add(e);
	}

	// ── 1. the granularity of an entity: exact ──────────────────────────────
	sameSet(where, fail, "onSet(Touch) with the granularity of an entity", world.setEntities, wantEnts);

	// ── 2 and 3. the granularity of an archetype: complete ──────────────────
	// The observer reads the tick for the change on the archetype, and not a query.
	// Therefore it reaches an archetype whose rows are all disabled, and the strong
	// expected value applies to it.
	coversSet(where, fail, "onSet(Touch) with the granularity of an archetype", world.setArchSigs, wantSigs);
	coversSet(where, fail, "changed(Touch)", world.changedTouchSigs, wantSigsEnabled);
	// The arm with `includeDisabled()` must reach the all-disabled archetypes too.
	coversSet(where, fail, "includeDisabled().changed(Touch)", world.changedTouchAllSigs, wantSigs);
	for (const sig of world.changedTouchSigs) {
		if (!world.changedTouchAllSigs.has(sig)) {
			fail(where, `changed(Touch) reported ${sig}, and includeDisabled().changed(Touch) did not`);
		}
	}

	// ── 4. the composition of a ChangedQuery ────────────────────────────────
	sameSet(
		where,
		fail,
		"changed(Touch).without(Fresh) against without(Fresh).changed(Touch)",
		world.changedTouchNoFreshSigs,
		world.changedTouchNoFreshAltSigs
	);
	for (const sig of world.changedTouchNoFreshSigs) {
		if (sig.includes("F")) {
			fail(where, `changed(Touch).without(Fresh) reported ${sig}, which holds Fresh`);
		}
		if (!world.changedTouchSigs.has(sig)) {
			fail(where, `changed(Touch).without(Fresh) reported ${sig}, which changed(Touch) did not`);
		}
	}

	// ── 5. changed(Age): exact, in both directions ──────────────────────────
	// `ageTick` asks for the mutable accessor of each archetype that its DEFAULT query
	// gives, and that call sets the tick even when no write follows. `changeRead` lists
	// the same archetypes through `forEach` on the same query. Therefore this is an
	// exact expected value, and it is the sharp check on the path with the granularity
	// of an archetype.
	sameSet(where, fail, "changed(Age) against the archetypes that ageTick visited",
		world.changedAgeArchIds, world.ageArchIdsNow);
	// The observer takes a different path. It does not read a query; it visits each
	// archetype that has one or more ROWS and a tick at or after its own baseline.
	// Therefore it also reaches an archetype whose rows are all disabled, and an
	// archetype that a row MOVED INTO, which `ageTick` may not have visited. So it is
	// bounded on both sides and not pinned to one value: it must hold every archetype
	// that `ageTick` visited, and it must hold nothing outside the archetypes that
	// carry `Age` and have a row now.
	coversSet(where, fail, "onSet(Age) with the granularity of an archetype",
		world.setAgeArchIds, world.ageArchIdsNow);
	for (const id of world.setAgeArchIds) {
		if (!world.ageArchIdsAll.has(id)) {
			fail(
				where,
				`onSet(Age) reported archetype ${id}, which does not carry Age or holds no row ` +
					`(the archetypes with a row are ${brief(world.ageArchIdsAll)})`
			);
		}
	}

	if (deep) {
		// The rows behind item 5, against the model. `ageTick` uses a DEFAULT query, so
		// the rows are the agents that carry `Age` and that are not disabled.
		const wantAged = new Set();
		for (const a of ref.liveAgents()) {
			if (ref.isDisabled(a)) continue;
			if (ref.ageOf(a) !== null) wantAged.add(world.byRef.get(a));
		}
		sameSet(where, fail, "the rows of changed(Age)", world.changedAgeEnts, wantAged);
		sameSet(where, fail, "the rows that ageTick visited", world.ageEntsNow, wantAged);
	}

	if (quiesce) {
		// This tick wrote no column, so the marks are the ONLY reason for a report. Item
		// 1 above pins the per-entity set to exactly those agents. The three checks
		// below then require each archetype layer to stay quiet. Together they are the
		// assertion about `ctx.markChanged`: it records a row for the per-entity
		// observer, and it makes no archetype changed.
		//
		// The floor keeps that pair possible to break. With no mark, the per-entity
		// layer must report nothing, and the difference between the two paths has no
		// test.
		if (marked.length === 0) {
			fail(where, `an idle tick marked no agent — the checks below would then pass ` +
				`against a world that reports nothing at all`);
		}
		if (world.setArchSigs.size !== 0) {
			fail(where, `onSet with the granularity of an archetype reported ` +
				`${brief(world.setArchSigs)} on a tick that wrote no column`);
		}
		if (world.changedTouchSigs.size !== 0) {
			fail(where, `changed(Touch) reported ${brief(world.changedTouchSigs)} on a tick that ` +
				`wrote no column — the layer over-reports, and every other check would pass`);
		}
		if (world.changedTouchAllSigs.size !== 0) {
			fail(where, `includeDisabled().changed(Touch) reported ` +
				`${brief(world.changedTouchAllSigs)} on a tick that wrote no column`);
		}
		// The layer must be BUSY while the checks above require it to be quiet. Without
		// this, a `changed()` implementation that always reported nothing would pass
		// every assertion in this function. The condition reads the model: if no enabled
		// agent carries `Age`, then an empty report is the correct one.
		let wantBusy = false;
		for (const a of ref.liveAgents()) {
			if (!ref.isDisabled(a) && ref.ageOf(a) !== null) {
				wantBusy = true;
				break;
			}
		}
		if (wantBusy && world.changedAgeArchIds.size === 0) {
			fail(where, `changed(Age) reported nothing, and ageTick still visits rows — the quiet ` +
				`result above would then prove nothing`);
		}
	}
}

// ── the quarantine oracle ───────────────────────────────────────────────────
/**
 * The partition of the enabled and the disabled rows, against the model.
 *
 * The harness toggles the rows through the HOST WRITE SEAM, because an immediate
 * `ecs.disable()` fires no observer. Five things get a check:
 *
 *  1. `isDisabled` for each live agent.
 *  2. A DEFAULT query gives exactly the enabled agents. This is the primary
 *     assertion about the partition, and `compare()` adds the strongest one: it
 *     compares `Age.ticks` exactly, and a disabled row that `eachChunk` still visits
 *     therefore gives a divergence at the next tick.
 *  3. `includeDisabled()` gives every agent.
 *  4. The set that `onDisable` and `onEnable` maintain alone.
 *  5. The `Tainted` tag, which the HOST adds and removes with the same command that
 *     toggles the row. It is present if and only if the agent is disabled.
 */
export function quarantineCheck(where, ref, world, fail) {
	const wantDisabled = new Set();
	for (const a of ref.disabled) {
		const e = world.byRef.get(a);
		if (e === undefined) {
			fail(where, `the model has ref agent ${a} disabled, and it has no ECS entity`);
		}
		wantDisabled.add(e);
	}

	// 1. the direct probe
	for (const e of world.liveAgents()) {
		const want = wantDisabled.has(e);
		if (world.ecs.isDisabled(e) !== want) {
			fail(where, `isDisabled(${e}) = ${!want}, the model says ${want}`);
		}
	}

	// 2 and 3. the two queries
	const gotEnabled = new Set(world.enabledAgents());
	const wantEnabled = new Set();
	for (const a of ref.enabledAgents()) wantEnabled.add(world.byRef.get(a));
	sameSet(where, fail, "a default query over the agents", gotEnabled, wantEnabled);
	const gotAll = new Set(world.liveAgents());
	const wantAll = new Set();
	for (const a of ref.liveAgents()) wantAll.add(world.byRef.get(a));
	sameSet(where, fail, "includeDisabled() over the agents", gotAll, wantAll);

	// 4. the observer-maintained set
	sameSet(where, fail, "the set that onDisable and onEnable maintain",
		world.observedDisabled, wantDisabled);

	// 5. the tag that the host adds
	sameSet(where, fail, "the Tainted tag that the host write seam adds",
		world.taintedEntities(), wantDisabled);
}

// ── the sparse-component oracle ─────────────────────────────────────────────
/**
 * The `Watch` sparse component, against the model.
 *
 * `redexMaintain` adds and removes `Watch` by the same rule that it uses for the
 * `Redex` tag: present if and only if the agent is in an active pair. A sparse add is
 * IMMEDIATE and a dense add is deferred, so one system covers two paths and the
 * reference gives one expected set for both.
 *
 * `withSparse` on a default query does not show a disabled row, and on
 * `includeDisabled()` it does. Therefore this is also a second reading of the
 * quarantine, through a term that is not a dense component.
 */
export function sparseCheck(where, ref, world, fail) {
	const wantAll = new Set();
	for (const [a, b] of ref.redexes()) {
		wantAll.add(world.byRef.get(a));
		wantAll.add(world.byRef.get(b));
	}
	const wantEnabled = new Set();
	const wantNone = new Set();
	for (const a of ref.liveAgents()) {
		const e = world.byRef.get(a);
		const inPair = wantAll.has(e);
		if (ref.isDisabled(a)) continue;
		if (inPair) wantEnabled.add(e);
		else wantNone.add(e);
	}
	const got = world.watchSets();
	sameSet(where, fail, "includeDisabled().withSparse(Watch)", got.all, wantAll);
	sameSet(where, fail, "withSparse(Watch)", got.enabled, wantEnabled);
	sameSet(where, fail, "withoutSparse(Watch)", got.none, wantNone);
	// The direct probe, for each agent of an active pair.
	for (const e of wantAll) {
		if (!world.ecs.hasSparse(e, world.Watch)) {
			fail(where, `hasSparse(${e}, Watch) is false, and the agent is in an active pair`);
		}
	}
}

// ── the oracle for the query verbs ──────────────────────────────────────────
/**
 * The verbs of a query that the net gives an exact model for.
 *
 * Each item below reads a fact that the reference already holds. Therefore this
 * layer adds no model, and it cannot go out of step with the rest of the harness.
 *
 *  1. `withRelation` and `withoutRelation` — `PORTS` is [3, 3, 1, 1], so a CON and a
 *     DUP hold port 1 and an ERA and the ROOT do not. The relation of port 1
 *     therefore partitions the agents BY TYPE, and the reference holds the type of
 *     each agent. The enabled arm is the same set without the disabled agents, so
 *     the pair also reads the row partition through a relation term.
 *  2. `optional(Age)` — the query spans the archetypes that hold `Age` and the
 *     archetypes that do not. The absent span must be exactly the `Fresh` agents.
 *     The present span must carry the numbers that the reference holds, which
 *     `compare` reads by a different route. Both spans must occur, or the check is
 *     half a check, and the floors count them.
 *  3. `singleEntity` — exactly one ROOT exists for the whole run. A production build
 *     skips the count and gives the first match, so the identity of the agent is the
 *     assertion in both builds.
 *  4. `firstEntity` — a member of an active pair while the net reduces, and
 *     `undefined` in the idle tail. The idle tail is what makes the second half
 *     reachable: a query that always gave its first row would pass the first half.
 *  5. `forEachUntil` — it must stop at the archetype that the predicate accepts, and
 *     it must report that it stopped. `forEach` over the same query gives the count
 *     of the archetypes, so this needs no model of the archetype graph.
 *  6. `ctx.getResource` and `ctx.hasResource` — the driver picks the phase number,
 *     so the driver knows the value. `surface.mjs` reads the host facade instead.
 */
export function queryVerbCheck(where, ref, world, fail, { deep, phase, rootRef }) {
	// ── the resource, from inside a system ──────────────────────────────────
	if (!world.resourceHas) fail(where, `ctx.hasResource(PhaseRes) is false, and the world registered it`);
	if (world.resourcePhase !== phase) {
		fail(where, `ctx.getResource(PhaseRes) is ${world.resourcePhase}, the driver set ${phase}`);
	}

	// ── singleEntity over the one ROOT ──────────────────────────────────────
	const wantRoot = world.byRef.get(rootRef);
	if (world.rootSingle !== wantRoot) {
		fail(where, `singleEntity() over the ROOT tag gave ${world.rootSingle}, want ${wantRoot}`);
	}

	// ── firstEntity over the active pairs ───────────────────────────────────
	const anyRedex = ref.redexCount > 0;
	if (anyRedex && world.redexFirst === undefined) {
		fail(where, `firstEntity() over Redex is undefined, and the reference holds ${ref.redexCount} active pairs`);
	}
	if (!anyRedex && world.redexFirst !== undefined) {
		fail(where, `firstEntity() over Redex gave ${world.redexFirst}, and the reference holds no active pair`);
	}

	// ── forEachUntil ────────────────────────────────────────────────────────
	// The predicate accepts the second archetype. Therefore the walk stops there when
	// the query gives two or more, and it runs to the end when it gives fewer.
	const wantVisited = Math.min(2, world.untilArchTotal);
	if (world.untilVisited !== wantVisited) {
		fail(where, `forEachUntil visited ${world.untilVisited} archetypes, want ${wantVisited} ` +
			`(forEach gives ${world.untilArchTotal})`);
	}
	const wantStopped = world.untilArchTotal >= 2;
	if (world.untilStopped !== wantStopped) {
		fail(where, `forEachUntil reported ${world.untilStopped}, want ${wantStopped} ` +
			`(forEach gives ${world.untilArchTotal} archetypes)`);
	}

	if (!deep) return;

	// ── the partition by port arity, through a relation term ────────────────
	const wantWith = new Set();
	const wantWithout = new Set();
	const wantWithEnabled = new Set();
	const wantAge = new Map();
	const wantNoAge = new Set();
	for (const a of ref.liveAgents()) {
		const e = world.byRef.get(a);
		// `PORTS[type] > 1` is "this agent has a port 1", which is a CON or a DUP.
		if (PORTS[ref.typeOf(a)] > 1) {
			wantWith.add(e);
			if (!ref.isDisabled(a)) wantWithEnabled.add(e);
		} else {
			wantWithout.add(e);
		}
		const age = ref.ageOf(a);
		if (age === null) wantNoAge.add(e);
		else wantAge.set(e, age);
	}
	sameSet(where, fail, "includeDisabled().withRelation(P1)", world.withP1, wantWith);
	sameSet(where, fail, "includeDisabled().withoutRelation(P1)", world.withoutP1, wantWithout);
	sameSet(where, fail, "withRelation(P1)", world.withP1Enabled, wantWithEnabled);

	// ── the optional column ─────────────────────────────────────────────────
	sameSet(where, fail, "optional(Age): the span with no Age", world.optionalAgeAbsent, wantNoAge);
	const gotAgeKeys = new Set(world.optionalAgeSeen.keys());
	sameSet(where, fail, "optional(Age): the span that holds Age", gotAgeKeys, new Set(wantAge.keys()));
	for (const [e, age] of wantAge) {
		const got = world.optionalAgeSeen.get(e);
		if (got !== age) {
			fail(where, `optional(Age): getOptionalColumnRead gave ${got} for ${e}, the model holds ${age}`);
		}
	}
}

// ── the event oracle ────────────────────────────────────────────────────────
/**
 * The channel of the events, against the plan of the tick.
 *
 * The rewrite system emits one event for each rewrite, in the order of the plan. A
 * reader in POST_UPDATE drains the channel. Therefore:
 *
 *   - the count of the rows must be the count of the rewrites of THIS tick. A
 *     channel that keeps its rows for a second tick gives a larger count, so this is
 *     the check on the automatic clear;
 *   - the rule of each row must be the rule that the plan names, in order;
 *   - both entity ids of a row must be DEAD, because each rule destroys both members
 *     of the active pair. A recycled id carries a new generation, so an id that comes
 *     back is still not alive under the old handle;
 *   - the count of the signals must be 1 on a tick that rolled an epoch, and 0 on
 *     every other tick. A signal is an event with no field, and it has its own count.
 */
export function eventCheck(where, world, plan, roll, fail) {
	const got = world.drainedEvents;
	if (got.length !== plan.length) {
		fail(
			where,
			`the event channel gave ${got.length} rows, the tick applied ${plan.length} rewrites ` +
				`— a channel must clear itself at the end of each update`
		);
	}
	for (let i = 0; i < plan.length && i < got.length; i++) {
		if (got[i][0] !== plan[i].rule) {
			fail(where, `event ${i} carries rule ${got[i][0]}, the plan says ${plan[i].rule}`);
		}
		if (world.ecs.isAlive(got[i][1]) || world.ecs.isAlive(got[i][2])) {
			fail(
				where,
				`event ${i} names ${got[i][1]} and ${got[i][2]}, and one of them is still alive ` +
					`— every rule destroys both members of the pair`
			);
		}
	}
	const wantSignals = roll === null ? 0 : 1;
	if (world.drainedSignals !== wantSignals) {
		fail(where, `the signal gave a count of ${world.drainedSignals}, want ${wantSignals}`);
	}
}

// ── the command-log oracle ──────────────────────────────────────────────────
/**
 * The log of the host commands, and its round trip through JSON.
 *
 * The recorder taps each command that the apply system drains. The harness knows how
 * many commands it put into the queue, so the count is a model. `serializeCommandLog`
 * and `deserializeCommandLog` must then give a log with the same shape: a
 * `ComponentDef` is a callable, so the serializer writes its id and the reader makes
 * a new def, and only the id survives. Therefore the comparison reads the ids.
 */
export function commandLogCheck(where, world, fail) {
	const { serializeCommandLog, deserializeCommandLog } = world._lib;
	const log = world.recorder.snapshotLog();
	let commands = 0;
	for (const t of log.ticks) commands += t.commands.length;
	if (commands !== world.enqueuedCommands) {
		fail(
			where,
			`the recorder logged ${commands} host commands, the harness enqueued ` +
				`${world.enqueuedCommands}`
		);
	}
	const back = deserializeCommandLog(serializeCommandLog(log));
	if (back.ticks.length !== log.ticks.length) {
		fail(where, `the log has ${log.ticks.length} ticks, and it came back with ${back.ticks.length}`);
	}
	for (let i = 0; i < log.ticks.length; i++) {
		const a = log.ticks[i];
		const b = back.ticks[i];
		if (a.tick !== b.tick || a.dt !== b.dt || a.commands.length !== b.commands.length) {
			fail(where, `tick ${i} of the log did not survive the round trip through JSON`);
		}
		for (let k = 0; k < a.commands.length; k++) {
			const x = a.commands[k];
			const y = b.commands[k];
			if (x.kind !== y.kind || x.eid !== y.eid) {
				fail(where, `command ${k} of tick ${i} came back as ${y.kind} on ${y.eid}, want ${x.kind} on ${x.eid}`);
			}
			// A def is a callable, so the round trip keeps its id alone.
			if (x.def !== undefined && x.def.id !== y.def.id) {
				fail(where, `command ${k} of tick ${i} came back naming component ${y.def.id}, want ${x.def.id}`);
			}
			if (x.field !== undefined && (x.field !== y.field || x.value !== y.value)) {
				fail(where, `the set_field command ${k} of tick ${i} did not survive the round trip`);
			}
		}
	}
}

/**
 * Reduce with the reference alone, no ECS. Two jobs:
 *
 *   1. It sizes the batch. A batch that swallows the entire reduction produces a
 *      one-tick run, and a one-tick run is nearly vacuous — the `Redex` tag never
 *      gets a chance to exist, so no observer ever fires, and the tick-boundary
 *      comparison happens exactly once. Knowing the rewrite count up front lets
 *      the driver pick a batch that guarantees a useful number of ticks.
 *   2. It is a free extra oracle. Same seed means the same reduction order, so the
 *      count must match the lockstep run's exactly — which catches any way the
 *      tick structure could perturb the reference itself.
 *
 * Cheap: no relations, no archetypes, no verification. Millions of rewrites/sec.
 */
export function refOnly(spec, seed, cap) {
	const rand = rng(seed);
	const ref = RefNet.load(spec);
	let rewrites = 0;
	let peak = ref.live;
	let normalised = false;
	while (rewrites < cap) {
		ref.settleRedex();
		if (ref.redexCount === 0) {
			normalised = true;
			break;
		}
		const [a, b] = ref.pickRedex(rand);
		applyRewrite(ref, a, b);
		rewrites++;
		if (ref.live > peak) peak = ref.live;
	}
	return { rewrites, peak, normalised, loops: ref.loops, canonical: ref.canonical() };
}

// ── the lockstep comparison ─────────────────────────────────────────────────
export function compare(where, ref, world) {
	const refLive = ref.liveAgents();
	const ecsLive = world.liveAgents();
	if (refLive.length !== ecsLive.length) {
		fail(where, `live agents: ecs ${ecsLive.length}, ref ${refLive.length}`);
	}

	// The bijection must be total and injective over the live set — checked, since
	// everything below reads through it.
	const seen = new Set();
	for (const r of refLive) {
		const e = world.byRef.get(r);
		if (e === undefined) fail(where, `ref agent ${r} has no ECS entity`);
		if (seen.has(e)) fail(where, `ECS entity ${e} is bound to two reference agents`);
		seen.add(e);
		if (!world.ecs.isAlive(e)) fail(where, `ref agent ${r} -> ECS entity ${e}, which is dead`);
	}
	for (const e of ecsLive) {
		if (!seen.has(e)) fail(where, `ECS entity ${e} is not bound to any reference agent`);
	}

	// Per-agent: type, every port, and the churn components.
	for (const r of refLive) {
		const e = world.byRef.get(r);
		const rt = ref.typeOf(r);
		const et = world._typeOf(e);
		if (rt !== et) {
			fail(where, `agent ref ${r}/ecs ${e}: type ecs ${TYPE_NAME[et]}, ref ${TYPE_NAME[rt]}`);
		}
		for (let p = 0; p < PORTS[rt]; p++) {
			const [rf, rq] = ref.getLink(r, p);
			const [ef, eq] = world.linkOf(e, p);
			const wantE = world.byRef.get(rf);
			if (ef !== wantE || eq !== rq) {
				fail(
					where,
					`agent ref ${r}/ecs ${e} port ${p}: ecs -> ${ef}:${eq}, ` +
						`ref -> ${rf}:${rq} (expected ecs entity ${wantE})`
				);
			}
		}
		// Fresh / Age — the pure archetype-churn components, mirrored exactly.
		const refFresh = ref.isFresh(r);
		const ecsFresh = world.ecs.hasComponent(e, world.Fresh);
		if (refFresh !== ecsFresh) {
			fail(where, `agent ref ${r}/ecs ${e}: Fresh ecs ${ecsFresh}, ref ${refFresh}`);
		}
		const refAge = ref.ageOf(r);
		const hasAge = world.ecs.hasComponent(e, world.Age);
		if ((refAge !== null) !== hasAge) {
			fail(where, `agent ref ${r}/ecs ${e}: Age presence ecs ${hasAge}, ref ${refAge !== null}`);
		}
		if (hasAge) {
			const ecsAge = world.ecs.getField(e, world.Age, "ticks");
			if (ecsAge !== refAge) {
				fail(where, `agent ref ${r}/ecs ${e}: Age.ticks ecs ${ecsAge}, ref ${refAge}`);
			}
			// The float arm keeps the same integer in an `f64` column. An integer below
			// 2^53 is exact in `f64`, so this comparison is exact and the run stays
			// reproducible from its seed. A deterministic world rejects a float column,
			// so this is the only place where one gets cover.
			if (world.float) {
				const ecsF = world.ecs.getField(e, world.Age, "fticks");
				if (ecsF !== refAge) {
					fail(where, `agent ref ${r}/ecs ${e}: Age.fticks ecs ${ecsF}, ref ${refAge}`);
				}
			}
		}
		// `Touch.seq` — the counter that the reference keeps in its own `setLink`, and
		// that the ECS keeps through `ctx.updateField`. It is the read-modify-write path
		// on a hot `i32` column, and the model of the change detection reads the same
		// counter.
		const ecsTouch = world.ecs.getField(e, world.Touch, "seq");
		const refTouch = ref.touchOf(r);
		if (ecsTouch !== refTouch) {
			fail(where, `agent ref ${r}/ecs ${e}: Touch.seq ecs ${ecsTouch}, ref ${refTouch}`);
		}
		// `Quar.count` — a column that the HOST writes, through `queue.setField` on the
		// write seam. Therefore this comparison is the check on the `set_field` command.
		const ecsQuar = world.ecs.getField(e, world.Quar, "count");
		const refQuar = ref.quarOf(r);
		if (ecsQuar !== refQuar) {
			fail(where, `agent ref ${r}/ecs ${e}: Quar.count ecs ${ecsQuar}, ref ${refQuar}`);
		}
		// `Tainted` — a tag that the HOST adds and removes, with the same command that
		// toggles the row. Therefore it is present if and only if the agent is disabled.
		const ecsTaint = world.ecs.hasComponent(e, world.Tainted);
		const refTaint = ref.isDisabled(r);
		if (ecsTaint !== refTaint) {
			fail(where, `agent ref ${r}/ecs ${e}: Tainted ecs ${ecsTaint}, ref ${refTaint}`);
		}
	}

	// Census.
	const rc = ref.census();
	const ec = world.census();
	for (let t = 0; t < 4; t++) {
		if (rc[t] !== ec[t]) {
			fail(where, `${TYPE_NAME[t]} count: ecs ${ec[t]}, ref ${rc[t]}`);
		}
	}

	// ── the observer oracle ─────────────────────────────────────────────────
	// Three independent derivations of one set: the observer callbacks, an ECS
	// rescan, and the reference. All three must agree.
	const observed = world.observedRedex;
	const rescan = world.rescanRedex();
	if (observed.size !== rescan.size) {
		fail(
			where,
			`observer redex queue has ${observed.size} entries, ECS rescan finds ${rescan.size}`
		);
	}
	for (const e of rescan) {
		if (!observed.has(e)) fail(where, `entity ${e} is an active pair member but not observer-queued`);
	}
	const refRedex = new Set();
	for (const [a, b] of ref.redexes()) {
		refRedex.add(world.byRef.get(a));
		refRedex.add(world.byRef.get(b));
	}
	if (refRedex.size !== observed.size) {
		fail(where, `observer queue ${observed.size} entries, reference says ${refRedex.size}`);
	}
	for (const e of refRedex) {
		if (!observed.has(e)) fail(where, `reference says ${e} is in an active pair; observer disagrees`);
	}

	// ── bijection-free structural check ─────────────────────────────────────
	const rcan = ref.canonical();
	const ecan = world.canonical();
	if (rcan.form !== ecan.form) {
		// Report the first differing character with a window, since these get long.
		let i = 0;
		while (i < rcan.form.length && rcan.form[i] === ecan.form[i]) i++;
		fail(
			where,
			`canonical forms differ at char ${i}\n    ecs: …${ecan.form.slice(Math.max(0, i - 40), i + 40)}…\n` +
				`    ref: …${rcan.form.slice(Math.max(0, i - 40), i + 40)}…`
		);
	}
	if (rcan.unreachable !== ecan.unreachable) {
		fail(where, `ROOT-unreachable agents: ecs ${ecan.unreachable}, ref ${rcan.unreachable}`);
	}
}

// ── orphan reclaim ──────────────────────────────────────────────────────────
/**
 * `relations.compact()` against an exactly-predicted reclaim count.
 *
 * The prediction is possible because only the `EpochAncestors` relation can leak:
 * it is the only `"orphan"` one. Under `"clear"` a dying target unlinks every
 * source, which empties and deletes its reverse key; under `"delete"` the sources
 * die with it; and a dying *source* is purged from every reverse set. So the
 * expected count is exactly "dead epochs that a live epoch still lists as an
 * ancestor, not already reclaimed" — which `RefProv` tracks by monotonic epoch
 * index, the one id space that never recycles.
 *
 * Three things are asserted, and the second and third are the documented promises
 * that a naive implementation would break:
 *   - the count matches;
 *   - compaction is **idempotent** — an immediate second call reclaims nothing;
 *   - compaction changes **nothing observable**: same `stateHash`, and the whole
 *     provenance layer (including the dangling forward links it just orphaned the
 *     reverse entries of) still verifies.
 */
export function compactCheck(where, world, provRef, stats) {
	const pending = provRef.pendingOrphanKeys();
	// `stateHash` needs a deterministic world. The float arm has none, so it keeps the
	// count and the idempotence, and it gives up the "nothing else changed" assertion.
	const before = world.hashable ? world.ecs.snapshots.stateHash() : 0;
	const got = world.ecs.relations.compact();
	if (got !== pending.size) {
		fail(
			where,
			`compact() reclaimed ${got} dead-target keys, model predicted ${pending.size} ` +
				`(dead epochs still referenced by a live one: [${[...pending]}])`
		);
	}
	provRef.noteCompacted(pending);
	const again = world.ecs.relations.compact();
	if (again !== 0) fail(where, `compact() is not idempotent — a second call reclaimed ${again}`);
	if (world.hashable) {
		const after = world.ecs.snapshots.stateHash();
		if (before !== after) {
			fail(where, `compact() moved stateHash ${before} -> ${after}; it must change nothing observable`);
		}
	}
	world.assertProvenance(`${where} [prov post-compact]`, provRef, fail);
	stats.compactions++;
	stats.compactReclaimed += got;
}

// ── snapshot metamorphism ───────────────────────────────────────────────────
/**
 * `stateHash` -> `capture` -> scribble -> `restore` -> same `stateHash`, same data.
 *
 * The scribble is what keeps this from being vacuous: if `restore` silently
 * no-opped, or if `stateHash` were blind to the columns the net lives in, the
 * round-trip would "pass" without having tested anything.
 *
 * The scribble is ONE DETERMINISTIC BYTE into one slot of one agent, and it is not
 * random data. That is enough, and the check between the write and the restore says
 * why: `stateHash` must MOVE for that one byte. A hash that does not move makes the
 * run fail immediately, and thus the check cannot become vacuous without a report.
 * A deterministic scribble also keeps the harness reproducible from its seed alone.
 * Do not describe this layer as a write of random bytes.
 */
export function snapshotRoundTrip(where, world) {
	const ecs = world.ecs;
	const h0 = ecs.snapshots.stateHash();
	const bytes = ecs.snapshots.capture();
	// The sparse store has its own pair of calls, and this pair is the NARROW path.
	// `capture` holds three sections: the dense columns, the sparse stores with the
	// relations, and the host bookkeeping. Therefore `restore` alone also returns the
	// sparse half. `captureSparse` and `restoreSparse` are the second, smaller path
	// that a caller uses for that half alone, and this layer covers both.
	const sparseBytes = ecs.snapshots.captureSparse();

	const agents = world.liveAgents();
	if (agents.length > 0) {
		const victim = agents[0];
		const before = ecs.getField(victim, world.Slot, "s0");
		ecs.setField(victim, world.Slot, "s0", (before + 7) % 251);
		if (ecs.snapshots.stateHash() === h0) {
			fail(where, `stateHash is blind to a Slot write — the snapshot oracle would be vacuous`);
		}
	}
	// The same idea for the sparse half: write ONE deterministic byte into one entry,
	// and require the hash to MOVE for it. A restore that did nothing would otherwise
	// pass, and it would give no error.
	const watched = [...world.watchSets().all];
	let scribbledSparse = false;
	if (watched.length > 0) {
		scribbledSparse = true;
		const hDense = ecs.snapshots.stateHash();
		const victim = watched[0];
		const before = ecs.getSparseField(victim, world.Watch, "hits");
		ecs.setSparseField(victim, world.Watch, "hits", (before + 11) % 251);
		if (ecs.snapshots.stateHash() === hDense) {
			fail(where, `stateHash is blind to a sparse write — the sparse round trip would be vacuous`);
		}
	}
	ecs.snapshots.restore(bytes);
	ecs.snapshots.restoreSparse(sparseBytes);
	const h1 = ecs.snapshots.stateHash();
	if (h0 !== h1) fail(where, `stateHash ${h0} -> ${h1} across capture/restore`);
	world.assertSelfConsistent(`${where} [post-restore]`);
	// The caller counts this result. A run that never wrote the sparse half shows
	// nothing about `restoreSparse`. Refer to `stats.sparseScribbles`.
	return scribbledSparse;
}

// ── confluence: the same net under different reduction orders ───────────────
/**
 * Reduce one net to normal form under `orders` different reduction orders and
 * require identical rewrite counts and identical canonical normal forms.
 *
 * WHAT THIS LAYER ORACLES, EXACTLY. It needs no known answer: strong confluence
 * says the count and the form are the same for every reduction order. But it is a
 * SPEC-level oracle, and it is not an ECS-level one. `lockstep` ends each order
 * with an UNCONDITIONAL `compare(...)`, and that comparison is a complete
 * structural isomorphism: a total bijection over the live agents, then the type of
 * each agent, each port link, `Fresh`, `Age` and the census. Each tick also asserts
 * `world.rewritesApplied === stats.rewrites`. Therefore each order already pins its
 * ECS result to its own reference, in the same run. An ECS that loses a link,
 * mis-migrates a row or drops an entity fails `lockstep` FIRST, before this
 * function compares anything, and it fails there whether the fault depends on the
 * order or not.
 *
 * What remains is the comparison of the two REFERENCE results with each other,
 * through the isomorphism. That is a real oracle, and it is the only layer that can
 * see a fault that `spec.mjs` and `ref.mjs` share — the failure mode that a
 * comparison of two implementations cannot see, because both sides agree. Refer to
 * `README.md`. Do not bill this layer as the deepest check of the ECS: the closed
 * form is the layer that is external to both implementations.
 *
 * Only meaningful for nets that normalise inside the step cap; non-normalising
 * runs are reported and skipped rather than compared mid-flight (a bounded prefix
 * of two different orders is legitimately different).
 */
export function confluence(
	lib,
	spec,
	{ orders, batch, steps, verifyEvery, snapEvery, label, prov, compactEvery, quar, float, record, sab }
) {
	const results = [];
	for (let k = 0; k < orders; k++) {
		const s = lockstep(lib, spec, {
			seed: 1000 + k * 7919,
			batch,
			steps,
			verifyEvery,
			snapEvery,
			label: `${label} order#${k}`,
			prov,
			compactEvery,
			quar,
			float,
			record,
			sab,
		});
		results.push(s);
	}
	const normalised = results.filter((r) => r.normalised);
	if (normalised.length < 2) {
		return { checked: false, reason: `only ${normalised.length}/${orders} orders normalised` };
	}
	const base = normalised[0];
	for (const r of normalised.slice(1)) {
		if (r.rewrites !== base.rewrites) {
			fail(
				`${label} confluence`,
				`rewrite counts differ across reduction orders: ${base.rewrites} vs ${r.rewrites} ` +
					`— strong confluence says they cannot`
			);
		}
		if (r.canonical.form !== base.canonical.form) {
			fail(
				`${label} confluence`,
				`normal forms differ across reduction orders\n    a: ${base.canonical.form}\n    b: ${r.canonical.form}`
			);
		}
		if (r.loops !== base.loops) {
			fail(`${label} confluence`, `wire-loop counts differ: ${base.loops} vs ${r.loops}`);
		}
	}
	return { checked: true, orders: normalised.length, rewrites: base.rewrites };
}

// ── non-vacuity ─────────────────────────────────────────────────────────────
/**
 * Suite-wide pressure accumulator.
 *
 * Every oracle above answers "is the ECS wrong?". None of them answers "did we
 * actually push on it?" — a harness that silently degenerated to one tick of one
 * archetype with no observer traffic would pass all of them and prove nothing.
 *
 * The floors are asserted across the whole suite rather than per case on purpose.
 * Per-case floors have to be tuned to each case's size, which makes them either
 * toothless or self-fulfilling; a small case legitimately cannot exercise six
 * archetypes. What matters is that the suite *as a whole* fired every rule, moved
 * rows through a wide archetype set, drove real observer traffic, and grew a net.
 */
export class Pressure {
	constructor() {
		this.archetypes = new Set();
		this.rules = new Map();
		this.observerAdds = 0;
		this.observerRemoves = 0;
		this.rewrites = 0;
		this.ticks = 0;
		this.snapshots = 0;
		this.maxGrowth = 0;
		this.cases = 0;
		// provenance layer
		this.records = 0;
		this.cascaded = 0;
		this.epochsPruned = 0;
		this.recordRemoves = 0;
		this.compactReclaimed = 0;
		this.maxProducedSet = 0;
		this.maxChainDepth = 0;
		this.provCases = 0;
		// the layers that this pass added
		this.setEntityCalls = 0;
		this.setArchCalls = 0;
		this.disableCalls = 0;
		this.enableCalls = 0;
		this.peakDisabled = 0;
		this.gatedRuns = 0;
		this.events = 0;
		this.idleTicks = 0;
		this.floatCases = 0;
		this.sabCases = 0;
		this.freshDisabledTicks = 0;
		this.peakFreshDisabled = 0;
		this.sparseScribbles = 0;
		this.optionalSpansWithAge = 0;
		this.optionalSpansWithoutAge = 0;
		this.untilStops = 0;
		this.markCalls = 0;
		this.unlinkCalls = 0;
	}
	absorb(spec, stats) {
		for (const s of stats.archetypes) this.archetypes.add(s);
		for (const [n, c] of stats.ruleHits) this.rules.set(n, (this.rules.get(n) ?? 0) + c);
		this.observerAdds += stats.observerAdds;
		this.observerRemoves += stats.observerRemoves;
		this.rewrites += stats.rewrites;
		this.ticks += stats.ticks;
		this.snapshots += stats.snapshots;
		this.maxGrowth = Math.max(this.maxGrowth, stats.peakAgents / spec.types.length);
		this.cases++;
		this.setEntityCalls += stats.setEntityCalls;
		this.setArchCalls += stats.setArchCalls;
		this.disableCalls += stats.disableCalls;
		this.enableCalls += stats.enableCalls;
		this.peakDisabled = Math.max(this.peakDisabled, stats.peakDisabled);
		this.gatedRuns += stats.gatedRuns;
		this.events += stats.events;
		this.idleTicks += stats.idleTicks;
		this.freshDisabledTicks += stats.freshDisabledTicks;
		this.peakFreshDisabled = Math.max(this.peakFreshDisabled, stats.peakFreshDisabled);
		this.sparseScribbles += stats.sparseScribbles;
		this.optionalSpansWithAge += stats.optionalSpansWithAge;
		this.optionalSpansWithoutAge += stats.optionalSpansWithoutAge;
		this.untilStops += stats.untilStops;
		this.markCalls += stats.markCalls;
		if (stats.hashable === false) this.floatCases++;
		if (stats.sab === true) this.sabCases++;
		const p = stats.provStats;
		if (p !== null && p !== undefined) {
			this.records += p.recordsCreated;
			this.cascaded += p.recordsCascaded;
			this.epochsPruned += p.epochsPruned;
			this.recordRemoves += stats.recordRemoves;
			this.compactReclaimed += stats.compactReclaimed;
			this.maxProducedSet = Math.max(this.maxProducedSet, p.maxProducedSet);
			this.maxChainDepth = Math.max(this.maxChainDepth, p.maxChainDepth);
			this.unlinkCalls += stats.unlinkCalls;
			this.provCases++;
		}
	}
	/**
	 * Check every floor.
	 *
	 * `mode` selects the set. A floor comes in one of two kinds:
	 *
	 *   - a floor on the PRESSURE, such as the count of the rewrites or the calls of
	 *     the observers. Each run must meet these.
	 *   - a floor on the ARMS of the suite, such as "one case used an `f64` column".
	 *     The CURATED SUITE builds those arms; the SOAK builds none of them, because
	 *     its purpose is duration and not coverage. A soak must therefore not measure
	 *     them, and `mode = "soak"` leaves them out.
	 *
	 * A soak also holds no idle tail. Its cases stop at a step limit, so most of them
	 * never reach a normal form, and a tick with no rewrite would put the two sides
	 * out of step.
	 */
	assert(mode = "suite") {
		const suite = mode === "suite";
		const ALL_RULES = ["CON~CON", "CON~DUP", "CON~ERA", "DUP~DUP", "DUP~ERA", "ERA~ERA"];
		const bad = [];
		const floor = (what, got, want) => {
			if (got < want) bad.push(`${what}: ${got} (want >= ${want})`);
		};
		floor("total rewrites", this.rewrites, 50000);
		floor("total ticks", this.ticks, 2000);
		// The quarantine adds a `Tainted` tag, so the archetype graph is wider than it
		// was. A soak runs fewer, larger cases, so it reaches fewer combinations.
		floor("distinct archetypes", this.archetypes.size, suite ? 20 : 12);
		floor("observer onAdd calls", this.observerAdds, 5000);
		floor("observer onRemove calls", this.observerRemoves, 5000);
		floor("snapshot round-trips", this.snapshots, 10);
		// ── the layers that this pass added ─────────────────────────────────
		// Without these floors each of the new layers could be present and inert. A
		// layer that never fires passes every assertion about what it reports.
		floor("onSet calls with the granularity of an entity", this.setEntityCalls, 10000);
		floor("onSet calls with the granularity of an archetype", this.setArchCalls, 100);
		floor("onDisable calls", this.disableCalls, 2000);
		floor("onEnable calls", this.enableCalls, 1000);
		floor("peak disabled agents in one case", this.peakDisabled, 5);
		floor("runs of the system that a run condition gates", this.gatedRuns, 500);
		floor("events emitted and drained", this.events, 50000);
		// A row that is both `Fresh` and disabled. `promoteFresh` must keep `Fresh` on
		// that row, and `compare()` reads `Fresh` at each tick. The state occurs only
		// because the promotion is one phase after the flush where the toggle lands.
		// Therefore this floor keeps that assertion possible to break.
		floor("ticks with a row that is Fresh and disabled", this.freshDisabledTicks, 200);
		floor("peak rows that are Fresh and disabled", this.peakFreshDisabled, 3);
		// The two spans of the `optional(Age)` query. The layer compares both, so a run
		// that reached one span alone tested nothing about the verb: where each
		// archetype holds the column, `optional` and a required term agree.
		floor("optional(Age) spans that hold the column", this.optionalSpansWithAge, 100);
		floor("optional(Age) spans with no column", this.optionalSpansWithoutAge, 100);
		// The early-out of `forEachUntil`. A query that never gave two archetypes would
		// always walk to the end, and the early-out would have no cover.
		floor("ticks on which forEachUntil stopped early", this.untilStops, 500);
		// The calls of `ctx.markChanged`. A mark puts a row into the per-entity layer
		// and leaves each archetype layer quiet. With no mark, the two layers agree, and
		// the difference between them has no test.
		floor("calls of ctx.markChanged", this.markCalls, 2000);
		if (suite) {
			// The idle tail is what bounds the change detection from ABOVE. A suite with
			// none of it proves only that a change gets reported, and not that a
			// non-change does not.
			floor("idle ticks that must report no change", this.idleTicks, 20);
			// A float column exists in the arm with no determinism alone, so a suite that
			// never builds that arm leaves the `f64` path with no cover.
			floor("cases with an f64 column", this.floatCases, 1);
			// The default profile puts the column store on a plain `ArrayBuffer`. The
			// `SharedArrayBuffer` profile is what a worker or a WASM backend needs, and a
			// suite that never builds it leaves that backing with no cover from this tool.
			floor("cases on the SharedArrayBuffer profile", this.sabCases, 1);
			// A snapshot round trip that wrote into the sparse store. Without that write,
			// a `restoreSparse` that makes no change passes the round trip.
			floor("snapshot round trips that wrote a sparse byte", this.sparseScribbles, 5);
		}
		const missing = ALL_RULES.filter((r) => !this.rules.has(r));
		if (missing.length > 0) bad.push(`rules never fired: ${missing.join(", ")}`);
		if (this.maxGrowth < 2) {
			bad.push(`no case grew past ${this.maxGrowth.toFixed(2)}x its initial size (want >= 2x)`);
		}
		// Provenance floors. Without these the layer could be present but inert —
		// records created and never cascaded, or multi sets never wider than one.
		if (this.provCases > 0) {
			floor("records logged", this.records, 20000);
			floor("records destroyed BY CASCADE", this.cascaded, 10000);
			floor("epochs pruned", this.epochsPruned, 100);
			floor("record onRemove calls (all cascade victims)", this.recordRemoves, 10000);
			floor("orphan keys reclaimed by compact()", this.compactReclaimed, 50);
			// The commutation rule makes four agents. Therefore a set of targets with
			// more than one value must occur. A set with one value shows nothing that an
			// exclusive relation cannot show. A soak uses `erase` cases as well, whose
			// rules make two agents, but a suite-wide maximum still reaches four.
			floor("widest multi target set", this.maxProducedSet, suite ? 4 : 2);
			// A chain of records with several levels. A walk over one level cannot test
			// truncation by `maxDepth`, and it cannot test the order of a parent before
			// its children.
			floor("deepest chain of records", this.maxChainDepth, 8);
			// The explicit unlink from a system. Each other change to a `Produced` set
			// comes from the `"clear"` policy, so with no call here the route through
			// `ctx.removeRelation` has no cover.
			floor("calls of ctx.removeRelation", this.unlinkCalls, 500);
		}
		if (bad.length > 0) fail(`${mode} non-vacuity`, bad.join("; "));
		return this;
	}
	report() {
		const rules = [...this.rules.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([n, c]) => `${n}=${c}`)
			.join(" ");
		console.log(`\npressure (suite-wide, all floors met)`);
		console.log(`  rewrites            ${this.rewrites}`);
		console.log(`  ticks               ${this.ticks}`);
		console.log(`  distinct archetypes ${this.archetypes.size}  [${[...this.archetypes].sort().join(" ")}]`);
		console.log(`  observer calls      +${this.observerAdds} / -${this.observerRemoves}`);
		console.log(`  snapshot round-trips ${this.snapshots}`);
		console.log(`  peak growth         ${this.maxGrowth.toFixed(2)}x initial`);
		console.log(`  rules               ${rules}`);
		console.log(`  change detection    ${this.setEntityCalls} onSet(entity) / ${this.setArchCalls} onSet(archetype)`);
		console.log(`  quarantine          -${this.disableCalls} / +${this.enableCalls} toggles, peak ${this.peakDisabled} disabled`);
		console.log(`  events              ${this.events} emitted and drained`);
		console.log(`  gated system        ${this.gatedRuns} runs under a run condition`);
		console.log(
			`  query verbs         optional(Age) spans ${this.optionalSpansWithAge} with / ` +
				`${this.optionalSpansWithoutAge} without, ${this.untilStops} forEachUntil early stops`
		);
		console.log(`  markChanged         ${this.markCalls} marks that no archetype layer may report`);
		console.log(`  ctx.removeRelation  ${this.unlinkCalls} explicit unlinks of a Produced pair`);
		console.log(`  idle tail           ${this.idleTicks} ticks that must report no change`);
		console.log(`  Fresh + disabled    ${this.freshDisabledTicks} ticks, peak ${this.peakFreshDisabled} rows`);
		console.log(`  sparse scribbles    ${this.sparseScribbles} snapshot round trips wrote the sparse store`);
		console.log(`  f64 arm             ${this.floatCases} cases with no determinism`);
		console.log(`  SharedArrayBuffer   ${this.sabCases} cases on the opt-in backing`);
		if (this.provCases > 0) {
			console.log(`  provenance layer    ${this.provCases} cases`);
			console.log(`    records           ${this.records} logged, ${this.cascaded} destroyed by cascade`);
			console.log(`    epochs pruned     ${this.epochsPruned}`);
			console.log(`    record observer   -${this.recordRemoves} removes (every one a cascade victim)`);
			console.log(`    compact()         ${this.compactReclaimed} orphan keys reclaimed`);
			console.log(`    widest multi set  ${this.maxProducedSet} targets`);
			console.log(`    deepest chain     ${this.maxChainDepth} levels (hierarchy / maxDepth)`);
		}
	}
}

// ── sized case runner ───────────────────────────────────────────────────────
/**
 * Run one case with a batch sized from a reference-only pre-pass, then
 * cross-check the two runs against each other.
 *
 * Same seed means the same reduction order, so a reference reduced on its own and
 * the same reference reduced inside the lockstep tick loop must agree exactly on
 * rewrite count and normal form. That is a check on the *harness*: it catches any
 * way the tick structure, the batching, or the ECS replay could perturb the model
 * half of the oracle.
 */
export function runCase(
	lib,
	spec,
	{
		seed,
		label,
		maxBatch,
		targetTicks = 24,
		verifyEvery,
		snapEvery,
		steps,
		prov,
		compactEvery,
		quar,
		float,
		record,
		sab,
	}
) {
	const pre = refOnly(spec, seed, steps);
	const batch = Math.max(1, Math.min(maxBatch, Math.ceil(pre.rewrites / targetTicks)));
	const stats = lockstep(lib, spec, {
		seed,
		batch,
		steps,
		verifyEvery,
		snapEvery,
		label,
		prov,
		compactEvery,
		quar,
		float,
		record,
		sab,
	});
	if (pre.normalised !== stats.normalised) {
		fail(label, `reference-only run ${pre.normalised ? "normalised" : "capped"}, lockstep did not`);
	}
	if (pre.rewrites !== stats.rewrites) {
		fail(
			label,
			`reference alone took ${pre.rewrites} rewrites, the same seed in lockstep took ${stats.rewrites}`
		);
	}
	if (pre.canonical.form !== stats.canonical.form) {
		fail(label, `reference-only normal form differs from the ECS's at the same seed`);
	}
	if (pre.loops !== stats.loops) {
		fail(label, `reference alone counted ${pre.loops} wire loops, lockstep ${stats.loops}`);
	}
	stats.batch = batch;
	return stats;
}

// ── reporting ───────────────────────────────────────────────────────────────
export function report(label, stats, extra = "") {
	console.log(
		`  ${label.padEnd(26)} ${String(stats.rewrites).padStart(8)} rw  ` +
			`${String(stats.ticks).padStart(5)} ticks  b=${String(stats.batch ?? "?").padStart(4)}  ` +
			`peak ${String(stats.peakAgents).padStart(6)}  ` +
			`${String(stats.archetypes.size).padStart(2)} arch  ` +
			`obs +${String(stats.observerAdds).padStart(6)}/-${String(stats.observerRemoves).padStart(6)}  ` +
			`${String(stats.snapshots).padStart(3)} snap  ${stats.normalised ? "norm" : "capped"}${extra}`
	);
	const p = stats.provStats;
	if (p !== null && p !== undefined) {
		console.log(
			`  ${" ".repeat(26)} prov: ${p.recordsCreated} records (${p.recordsCascaded} cascade-destroyed), ` +
				`${p.epochsCreated} epochs (${p.epochsPruned} pruned), ` +
				`peak ${p.maxLiveRecords} live / ${p.maxProducedSet}-wide sets, ` +
				`rec obs +${stats.recordAdds}/-${stats.recordRemoves}, ` +
				`${stats.compactions} compacts reclaiming ${stats.compactReclaimed}`
		);
	}
}

