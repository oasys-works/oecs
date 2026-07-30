/**
 * A test of the net oracle with mutants.
 *
 * An oracle that never fails shows nothing. This program puts known ECS bugs into
 * the code, and it requires the oracle to find each one. Therefore a successful run
 * of the oracle gives information, and it is not only the absence of an error.
 *
 * The program puts each bug into the *built bundle*, and never into the source tree.
 * Each mutant is a patch of text against a copy of `bench/.out/…`, and the program
 * gives that copy to `run.mjs --lib=<mutant>`. The program changes no file in `src/`.
 * Therefore it is safe to run it when the working tree has changes.
 *
 * Each mutant changes a mechanism that the oracle must use:
 *   - the placement of a row in an archetype: swap-remove, the back pointer to the
 *     entity row, and the cached capacity of the row plane. `archetype.ts` is making
 *     changes to that plane now.
 *   - the maintenance of the reverse index of a relation, during a replacement in an
 *     exclusive relation.
 *   - the dispatch of a structural observer.
 *
 * WHAT "CAUGHT" MEANS. A mutant is caught when the oracle run gives a nonzero exit,
 * and that alone does not say WHICH mechanism found the bug. This program therefore
 * puts each catch into one of two classes, and it reports both counts:
 *
 *   - BY THE ORACLE — the run reported a `DIVERGENCE`, or an assertion of the
 *     harness itself. These are the layers that `README.md` describes.
 *   - BY THE ENGINE — the engine threw its own error before an oracle layer looked
 *     at the state. That is still a detection, and it is still useful. But it is not
 *     evidence about the oracle, and some of these errors exist only in a
 *     development build.
 *
 * THE BUILD. The battery uses a DEVELOPMENT build by default, because the guards of
 * that build give more mechanisms a chance to fire. But the released package is a
 * production build, so `--prod` runs the same battery against `__DEV__ = false`.
 * Both builds catch every mutant in the list, and two of them change their
 * mechanism between the builds:
 *   - `rowplane-stale-eids` — a DEV post-condition in `_growRows` in a development
 *     build, and the self-consistency layer of the oracle in a production build.
 *   - `rowplane-grow-guard-wrong-term` — the DEV access checker in a development
 *     build, and an unrelated engine error in a production build. `README.md`
 *     attributes this mutant to the access checker, which the released package does
 *     not contain.
 *
 *   node bench/net-oracle/mutants.mjs           # development build (more guards)
 *   node bench/net-oracle/mutants.mjs --prod    # the build that the package ships
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { buildLib } from "../build.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const outDir = path.join(here, "../.out/mutants");
fs.mkdirSync(outDir, { recursive: true });

const PROD = process.argv.includes("--prod");
const base = path.join(outDir, PROD ? "base.prod.mjs" : "base.mjs");
await buildLib(base, { dev: !PROD, from: root });
const baseSrc = fs.readFileSync(base, "utf8");

// ── the mutants ─────────────────────────────────────────────────────────────
const MUTANTS = [
	{
		id: "rowplane-backpointer",
		what: "swap-remove forgets to fix the moved entity's row backpointer",
		find: `        entityRow[getEntityIndex(eids[row])] = row;
      }
      this.length = last;
      this.enabledCount = last;`,
		to: `      }
      this.length = last;
      this.enabledCount = last;`,
	},
	{
		id: "rowplane-no-column-copy",
		what: "swap-remove moves the entity id but not the column data",
		find: `        for (let i = 0; i < bufs.length; i++) bufs[i][row] = bufs[i][last];
        entityRow[getEntityIndex(eids[row])] = row;
      }
      this.length = last;`,
		to: `        entityRow[getEntityIndex(eids[row])] = row;
      }
      this.length = last;`,
	},
	{
		id: "rowplane-overreported-cap",
		what: "the row plane's cached capacity is one row larger than reality",
		find: `    this._rowCap = eidCap < colCap ? eidCap : colCap;`,
		to: `    this._rowCap = (eidCap < colCap ? eidCap : colCap) + 1;`,
	},
	{
		id: "rowplane-stale-eids",
		what: "the row plane keeps a stale entity-id view after a grow",
		find: `    this._eids = this._entityIds.buf;`,
		to: `    if (this._eids === void 0) this._eids = this._entityIds.buf;`,
	},
	{
		// `_growRows` uses the COLUMN capacity term alone to decide if a column needs
		// to become larger. Therefore a shortage in the entity-id array alone does not
		// make the complete column store do a new allocation and a republish for no
		// change of size. A decision on the entity-id term is the wrong-term bug that
		// this guard permits: the code made the entity-id array as large as `need` two
		// lines before. Therefore the test always passes, and the code skips a true
		// shortage of a column with no message.
		//
		// (The other half of that reserve — re-syncing the row plane when the grow
		// THROWS — has no mutant here: the oracle runs the heap profile, where
		// `growHandler` is null and nothing in the grow path throws. It is pinned by
		// unit tests instead.)
		id: "rowplane-grow-guard-wrong-term",
		what: "the reserve tests the entity-id capacity, so a needed column grow never happens",
		find: `    if (need <= this._colCap) {`,
		to: `    if (need <= this._entityIds.buf.length) {`,
	},
	{
		id: "relation-reverse-leak",
		what: "exclusive-relation replace leaves the old reverse-index entry behind",
		find: `  unlinkReverse(tgt, src) {
    const set = this._reverse.get(tgt);
    if (set === void 0) return;`,
		to: `  unlinkReverse(tgt, src) {
    const set = this._reverse.get(tgt);
    if (set !== void 0) return;`,
	},
	{
		id: "observer-drop-remove",
		what: "structural dispatch never fires onRemove",
		find: `      if (obs.onRemove !== void 0) {
        const eids = this._remBuckets.get(obs.cid);
        if (eids !== void 0 && eids.length > 0)
          this._fireEach(obs, obs.onRemove, eids, "remove");
      }`,
		to: `      if (false) {
        const eids = this._remBuckets.get(obs.cid);
        if (eids !== void 0 && eids.length > 0)
          this._fireEach(obs, obs.onRemove, eids, "remove");
      }`,
	},
	{
		id: "cascade-not-transitive",
		what: 'the "delete" policy destroys the target but not its sources',
		find: `      if (rs.onDeleteTarget === "delete") {
        for (let i = 0; i < sources.length; i++) cascade.push(sources[i]);
        continue;
      }`,
		to: `      if (rs.onDeleteTarget === "delete") {
        continue;
      }`,
	},
	{
		id: "clear-policy-noop",
		what: 'the "clear" policy leaves the relation on every source when a target dies',
		find: `      for (let i = 0; i < sources.length; i++) rs.unlink(sources[i], targetId);`,
		to: `      if (sources.length < 0) rs.unlink(sources[0], targetId);`,
	},
	{
		id: "multi-forward-set-keeps-dead",
		what: "a multi relation's forward target set keeps a target that was unlinked",
		find: `    if (!set.has(tgt)) return;
    set.delete(tgt);
    this.unlinkReverse(tgt, src);`,
		to: `    if (!set.has(tgt)) return;
    this.unlinkReverse(tgt, src);`,
	},
	{
		id: "multi-targetsof-unsorted",
		what: "multi targetsOf drops its deterministic ascending sort",
		find: `    out.sort((a, b) => a - b);
    return out;
  }
  has(index) {`,
		to: `    return out;
  }
  has(index) {`,
	},
	{
		id: "compact-undercounts",
		what: "compact() reclaims the dead keys but reports zero",
		find: `        this._reverse.delete(tgt);
        dropped++;`,
		to: `        this._reverse.delete(tgt);`,
	},
	{
		id: "compact-drops-live-keys",
		what: "compact() prunes reverse entries for LIVE targets too",
		find: `      if (!isAlive(unsafeCast(tgt))) {
        this._reverse.delete(tgt);
        dropped++;
      }`,
		to: `      {
        this._reverse.delete(tgt);
        dropped++;
      }`,
	},
	{
		id: "observer-double-add",
		what: "structural dispatch fires onAdd twice for the same batch",
		find: `      if (obs.onAdd !== void 0) {
        const eids = this._addBuckets.get(obs.cid);
        if (eids !== void 0 && eids.length > 0) this._fireEach(obs, obs.onAdd, eids, "add");
      }`,
		to: `      if (obs.onAdd !== void 0) {
        const eids = this._addBuckets.get(obs.cid);
        if (eids !== void 0 && eids.length > 0) this._fireEach(obs, obs.onAdd, eids, "add");
        if (eids !== void 0 && eids.length > 0) this._fireEach(obs, obs.onAdd, eids, "add");
      }`,
	},
];

// ── the battery each mutant is run against ──────────────────────────────────
// Small and fast: a mutant that survives all of these is a real blind spot, and
// the point is to learn that quickly rather than to soak.
// `erase:14` and the growth case are not redundant with the small ones: the
// row-plane grow path (a stale buffer view, an over-reported capacity) only
// misbehaves once an archetype outgrows the capacity it was prewarmed with, and
// the small cases never get there. Both of those mutants escaped the battery
// until a case that actually grows large archetypes was added.
const BATTERY = [
	{ name: "erase:8", args: ["--net=erase:8", "--batch=4", "--verify=1", "--snap=8"] },
	{ name: "dup:6", args: ["--net=dup:6", "--batch=4", "--verify=1", "--snap=8"] },
	{
		name: "random:3",
		args: ["--net=random:3,30,18,20", "--steps=4000", "--batch=8", "--verify=2", "--snap=32"],
	},
	{ name: "erase:14", args: ["--net=erase:14", "--batch=32", "--verify=8", "--snap=0"] },
	{
		name: "grow:2",
		args: ["--net=random:2,24,24,12", "--steps=20000", "--batch=32", "--verify=16", "--snap=0"],
	},
];

function runOracle(libPath, args) {
	const r = spawnSync(
		process.execPath,
		[path.join(here, "run.mjs"), `--lib=${libPath}`, "--quiet", ...args],
		{ encoding: "utf8", cwd: root, timeout: 180000 }
	);
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	return { ok: r.status === 0, out, status: r.status };
}

/**
 * What found the mutant, and by which mechanism.
 *
 * The exit code says only "something failed". This separates the layers that
 * `README.md` bills as the oracle from an error that the engine threw on its own.
 * A `DIVERGENCE` report is an oracle layer. So is any `fail()` of the harness: those
 * carry a `[ecs]`, `[ref]` or `[prov]` tag and the case and tick. Anything else is
 * the engine, and an engine error is a detection but not evidence about the oracle.
 */
