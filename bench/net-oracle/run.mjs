/**
 * A deterministic oracle for a simulation. It reduces an interaction net in lockstep
 * against a reference reducer, and it compares the two nets. This file is the command
 * line, and the oracles are in `driver.mjs`.
 *
 * Two groups of layers run at a different rate. The cheap layers run at EACH tick:
 * the totals, the channel of the events, and the change detection. The full
 * comparison of each live agent runs at each VERIFICATION tick, which `--verify=N`
 * selects. Use `--verify=1` to compare at each tick.
 *
 * THE REASON FOR AN INTERACTION NET. This workload has a purpose: each rewrite is
 * difficult for an archetype ECS. Each rewrite despawns two entities, and it spawns
 * a maximum of four. It changes the target of a maximum of eight exclusive
 * relations. It writes approximately 12 `u8` columns, and it moves several rows
 * between archetypes. It does all of this through deferred commands, and the
 * observers run at each flush. Therefore each tick does work.
 *
 * THE REASON THAT A CHECK IS POSSIBLE. The interaction combinators of Lafont are
 * strongly confluent. They have linearity, they have binary interaction, and their
 * rules have no ambiguity. Together, these three properties give one result: each
 * sequence of reductions reaches the same normal form, and it uses the same number
 * of rewrites. Therefore one correct step by chance cannot give a correct result.
 * The archetype layout and the sequence of the flush can give the ECS any sequence
 * of reductions, but the final net and the total number of rewrites must agree.
 *
 * The oracles, from the weakest to the strongest:
 *
 *   1. SELF-CONSISTENCY (the ECS alone) — each port connects to a live port that
 *      connects back. The reverse index of the relations agrees with the forward
 *      links, `pairsOf` gives the same set of pairs, a DEAD entity holds no key in
 *      that index, and `sourcesOfAny` agrees with the reads of one relation at a
 *      time. The relation graph and the `u8` slot columns are two independent
 *      records of one fact, and they must agree. This layer needs no reference.
 *   2. LOCKSTEP (the ECS against the reference) — at each VERIFICATION tick, and
 *      through a bijection of the ids, the driver compares the type of each agent,
 *      the links, `Fresh`, `Age`, `Touch.seq`, `Quar.count`, `Tainted`, the census
 *      and the number of loops. It finds the first tick that differs. With
 *      `--verify=1` each tick is a verification tick, and with `--batch=1` the driver
 *      finds the first rewrite that differs.
 *   3. CANONICAL FORM (the ECS against the reference, with no bijection) — the
 *      driver gives new numbers to both nets by a breadth-first search from ROOT,
 *      and it then compares them as strings. Therefore an error in the map of the
 *      ids in the harness cannot hide a true difference.
 *   4. THE QUEUES OF THE OBSERVERS — the `onAdd` and `onRemove` callbacks alone
 *      build the redex set and the record set. The driver compares each set against
 *      a new scan of the ECS, and against the reference. A record dies only
 *      *indirectly*. Therefore the second set is the assertion that a cascade calls
 *      `onRemove` for each entity that it destroys.
 *   5. THE PROVENANCE LAYER — a second population of entities (refer to `prov.mjs`)
 *      uses the part of the relation API that the exclusive ports of the net do not
 *      use: sets of targets on a multi relation, the exact set of entities that the
 *      `"delete"` cascade destroys, `"orphan"` with an exactly predicted reclaim
 *      count from `relations.compact()`, and the helpers that do a traversal. A chain
 *      of records that is hundreds of levels deep covers `ancestorsOf` past depth 1,
 *      truncation by `maxDepth`, and the order of a parent before its children.
 *   6. A CLOSED FORM — you can calculate the number of rewrites of the generator for
 *      an erasure tree by hand (`2^(depth+1)`). Therefore the two implementations
 *      can be incorrect together, and the run still fails. This is the only layer
 *      that is external to BOTH implementations. A snapshot and a restore must also
 *      make no change to `stateHash`.
 *   7. CONFLUENCE — the same net under several reduction orders must give an equal
 *      number of rewrites and an equal normal form. This layer sits beside the
 *      closed form, and not above it: each order already compares its ECS result
 *      with its own reference in layer 2, so a fault in the ECS fails there first.
 *      What confluence adds is a check of the SPEC against itself, which finds a
 *      fault that `spec.mjs` and `ref.mjs` hold together. `driver.mjs::confluence`
 *      gives the complete reason.
 *   8. CHANGE DETECTION — the reference counts `Touch.seq` in its own `setLink`, so
 *      the set of agents that a tick wrote comes from the model. An `onSet` observer
 *      with the granularity of an entity must report exactly that set. A second
 *      observer with the granularity of an archetype, and a `changed()` query, must
 *      report each archetype that holds one of those agents. `changed(Age)` is exact
 *      in both directions. Refer to `driver.mjs::changeCheck`.
 *   9. THE IDLE TAIL — after a net reaches its normal form, the driver runs a few
 *      ticks with no rewrite. Those ticks write no column, so the `onSet` observers
 *      and `changed(Touch)` must go QUIET, and `changed(Age)` must stay busy. This is
 *      the only layer that bounds the change detection from ABOVE.
 *  10. THE PARTITION OF THE ROWS — the quarantine disables and enables agents through
 *      the HOST WRITE SEAM, so `onDisable` and `onEnable` fire. A default query must
 *      not show a disabled row, and the exact comparison of `Age.ticks` in layer 2 is
 *      the proof of it.
 *  11. THE EVENTS, THE RESOURCES AND THE SPARSE COMPONENTS — one event for each
 *      rewrite, drained and compared with the plan; a resource that gates a system
 *      through `runIfResourceEq` on a set of ticks that the driver picks; and a sparse
 *      component whose membership rule the reference also holds.
 *  12. THE VERBS OF A QUERY — `withRelation` and `withoutRelation` against the arity
 *      of the ports, `optional` against the agents that have no `Age` yet,
 *      `singleEntity` against the one ROOT, `firstEntity` against the idle tail, and
 *      `forEachUntil` against the count of the archetypes that `forEach` gives. Each
 *      one reads a fact that the reference already holds.
 *  13. `ctx.markChanged` — a mark records a row for the per-entity `onSet` observer,
 *      and it makes no archetype changed. The idle tail is where that difference is
 *      sharp: a mark is the only reason for a report there.
 *  14. `ctx.removeRelation` AND `ctx.hasRelation` — one system removes one `Produced`
 *      pair on each verification tick, and the model applies the same removal. A port
 *      of the net is exclusive, so a rewrite replaces its target instead.
 *
 * `surface.mjs` holds 15 more probes, for the parts of the API that a net which must
 * keep its meaning cannot reach: a cycle in a relation, a named error, a replay into a
 * second world, the batch paths, the combinators for a run condition, the explicit
 * removal of a relation, the cursors, the immediate toggle from the host, the refusal
 * of a damaged snapshot, and the immediate component writes of the host.
 *
 * `mutants.mjs` shows that this tool is necessary. It puts 35 known ECS bugs into a
 * built bundle, and it requires the oracle to find each one. It also reports how many
 * of them an ORACLE layer found, and how many an engine error found first.
 *
 * Usage:
 *   node bench/net-oracle/run.mjs                      # the curated suite, a short run
 *   node bench/net-oracle/run.mjs --soak               # long runs, millions of rewrites
 *   node bench/net-oracle/run.mjs --net=erase:14 --batch=64
 *   node bench/net-oracle/run.mjs --net=random:1,30,18,20 --steps=2000000 --verify=200
 *   node bench/net-oracle/run.mjs --net=dup:6 --batch=1   # per-rewrite attribution
 *
 * Options:
 *   --net=SPEC     erase:D | dup:D | random:seed,nCon,nDup,nEra
 *   --seed=N       reduction-order seed (default 1)
 *   --batch=N      rewrites per tick (default 32; 1 for exact attribution)
 *   --steps=N      max rewrites (default 200000)
 *   --verify=N     deep verify every N ticks (default 1)
 *   --snap=N       snapshot round-trip every N ticks (default 64; 0 to disable)
 *   --orders=N     reduction orders to cross-check for confluence (default 3)
 *   --soak         long-duration preset instead of the suite
 *   --prov=0       omit the provenance layer (cascade / multi / orphan coverage)
 *   --epoch=N      ticks per epoch (default 8)
 *   --retain=N     epochs retained before pruning cascades (default 4)
 *   --compact=N    relations.compact() check every N ticks (default 16; 0 to disable)
 *   --float        a world with NO determinism and an `f64` mirror column. That is the
 *                  only arm that can hold a float column, and it gives up `stateHash`,
 *                  `capture` and `restore`, which all need determinism.
 *   --sab          put the column store on a `SharedArrayBuffer`. That is the opt-in
 *                  profile that a worker or a WASM compute backend needs.
 *   --record       log each host command, and check the log's round trip through JSON.
 *   --lib=PATH     use an already-built bundle (how `mutants.mjs` injects bugs)
 *   --prod         build with __DEV__=false (default is dev: guards on)
 *   --surface      run the API-surface probes alone, and no simulation
 *   --quiet        less per-case detail
 *
 * THE DEFAULT BUILD IS A DEVELOPMENT BUILD, and the released package is not. A
 * development build keeps the internal guards, and thus it gives more mechanisms a
 * chance to find a fault — which is the correct default for a correctness tool. But
 * the shipped path is the production path, so run `--prod` as well before you trust
 * a result about the released package. `bench/README.md` records which tool uses
 * which build.
 */
