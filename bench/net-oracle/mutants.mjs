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
 * THE BUILD. The battery uses a DEVELOPMENT build by default. The guards of that
 * build give more mechanisms a chance to fire. But the released package is a
 * production build, so `--prod` runs the same battery against `__DEV__ = false`.
 *
 * Both builds catch each mutant in the list, and both give the SAME mechanism for
 * each one. A measurement of the two builds gives these numbers: 32 mutants that an
 * oracle layer catches, 3 that an engine error catches, and 0 that escape. The three
 * that an engine error catches are all on the path that makes a row plane larger.
 * `README.md` holds the table.
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

	// ── the change detection ────────────────────────────────────────────────
	{
		id: "onset-entity-never-fires",
		what: "the per-entity onSet drain returns before it calls anything",
		find: `    if (eids.length === 0) return;
    const def = obs.def;
    const fn = obs.onSetEntity;`,
		to: `    if (eids.length >= 0) return;
    const def = obs.def;
    const fn = obs.onSetEntity;`,
	},
	{
		// The per-entity onSet must SKIP a disabled entity, so that it matches the
		// grain of the archetype path, whose row sweep stops at the enabled rows. This
		// mutant drops that filter. Nothing outside `changeCheck` compares the set of
		// the reported entities with an exact expected set, so nothing else sees it.
		id: "onset-entity-reports-disabled",
		what: "the per-entity onSet reports a DISABLED entity, which a default query hides",
		find: `        if (this.store.isAlive(eid) && this.store.hasComponent(eid, def) && !this.store.isDisabled(eid)) {`,
		to: `        if (this.store.isAlive(eid) && this.store.hasComponent(eid, def)) {`,
	},
	{
		// `cols.mut(def)` must set the tick for the change AT THE MOMENT OF THE CALL,
		// and it must do that even when no write follows. `ageTick` in the harness uses
		// `cols.mut`, which resolves to `columnGroupMut` below. Therefore this mutant
		// makes `changed(Age)` and the `onSet` observer on `Age` report nothing at all.
		//
		// The FIRST version of this mutant removed the same line from `ctx.ref`, and it
		// ESCAPED: the harness writes `Age` through `eachChunk` alone, so `ctx.ref` was
		// a path that no case reached. The escape was correct, and the lesson is the one
		// that `README.md` records about a mutant that goes stale — a mutant must name
		// the code that the harness runs.
		id: "changed-tick-not-set-by-mut",
		what: "the mutable column group does not set the change tick",
		find: `    this._changedTick[cid] = tick;
    return this._mutGroupCache[cid];`,
		to: `    return this._mutGroupCache[cid];`,
	},
	{
		// The opposite fault: the layer reports EVERY archetype at EVERY tick. Each
		// check that asks "did the ECS report the change" passes. The IDLE TAIL is the
		// only thing that asks the other question, so this mutant is the proof that the
		// tail earns its place in the harness.
		id: "changed-arch-reports-everything",
		what: "the archetype-granular onSet ignores its baseline and reports every archetype",
		find: `      if (arch.length > 0 && arch._changedTick[cid] >= baseline) cb(arch);`,
		to: `      if (arch.length > 0) cb(arch);`,
	},

	// ── the partition of the enabled and the disabled rows ──────────────────
	{
		id: "disable-row-keeps-enabled-count",
		what: "disableRow moves the row but does not shrink the enabled region",
		find: `      entityRow[getEntityIndex(eids[lastEnabled])] = lastEnabled;
    }
    this.enabledCount = lastEnabled;
  }`,
		to: `      entityRow[getEntityIndex(eids[lastEnabled])] = lastEnabled;
    }
  }`,
	},
	{
		id: "toggle-fans-the-wrong-way",
		what: "a net toggle fans onEnable where it must fan onDisable, and the reverse",
		find: `    arch.mask.forEach(nowDisabled ? this._collectDisableBit : this._collectEnableBit);`,
		to: `    arch.mask.forEach(nowDisabled ? this._collectEnableBit : this._collectDisableBit);`,
	},

	// ── a dead key in the reverse index ─────────────────────────────────────
	{
		// `README.md` named this gap before this pass, and it also named the shape of
		// the mutant that would show whether the gap was reachable. Under `"clear"` the
		// death of a target must delete the key of that target from the reverse index.
		// This mutant clears the FORWARD link and leaves the reverse key, under a key
		// that names a DEAD entity.
		//
		// `assertSelfConsistent` asks `sourcesOf` for the LIVE agents alone, and
		// `pairsOf` reads the forward store. Therefore neither of them can see this.
		// The cohort of the recently dead agents is what sees it.
		//
		// `_forward` exists on the store of a multi relation and not on the store of an
		// exclusive one, so the test below selects the exclusive ports of the net.
		id: "clear-leaves-dead-reverse-key",
		what: 'the "clear" policy clears the forward link and leaves the reverse key of the dead target',
		find: `      for (let i = 0; i < sources.length; i++) rs.unlink(sources[i], targetId);`,
		to: `      for (let i = 0; i < sources.length; i++) {
        if (rs._forward === void 0) rs._store.remove(getEntityIndex(sources[i]));
        else rs.unlink(sources[i], targetId);
      }`,
	},

	// ── the walk over a deep chain ──────────────────────────────────────────
	{
		// `InEpoch` is one level deep, so it cannot see this. The chain of records is
		// hundreds of levels deep, and `_assertRecordChain` compares the count of the
		// walk at `maxDepth` 1 and 2 with the model.
		id: "hierarchy-ignores-maxdepth",
		what: "a hierarchy walk keeps the entities that are deeper than maxDepth",
		find: `      if (d > maxDepth) continue;`,
		to: `      if (d > maxDepth && false) continue;`,
	},

	// ── the events, and the host write seam ─────────────────────────────────
	{
		id: "events-not-cleared-at-the-tick-tail",
		what: "an event channel keeps its rows past the end of the update",
		find: `      this.store.clearEvents();
      if (DEV) this.store._trace?.tickEnd(this._tick);`,
		to: `      if (DEV) this.store._trace?.tickEnd(this._tick);`,
	},
	// ── the probes of the API surface ───────────────────────────────────────
	{
		// The mutant that ESCAPED the first time. `README.md` holds the lesson: a
		// pattern that matches is not the same as a pattern that names code which the
		// harness runs. The first version removed this line, and no case reached
		// `ctx.ref`. Therefore the mutant survived. The probe for the cursors and the
		// refs reaches the line now. It writes through `ctx.ref`, and it then reads
		// `changed()`.
		id: "changed-tick-not-set-by-ref",
		what: "ctx.ref does not stamp the change tick",
		find: `    arch._changedTick[def.id] = this.store._tick;
    return createRef(arch.columnGroups[def.id], row);`,
		to: `    return createRef(arch.columnGroups[def.id], row);`,
	},
	{
		// `relations.remove(src, R)` with NO target must remove each target of that
		// source. The simulation never calls the explicit unlink. A port is an exclusive
		// relation, and a rewrite REPLACES its target. Therefore the probe for the
		// removal of a relation is the only layer that sees this fault.
		id: "relation-remove-ignores-the-all-form",
		what: "relations.remove without a target argument removes nothing",
		find: `    rs.unlink(src, tgt);`,
		to: `    if (tgt !== void 0) rs.unlink(src, tgt);`,
	},
	{
		id: "host-seam-drops-set-field",
		what: "the apply dispatch of the write seam ignores a set_field command",
		find: `      ctx.setField(cmd.eid, cmd.def, cmd.field, cmd.value);
      return void 0;
    case "disable":`,
		to: `      return void 0;
    case "disable":`,
	},
	{
		// Layer 8 does a round trip that must SUCCEED, so the bytes that it gives to
		// `restore` always carry the version of this build. Therefore no simulation
		// reaches the version guard, and the probe for the restore of the whole world
		// is the only layer that sees this fault.
		id: "restore-accepts-any-version",
		what: "a restore of a world does not check the version of the snapshot",
		find: `  const version = view.getUint32(4, true);
  if (version !== ECS_SNAPSHOT_VERSION) {`,
		to: `  const version = view.getUint32(4, true);
  if (false) {`,
	},
	{
		// The simulation removes one component at a time, through `ctx.commands` and
		// through the write seam. Therefore the plural form has no cover in a net, and
		// the probe for the immediate component writes is the only layer that sees this.
		id: "remove-components-drops-all-but-the-first",
		what: "the plural remove detaches the first component only",
		find: `    this.store.removeComponents(entityId, defs);`,
		to: `    this.store.removeComponents(entityId, defs.slice(0, 1));`,
	},
	{
		// `ctx.removeRelation` is the route of a SYSTEM. `surface.mjs` covers the host
		// route, `ecs.relations.remove`, which is a different method. This mutant drops
		// the target argument, so the call removes EVERY target and not the one that the
		// caller named. The `Produced` set of the provenance layer is compared element
		// by element, so the model sees it.
		id: "ctx-remove-relation-drops-the-target",
		what: "ctx.removeRelation removes every target instead of the named one",
		find: `  removeRelation(src, def, tgt) {
    if (DEV) accessCheck.checkRelationWrite(def);
    this.store.removeRelation(src, def, tgt);
    return this;
  }`,
		to: `  removeRelation(src, def, tgt) {
    if (DEV) accessCheck.checkRelationWrite(def);
    this.store.removeRelation(src, def);
    return this;
  }`,
	},
	{
		// `ctx.hasRelation` asks whether the source holds ANY target. The driver reads it
		// on both sides of the explicit unlink, and the model gives the number of the
		// targets that are left. Therefore a call that always agrees fails when the
		// unlink took the last target.
		id: "ctx-has-relation-always-true",
		what: "ctx.hasRelation reports a target for every source",
		find: `  hasRelation(src, def) {
    return this.store.hasRelation(src, def);
  }`,
		to: `  hasRelation(src, def) {
    return true;
  }`,
	},
	{
		// `ctx.markChanged` puts a row into the list for the per-entity `onSet`
		// observer. A call that does nothing loses each mark, and the set with the
		// granularity of an entity is exact in both directions.
		id: "mark-changed-does-nothing",
		what: "ctx.markChanged records no row",
		find: `  markChanged(entityId, def) {
    if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
  }`,
		to: `  markChanged(entityId, def) {
  }`,
	},
	{
		// The other direction, and the sharper one. `markChanged` must NOT set the tick
		// for the change on the archetype. This mutant sets it, so the mark reaches
		// `changed(Touch)` as well. Only the IDLE TAIL sees that: each tick before it
		// writes a column, and the archetype layers are bounded from below there.
		id: "mark-changed-also-stamps-the-archetype",
		what: "ctx.markChanged makes the whole archetype changed",
		find: `  markChanged(entityId, def) {
    if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
  }`,
		to: `  markChanged(entityId, def) {
    if (this.store._anyDirtyTracked) this.store._noteSet(def, entityId);
    const arch = this.store.resolveEntity(entityId);
    arch._changedTick[def.id] = this.store._tick;
  }`,
	},
	{
		// `withRelation` narrows the rows by the backing sparse id of the relation.
		// Without that term the query gives EVERY agent, and the answer then holds the
		// ERA and the ROOT, which have no port 1.
		id: "with-relation-does-not-narrow",
		what: "withRelation keeps every row instead of the sources of that relation",
		find: `    const sid = this._resolver._relationBackingSparseId(def);
    const result = this._deriveRelation(
      appendSparse(this._sparseInclude, sid),`,
		to: `    const sid = this._resolver._relationBackingSparseId(def);
    const result = this._deriveRelation(
      this._sparseInclude,`,
	},
	{
		// The fetch of an optional column must give the column when the archetype holds
		// it. A fetch that always reports "absent" makes each span look like a `Fresh`
		// span, and the layer for the query verbs compares both spans with the model.
		id: "optional-column-always-absent",
		what: "getOptionalColumnRead reports every optional column as absent",
		find: `    const offset = this._colOffset[cid];
    if (offset === void 0) return void 0;`,
		to: `    const offset = this._colOffset[cid];
    if (true) return void 0;`,
	},
	{
		// `forEachUntil` must STOP at the archetype that the predicate accepts. This
		// mutant keeps the return value correct and walks to the end, so only the count
		// of the archetypes that the callback saw can find it. The mutant replaces the
		// whole method, because the early-out has one form for a development build and
		// another for a production build, and a mutant must fire in both.
		id: "for-each-until-does-not-stop",
		what: "forEachUntil visits every archetype and does not stop early",
		find: `  forEachUntil(cb) {
    if (this._includeDisabled) {
      const prev = _setIterAllRows(true);
      try {
        return this._forEachUntilInner(cb);
      } finally {
        _setIterAllRows(prev);
      }
    }
    return this._forEachUntilInner(cb);
  }`,
		to: `  forEachUntil(cb) {
    let hit = false;
    this.forEach((arch) => {
      if (cb(arch)) hit = true;
    });
    return hit;
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
	// The probes of the API surface. This case is LAST for a reason: each case above
	// keeps the mechanism that it had, and this case adds the parts of the API that no
	// simulation reaches. Before this case, each case named a `--net=`. Therefore
	// `surface.mjs` never ran against a mutant, and no probe in it had evidence that
	// it can fail.
	{ name: "surface", args: ["--surface"] },
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
