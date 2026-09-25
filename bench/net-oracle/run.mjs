/**
 * A deterministic oracle for a simulation. It reduces an interaction net in lockstep
 * against a reference reducer, and it compares the two nets. This file is the command
 * line, and the oracles are in `driver.mjs`.
 *
 * Two groups of layers run at a different rate. The cheap layers run at each tick:
 * the totals, the channel of the events, and the change detection. The full
 * comparison of each live agent runs at each verification tick, which `--verify=N`
 * selects. Use `--verify=1` to compare at each tick.
 *
 * The reason for an interaction net. This workload has a purpose: each rewrite is
 * difficult for an archetype ECS. Each rewrite despawns two entities, and it spawns
 * a maximum of four. It changes the target of a maximum of eight exclusive
 * relations. It writes approximately 12 `u8` columns, and it moves several rows
 * between archetypes. It does all of this through deferred commands, and the
 * observers run at each flush. Therefore each tick does work.
 *
 * The reason a check is possible. The interaction combinators of Lafont are
 * strongly confluent. They have linearity, they have binary interaction, and their
 * rules have no ambiguity. Together, these three properties give one result: each
 * sequence of reductions reaches the same normal form, and it uses the same number
 * of rewrites. Therefore one correct step by chance cannot give a correct result.
 * The archetype layout and the sequence of the flush can give the ECS any sequence
 * of reductions, but the final net and the total number of rewrites must agree.
 *
 * The oracles, from the weakest to the strongest:
 *
 *   1. Self-consistency (the ECS alone), each port connects to a live port that
 *      connects back. The reverse index of the relations agrees with the forward
 *      links, `pairsOf` gives the same set of pairs, a dead entity holds no key in
 *      that index, and `sourcesOfAny` agrees with the reads of one relation at a
 *      time. The relation graph and the `u8` slot columns are two independent
 *      records of one fact, and they must agree. This layer needs no reference.
 *   2. Lockstep (the ECS against the reference), at each verification tick, and
 *      through a bijection of the ids, the driver compares the type of each agent,
 *      the links, `Fresh`, `Age`, `Touch.seq`, `Quar.count`, `Tainted`, the census
 *      and the number of loops. It finds the first tick that differs. With
 *      `--verify=1` each tick is a verification tick, and with `--batch=1` the driver
 *      finds the first rewrite that differs.
 *   3. Canonical form (the ECS against the reference, with no bijection), the
 *      driver gives new numbers to both nets by a breadth-first search from ROOT,
 *      and it then compares them as strings. Therefore an error in the map of the
 *      ids in the harness cannot hide a true difference.
 *   4. The queues of the observers, the `onAdd` and `onRemove` callbacks alone
 *      build the redex set and the record set. The driver compares each set against
 *      a new scan of the ECS, and against the reference. A record dies only
 *      *indirectly*. Therefore the second set is the assertion that a cascade calls
 *      `onRemove` for each entity that it destroys.
 *   5. The provenance layer, a second population of entities (refer to `prov.mjs`)
 *      uses the part of the relation API that the exclusive ports of the net do not
 *      use: sets of targets on a multi relation, the exact set of entities that the
 *      `"delete"` cascade destroys, `"orphan"` with an exactly predicted reclaim
 *      count from `relations.compact()`, and the helpers that do a traversal. A chain
 *      of records that is hundreds of levels deep covers `ancestorsOf` past depth 1,
 *      truncation by `maxDepth`, and the order of a parent before its children.
 *   6. A closed form. You can calculate the number of rewrites of the generator for
 *      an erasure tree by hand (`2^(depth+1)`). Therefore the two implementations
 *      can be incorrect together, and the run still fails. This is the only layer
 *      that is external to both implementations. A snapshot and a restore must also
 *      make no change to `stateHash`.
 *   7. Confluence, the same net under several reduction orders must give an equal
 *      number of rewrites and an equal normal form. This layer sits beside the
 *      closed form, and not above it: each order already compares its ECS result
 *      with its own reference in layer 2, so a fault in the ECS fails there first.
 *      What confluence adds is a check of the spec against itself, which finds a
 *      fault that `spec.mjs` and `ref.mjs` hold together. `driver.mjs::confluence`
 *      gives the complete reason.
 *   8. Change detection, the reference counts `Touch.seq` in its own `setLink`, so
 *      the set of agents that a tick wrote comes from the model. An `onSet` observer
 *      with the granularity of an entity must report exactly that set. A second
 *      observer with the granularity of an archetype, and a `changed()` query, must
 *      report each archetype that holds one of those agents. `changed(Age)` is exact
 *      in both directions. Refer to `driver.mjs::changeCheck`.
 *   9. The idle tail, after a net reaches its normal form, the driver runs a few
 *      ticks with no rewrite. Those ticks write no column, so the `onSet` observers
 *      and `changed(Touch)` must go quiet, and `changed(Age)` must stay busy. This is
 *      the only layer that bounds the change detection from above.
 *  10. The partition of the rows, the quarantine disables and enables agents through
 *      the host write seam, so `onDisable` and `onEnable` fire. A default query must
 *      not show a disabled row, and the exact comparison of `Age.ticks` in layer 2 is
 *      the proof of it.
 *  11. The events, the resources and the sparse components, one event for each
 *      rewrite, drained and compared with the plan. A resource that gates a system
 *      through `runIfResourceEq` on a set of ticks that the driver picks, and a sparse
 *      component whose membership rule the reference also holds.
 *  12. The verbs of a query, `andRelation` and `notRelation` against the arity
 *      of the ports, `optional` against the agents that have no `Age` yet,
 *      `singleEntity` against the one ROOT, `firstEntity` against the idle tail, and
 *      `some` against the count of the archetypes that `forEachArchetype` gives. Each
 *      one reads a fact that the reference already holds.
 *  13. `ctx.markChanged`, a mark records a row for the per-entity `onSet` observer,
 *      and it makes no archetype changed. The idle tail is where that difference is
 *      sharp: a mark is the only reason for a report there.
 *  14. `ctx.removeRelation` and `ctx.hasRelation`, one system removes one `Produced`
 *      pair on each verification tick, and the model applies the same removal. A port
 *      of the net is exclusive, so a rewrite replaces its target instead.
 *  15. The archetype terms. One set of agents, in three spellings. They are a chain
 *      of verbs, a nested expression through `where`, and a term of the harness's
 *      own making. The expression nests the free `and`, `or` and `not`. The model
 *      holds the set, and the three must also report one archetype list.
 *  16. Two phases that the harness adds. A census before UPDATE reads the count of
 *      the live agents at the start of the tick. A census after UPDATE reads the
 *      count after the rewrites. Both read `Age.ticks` of the ROOT before the bump
 *      of POST_UPDATE. So the position of each phase has an exact expected value.
 *  17. The row grain. `ecs.trackRows(Mix)` gives `Mix` a row tick column.
 *      `cols.ticksRead(Mix)` against `cols.since` must report exactly the agents
 *      that the reference wrote in its own `setLink`. `changed(Mix).forEachColumns`
 *      reaches the same rows behind the filter on the archetype.
 *  18. The sparse row grain. `ctx.sparseChanged(Watch)` must report exactly the
 *      members that `redexMaintain` wrote through the mutable sparse cursor.
 *  19. The pool. The age bump of the net runs as a `js` kernel across two workers.
 *      The pooled world gets the complete oracle. Three of its numbers must equal
 *      those of the same run with no pool. They are `stateHash`, the normal form
 *      and the count of the rewrites. The sequential body must not run there, which
 *      says the pool took each pass.
 *
 * `surface.mjs` holds 21 more probes. They cover the parts of the API that a net
 * which must keep its meaning cannot reach. Those parts are a cycle in a
 * relation, a named error, a replay into a second world, the batch paths, the
 * combinators for a run condition, the explicit removal of a relation, the
 * cursors, the immediate toggle from the host, the refusal of a damaged
 * snapshot, and the immediate component writes of the host.
 *
 * `mutants.mjs` shows that this tool is necessary. It puts known ECS bugs into a
 * built bundle, and it requires the oracle to find each one. It also reports how many
 * of them an oracle layer found, and how many an engine error found first.
 *
 * Usage:
 *   node bench/net-oracle/run.mjs                      # the curated suite, a short run
 *   node bench/net-oracle/run.mjs --soak               # long runs, millions of rewrites
 *   node bench/net-oracle/run.mjs --stress             # large nets, a fingerprint at each tick
 *   node bench/net-oracle/run.mjs --net=erase:14 --batch=64
 *   node bench/net-oracle/run.mjs --net=random:1,30,18,20 --steps=2000000 --verify=200
 *   node bench/net-oracle/run.mjs --net=dup:6 --batch=1   # per-rewrite attribution
 *   node bench/net-oracle/run.mjs --surface            # the probes for the API surface
 *   node bench/net-oracle/run.mjs --memory             # the store base, the cap and the fixed buffer
 *   node bench/net-oracle/run.mjs --workers            # one system across a pool
 *
 * Options:
 *   --net=spec     erase:D | dup:D | random:seed,nCon,nDup,nEra
 *   --seed=N       reduction-order seed (default 1)
 *   --batch=N      rewrites per tick (default 32, and 1 for exact attribution)
 *   --steps=N      max rewrites (default 200000)
 *   --verify=N     deep verify every N ticks (default 1)
 *   --snap=N       snapshot round-trip every N ticks (default 64, and 0 to disable)
 *   --orders=N     reduction orders to cross-check for confluence (default 3)
 *   --soak         long-duration preset instead of the suite
 *   --prov=0       omit the provenance layer (cascade, multi and orphan coverage)
 *   --epoch=N      ticks per epoch (default 8)
 *   --retain=N     epochs retained before pruning cascades (default 4)
 *   --compact=N    relations.compact() check every N ticks (default 16, and 0 to disable)
 *   --float        a world with no determinism and an `f64` mirror column. That is the
 *                  only arm that can hold a float column, and it gives up `stateHash`,
 *                  `capture` and `restore`, which all need determinism.
 *   --sab          put the column store on a `SharedArrayBuffer`. That is the opt-in
 *                  profile that a worker or a WASM compute backend needs.
 *   --base=N       the byte offset of the store header inside the backing. A WASM
 *                  module owns the low addresses of its own linear memory. A world
 *                  that shares bytes with one starts its store above them.
 *   --cap=N        the byte ceiling of the backing. A grow that passes it throws
 *                  `STORE_CAP_EXCEEDED`, and there is no fallback.
 *   --record       log each host command, and check the log's round trip through JSON.
 *   --fp=N         the fingerprint of every agent at each N ticks (default 1, and 0 is never).
 *                  One linear scan on each side, so it runs where the deep comparison
 *                  of `--verify` cannot. Refer to `fingerprint.mjs`.
 *   --phase=N      the checkpoints inside a tick, at each N ticks (default 1, and 0 is
 *                  never). A development build compares the fingerprint after
 *                  PRE_UPDATE, UPDATE and POST_UPDATE with the reference at the same
 *                  point. Each checkpoint is one more scan. A production build has
 *                  no trace seam, so it has no checkpoint.
 *   --stress       large nets, with the fingerprint at each tick and the deep
 *                  comparison on a cadence. Duration and scale, as `--soak`, but
 *                  with the check at each frame.
 *   --lib=path     use an already-built bundle (how `mutants.mjs` injects bugs)
 *   --prod         build with __DEV__=false (default is dev: guards on)
 *   --surface      run the API-surface probes alone, and no simulation
 *   --memory       run the arms for the layout of the memory alone: the store base,
 *                  a cap that the case fits inside, a fixed buffer, and a cap that
 *                  the case does not fit inside
 *   --workers      run the arm for the pool alone: the age bump of the net as a
 *                  `js` kernel across two workers, against the same run with no pool
 *   --quiet        less per-case detail
 *
 * The default build is a development build, and the released package is not. A
 * development build keeps the internal guards, and thus it gives more mechanisms a
 * chance to find a fault, which is the correct default for a correctness tool. But
 * the shipped path is the production path, so run `--prod` as well before you trust
 * a result about the released package. `bench/README.md` records which tool uses
 * which build.
 */
