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
 * What "caught" means. A mutant is caught when the oracle run gives a nonzero exit,
 * and that alone does not say which mechanism found the bug. This program therefore
 * puts each catch into one of two classes, and it reports both counts:
 *
 *   - By the oracle, the run reported a `DIVERGENCE`, or an assertion of the
 *     harness itself. These are the layers that `README.md` describes.
 *   - By the engine, the engine threw its own error before an oracle layer looked
 *     at the state. That is still a detection, and it is still useful. But it is not
 *     evidence about the oracle, and some of these errors exist only in a
 *     development build.
 *
 * The build. The battery uses a development build by default. The guards of that
 * build give more mechanisms a chance to fire. But the released package is a
 * production build, so `--prod` runs the same battery against `__DEV__ = false`.
 *
 * A mutant that names a guard a production build does not run carries `devOnly`.
 * The flag is false there, so the branch and the mutation are both inert. A skip
 * is the honest result. `--prod` skips those. It counts them in neither the
 * catches nor the escapes.
 *
 * An engine error catches some of the mutants. Some of those are on the path that
 * makes a row plane larger. Some are in the sparse store, where the relations share
 * the store class and throw first. `README.md` holds the table of both builds.
 *
 *   node bench/net-oracle/mutants.mjs           # development build (more guards)
 *   node bench/net-oracle/mutants.mjs --prod    # the build that the package ships
 *   node bench/net-oracle/mutants.mjs --only=split-end-short-by-one
 *
 * `--only=id[,id]` runs the named mutants and no others. Use it while you write
 * one. A gate runs the whole list, because a run that names a subset says nothing
 * about the rest.
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
// `--only=id[,id]` runs the named mutants and no others. It is for the loop a
// person runs while writing one. It is not for a gate, because a run that names a
// subset proves nothing about the rest.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg === undefined ? null : new Set(onlyArg.slice("--only=".length).split(","));
const base = path.join(outDir, PROD ? "base.prod.mjs" : "base.mjs");
await buildLib(base, { dev: !PROD, from: root });
const baseSrc = fs.readFileSync(base, "utf8");