import path from "node:path";
import url from "node:url";
import { buildLib } from "../build.mjs";
import { netFromArg, assertNetSpecValid, dupTree, erasureTree, randomNet } from "./nets.mjs";
import { Divergence, Pressure, confluence, fail, lockstep, report, runCase } from "./driver.mjs";
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
	record: argv.includes("--record"),
};
// Soak cases carry their own step budgets; an explicit `--steps` overrides them
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
const lib = await import(url.pathToFileURL(outfile).href);

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
	} else if (OPT.net !== null) {
		// ── single explicit case ────────────────────────────────────────────
		const spec = netFromArg(OPT.net, OPT.seed);
		console.log(`net-oracle: ${spec.name}  seed=${OPT.seed} batch=${OPT.batch} ` +
			`steps=${OPT.steps} verify=${OPT.verify} snap=${OPT.snap} ${OPT.prod ? "prod" : "dev"}` +
			`${OPT.float ? " f64/no-determinism" : ""}${OPT.sab ? " sab" : ""}${OPT.record ? " record" : ""}`);
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
			console.log(`  closed form OK: ${spec.expectRewrites} rewrites, ${spec.expectAgents} agents, ${spec.expectLoops} loops`);
		}
		cases = 1;
	} else if (OPT.soak) {
		// ── soak ────────────────────────────────────────────────────────────
		// Long runs at ~1e5 rewrites/s. Verification is sparse here on purpose: the
		// suite already checks every tick on small nets, so what this adds is
		// DURATION — millions of structural transitions, entity-slot recycling well
		// past the live count, and archetypes that grow far beyond their prewarmed
		// capacity. The two grow-path mutants in `mutants.mjs` are exactly the class
		// of bug only this reaches.
		console.log(`net-oracle soak (${OPT.prod ? "prod" : "dev"} build)`);
		const pressure = new Pressure();
		// Verification is O(live agents) — three `sourcesOf` calls per agent plus two
		// canonical traversals — so cadence has to be set against each case's live
		// count, not globally. The churn cases hold a few hundred to a few thousand
		// agents and can afford a tight cadence; the growth cases run to hundreds of
		// thousands, where the same cadence would spend all its time verifying and
		// never reach the scale that is the entire point of running them.
		const SOAK = [
			// bounded live set, endless churn — cumulative creates >> peak concurrency
			{ net: "random:6,30,18,20", steps: 5_000_000, batch: 32, verify: 400, snap: 2000, label: "churn-small" },
			{ net: "random:1,30,18,20", steps: 3_000_000, batch: 32, verify: 400, snap: 2000, label: "churn-mid" },
			// unbounded growth — large archetypes, repeated column grows
			{ net: "random:2,24,24,12", steps: 400_000, batch: 512, verify: 50, snap: 0, label: "growth" },
			{ net: "random:12,40,30,20", steps: 400_000, batch: 512, verify: 50, snap: 0, label: "growth-wide" },
			// closed-form answer at scale
			{ net: "erase:18", steps: 1_000_000, batch: 256, verify: 32, snap: 400, label: "erase-large" },
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
		// A soak measures DURATION, and it builds none of the arms of the suite.
		// Therefore the floors for those arms do not apply to it. Refer to
		// `Pressure.assert`.
		pressure.assert("soak").report();
	} else {
		// ── curated suite ───────────────────────────────────────────────────
		console.log(`net-oracle suite (${OPT.prod ? "prod" : "dev"} build)`);
		const pressure = new Pressure();

		// 1. Closed-form erasure trees — the answer comes from neither implementation.
		console.log(`\n[1] erasure trees — closed-form rewrite count 2^(depth+1)`);
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

		// 2. Duplication — the growth/allocation-pressure axis. Commutation is the
		//    only rule that grows the net, so this is where spawn pressure lives.
		console.log(`\n[2] duplication trees — allocation pressure (net grows, then collapses)`);
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
			});
			if (stats.peakAgents <= spec.types.length) {
				fail(spec.name, `peak ${stats.peakAgents} agents never exceeded the initial ${spec.types.length}`);
			}
			report(spec.name, stats, `  grew ${(stats.peakAgents / spec.types.length).toFixed(1)}x`);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 3. Random nets — open-ended churn with no reason to terminate. These are
		//    where the long-running pressure comes from, and where CON~CON / DUP~DUP
		//    (which the structured generators never produce) actually fire.
		console.log(`\n[3] random nets — unstructured churn`);
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
			});
			report(`random#${s}`, stats);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 4. Confluence — the order-invariance oracle.
		console.log(`\n[4] confluence — same net, ${OPT.orders} reduction orders, must agree exactly`);
		for (const spec of [
			assertNetSpecValid(erasureTree(7)),
			assertNetSpecValid(dupTree(4)),
			assertNetSpecValid(dupTree(6)),
			assertNetSpecValid(randomNet(11, 20, 10, 14)),
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
			});
			console.log(
				`  ${spec.name.padEnd(30)} ${
					r.checked
						? `${r.orders} orders agree at ${r.rewrites} rewrites`
						: `skipped (${r.reason})`
				}`
			);
			cases++;
		}

		// 5. The arms for the profile. Each one runs the SAME oracle over a different
		//    world, so the layers above cover the profile and not one call of it.
		console.log(`\n[5] profiles — the f64 arm, the SharedArrayBuffer arm, and the command log`);
		for (const arm of [
			// A world with no determinism, and an `f64` mirror column. A deterministic
			// world rejects a float column, so this is the only arm that covers one. It
			// gives up `stateHash`, `capture` and `restore`, which all need determinism,
			// so `snapEvery` is 0 here.
			{ label: "f64 / no determinism", spec: dupTree(6), float: true, snap: 0 },
			{ label: "f64 / churn", spec: randomNet(21, 24, 14, 16), float: true, snap: 0, steps: 4000 },
			// The opt-in `SharedArrayBuffer` backing, with every layer on.
			{ label: "SharedArrayBuffer", spec: dupTree(6), sab: true, snap: 8 },
			{ label: "SharedArrayBuffer / churn", spec: randomNet(22, 24, 14, 16), sab: true, snap: 16, steps: 4000 },
			// The recorder for the host commands. It keeps the complete stream, so this
			// arm is small, and `commandLogCheck` reads it at the end.
			{ label: "host command log", spec: erasureTree(6), record: true, snap: 8 },
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
			});
			report(arm.label, stats);
			pressure.absorb(spec, stats);
			cases++;
		}

		// 6. The probes for the API surface. Each one is small, and each one has an
		//    exact expected value. They cover the parts of the API that a net which
		//    must keep its meaning cannot reach: a cycle in a relation, a named error,
		//    a replay into a second world, the batch paths, and the combinators for a
		//    run condition. `surface.mjs` gives the complete reason.
		console.log(`\n[6] the API surface — the parts that the simulation cannot reach`);
		const surface = runSurface(lib, { quiet: OPT.quiet });
		console.log(`  ${surface.probes} probes, ${surface.checks} checks`);
		cases += surface.probes;

		pressure.assert().report();
	}

	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	console.log(`\nok — ${cases} cases, ${(ms / 1000).toFixed(1)}s`);
} catch (err) {
	if (err instanceof Divergence) {
		console.error(`\nDIVERGENCE\n  ${err.message}\n`);
		console.error(`reproduce with a per-rewrite batch for exact attribution:`);
		console.error(`  node bench/net-oracle/run.mjs --net=${OPT.net ?? "<case>"} --seed=${OPT.seed} --batch=1 --verify=1`);
		process.exit(1);
	}
	throw err;
}