import path from "node:path";
import url from "node:url";
import { buildLib } from "../build.mjs";
import { netFromArg, assertNetSpecValid, dupTree, erasureTree, randomNet } from "./nets.mjs";
import {
	Divergence,
	Pressure,
	confluence,
	fail,
	lockstep,
	memoryArms,
	report,
	runCase,
	workersArm
} from "./driver.mjs";
import { runSurface } from "./surface.mjs";

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const num = (name, dflt) => Number(flag(name, dflt));
const OPT = {
	net: flag("net", null),
	seed: num("seed", 1),
	batch: num("batch", 32),
	steps: num("steps", 200000),
	verify: num("verify", 1),
	snap: num("snap", 64),
	orders: num("orders", 3),
	soak: argv.includes("--soak"),
	prod: argv.includes("--prod"),
	quiet: argv.includes("--quiet"),
	// Provenance layer: `--prov=0` omits it entirely (a leaner, faster net-only run).
	prov: num("prov", 1) === 0 ? null : { epochEvery: num("epoch", 8), retain: num("retain", 4) },
	compactEvery: num("compact", 16),
	float: argv.includes("--float"),
	sab: argv.includes("--sab"),
	base: num("base", 0),
	cap: num("cap", 0),
	record: argv.includes("--record"),
	fp: num("fp", 1),
	phase: num("phase", 1),
	stress: argv.includes("--stress")
};
// A stress case gives its checkpoints a cadence of their own, because each one is a
// scan of each agent and the large cases hold hundreds of thousands. An explicit
// `--phase` overrides that cadence, as `--steps` overrides the budgets.
const explicitPhase = argv.some((a) => a.startsWith("--phase=")) ? OPT.phase : null;
const explicitFp = argv.some((a) => a.startsWith("--fp=")) ? OPT.fp : null;
// Soak cases carry their own step budgets. An explicit `--steps` overrides them
// all, but the default must not silently cap a soak at the suite's 200k.
const explicitSteps = argv.some((a) => a.startsWith("--steps=")) ? OPT.steps : null;