// ── the mutants ─────────────────────────────────────────────────────────────
const MUTANTS = [
	{
		id: "rowplane-backpointer",
		what: "swap-remove forgets to fix the moved entity's row backpointer",
		find: `        entityRows[getEntityIndex(eids[row])] = row;
      }
      this.length = last;
      this.enabledCount = last;`,
		to: `      }
      this.length = last;
      this.enabledCount = last;`
	},
	{
		// `_moveRow` is the one primitive behind each swap-remove fill. It walks the
		// width-canonical plane (`_widthBufs`), so this mutant empties that primitive
		// and each fill then moves the entity id alone.
		id: "rowplane-no-column-copy",
		what: "swap-remove moves the entity id but not the column data",
		find: `  _moveRow(to, from) {
    const bufs = this._widthBufs;
    for (let i = 0; i < bufs.length; i++) bufs[i][to] = bufs[i][from];
  }`,
		to: `  _moveRow(to, from) {
  }`
	},
	{
		// the same primitive, with a fault that a small archetype never shows: one bit
		// of the first column of the moved row, and only when the row comes from past
		// the first thousand. The suite's small nets never reach that row. `erase:14`
		// does, and the fingerprint at each tick is what names the tick of the fault
		// the deep comparison on its cadence would name a later one.
		id: "moverow-corrupts-a-large-archetype",
		what: "the swap-remove fill flips one bit of the moved row in an archetype past a thousand rows",
		find: `    for (let i = 0; i < bufs.length; i++) bufs[i][to] = bufs[i][from];`,
		to: `    for (let i = 0; i < bufs.length; i++) bufs[i][to] = bufs[i][from];
    if (from > 1000) bufs[0][to] ^= 1;`
	},
	{
		// the width-canonical view of an `i16` column. A view of the wrong width moves
		// half of the bytes of each element, so a row move changes the value. Only a
		// column of that kind shows it, and `Mix.m16` and `Mix.b16` are those columns.
		id: "widthview-i16-through-u8",
		what: "the row plane views an i16 column through a one-byte class, so a move keeps half of each element",
		find: `    case I16:
      return new Uint16Array(buf.buffer, buf.byteOffset, buf.length);`,
		to: `    case I16:
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);`
	},
	{
		// the stored bits of an `f32` default. A template converts each default one
		// time, and the append copies bits. Without the rounding through the scratch
		// `Float32Array`, the number goes through the `Uint32Array` view as an integer,
		// and the column then holds zero. `Mix.bf32` is the column, and it exists in
		// the float arm alone, so the battery holds a float case.
		id: "towidthbits-f32-no-round",
		what: "the template stores an f32 default as an integer, so the column reads zero",
		find: `    case F32:
      F32_SCRATCH[0] = v;
      return F32_BITS[0];`,
		to: `    case F32:
      return v;`
	},
	// ── the id-indexed sparse store ────────────────────────────────────────
	// `Watch` is the sparse component of the net. Its membership is the redex
	// set, and its `hits` field mirrors `Touch.seq` as the low byte. Each mutant
	// below breaks one mechanism of the store, and the sparse layer, the value
	// mirror, or the fingerprint must see it.
	{
		// A member joins at the wrong position of the member list. `has` still
		// says yes, so the first symptom is a later remove that swaps the wrong
		// slot, and a member that the walk then skips or repeats.
		id: "sparse-join-wrong-position",
		what: "a sparse member joins at the wrong position, so a later remove corrupts the member list",
		find: `    this._pos[index] = this._size;
    this._dense[this._size++] = index;`,
		to: `    this._pos[index] = this._size + 1;
    this._dense[this._size++] = index;`
	},
	{
		// the member that a swap-remove moves into the hole keeps its old
		// position, so its own remove later removes the wrong entry.
		id: "sparse-remove-stale-position",
		what: "a swap-remove leaves the moved member's position stale, so its own remove hits the wrong entry",
		find: `    this._pos[moved] = p;`,
		to: `    this._pos[moved] = last;`
	},
	{
		// A grow keeps the columns and drops the positions, so every member of
		// the store before the grow reads absent after it.
		id: "sparse-grow-drops-members",
		what: "a grow of the sparse columns forgets every member's position",
		find: `    pos.set(this._pos);`,
		to: `    pos.set(this._pos.subarray(0, 1));`
	},
	{
		// the member at position zero of the list reads absent.
		id: "sparse-has-off-by-one",
		what: "membership at position zero of the sparse member list reads absent",
		find: `    return this._pos[index] >= 0;`,
		to: `    return this._pos[index] > 0;`
	},
	{
		// A read of a sparse field takes the neighbour's slot.
		id: "sparse-getfield-neighbour",
		what: "a sparse field read takes the value at the next index",
		find: `    return this._cols[fieldIdx][index];`,
		to: `    return this._cols[fieldIdx][index + 1];`
	},
	{
		// the value path of a `u8` column keeps seven bits, so a mirror of `seq`
		// diverges at the first member whose low byte has the high bit set.
		id: "writeelem-u8-seven-bits",
		what: "a write to a u8 column through the kind-split site keeps seven bits",
		find: `    case U8:
      buf[row] = v;
      return;`,
		to: `    case U8:
      buf[row] = v & 0x7f;
      return;`
	},
	{
		id: "rowplane-overreported-cap",
		what: "the row plane's cached capacity is one row larger than reality",
		find: `    this._rowCap = eidCap < colCap ? eidCap : colCap;`,
		to: `    this._rowCap = (eidCap < colCap ? eidCap : colCap) + 1;`
	},
	{
		id: "rowplane-stale-eids",
		what: "the row plane keeps a stale entity-id view after a grow",
		find: `    this._eids = this._entityIds.buf;`,
		to: `    if (this._eids === void 0) this._eids = this._entityIds.buf;`
	},
	{
		// `_growRows` uses the column capacity term alone to decide if a column needs
		// to become larger. Therefore a shortage in the entity-id array alone does not
		// make the complete column store do a new allocation and a republish for no
		// change of size. A decision on the entity-id term is the wrong-term bug that
		// this guard permits: the code made the entity-id array as large as `need` two
		// lines before. Therefore the test always passes, and the code skips a true
		// shortage of a column with no message.
		//
		// (The other half of that reserve, re-syncing the row plane when the grow
		// throws, has no mutant here: the oracle runs the heap profile, where
		// `growHandler` is null and nothing in the grow path throws. It is pinned by
		// unit tests instead.)
		id: "rowplane-grow-guard-wrong-term",
		what: "the reserve tests the entity-id capacity, so a needed column grow never happens",
		find: `    if (need <= this._colCap) {`,
		to: `    if (need <= this._entityIds.buf.length) {`
	},
	{
		id: "relation-reverse-leak",
		what: "exclusive-relation replace leaves the old reverse-index entry behind",
		find: `  _unlinkReverse(tgt, src) {
    const set = this._reverse.get(tgt);
    if (set === void 0) return;`,
		to: `  _unlinkReverse(tgt, src) {
    const set = this._reverse.get(tgt);
    if (set !== void 0) return;`
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
      }`
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
      }`
	},
	{
		id: "clear-policy-noop",
		what: 'the "clear" policy leaves the relation on every source when a target dies',
		find: `      for (let i = 0; i < sources.length; i++) rs.unlink(sources[i], targetId);`,
		to: `      if (sources.length < 0) rs.unlink(sources[0], targetId);`
	},
	{
		id: "multi-forward-set-keeps-dead",
		what: "a multi relation's forward target set keeps a target that was unlinked",
		find: `    if (!set.has(tgt)) return;
    set.delete(tgt);
    this._unlinkReverse(tgt, src);`,
		to: `    if (!set.has(tgt)) return;
    this._unlinkReverse(tgt, src);`
	},
	{
		id: "multi-targetsof-unsorted",
		what: "multi targetsOf drops its deterministic ascending sort",
		find: `    out.sort((a, b) => a - b);
    return out;
  }
  hasIndex(index) {`,
		to: `    return out;
  }
  hasIndex(index) {`
	},
	{
		id: "compact-undercounts",
		what: "compact() reclaims the dead keys but reports zero",
		find: `        this._reverse.delete(tgt);
        dropped++;`,
		to: `        this._reverse.delete(tgt);`
	},
	{
		id: "compact-drops-live-keys",
		what: "compact() prunes reverse entries for live targets too",
		find: `      if (!isAlive(unsafeCast(tgt))) {
        this._reverse.delete(tgt);
        dropped++;
      }`,
		to: `      {
        this._reverse.delete(tgt);
        dropped++;
      }`
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
      }`
	},

	// ── the change detection ────────────────────────────────────────────────
	{
		id: "onset-entity-never-fires",
		what: "the per-entity onSet drain returns before it calls anything",
		find: `    if (n === 0 && m === 0) return;
    const def = obs.def;
    const fn = obs.onSetEntity;`,
		to: `    if (n >= 0 && m >= 0) return;
    const def = obs.def;
    const fn = obs.onSetEntity;`
	},
	{
		// The per-entity onSet must skip a disabled entity, so that it matches the
		// grain of the archetype path, whose row sweep stops at the enabled rows. This
		// mutant drops that filter. Nothing outside `changeCheck` compares the set of
		// the reported entities with an exact expected set, so nothing else sees it.
		id: "onset-entity-reports-disabled",
		what: "the per-entity onSet reports a disabled entity, which a default query hides",
		find: `          if (!this._store.isAlive(eid) || !this._store.hasComponent(eid, def) || this._store.isDisabled(eid))
            continue;`,
		to: `          if (!this._store.isAlive(eid) || !this._store.hasComponent(eid, def))
            continue;`
	},
	{
		// `cols.mut(def)` must set the tick for the change at the moment of the call,
		// and it must do that even when no write follows. `ageTick` in the harness uses
		// `cols.mut`, which resolves to `columnGroupMut` below. Therefore this mutant
		// makes `changed(Age)` and the `onSet` observer on `Age` report nothing at all.
		//
		// The first version of this mutant removed the same line from `ctx.ref`, and it
		// escaped: the harness writes `Age` through `forEachColumns` alone, so `ctx.ref` was
		// a path that no case reached. The escape was correct, and the lesson is the one
		// that `README.md` records about a mutant that goes stale, a mutant must name
		// the code that the harness runs.
		id: "changed-tick-not-set-by-mut",
		what: "the mutable column group does not set the change tick",
		find: `    this.changedTick[cid] = tick;
    return this._mutGroupCache[cid];`,
		to: `    return this._mutGroupCache[cid];`
	},
	{
		// The opposite fault: the layer reports every archetype at every tick. Each
		// check that asks "did the ECS report the change" passes. The idle tail is the
		// only thing that asks the other question, so this mutant is the proof that the
		// tail earns its place in the harness.
		id: "changed-arch-reports-everything",
		what: "the archetype-granular onSet ignores its baseline and reports every archetype",
		find: `      if (arch.length > 0 && arch.changedTick[cid] > baseline) cb(arch);`,
		to: `      if (arch.length > 0) cb(arch);`
	},

	// ── the row tick plane ──────────────────────────────────────────────────
	// `redexMaintain` records each touched agent into `Seen` through `cols.ticks`
	// in a chunk loop, and the `onSet` observer on `Seen` reads the scan of the
	// plane alone. Refer to `changeCheck`.
	{
		// A chunk loop that takes the tick column asks the drain to scan. Without
		// the request the stores land in the plane and nothing reads them.
		id: "note-scan-does-nothing",
		what: "cols.ticks makes no scan request, so a row record in a chunk loop is lost",
		find: `  noteScan(cid) {
    const meta = this._componentMetas[cid];
    if (meta.rowTicks) meta.scanTick = this.changeTick;
  }`,
		to: `  noteScan(cid) {
  }`
	},
	{
		// The scan must read the plane. One that reports every row of a stamped
		// archetype reports the agents a rewrite left alone.
		id: "scan-ignores-the-row-tick",
		what: "the scan reports every enabled row of a stamped archetype",
		find: `          for (let r = 0; r < n; r++) if (t[r] > since) res.scanned.push(eids[r]);`,
		to: `          for (let r = 0; r < n; r++) res.scanned.push(eids[r]);`
	},
	{
		// `redexMaintain` stamps a row and then moves it, through the deferred add
		// or remove of `Redex`, in the same phase. The tick must travel with the row.
		id: "transition-drops-the-row-tick",
		what: "a transition zeroes the row tick instead of carrying it",
		find: `      bufs[i][to] = st !== void 0 ? st[from] : 0;`,
		to: `      bufs[i][to] = 0;`
	},
	// A fifth mutant, the template append that keeps a stale tick in a freed
	// slot, escaped: every agent the net spawns is also touched in the same
	// tick, so the stale tick changes nothing here. `row_ticks.test.ts` holds
	// that case, with a host spawn into the slot a despawn freed.

	// ── the sparse row grain ────────────────────────────────────────────────
	// `redexMaintain` writes `Watch.hits` through the mutable sparse cursor for
	// a member that stays, and the `onSet` observer on `Watch` must report
	// exactly those. Refer to `changeCheck`.
	{
		id: "sparse-cursor-at-does-not-stamp",
		what: "the mutable sparse cursor does not stamp the row tick on at()",
		find: `    const t = plane.ticks;
    if (t !== null) {
      const now = clock.changeTick;
      t[index] = now;
      plane.changedTick = now;
    }
    return this;`,
		to: `    return this;`
	},
	{
		id: "sparse-drain-gate-never-opens",
		what: "the sparse drain treats every component as idle",
		find: `    if (st.changedTick <= since) return out;`,
		to: `    return out;`
	},

	// ── the partition of the enabled and the disabled rows ──────────────────
	{
		id: "disable-row-keeps-enabled-count",
		what: "disableRow moves the row but does not shrink the enabled region",
		find: `      entityRows[getEntityIndex(eids[lastEnabled])] = lastEnabled;
    }
    this.enabledCount = lastEnabled;
  }`,
		to: `      entityRows[getEntityIndex(eids[lastEnabled])] = lastEnabled;
    }
  }`
	},
	{
		id: "toggle-fans-the-wrong-way",
		what: "a net toggle fans onEnable where it must fan onDisable, and the reverse",
		find: `    arch.mask.forEach(nowDisabled ? this._collectDisableBit : this._collectEnableBit);`,
		to: `    arch.mask.forEach(nowDisabled ? this._collectEnableBit : this._collectDisableBit);`
	},

	// ── a dead key in the reverse index ─────────────────────────────────────
	{
		// `README.md` named this gap before this pass, and it also named the shape of
		// the mutant that would show whether the gap was reachable. Under `"clear"` the
		// death of a target must delete the key of that target from the reverse index.
		// This mutant clears the forward link and leaves the reverse key, under a key
		// that names a dead entity.
		//
		// `assertSelfConsistent` asks `sourcesOf` for the live agents alone, and
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
      }`
	},

	// ── the walk over a deep chain ──────────────────────────────────────────
	{
		// `InEpoch` is one level deep, so it cannot see this. The chain of records is
		// hundreds of levels deep, and `_assertRecordChain` compares the count of the
		// walk at `maxDepth` 1 and 2 with the model.
		id: "hierarchy-ignores-maxdepth",
		what: "a hierarchy walk keeps the entities that are deeper than maxDepth",
		find: `      if (d > maxDepth) continue;`,
		to: `      if (d > maxDepth && false) continue;`
	},

	// ── the events, and the host write seam ─────────────────────────────────
	{
		id: "events-not-cleared-at-the-tick-tail",
		what: "an event channel keeps its rows past the end of the update",
		find: `      if (this._store.hasEvents) this._store.events.clear();
      if (DEV) this._store.trace?.tickEnd(this._tick);`,
		to: `      if (DEV) this._store.trace?.tickEnd(this._tick);`
	},
	// ── the probes of the API surface ───────────────────────────────────────
	{
		// The mutant that escaped the first time. `README.md` holds the lesson: a
		// pattern that matches is not the same as a pattern that names code which the
		// harness runs. The first version removed this line, and no case reached
		// `ctx.ref`. Therefore the mutant survived. The probe for the cursors and the
		// refs reaches the line now. It writes through `ctx.ref`, and it then reads
		// `changed()`.
		id: "changed-tick-not-set-by-ref",
		what: "ctx.ref does not stamp the change tick",
		find: `    arch.changedTick[def.id] = this._store.changeTick;
    if (this._store.anyDirtyTracked) this._store.noteSet(def.id, arch, row, entityId);
    return createRef(arch.accessorColumns[def.id], row);`,
		to: `    if (this._store.anyDirtyTracked) this._store.noteSet(def.id, arch, row, entityId);
    return createRef(arch.accessorColumns[def.id], row);`
	},
	{
		// `relations.remove(src, R)` with no target must remove each target of that
		// source. The simulation never calls the explicit unlink. A port is an exclusive
		// relation, and a rewrite replaces its target. Therefore the probe for the
		// removal of a relation is the only layer that sees this fault.
		id: "relation-remove-ignores-the-all-form",
		what: "relations.remove without a target argument removes nothing",
		find: `    rs.unlink(src, tgt);`,
		to: `    if (tgt !== void 0) rs.unlink(src, tgt);`
	},
	{
		id: "host-seam-drops-set-field",
		what: "the apply dispatch of the write seam ignores a set_field command",
		find: `      ctx.setField(cmd.eid, cmd.def, cmd.field, cmd.value);
      return void 0;
    case "disable":`,
		to: `      return void 0;
    case "disable":`
	},
	{
		// Layer 8 does a round trip that must succeed, so the bytes that it gives to
		// `restore` always carry the version of this build. Therefore no simulation
		// reaches the version guard, and the probe for the restore of the whole world
		// is the only layer that sees this fault.
		id: "restore-accepts-any-version",
		what: "a restore of a world does not check the version of the snapshot",
		find: `  const version = view.getUint32(4, true);
  if (version !== ECS_SNAPSHOT_VERSION && version !== LEGACY_ECS_SNAPSHOT_VERSION) {`,
		to: `  const version = view.getUint32(4, true);
  if (false) {`
	},
	{
		// The simulation removes one component at a time, through `ctx.commands` and
		// through the write seam. Therefore the plural form has no cover in a net, and
		// the probe for the immediate component writes is the only layer that sees this.
		id: "remove-components-drops-all-but-the-first",
		what: "the plural remove detaches the first component only",
		find: `    this._store.removeComponents(entityId, defs);`,
		to: `    this._store.removeComponents(entityId, defs.slice(0, 1));`
	},
	{
		// `ctx.removeRelation` is the route of a system. `surface.mjs` covers the host
		// route, `ecs.relations.remove`, which is a different method. This mutant drops
		// the target argument, so the call removes every target and not the one that the
		// caller named. The `Produced` set of the provenance layer is compared element
		// by element, so the model sees it.
		id: "ctx-remove-relation-drops-the-target",
		what: "ctx.removeRelation removes every target instead of the named one",
		find: `  removeRelation(src, def, tgt) {
    if (DEV) accessCheck.assertRelationWrite(def);
    this._store.requireRelations("ctx.removeRelation").removeRelation(src, def, tgt);
    return this;
  }`,
		to: `  removeRelation(src, def, tgt) {
    if (DEV) accessCheck.assertRelationWrite(def);
    this._store.requireRelations("ctx.removeRelation").removeRelation(src, def);
    return this;
  }`
	},
	{
		// `ctx.hasRelation` asks whether the source holds any target. The driver reads it
		// on both sides of the explicit unlink, and the model gives the number of the
		// targets that are left. Therefore a call that always agrees fails when the
		// unlink took the last target.
		id: "ctx-has-relation-always-true",
		what: "ctx.hasRelation reports a target for every source",
		find: `  hasRelation(src, def) {
    return this._store.requireRelations("ctx.hasRelation").hasRelation(src, def);
  }`,
		to: `  hasRelation(src, def) {
    return true;
  }`
	},
	{
		// `ctx.markChanged` puts a row into the list for the per-entity `onSet`
		// observer. A call that does nothing loses each mark, and the set with the
		// granularity of an entity is exact in both directions.
		id: "mark-changed-does-nothing",
		what: "ctx.markChanged records no row",
		find: `  markChanged(entityId, def) {
    if (this._store.anyDirtyTracked) this._store.noteSetEntity(def, entityId);
  }`,
		to: `  markChanged(entityId, def) {
  }`
	},
	{
		// The other direction, and the sharper one. `markChanged` must not set the tick
		// for the change on the archetype. This mutant sets it, so the mark reaches
		// `changed(Touch)` as well. Only the idle tail sees that: each tick before it
		// writes a column, and the archetype layers are bounded from below there.
		id: "mark-changed-also-stamps-the-archetype",
		what: "ctx.markChanged makes the whole archetype changed",
		find: `  markChanged(entityId, def) {
    if (this._store.anyDirtyTracked) this._store.noteSetEntity(def, entityId);
  }`,
		to: `  markChanged(entityId, def) {
    if (this._store.anyDirtyTracked) this._store.noteSetEntity(def, entityId);
    const arch = this._store.resolveEntity(entityId);
    arch.changedTick[def.id] = this._store.changeTick;
  }`
	},
	{
		// `andRelation` narrows the rows by the backing sparse id of the relation.
		// Without that term the query gives every agent, and the answer then holds the
		// ERA and the ROOT, which have no port 1.
		id: "with-relation-does-not-narrow",
		what: "andRelation keeps every row instead of the sources of that relation",
		find: `    const sid = this._resolver.relationBackingSparseId(def, "query.andRelation");
    const result = this._deriveRelation(
      appendSparse(this.terms.sparseIncludes, sid),`,
		to: `    const sid = this._resolver.relationBackingSparseId(def, "query.andRelation");
    const result = this._deriveRelation(
      this.terms.sparseIncludes,`
	},
	{
		// The fetch of an optional column must give the column when the archetype holds
		// it. A fetch that always reports "absent" makes each span look like a `Fresh`
		// span, and the layer for the query verbs compares both spans with the model.
		id: "optional-column-always-absent",
		what: "getOptionalColumnRead reports every optional column as absent",
		find: `    const offset = this.colOffset[cid];
    if (offset === void 0) return void 0;`,
		to: `    const offset = this.colOffset[cid];
    if (true) return void 0;`
	},
	{
		// `some` must stop at the archetype that the predicate accepts. This
		// mutant keeps the return value correct and walks to the end, so only the count
		// of the archetypes that the callback saw can find it. The mutant replaces the
		// whole method, because the early-out has one form for a development build and
		// another for a production build, and a mutant must fire in both.
		id: "for-each-until-does-not-stop",
		what: "query.some visits every archetype and does not stop early",
		find: `  some(cb) {
    if (this.includesDisabled) {
      const prev = _setIterAllRows(true);
      try {
        return this._someInner(cb);
      } finally {
        _setIterAllRows(prev);
      }
    }
    return this._someInner(cb);
  }`,
		to: `  some(cb) {
    let hit = false;
    this.forEachArchetype((arch) => {
      if (cb(arch)) hit = true;
    });
    return hit;
  }`
	},
	{
		// `or` must accept an archetype that one operand accepts. This mutant makes it
		// require every operand. The harness runs `or(and(Age, Touch), Redex)` inside
		// a `where`. The mutant narrows the result to the aged agents of an active
		// pair. The model holds every aged agent.
		id: "or-matches-like-and",
		what: "or requires every operand instead of one",
		find: `function or(...terms) {
  const parts = terms.map(exprMatcher);
  const name = \`or(\${terms.map(exprName).join(", ")})\`;
  return {
    name,
    matches(mask) {
      for (let i = 0; i < parts.length; i++) {
        if (parts[i](mask)) return true;
      }
      return false;
    }
  };
}`,
		to: `function or(...terms) {
  const parts = terms.map(exprMatcher);
  const name = \`or(\${terms.map(exprName).join(", ")})\`;
  return {
    name,
    matches(mask) {
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i](mask)) return false;
      }
      return true;
    }
  };
}`
	},
	{
		// `where` caches on the identity of the term. This mutant keys the cache on
		// the cache itself. Every term of one parent query then shares one entry, and
		// the first term wins. The harness builds three `where` queries over one
		// parent, and the complement is the one whose set changes.
		id: "where-cache-ignores-the-term",
		what: "the where cache returns another term's archetype list",
		find: `  where(term) {
    const cache = this._resolver.caches.whereSingle;
    let byQuery = cache.get(term);
    if (byQuery === void 0) {
      byQuery = /* @__PURE__ */ new Map();
      cache.set(term, byQuery);
    }`,
		to: `  where(term) {
    const cache = this._resolver.caches.whereSingle;
    let byQuery = cache.get(cache);
    if (byQuery === void 0) {
      byQuery = /* @__PURE__ */ new Map();
      cache.set(cache, byQuery);
    }`
	},
	{
		// The row grain reads one component's tick plane. This mutant gives the first
		// plane of the archetype instead, which is `Touch`. `Touch` also carries the
		// rows that `ctx.markChanged` recorded, and `Mix` does not. So the reported
		// set grows by the marks of the tick.
		id: "ticksread-wrong-component-plane",
		what: "cols.ticksRead returns the tick plane of another component",
		find: `  ticksRead(def) {
    const arch = this.arch;
    const cid = def.id;
    const t = arch.rowTicks[cid];`,
		to: `  ticksRead(def) {
    const arch = this.arch;
    const cid = def.id;
    const t = arch.rowTicks.find((p) => p !== void 0);`
	},
	{
		// `cols.since` is the change tick of the previous run of the system. This
		// mutant makes it the tick of this pass. No row is then above it, and the row
		// grain reports nothing.
		id: "chunk-since-is-the-current-tick",
		what: "forEachColumns sets cols.since to the tick of this pass, so no row reports",
		find: `    view.since = this._resolver.getLastRunTick();`,
		to: `    view.since = this._resolver.getChangeTick();`
	},
	{
		// The same fault on the `changed()` path. It also silences the filter on the
		// archetype, so `changed(def).forEachColumns` visits nothing.
		id: "changed-chunk-since-is-the-current-tick",
		what: "changed().forEachColumns sets cols.since to the tick of this pass",
		find: `    view.since = q.lastRunTick();`,
		to: `    view.since = q.changeTick();`
	},
	{
		// `addPhase` must order the new phase against the phases it names. Declaration
		// order breaks a tie, and every built-in is declared first. So a phase that
		// lost its `before` falls to the tail of its loop. The census that must run
		// before UPDATE then reads the count after the rewrites.
		id: "addphase-drops-before",
		what: "addPhase ignores the before targets",
		find: `    for (const target of config.before ?? EMPTY_ARRAY) {
      node.before.push(this._checkPhase(target));
    }`,
		to: `    for (const target of []) {
      node.before.push(this._checkPhase(target));
    }`
	},
	{
		// The other half. The census after UPDATE is declared before the census
		// before UPDATE. With its `after` dropped, its `before` alone puts it ahead
		// of UPDATE. It then reads the count at the start of the tick.
		id: "addphase-drops-after",
		what: "addPhase ignores the after targets",
		find: `    for (const target of config.after ?? EMPTY_ARRAY) {
      node.after.push(this._checkPhase(target));
    }`,
		to: `    for (const target of []) {
      node.after.push(this._checkPhase(target));
    }`
	},
	{
		// `ctx.sparseChanged` compares the sparse row tick with the previous run of
		// the system. This mutant compares it with the tick of this run, which no
		// stamp can pass, so every member reports unchanged.
		id: "sparse-changed-reads-the-wrong-tick",
		what: "ctx.sparseChanged compares the sparse row tick with the wrong tick",
		find: `    return this._store.sparseTickOf(def, entityId) > this.lastRunTick;`,
		to: `    return this._store.sparseTickOf(def, entityId) > this._store.changeTick;`
	},
	// ── the mutants for the probes of the API surface ───────────────────────
	// The battery reaches these through its last case. The report of the
	// oracle-surface agent gives the find and the replace text of each one. Five of
	// them name a guard that a production build removes, and `devOnly` marks those.
	// The mutation is inert there, so a skip is the honest result.
	{
		id: "assert-template-accepts-anything",
		what: "assertTemplate accepts every value, so a bundle reaches the store as a template",
		devOnly: true,
		find: `typeof value.archetypeId === "number"`,
		to: `true`
	},
	{
		id: "template-array-guard-never-fires",
		what: "the pre-0.5 array shape reaches the store instead of a named refusal",
		devOnly: true,
		find: `if (DEV && items.length === 1 && Array.isArray(items[0])) {`,
		to: `if (false) {`
	},
	{
		id: "restore-error-carries-another-category",
		what: "ECSRestoreError carries another category",
		find: `super("SNAPSHOT_RESTORE_FAILED" /* SNAPSHOT_RESTORE_FAILED */, message);`,
		to: `super("DETERMINISM_DISABLED" /* DETERMINISM_DISABLED */, message);`
	},
	{
		id: "restore-error-keeps-the-base-name",
		what: "ECSRestoreError keeps the name of its base class",
		find: `    this.name = "ECSRestoreError";`,
		to: `    this.name = "ECSError";`
	},
	{
		id: "archetype-term-guard-never-fires",
		what: "a reader of the dense list answers a query that carries an archetype term",
		devOnly: true,
		find: `    if (terms.length === 0) return;`,
		to: `    if (terms.length >= 0) return;`
	},
	{
		id: "dense-guard-ignores-a-sparse-term",
		what: "the dense-path guard ignores a sparse term",
		devOnly: true,
		// The bundle folds the condition onto one line. So the pattern names the
		// whole line, and not the first term of it.
		find: `    if (this.terms.sparseIncludes.length > 0 || this.terms.sparseExcludes.length > 0 ||`,
		to: `    if (this.terms.sparseIncludes.length > 99 || this.terms.sparseExcludes.length > 0 ||`
	},
	{
		id: "missing-plugin-slot-answers-undefined",
		what: "a slot for a plugin that is absent answers undefined",
		find: `throw pluginMissingError(plugin, ` + "`ecs.${plugin}.${key}`" + `);`,
		to: `return undefined;`
	},
	{
		id: "a-second-plugin-of-one-name-installs",
		what: "a second plugin of one name installs",
		find: `if (installed.has(plugin.name)) throw pluginInstalledTwiceError(plugin.name);`,
		to: `if (false) throw pluginInstalledTwiceError(plugin.name);`
	},
	{
		id: "the-surface-guard-accepts-a-collision",
		what: "the surface guard accepts a facade that overwrites a member of the world",
		devOnly: true,
		find: `    if (key in world) {`,
		to: `    if (false) {`
	},
	{
		id: "a-foreign-phase-handle-is-accepted",
		what: "a phase handle from another world is accepted",
		find: `    if (node.owner !== this) {`,
		to: `    if (false) {`
	},
	{
		// The bare `if (err instanceof TypeError) {` matches two times, because the
		// sort of the systems raises its own fault through the same shape. The three
		// lines below match one time.
		id: "a-phase-cycle-throws-the-raw-type-error",
		what: "a cycle in the phases throws the TypeError of the sort instead of a named fault",
		find: `      if (err instanceof TypeError) {
        throw new ECSError(
          "CIRCULAR_PHASE_DEPENDENCY"`,
		to: `      if (false) {
        throw new ECSError(
          "CIRCULAR_PHASE_DEPENDENCY"`
	},
	{
		id: "a-before-edge-points-the-wrong-way",
		what: "a before edge between two phases points the wrong way",
		find: `        if (other !== node && inLoop.has(other)) edges.get(node).push(other);`,
		to: `        if (other !== node && inLoop.has(other)) edges.get(other).push(node);`
	},
	{
		id: "the-seam-ignores-the-phase-the-caller-named",
		what: "the host write seam drains at its default phases and not at the one the caller named",
		find: `  const schedules = opts?.schedules ?? [`,
		to: `  const schedules = [`
	},
	{
		id: "the-rebuild-ignores-every-archetype-term",
		what: "the rebuild of a query keeps every archetype that the mask picked",
		find: `if (!terms[t].matches(arch.mask)) continue outer;`,
		to: `if (false) continue outer;`
	},
	{
		id: "not-matches-where-it-must-refuse",
		what: "not accepts an archetype that one operand accepts",
		find: `        if (parts[i](mask)) return false;`,
		to: `        if (parts[i](mask)) return true;`
	},
	{
		id: "a-derive-drops-the-archetype-terms",
		what: "a derive of a query drops the archetype terms",
		find: `    archetypeTerms: patch.archetypeTerms ?? base.archetypeTerms`,
		to: `    archetypeTerms: base.archetypeTerms`
	},
	// ── the layout of the memory ────────────────────────────────────────────
	// The battery reaches these through its `memory` case. Each other case runs at
	// a store base of 0 and under the default cap. Neither mutant below changes
	// anything there.
	{
		// A column view starts at `storeBase + relOff`. A view that drops the base
		// reads and writes the bytes of another region of the backing. At a base of
		// 0 the mutation is inert, which is why the battery needs the memory case.
		id: "a-reader-ignores-the-store-base",
		what: "a column view ignores the store base and addresses the start of the backing",
		find: `function createView(buffer, storeBase, typeTag, relOff, rowCapacity) {
  const byteOff = storeBase + relOff;`,
		to: `function createView(buffer, storeBase, typeTag, relOff, rowCapacity) {
  const byteOff = relOff;`
	},
	{
		// The refusal at the cap must name the world that it refused. Without the
		// count of the live entities the message says only that a number of bytes was
		// too large. The caller then cannot tell a budget that is too small from
		// growth that ran away.
		id: "the-cap-refusal-names-no-live-count",
		what: "the refusal at the byte ceiling does not name the live entities of the world",
		find: `      intent = \` Declared \${ctx.intentLabel}. The ECS holds \${live} live entities.\`;`,
		to: `      intent = \` Declared \${ctx.intentLabel}.\`;`
	},
	// ── the fixed buffer and the pool ───────────────────────────────────────
	// The battery reaches the first two through its `memory` case, and the last
	// two through its `workers` case.
	{
		// A fixed buffer is born at the ceiling and it never grows. The store
		// relocates a column to the tail inside that buffer. It reads the tail from
		// the header capacity, because `reservedAtCap` says the byte length is the
		// cap. This mutant makes the buffer grow instead. The byte length is then the
		// current need, and the tail lies outside it.
		id: "the-fixed-allocator-grows",
		what: "the fixed allocator grows its buffer instead of reserving the whole cap",
		find: `      create: (_byteLength, maxByteLength) => new SharedArrayBuffer(maxByteLength),`,
		to: `      create: (byteLength, maxByteLength) => new SharedArrayBuffer(byteLength, { maxByteLength }),`
	},
	{
		// The ceiling is a hard ceiling. This mutant applies it at twice the value
		// the caller declared. A request that must be refused then reaches the
		// allocator's own grow. The fault it gives carries no `ECS_ERROR` code.
		id: "the-cap-check-lets-a-grow-through",
		what: "the byte ceiling is applied at twice the value the caller declared",
		find: `    if (bytes > maxBytes) {`,
		to: `    if (bytes > maxBytes * 2) {`
	},
	{
		// A worker reads the enabled row count of each archetype out of its
		// descriptor. It takes its own share of that count. A count that is one short
		// leaves the last enabled row of every archetype to no worker. That agent
		// never ages. Nothing outside a worker or a compute backend reads the
		// descriptor. So this is inert in each other case of the battery.
		id: "the-pool-skips-the-last-row-of-a-partition",
		what: "the published enabled row count is one short, so no worker owns the last row",
		find: `        a.hasColumns ? a.enabledCount : 0,`,
		to: `        a.hasColumns ? Math.max(0, a.enabledCount - 1) : 0,`
	},
	{
		// The join stamps what the pass wrote, because a worker writes columns and
		// makes no record. Without the stamp the archetype carries no change tick,
		// and a `changed()` query over the written component goes quiet.
		id: "the-pool-does-not-stamp-what-it-wrote",
		what: "the join of the pool leaves the archetype change tick of the written columns alone",
		find: `        archetype.columnGroupMut(def, runTick);
        const ticks = archetype.rowTicks[def.id];`,
		to: `        const ticks = archetype.rowTicks[def.id];`
	},
	{
		// The split of the rows lives inside the worker. Each worker takes the half
		// open range that its index and the worker count give. The ranges of the
		// workers then cover the enabled rows one time. This mutant makes each range
		// end one row early, so the row at each boundary is done by no worker.
		//
		// `worker-entry.mjs` is what makes this reachable. It starts the loop from
		// the bundle the host loaded, where `src/worker.ts` starts it from the
		// sources of the tree.
		id: "split-end-short-by-one",
		what: "each worker's row range ends one row early, so a row at each boundary is skipped",
		find: `      const end = Math.floor(rows * (index + 1) / count);`,
		to: `      const end = Math.floor(rows * (index + 1) / count) - 1;`
	},
	{
		// The other direction. Every worker after the first begins one row below its
		// own range. The row at each boundary is then done two times. The age of that
		// agent runs ahead of the model, where the mutant above leaves it behind.
		id: "split-begin-overlaps",
		what: "each worker after the first begins one row early, so a row is done two times",
		find: `      const begin = Math.floor(rows * index / count);`,
		to: `      const begin = Math.floor(rows * index / count) - (index > 0 ? 1 : 0);`
	},
	{
		// The tail alone. Each range but the last is correct, and the last worker
		// stops one row short of the enabled count. A split that a test drove with
		// one worker would still be correct, and the arm runs two.
		id: "split-last-worker-stops-short",
		what: "the last worker stops one row short of the tail",
		find: `      const end = Math.floor(rows * (index + 1) / count);`,
		to: `      const end = index === count - 1 ? Math.max(0, rows - 1) : Math.floor(rows * (index + 1) / count);`
	},
	// ── the storage seam ─────────────────────────────────────────────────────
	{
		// Each rewrite destroys two agents through the deferred flush, and both hold
		// a record in `Kin`. The size check at each tick sees the first one left.
		id: "flush-skips-the-storage-purge",
		what: "the destroy flush never calls a plugin store's purge",
		find: `      if (hasPurgers) this._purgeStorages(eid);`,
		to: `      void hasPurgers;`
	},
	{
		// The net destroys through the flush alone, so the immediate despawn has no
		// cover there. The probe of the storage seam despawns at once.
		id: "immediate-destroy-skips-the-storage-purge",
		what: "the immediate despawn never calls a plugin store's purge",
		find: `    if (this._purgers.length > 0) this._purgeStorages(id);`,
		to: `    void 0;`
	},
	{
		// `Kin` registers before `Pair`, so the first store keeps its purge and the
		// second loses it. `Pair` then keeps the records of the pairs a rewrite took.
		// Both destroy paths share the loop, so this reaches the flush and the
		// immediate despawn alike.
		id: "the-purge-reaches-the-first-store-alone",
		what: "a destroy purges the first plugin store and no other",
		find: `    for (let p = 0; p < purgers.length; p++) purgers[p].purge(id);`,
		to: `    for (let p = 0; p < Math.min(1, purgers.length); p++) purgers[p].purge(id);`
	},
	{
		id: "register-storage-forgets-the-purge",
		what: "registerStorage keeps the store but never lists its purge",
		find: `    if (provider.purge !== void 0) this._purgers.push(provider);`,
		to: `    if (false) this._purgers.push(provider);`
	},
	{
		// The snapshot layer writes one value into `Kin` and requires the digest to
		// move for it.
		id: "the-digest-skips-the-plugin-stores",
		what: "stateHash never folds a plugin store",
		find: `      provider.hash(fold);`,
		to: `      void fold;`
	},
	{
		// Each store in the net folds its size, so the words it folds move the digest
		// with no header. A store that folds no word is in the probe alone.
		id: "the-digest-drops-the-store-position",
		what: "stateHash folds each plugin store's words with no position before them",
		find: `      h = fnv1aStepWord(h, s);
      provider.hash(fold);`,
		to: `      provider.hash(fold);`
	},
	{
		id: "the-restore-skips-the-plugin-stores",
		what: "a restore never hands a plugin store its section",
		find: `      storageSections[i].provider.restore(storageSections[i].bytes);`,
		to: `      void storageSections;`
	},
	{
		// The layer 8 round trip restores into the world that made the bytes, so the
		// names always match there. The probe restores into a world with another
		// store of the same width, which only the name tells apart.
		id: "the-restore-ignores-the-store-names",
		what: "a restore matches the storage sections by count alone",
		find: `    for (let i = 0; same && i < live.length; i++) same = entries[i].name === live[i].name;`,
		to: `    void live;`
	},
	{
		id: "the-restore-skips-a-store-validate",
		what: "a restore never lets a store refuse its own section",
		find: `          provider.validate(entries[i].bytes);`,
		to: `          void entries;`
	},
	{
		// A store that restores before the dense mount reads the world as it was
		// before the restore. The probe's store asks for an entity that died after
		// the capture.
		id: "the-restore-mounts-the-stores-first",
		what: "a restore hands each store its section before it mounts the world",
		find: `    const storageSections = this._matchStorageSections(sections.storage);`,
		to: `    const storageSections = this._matchStorageSections(sections.storage);
    for (const s of storageSections) s.provider.restore(s.bytes);`
	},
	{
		id: "a-store-refusal-escapes-as-a-plain-error",
		what: "a store's own refusal leaves restore as the store's error, not an ECSRestoreError",
		find: `          if (err instanceof ECSRestoreError) throw err;`,
		to: `          throw err;`
	},
	{
		id: "the-restore-refuses-the-legacy-frame",
		what: "a restore refuses a frame of version 1",
		find: `  if (version !== ECS_SNAPSHOT_VERSION && version !== LEGACY_ECS_SNAPSHOT_VERSION) {`,
		to: `  if (version !== ECS_SNAPSHOT_VERSION) {`
	},
	{
		// Skips the store, so the match sees none of it. Only the explicit
		// refusal names a store with no capture.
		id: "the-restore-keeps-a-store-with-no-capture",
		what: "a restore passes over a store with no capture and leaves its data",
		find: `      if (storages[i].capture === void 0) {`,
		to: `      if (storages[i].capture === void 0) {
        continue;`
	},
	{
		id: "a-second-store-of-one-name-registers",
		what: "registerStorage takes a second store of one name",
		find: `      if (this._storages[i].name === name) {`,
		to: `      if (false) {`
	},
	{
		id: "a-half-store-registers",
		what: "registerStorage takes a store with capture and no restore",
		find: `    if (provider.capture === void 0 !== (provider.restore === void 0)) {`,
		to: `    if (false) {`
	},
	// ── the access domains ──────────────────────────────────────────────────
	// Each one names a check that a development build alone runs, so each carries
	// `devOnly`. A production build compiles the check out, and the probe reads
	// there that the access went through.
	{
		// `net-aos` declares its two domains in `domainWrites` alone and reads
		// `Kin`, so the net throws first. That is an engine error: the fault is
		// fatal, and the probe of the storage seam is the layer that names it.
		id: "a-domain-write-implies-no-read",
		what: "a domain in domainWrites does not grant its read",
		devOnly: true,
		find: `      domainReads.add(domainW[i]);`,
		to: `      void 0;`
	},
	{
		id: "a-domain-write-checks-the-read-set",
		what: "a domain write passes where the system declared the read alone",
		devOnly: true,
		find: `    if (this._activeSets.domainWrites.has(domain)) return;`,
		to: `    if (this._activeSets.domainReads.has(domain)) return;`
	},
	{
		id: "a-domain-read-is-never-refused",
		what: "a domain read passes in a system that declared nothing",
		devOnly: true,
		find: `    if (this._activeSets.domainReads.has(domain)) return;`,
		to: `    return;`
	},
	{
		id: "a-run-condition-drops-its-domain-reads",
		what: "a run condition's domainReads authorise nothing",
		devOnly: true,
		find: `    for (let i = 0; i < cond.domainReads.length; i++) domainReads.add(cond.domainReads[i]);`,
		to: `    void cond;`
	},
	{
		id: "a-combinator-drops-domain-reads",
		what: "runIfAll carries no domainReads of its operands",
		devOnly: true,
		find: `    if (c.domainReads) domainReads.push(...c.domainReads);`,
		to: `    void c;`
	},
	{
		id: "registration-drops-the-domain-reads",
		what: "a system's domainReads never reach its descriptor",
		devOnly: true,
		find: `    domainReads: config.domainReads,`,
		to: `    domainReads: void 0,`
	},
	{
		id: "the-domain-read-never-asks-the-checker",
		what: "AccessDomain.assertRead never calls the access checker",
		devOnly: true,
		find: `      if (DEV) accessCheck.assertDomainRead(domain);`,
		to: `      if (false) accessCheck.assertDomainRead(domain);`
	}
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
		args: ["--net=random:3,30,18,20", "--steps=4000", "--batch=8", "--verify=2", "--snap=32"]
	},
	// the two large cases keep the fingerprint at each tick, which is what names the
	// tick of a fault in a large archetype, and they give the checkpoints inside a
	// tick a cadence: each checkpoint is one more scan of each agent, and the battery
	// must stay fast.
	{
		name: "erase:14",
		args: ["--net=erase:14", "--batch=32", "--verify=8", "--snap=0", "--phase=8"]
	},
	{
		name: "grow:2",
		args: [
			"--net=random:2,24,24,12",
			"--steps=20000",
			"--batch=32",
			"--verify=16",
			"--snap=0",
			"--phase=8"
		]
	},
	// the float arm. `Mix.mf32` and `Mix.bf32` exist in this arm alone, so a fault in
	// the `f32` path of the row plane has no other case that can show it.
	{ name: "float:dup6", args: ["--net=dup:6", "--float", "--batch=4", "--verify=1", "--snap=0"] },
	// the arms for the layout of the memory. Each case above runs at a store base of
	// 0, and under the default cap. A fault in either one is inert there.
	{ name: "memory", args: ["--memory"] },
	// the pool. Each case above runs one thread, so a fault in the host half of the
	// pool is inert there. The worker itself runs the sources of the tree, and a
	// mutant lives in the bundle. So this case reads the host half alone.
	{ name: "workers", args: ["--workers"] },
	// the probes of the API surface. This case is last for a reason: each case above
	// keeps the mechanism that it had, and this case adds the parts of the API that no
	// simulation reaches. Before this case, each case named a `--net=`. Therefore
	// `surface.mjs` never ran against a mutant, and no probe in it had evidence that
	// it can fail.
	{ name: "surface", args: ["--surface"] }
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
	const lines = out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const i = lines.findIndex((l) => l === "DIVERGENCE");
	if (i >= 0 && lines[i + 1]) return { by: "oracle", why: lines[i + 1] };
	// `fail()` throws a plain `Error` whose message names the case, the tick and the
	// layer in brackets. The harness's own observer bookkeeping throws with an
	// `observer:` prefix. Both are the oracle finding the fault.
	const harness = lines.find(
		(l) => /^Error: .*\[(ecs|ref|prov)[^\]]*\]:/.test(l) || l.startsWith("Error: observer:")
	);
	if (harness !== undefined) return { by: "oracle", why: harness };
	const err = lines.find((l) => /Error:|error:/.test(l));
	return { by: "engine", why: err ?? lines[lines.length - 1] ?? "(no output)" };
}

