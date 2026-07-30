/**
 * A deterministic oracle for a simulation. It reduces an interaction net in
 * lockstep against a reference reducer, and it checks the result at each tick. This
 * file is the command line. The oracles are in `driver.mjs`.
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
 *      links. The relation graph and the `u8` slot columns are two independent
 *      records of one fact, and they must agree. This layer needs no reference.
 *   2. LOCKSTEP (the ECS against the reference) — at each tick, and through a
 *      bijection of the ids, the driver compares the type of each agent, the links,
 *      `Fresh`, `Age`, the census and the number of loops. It finds the first tick
 *      that differs. With `--batch=1`, it finds the first rewrite that differs.
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
 *      count from `relations.compact()`, and the helpers that do a traversal.
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
 *
 * `mutants.mjs` shows that this tool is necessary. It puts fourteen known ECS bugs
 * into a built bundle, and it requires the oracle to find each one. It also reports
 * how many of them an ORACLE layer found, and how many an engine error found first.
 *
 * Usage:
 *   node bench/net-oracle/run.mjs                      # curated suite (~15s)
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
 *   --lib=PATH     use an already-built bundle (how `mutants.mjs` injects bugs)
 *   --prod         build with __DEV__=false (default is dev: guards on)
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
	if (OPT.net !== null) {
		// ── single explicit case ────────────────────────────────────────────
		const spec = netFromArg(OPT.net, OPT.seed);
		console.log(`net-oracle: ${spec.name}  seed=${OPT.seed} batch=${OPT.batch} ` +
			`steps=${OPT.steps} verify=${OPT.verify} snap=${OPT.snap} ${OPT.prod ? "prod" : "dev"}`);
		const stats = lockstep(lib, spec, {
			seed: OPT.seed,
			batch: OPT.batch,
			steps: OPT.steps,
			verifyEvery: OPT.verify,
			snapEvery: OPT.snap,
			label: spec.name,
			prov: OPT.prov,
			compactEvery: OPT.compactEvery,
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
		pressure.assert().report();
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