function reason(out) {
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	const i = lines.findIndex((l) => l === "DIVERGENCE");
	if (i >= 0 && lines[i + 1]) return { by: "oracle", why: lines[i + 1] };
	// `fail()` throws a plain `Error` whose message names the case, the tick and the
	// layer in brackets. The harness's own observer bookkeeping throws with an
	// `observer:` prefix. Both are the oracle finding the fault.
	const harness = lines.find((l) => /^Error: .*\[(ecs|ref|prov)[^\]]*\]:/.test(l) || /^Error: observer:/.test(l));
	if (harness !== undefined) return { by: "oracle", why: harness };
	const err = lines.find((l) => /Error:|error:/.test(l));
	return { by: "engine", why: err ?? lines[lines.length - 1] ?? "(no output)" };
}

// ── sanity: the unmutated bundle must pass the whole battery ────────────────
console.log(`mutation test — ${PROD ? "PRODUCTION" : "development"} build — baseline first\n`);
for (const c of BATTERY) {
	const r = runOracle(base, c.args);
	if (!r.ok) {
		console.error(`BASELINE FAILED on ${c.name} — fix the harness before trusting mutants`);
		console.error(r.out);
		process.exit(1);
	}
	console.log(`  baseline ${c.name.padEnd(12)} pass`);
}