// ── sanity: the unmutated bundle must pass the whole battery ────────────────
console.log(`mutation test, ${PROD ? "production" : "development"} build, baseline first\n`);
for (const c of BATTERY) {
	const r = runOracle(base, c.args);
	if (!r.ok) {
		console.error(`BASELINE FAILED on ${c.name}, fix the harness before trusting mutants`);
		console.error(r.out);
		process.exit(1);
	}
	console.log(`  baseline ${c.name.padEnd(12)} pass`);
}

// ── run every mutant ────────────────────────────────────────────────────────
console.log(
	`\n${ONLY === null ? MUTANTS.length : ONLY.size} mutants x ${BATTERY.length} cases` +
		`${ONLY === null ? "" : "  (--only)"}\n`
);
const escaped = [];
const skipped = [];
const byMechanism = { oracle: [], engine: [] };
for (const m of MUTANTS) {
	if (ONLY !== null && !ONLY.has(m.id)) continue;
	// A mutant that names a guard of a development build cannot fire in a
	// production build. The flag is false there, so the branch and the mutation are
	// both inert. A skip is the honest result, and an escape is not.
	if (PROD && m.devOnly === true) {
		skipped.push(m.id);
		console.log(`  skipped  ${m.id.padEnd(28)} names a guard that a production build does not run`);
		continue;
	}
	const hits = baseSrc.split(m.find).length - 1;
	if (hits !== 1) {
		console.error(
			`  ${m.id}: pattern matched ${hits}x in the bundle (want exactly 1), mutant is stale`
		);
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
			`  ${caughtBy.by === "oracle" ? "oracle " : "engine "} ${m.id.padEnd(28)} by ${caughtBy.case}`
		);
		console.log(`           ${" ".repeat(28)} ${caughtBy.why.slice(0, 140)}`);
	}
}