const here = path.dirname(url.fileURLToPath(import.meta.url));
// `--lib=` points at an already-built bundle instead of building from source. That
// is how `mutants.mjs` feeds this harness deliberately broken ECS builds without
// ever touching the working tree.
const preBuilt = flag("lib", null);
let outfile;
if (preBuilt !== null) {
	outfile = path.resolve(preBuilt);
} else {
	outfile = path.join(here, "../.out/oecs.net-oracle.mjs");
	await buildLib(outfile, { dev: !OPT.prod, from: path.join(here, "../..") });
}
const libUrl = url.pathToFileURL(outfile).href;
const lib = await import(libUrl);
// The worker entry of the oracle reads this. It imports the same build that this
// process loaded. A fault in the bundle then reaches the worker half of the pool
// as well. A worker inherits the environment of the process that started it.
process.env.OECS_NET_ORACLE_LIB = libUrl;
const WORKER_ENTRY = new URL("./worker-entry.mjs", import.meta.url);

/** The arms for the layout of the memory: the store base, and the two halves of
 * the byte ceiling. `pressure` may be `null`, which is the `--memory` arm, where
 * the floors of the suite do not apply. */
function runMemoryArms(lib, pressure) {
	const spec = assertNetSpecValid(dupTree(6));
	// A net that does not fit inside the ceiling below. The load spawns every
	// agent, so the grow that crosses the ceiling happens there.
	const capSpec = assertNetSpecValid(dupTree(12));
	const r = memoryArms(lib, {
		spec,
		capSpec,
		cap: 8 * 1024 * 1024,
		tooSmall: 1024 * 1024,
		seed: OPT.seed,
		maxBatch: OPT.batch,
		verifyEvery: 2,
		snapEvery: 8,
		steps: OPT.steps,
		prov: OPT.prov,
		compactEvery: OPT.compactEvery,
		fpEvery: OPT.fp,
		phaseEvery: OPT.phase
	});
	report("SharedArrayBuffer", r.atZero);
	report("at a store base", r.atBase);
	report("under a declared cap", r.underCap);
	report("on a fixed buffer", r.onFixed);
	console.log(
		`  ${"the store base".padEnd(26)} base 0 and base ${r.base} agree on stateHash ` +
			`${r.atZero.finalHash}, on the normal form and on ${r.atZero.rewrites} rewrites`
	);
	console.log(
		`  ${"the cap on the backing".padEnd(26)} STORE_CAP_EXCEEDED at ${r.refused.cap} bytes, and the ` +
			`message names the ${r.refused.live} live entities that the world holds`
	);
	console.log(
		`  ${"the fixed allocator".padEnd(26)} one stateHash with the growable buffer, and the same ` +
			`refusal at ${r.refusedFixed.live} live entities`
	);
	if (pressure !== null) {
		pressure.absorb(spec, r.atZero);
		pressure.absorb(spec, r.atBase);
		pressure.absorb(spec, r.underCap);
		pressure.absorb(spec, r.onFixed);
	}
	return { cases: 6 };
}

