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
import { applyRewrite, assertRulesLinear, rng, PORTS, RULE_ID, TYPE_NAME } from "./spec.mjs";
import { RefNet } from "./ref.mjs";
import { RefProv } from "./prov.mjs";
import { EcsNet } from "./world.mjs";

/** Default provenance-layer shape: an epoch every 8 ticks, 4 retained. At the
 * suite's batch of 32 that bounds the live record population to ~1k while pruning
 * (and therefore cascade-destroying) an epoch's worth of records every 8 ticks. */
export const PROV_DEFAULT = { epochEvery: 8, retain: 4 };

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
	{ seed, batch, steps, verifyEvery, snapEvery, label, prov = PROV_DEFAULT, compactEvery = 16 }
) {
	const rand = rng(seed);
	const ref = RefNet.load(spec);
	const provRef = prov === null ? null : new RefProv(prov);
	const world = new EcsNet(lib, { strict: batch <= 4, prov });
	world.load(spec);

	ref.assertConsistent(`${label} t0 (ref load)`);

	const stats = {
		rewrites: 0,
		ticks: 0,
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

		// Mirrors the ECS's PRE_UPDATE promotion, which runs before the rewrites.
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
		world.runTick(plan, roll);
		ref.ageTick(); // mirrors the ECS's POST_UPDATE age bump
		stats.rewrites += plan.length;
		stats.ticks++;

		const where = `${label} tick ${stats.ticks} (rewrite ${stats.rewrites})`;

		// ── tier 1: cheap totals, every tick ────────────────────────────────
		if (world.loops !== ref.loops) {
			fail(where, `wire-loop count: ecs ${world.loops}, ref ${ref.loops}`);
		}
		if (world.rewritesApplied !== stats.rewrites) {
			fail(where, `ecs applied ${world.rewritesApplied} rewrites, planned ${stats.rewrites}`);
		}

		// ── tier 2: full structure, every `verifyEvery` ticks ────────────────
		if (stats.ticks % verifyEvery === 0) {
			ref.assertConsistent(`${where} [ref]`);
			ref.assertRedexIndex(`${where} [ref]`);
			world.assertSelfConsistent(`${where} [ecs]`);
			compare(where, ref, world);
			if (provRef !== null) world.assertProvenance(`${where} [prov]`, provRef, fail);
			for (const s of world.archetypeSignatures()) stats.archetypes.add(s);
		}

		// ── tier 3: snapshot metamorphism ───────────────────────────────────
		if (snapEvery > 0 && stats.ticks % snapEvery === 0) {
			snapshotRoundTrip(where, world);
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

	stats.observerAdds = world.observerAdds;
	stats.observerRemoves = world.observerRemoves;
	stats.recordAdds = world.recordAdds;
	stats.recordRemoves = world.recordRemoves;

	// Final full verification regardless of the cadence above.
	const where = `${label} final (rewrite ${stats.rewrites})`;
	ref.assertConsistent(`${where} [ref]`);
	ref.assertRedexIndex(`${where} [ref]`);
	world.assertSelfConsistent(`${where} [ecs]`);
	compare(where, ref, world);
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
	// Release the world's backing before returning. The suite builds ~30 of these in
	// one process and the growth soak cases each hold hundreds of thousands of
	// agents; without this they all stay resident at once.
	world.redexObserver.dispose();
	world.ecs.dispose();
	return stats;
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
	const before = world.ecs.snapshots.stateHash();
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
	const after = world.ecs.snapshots.stateHash();
	if (before !== after) {
		fail(where, `compact() moved stateHash ${before} -> ${after}; it must change nothing observable`);
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

	const agents = world.liveAgents();
	if (agents.length > 0) {
		const victim = agents[0];
		const before = ecs.getField(victim, world.Slot, "s0");
		ecs.setField(victim, world.Slot, "s0", (before + 7) % 251);
		if (ecs.snapshots.stateHash() === h0) {
			fail(where, `stateHash is blind to a Slot write — the snapshot oracle would be vacuous`);
		}
	}
	ecs.snapshots.restore(bytes);
	const h1 = ecs.snapshots.stateHash();
	if (h0 !== h1) fail(where, `stateHash ${h0} -> ${h1} across capture/restore`);
	world.assertSelfConsistent(`${where} [post-restore]`);
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
	{ orders, batch, steps, verifyEvery, snapEvery, label, prov, compactEvery }
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
		this.provCases = 0;
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
		const p = stats.provStats;
		if (p !== null && p !== undefined) {
			this.records += p.recordsCreated;
			this.cascaded += p.recordsCascaded;
			this.epochsPruned += p.epochsPruned;
			this.recordRemoves += stats.recordRemoves;
			this.compactReclaimed += stats.compactReclaimed;
			this.maxProducedSet = Math.max(this.maxProducedSet, p.maxProducedSet);
			this.provCases++;
		}
	}
	assert() {
		const ALL_RULES = ["CON~CON", "CON~DUP", "CON~ERA", "DUP~DUP", "DUP~ERA", "ERA~ERA"];
		const bad = [];
		const floor = (what, got, want) => {
			if (got < want) bad.push(`${what}: ${got} (want >= ${want})`);
		};
		floor("total rewrites", this.rewrites, 50000);
		floor("total ticks", this.ticks, 2000);
		floor("distinct archetypes", this.archetypes.size, 12);
		floor("observer onAdd calls", this.observerAdds, 5000);
		floor("observer onRemove calls", this.observerRemoves, 5000);
		floor("snapshot round-trips", this.snapshots, 10);
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
			// exclusive relation cannot show.
			floor("widest multi target set", this.maxProducedSet, 4);
		}
		if (bad.length > 0) fail("suite non-vacuity", bad.join("; "));
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
		if (this.provCases > 0) {
			console.log(`  provenance layer    ${this.provCases} cases`);
			console.log(`    records           ${this.records} logged, ${this.cascaded} destroyed by cascade`);
			console.log(`    epochs pruned     ${this.epochsPruned}`);
			console.log(`    record observer   -${this.recordRemoves} removes (every one a cascade victim)`);
			console.log(`    compact()         ${this.compactReclaimed} orphan keys reclaimed`);
			console.log(`    widest multi set  ${this.maxProducedSet} targets`);
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
	{ seed, label, maxBatch, targetTicks = 24, verifyEvery, snapEvery, steps, prov, compactEvery }
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