console.log("");
// Both counts, always. "14 of 14 caught" is true and it is not the whole answer:
// the mutants that only the engine found say nothing about the layers of the
// oracle, and one of them needs a guard that the released package removes.
const selected = ONLY === null ? MUTANTS : MUTANTS.filter((m) => ONLY.has(m.id));
if (ONLY !== null) {
	const unknown = [...ONLY].filter((id) => !MUTANTS.some((m) => m.id === id));
	if (unknown.length > 0) {
		console.error(`\n--only names no such mutant: ${unknown.join(", ")}`);
		process.exit(1);
	}
}
const ran = selected.length - skipped.length;
console.log(
	`${byMechanism.oracle.length}/${ran} caught by an ORACLE layer, ` +
		`${byMechanism.engine.length}/${ran} caught by an ENGINE error, ` +
		`${escaped.length} escaped   (${PROD ? "production" : "development"} build)`
);
if (skipped.length > 0) {
	console.log(`  skipped: ${skipped.join(", ")}`);
	console.log(`  Each one names a guard that a production build does not run.`);
}
if (byMechanism.engine.length > 0) {
	console.log(`  engine-caught: ${byMechanism.engine.join(", ")}`);
	console.log(`  These prove that the bug is fatal. They do not prove that the oracle sees it.`);
}
if (escaped.length > 0) {
	console.error(`\n${escaped.length}/${ran} mutants ESCAPED, the oracle has blind spots:`);
	for (const e of escaped) console.error(`  ${e.id}: ${e.what} (${e.why})`);
	process.exit(1);
}
console.log(`ok, all ${ran} mutants caught`);