/** One system of the net across a pool of workers, against the same run with no
 * pool. `pressure` may be `null`, which is the `--workers` arm. */
async function runWorkersArm(lib, pressure) {
	const spec = assertNetSpecValid(dupTree(6));
	const r = await workersArm(lib, spec, {
		count: 2,
		workerUrl: WORKER_ENTRY,
		seed: OPT.seed,
		maxBatch: OPT.batch,
		verifyEvery: 2,
		snapEvery: 8,
		steps: OPT.steps,
		prov: OPT.prov,
		compactEvery: OPT.compactEvery,
		fpEvery: OPT.fp,
		phaseEvery: OPT.phase
	});
	report("the age bump, one thread", r.sequential);
	report(`the age bump, ${r.count} workers`, r.pooled);
	console.log(
		`  ${"the workers arm".padEnd(26)} one stateHash ${r.pooled.finalHash}, one normal form, ` +
			`${r.pooled.rewrites} rewrites, and the sequential body ran ` +
			`${r.pooled.ageSequentialRuns} times in the pooled world`
	);
	if (pressure !== null) {
		pressure.absorb(spec, r.sequential);
		pressure.absorb(spec, r.pooled);
	}
	return { cases: 2 };
}

// ── main ────────────────────────────────────────────────────────────────────
const t0 = process.hrtime.bigint();
let cases = 0;