// ── run every mutant ────────────────────────────────────────────────────────
console.log(`\n${MUTANTS.length} mutants x ${BATTERY.length} cases\n`);
const escaped = [];
const byMechanism = { oracle: [], engine: [] };
for (const m of MUTANTS) {
	const hits = baseSrc.split(m.find).length - 1;
	if (hits !== 1) {
		console.error(`  ${m.id}: pattern matched ${hits}x in the bundle (want exactly 1) — mutant is stale`);
		escaped.push({ ...m, why: `pattern matched ${hits}x` });
		continue;
	}
	const file = path.join(outDir, `${m.id}.mjs`);
	fs.writeFileSync(file, baseSrc.replace(m.find, m.to));

	let caughtBy = null;
	for (const c of BATTERY) {
		const r = runOracle(file, c.args);
		if (!r.ok) {
			caughtBy = { case: c.name, ...reason(r.out) };
			break;
		}
	}
	if (caughtBy === null) {
		console.log(`  ESCAPED  ${m.id.padEnd(28)} ${m.what}`);
		escaped.push({ ...m, why: "survived every case" });
	} else {
		byMechanism[caughtBy.by].push(m.id);
		console.log(
			`  ${caughtBy.by === "oracle" ? "ORACLE " : "engine "} ${m.id.padEnd(28)} by ${caughtBy.case}`
		);
		console.log(`           ${" ".repeat(28)} ${caughtBy.why.slice(0, 140)}`);
	}
}

console.log("");
// Both counts, always. "14 of 14 caught" is true and it is not the whole answer:
// the mutants that only the engine found say nothing about the layers of the
// oracle, and one of them needs a guard that the released package removes.
console.log(
	`${byMechanism.oracle.length}/${MUTANTS.length} caught by an ORACLE layer · ` +
		`${byMechanism.engine.length}/${MUTANTS.length} caught by an ENGINE error · ` +
		`${escaped.length} escaped   (${PROD ? "production" : "development"} build)`
);
if (byMechanism.engine.length > 0) {
	console.log(`  engine-caught: ${byMechanism.engine.join(", ")}`);
	console.log(`  These prove that the bug is fatal. They do not prove that the oracle sees it.`);
}
if (escaped.length > 0) {
	console.error(`\n${escaped.length}/${MUTANTS.length} mutants ESCAPED — the oracle has blind spots:`);
	for (const e of escaped) console.error(`  ${e.id}: ${e.what} (${e.why})`);
	process.exit(1);
}
console.log(`ok — all ${MUTANTS.length} mutants caught`);