try {
	if (argv.includes("--surface")) {
		// The probes alone. `mutants.mjs` needs this arm. Each case of its battery names
		// a `--net=`, which takes the branch below. Therefore the battery could not
		// reach the probes, and no mutant could show that a probe catches a fault.
		console.log(`net-oracle surface (${OPT.prod ? "prod" : "dev"} build)`);
		const surface = runSurface(lib, { quiet: OPT.quiet });
		console.log(`  ${surface.probes} probes, ${surface.checks} checks`);
		cases = surface.probes;
	} else if (argv.includes("--memory")) {
		// The arms for the layout of the memory alone, and no suite. `mutants.mjs`
		// needs this arm. Each other case of its battery names a `--net=`. Such a run
		// reaches neither the store base nor the refusal at the cap.
		console.log(`net-oracle memory arms (${OPT.prod ? "prod" : "dev"} build)`);
		cases = runMemoryArms(lib, null).cases;
	} else if (argv.includes("--workers")) {
		// The pool alone, and no suite. `mutants.mjs` needs this arm. Each other case
		// of its battery runs one thread. A fault in the host half of the pool is
		// inert there.
		console.log(`net-oracle workers arm (${OPT.prod ? "prod" : "dev"} build)`);
		cases = (await runWorkersArm(lib, null)).cases;
	} else if (OPT.net !== null) {
		// ── single explicit case ────────────────────────────────────────────
		const spec = netFromArg(OPT.net, OPT.seed);
		console.log(
			`net-oracle: ${spec.name}  seed=${OPT.seed} batch=${OPT.batch} ` +
				`steps=${OPT.steps} verify=${OPT.verify} snap=${OPT.snap} ${OPT.prod ? "prod" : "dev"}` +
				`${OPT.float ? " f64/no-determinism" : ""}${OPT.sab ? " sab" : ""}${OPT.record ? " record" : ""}`
		);
		const stats = lockstep(lib, spec, {
			seed: OPT.seed,
			batch: OPT.batch,
			steps: OPT.steps,
			verifyEvery: OPT.verify,
			snapEvery: OPT.snap,
			label: spec.name,
			prov: OPT.prov,
			compactEvery: OPT.compactEvery,
			float: OPT.float,
			sab: OPT.sab,
			record: OPT.record,
			storeBase: OPT.base,
			maxBytes: OPT.cap,
			fpEvery: OPT.fp,
			phaseEvery: OPT.phase
		});
		stats.batch = OPT.batch;
		report(spec.name, stats);
		if (spec.expectRewrites !== undefined && stats.normalised) {
			if (stats.rewrites !== spec.expectRewrites) {
				fail(spec.name, `closed form says ${spec.expectRewrites} rewrites, got ${stats.rewrites}`);
			}
			if (stats.live !== spec.expectAgents) {
				fail(spec.name, `closed form says ${spec.expectAgents} agents remain, got ${stats.live}`);
			}
			console.log(
				`  closed form OK: ${spec.expectRewrites} rewrites, ${spec.expectAgents} agents, ${spec.expectLoops} loops`
			);
		}
		cases = 1;
	} else if (OPT.soak) {
		// ── soak ────────────────────────────────────────────────────────────
		// Long runs at ~1e5 rewrites/s. Verification is sparse here on purpose: the
		// suite already checks every tick on small nets, so what this adds is
		// duration, millions of structural transitions, entity-slot recycling well
		// past the live count, and archetypes that grow far beyond their prewarmed
		// capacity. The two grow-path mutants in `mutants.mjs` are exactly the class
		// of bug only this reaches.
		console.log(`net-oracle soak (${OPT.prod ? "prod" : "dev"} build)`);
		const pressure = new Pressure();
		// Verification is O(live agents), three `sourcesOf` calls per agent plus two
		// canonical traversals, so cadence has to be set against each case's live
		// count, not globally. The churn cases hold a few hundred to a few thousand
		// agents and can afford a tight cadence. The growth cases run to hundreds of
		// thousands, where the same cadence would spend all its time verifying and
		// never reach the scale that is the entire point of running them.
		const SOAK = [
			// bounded live set, endless churn, cumulative creates >> peak concurrency.
			// The fingerprint and its checkpoints get a cadence here: the soak measures
			// duration, and a scan of each agent at each of its 150k ticks would make it
			// a different tool. `--stress` is that tool.
			{
				net: "random:6,30,18,20",
				steps: 5_000_000,
				batch: 32,
				verify: 400,
				snap: 2000,
				fp: 16,
				phase: 128,
				label: "churn-small"
			},
			{
				net: "random:1,30,18,20",
				steps: 3_000_000,
				batch: 32,
				verify: 400,
				snap: 2000,
				fp: 16,
				phase: 128,
				label: "churn-mid"
			},
			// unbounded growth, large archetypes, repeated column grows
			{
				net: "random:2,24,24,12",
				steps: 400_000,
				batch: 512,
				verify: 50,
				snap: 0,
				fp: 4,
				phase: 32,
				label: "growth"
			},
			{
				net: "random:12,40,30,20",
				steps: 400_000,
				batch: 512,
				verify: 50,
				snap: 0,
				fp: 4,
				phase: 32,
				label: "growth-wide"
			},
			// closed-form answer at scale
			{
				net: "erase:18",
				steps: 1_000_000,
				batch: 256,
				verify: 32,
				snap: 400,
				fp: 8,
				phase: 64,
				label: "erase-large"
			}
		];
		for (const c of SOAK) {
			const spec = netFromArg(c.net, OPT.seed);
			const steps = explicitSteps ?? c.steps;
			const batch = c.batch ?? OPT.batch;
			const t = process.hrtime.bigint();
			const stats = lockstep(lib, spec, {
				seed: OPT.seed,
				batch,
				steps,
				verifyEvery: c.verify,
				snapEvery: c.snap,
				label: `${c.label} ${spec.name}`,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				// the cadence of the case, unless the command line names one.
				fpEvery: explicitFp ?? c.fp,
				phaseEvery: explicitPhase ?? c.phase
			});
			stats.batch = batch;
			const secs = Number(process.hrtime.bigint() - t) / 1e9;
			if (spec.expectRewrites !== undefined && stats.normalised) {
				if (stats.rewrites !== spec.expectRewrites) {
					fail(c.label, `closed form says ${spec.expectRewrites} rewrites, got ${stats.rewrites}`);
				}
				if (stats.live !== spec.expectAgents) {
					fail(c.label, `closed form says ${spec.expectAgents} agents remain, got ${stats.live}`);
				}
			}
			report(c.label, stats, `  ${(stats.rewrites / secs / 1000).toFixed(0)}k rw/s`);
			pressure.absorb(spec, stats);
			cases++;
		}
		// A soak measures duration, and it builds none of the arms of the suite.
		// Therefore the floors for those arms do not apply to it. Refer to
		// `Pressure.assert`.
		pressure.assert("soak", { dev: !OPT.prod }).report();
	} else if (OPT.stress) {
		// ── stress ──────────────────────────────────────────────────────────
		// Large nets, and the check at each tick. `--soak` verifies on a cadence of
		// hundreds of ticks, because the deep comparison is O(live agents) with a
		// large constant. The fingerprint is one linear scan, so these cases run it
		// at each tick, and at each phase of each tick in a development build. The
		// deep comparison stays, on a cadence, for the message that names an agent.
		console.log(`net-oracle stress (${OPT.prod ? "prod" : "dev"} build), fingerprint at each tick`);
		const pressure = new Pressure();
		const STRESS = [
			// unbounded growth: hundreds of thousands of live agents, large archetypes
			{
				net: "random:2,24,24,12",
				steps: 400_000,
				batch: 512,
				verify: 100,
				snap: 0,
				phase: 16,
				label: "growth"
			},
			{
				net: "random:12,40,30,20",
				steps: 400_000,
				batch: 512,
				verify: 100,
				snap: 0,
				phase: 16,
				label: "growth-wide"
			},
			// bounded live set, long churn: many ticks, each one checked. The deep
			// comparison is cheap on a net of this size, and the marks and the explicit
			// unlinks follow its cadence, so a tight cadence here is what meets their floors.
			{
				net: "random:6,30,18,20",
				steps: 1_000_000,
				batch: 32,
				verify: 50,
				snap: 2000,
				phase: 4,
				label: "churn"
			},
			// the closed form at scale
			{
				net: "erase:16",
				steps: 1_000_000,
				batch: 128,
				verify: 64,
				snap: 200,
				phase: 8,
				label: "erase-large"
			}
		];
		for (const c of STRESS) {
			const spec = netFromArg(c.net, OPT.seed);
			const steps = explicitSteps ?? c.steps;
			const batch = c.batch ?? OPT.batch;
			const t = process.hrtime.bigint();
			const stats = lockstep(lib, spec, {
				seed: OPT.seed,
				batch,
				steps,
				verifyEvery: c.verify,
				snapEvery: c.snap,
				label: `${c.label} ${spec.name}`,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				fpEvery: OPT.fp,
				phaseEvery: explicitPhase ?? c.phase
			});
			stats.batch = batch;
			const secs = Number(process.hrtime.bigint() - t) / 1e9;
			if (spec.expectRewrites !== undefined && stats.normalised) {
				if (stats.rewrites !== spec.expectRewrites) {
					fail(c.label, `closed form says ${spec.expectRewrites} rewrites, got ${stats.rewrites}`);
				}
				if (stats.live !== spec.expectAgents) {
					fail(c.label, `closed form says ${spec.expectAgents} agents remain, got ${stats.live}`);
				}
			}
			report(c.label, stats, `  ${(stats.rewrites / secs / 1000).toFixed(0)}k rw/s`);
			pressure.absorb(spec, stats);
			cases++;
		}
		pressure.assert("soak", { dev: !OPT.prod }).report();
	} else {
		// ── curated suite ───────────────────────────────────────────────────
		console.log(`net-oracle suite (${OPT.prod ? "prod" : "dev"} build)`);
		const pressure = new Pressure();

		// 1. Closed-form erasure trees, the answer comes from neither implementation.
		console.log(`\n[1] erasure trees, closed-form rewrite count 2^(depth+1)`);
		for (const depth of [1, 4, 8, 11, 14]) {
			const spec = assertNetSpecValid(erasureTree(depth));
			const stats = runCase(lib, spec, {
				seed: OPT.seed,
				label: spec.name,
				maxBatch: OPT.batch,
				verifyEvery: depth <= 8 ? 1 : 8,
				snapEvery: OPT.snap,
				steps: OPT.steps,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				fpEvery: OPT.fp,
				phaseEvery: OPT.phase
			});
			if (!stats.normalised) fail(spec.name, `did not normalise within ${OPT.steps} rewrites`);
			if (stats.rewrites !== spec.expectRewrites) {
				fail(spec.name, `closed form says ${spec.expectRewrites} rewrites, got ${stats.rewrites}`);
			}
			if (stats.live !== spec.expectAgents) {
				fail(spec.name, `closed form says ${spec.expectAgents} agents remain, got ${stats.live}`);
			}
			if (stats.loops !== spec.expectLoops) {
				fail(spec.name, `closed form says ${spec.expectLoops} wire loops, got ${stats.loops}`);
			}
			report(spec.name, stats, `  closed form OK`);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 2. Duplication, the growth/allocation-pressure axis. Commutation is the
		//    only rule that grows the net, so this is where spawn pressure lives.
		console.log(`\n[2] duplication trees, allocation pressure (net grows, then collapses)`);
		for (const depth of [3, 5, 7, 9]) {
			const spec = assertNetSpecValid(dupTree(depth));
			const stats = runCase(lib, spec, {
				seed: OPT.seed,
				label: spec.name,
				maxBatch: OPT.batch,
				verifyEvery: depth <= 7 ? 1 : 4,
				snapEvery: OPT.snap,
				steps: OPT.steps,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				fpEvery: OPT.fp,
				phaseEvery: OPT.phase
			});
			if (stats.peakAgents <= spec.types.length) {
				fail(
					spec.name,
					`peak ${stats.peakAgents} agents never exceeded the initial ${spec.types.length}`
				);
			}
			report(spec.name, stats, `  grew ${(stats.peakAgents / spec.types.length).toFixed(1)}x`);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 3. Random nets, open-ended churn with no reason to terminate. These are
		//    where the long-running pressure comes from, and where CON~CON and DUP~DUP
		//    (which the structured generators never produce) actually fire.
		console.log(`\n[3] random nets, unstructured churn`);
		for (const s of [1, 2, 3, 4, 5, 6]) {
			const spec = assertNetSpecValid(randomNet(s, 30, 18, 20));
			const steps = Math.min(OPT.steps, 20000);
			const stats = runCase(lib, spec, {
				seed: s,
				label: spec.name,
				maxBatch: OPT.batch,
				verifyEvery: 4,
				snapEvery: OPT.snap,
				steps,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				fpEvery: OPT.fp,
				phaseEvery: OPT.phase
			});
			report(`random#${s}`, stats);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 4. Confluence, the order-invariance oracle.
		console.log(`\n[4] confluence, same net, ${OPT.orders} reduction orders, must agree exactly`);
		for (const spec of [
			assertNetSpecValid(erasureTree(7)),
			assertNetSpecValid(dupTree(4)),
			assertNetSpecValid(dupTree(6)),
			assertNetSpecValid(randomNet(11, 20, 10, 14))
		]) {
			const r = confluence(lib, spec, {
				orders: OPT.orders,
				batch: OPT.batch,
				steps: OPT.steps,
				verifyEvery: 16,
				snapEvery: 0,
				label: spec.name,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				fpEvery: OPT.fp,
				phaseEvery: OPT.phase
			});
			console.log(
				`  ${spec.name.padEnd(30)} ${
					r.checked ? `${r.orders} orders agree at ${r.rewrites} rewrites` : `skipped (${r.reason})`
				}`
			);
			cases++;
		}

		// 5. The arms for the profile. Each one runs the same oracle over a different
		//    world, so the layers above cover the profile and not one call of it.
		console.log(
			`\n[5] profiles, the f64 arm, the SharedArrayBuffer arm, the store base, the cap, the fixed ` +
				`buffer, the pool, and the command log`
		);
		const armStats = new Map();
		for (const arm of [
			// A world with no determinism, and an `f64` mirror column. A deterministic
			// world rejects a float column, so this is the only arm that covers one. It
			// gives up `stateHash`, `capture` and `restore`, which all need determinism,
			// so `snapEvery` is 0 here.
			{ label: "f64, no determinism", spec: dupTree(6), float: true, snap: 0 },
			{
				label: "f64, with churn",
				spec: randomNet(21, 24, 14, 16),
				float: true,
				snap: 0,
				steps: 4000
			},
			// the opt-in `SharedArrayBuffer` backing, with every layer on. The arms of
			// `runMemoryArms` below carry the rest of that backing. They are the store
			// base, the fixed buffer, and the two halves of the cap.
			{
				label: "SharedArrayBuffer, with churn",
				spec: randomNet(22, 24, 14, 16),
				sab: true,
				snap: 16,
				steps: 4000
			},
			// the recorder for the host commands. It keeps the complete stream, so this
			// arm is small, and `commandLogCheck` reads it at the end.
			{ label: "host command log", spec: erasureTree(6), record: true, snap: 8 }
		]) {
			const spec = assertNetSpecValid(arm.spec);
			const steps = Math.min(OPT.steps, arm.steps ?? OPT.steps);
			const stats = runCase(lib, spec, {
				seed: OPT.seed,
				label: `${arm.label} ${spec.name}`,
				maxBatch: OPT.batch,
				verifyEvery: 2,
				snapEvery: arm.snap,
				steps,
				prov: OPT.prov,
				compactEvery: OPT.compactEvery,
				float: arm.float === true,
				sab: arm.sab === true,
				record: arm.record === true,
				storeBase: arm.storeBase ?? 0,
				maxBytes: arm.maxBytes ?? 0,
				fpEvery: OPT.fp,
				phaseEvery: OPT.phase
			});
			report(arm.label, stats);
			armStats.set(arm.label, stats);
			pressure.absorb(spec, stats);
			cases++;
		}

		// The store base and the two halves of the cap. Each arm runs the complete
		// oracle, and the comparison between them is what makes the base a check.
		const mem = runMemoryArms(lib, pressure);
		cases += mem.cases;
		// One system of the net across a pool. The pooled world gets the complete
		// oracle, and the pair of runs must agree on every number.
		const par = await runWorkersArm(lib, pressure);
		cases += par.cases;

		// 6. The probes for the API surface. Each one is small, and each one has an
		//    exact expected value. They cover the parts of the API that a net which
		//    must keep its meaning cannot reach: a cycle in a relation, a named error,
		//    a replay into a second world, the batch paths, and the combinators for a
		//    run condition. `surface.mjs` gives the complete reason.
		console.log(`\n[6] the API surface, the parts that the simulation cannot reach`);
		const surface = runSurface(lib, { quiet: OPT.quiet });
		console.log(`  ${surface.probes} probes, ${surface.checks} checks`);
		cases += surface.probes;

		pressure.assert("suite", { dev: !OPT.prod }).report();
	}

	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	console.log(`\nok, ${cases} cases, ${(ms / 1000).toFixed(1)}s`);
} catch (err) {
	if (err instanceof Divergence) {
		console.error(`\nDIVERGENCE\n  ${err.message}\n`);
		console.error(`reproduce with a per-rewrite batch for exact attribution:`);
		console.error(
			`  node bench/net-oracle/run.mjs --net=${OPT.net ?? "<case>"} --seed=${OPT.seed} --batch=1 --verify=1`
		);
		process.exit(1);
	}
	throw err;
}
