/**
 * The reference model for the provenance layer. This is the model half of the oracle
 * for the part of the relation API that the net itself does not use.
 *
 * The ports of the net are *exclusive* relations with `onDeleteTarget: "clear"`.
 * Therefore four documented behaviours have no test. For all four, a bug gives no
 * error message:
 *
 *   - **sets of targets on a multi relation** — the order from `targetsOf`, and a set
 *     of targets that becomes smaller because a *target* died, and not because the
 *     source made a change;
 *   - **the `"delete"` cascade** — the destruction of one entity destroys other
 *     entities indirectly, and the ECS must also call `onRemove` for each of them;
 *   - **`"orphan"` with `relations.compact()`** — the documented growth of the
 *     reverse index, its reclaim count, and the guarantee that the compaction
 *     changes nothing else;
 *   - **the helpers that do a traversal** — `ancestorsOf`, `rootOf`, `cascadeOf` and
 *     `hierarchy`.
 *
 * An audit log that keeps its records by epoch uses all four naturally. There is one
 * **record** for each rewrite. Each record has an `InEpoch` relation to an **epoch**
 * (exclusive, `"delete"`), and it holds the agents that it `Produced` (multi,
 * `"clear"`). Each epoch has an `EpochAncestors` relation to the earlier epochs
 * (multi, `"orphan"`). The model keeps a fixed window of epochs, and it despawns the
 * others. Therefore we know exactly which entities the cascade destroys, we know
 * exactly the reclaim count of the reverse index, and the live population has a
 * limit.
 *
 * The key of an epoch is an **index that only increases**, and it is not an entity
 * id. The key of a record is a serial number that only increases. These keys make a
 * model of the orphan policy possible. The orphan policy is *about* dead handles. A
 * model that recycled ids, as the ECS does, cannot find the difference between a dead
 * handle and a handle that it used again.
 */

export class RefProv {
	constructor({ epochEvery, retain }) {
		this.epochEvery = epochEvery;
		this.retain = retain;
		/** epochIndex -> { alive, ancestors: epochIndex[] } — never pruned, so a dead
		 * handle stays distinguishable from a recycled one. */
		this.epochs = new Map();
		this.liveEpochs = []; // indices, ascending — the retention window
		this.currentEpoch = -1;
		this.nextEpoch = 0;
		/** serial -> { rule, epoch, produced: Set<refAgentId> } */
		this.records = new Map();
		this.recordsByEpoch = new Map(); // epochIndex -> Set<serial>
		this.producedBy = new Map(); // refAgentId -> Set<serial>
		this.nextRecord = 0;
		/** Dead orphan targets whose reverse-index key has already been reclaimed.
		 * `compact()` is idempotent, so the expected count has to net these out. */
		this.compacted = new Set();
		this.stats = {
			epochsCreated: 0,
			epochsPruned: 0,
			recordsCreated: 0,
			recordsCascaded: 0,
			compactReclaimed: 0,
			maxLiveRecords: 0,
			maxProducedSet: 0,
		};
	}

	// ── the per-tick epoch roll (mirrors the ECS's PRE_UPDATE system) ────────
	/**
	 * On an epoch boundary: open a new epoch listing every currently-live epoch as
	 * an ancestor, then prune the window back to `retain`, cascade-destroying each
	 * pruned epoch's records. Returns `null` on a non-boundary tick.
	 */
	roll(tick) {
		if (tick % this.epochEvery !== 0) return null;
		const idx = this.nextEpoch++;
		this.epochs.set(idx, { alive: true, ancestors: [...this.liveEpochs] });
		this.liveEpochs.push(idx);
		this.currentEpoch = idx;
		this.stats.epochsCreated++;
		const pruned = [];
		while (this.liveEpochs.length > this.retain) {
			const old = this.liveEpochs.shift();
			this.epochs.get(old).alive = false;
			pruned.push(old);
			this.stats.epochsPruned++;
			// The `"delete"` cascade: every record in that epoch goes with it.
			const victims = this.recordsByEpoch.get(old);
			if (victims !== undefined) {
				for (const serial of [...victims]) this._dropRecord(serial);
				this.recordsByEpoch.delete(old);
			}
		}
		return { created: idx, pruned };
	}

	_dropRecord(serial) {
		const rec = this.records.get(serial);
		if (rec === undefined) return;
		for (const a of rec.produced) {
			const set = this.producedBy.get(a);
			if (set !== undefined) {
				set.delete(serial);
				if (set.size === 0) this.producedBy.delete(a);
			}
		}
		this.records.delete(serial);
		this.recordsByEpoch.get(rec.epoch)?.delete(serial);
		this.stats.recordsCascaded++;
	}

	// ── per-rewrite records ─────────────────────────────────────────────────
	/** Log one rewrite. `produced` is the reference agent ids the rule created. */
	addRecord(rule, produced) {
		if (this.currentEpoch < 0) return null;
		const serial = this.nextRecord++;
		const set = new Set(produced);
		this.records.set(serial, { rule, epoch: this.currentEpoch, produced: set });
		for (const a of set) {
			let by = this.producedBy.get(a);
			if (by === undefined) {
				by = new Set();
				this.producedBy.set(a, by);
			}
			by.add(serial);
		}
		let byE = this.recordsByEpoch.get(this.currentEpoch);
		if (byE === undefined) {
			byE = new Set();
			this.recordsByEpoch.set(this.currentEpoch, byE);
		}
		byE.add(serial);
		this.stats.recordsCreated++;
		if (set.size > this.stats.maxProducedSet) this.stats.maxProducedSet = set.size;
		if (this.records.size > this.stats.maxLiveRecords) {
			this.stats.maxLiveRecords = this.records.size;
		}
		return serial;
	}

	/**
	 * Mirrors `onDeleteTarget: "clear"` on `Produced`: when an agent dies, it drops
	 * out of every record's target set. Note the direction — the record is the
	 * *source* and survives; it is the ECS's job to shrink its set, and nothing the
	 * record itself does causes it.
	 */
	onAgentDeath(refId) {
		const by = this.producedBy.get(refId);
		if (by === undefined) return;
		for (const serial of by) this.records.get(serial)?.produced.delete(refId);
		this.producedBy.delete(refId);
	}

	// ── reads the oracle compares against ───────────────────────────────────
	liveRecords() {
		return [...this.records.keys()].sort((a, b) => a - b);
	}

	/** Records in `epochIndex`, ascending by serial. */
	recordsIn(epochIndex) {
		return [...(this.recordsByEpoch.get(epochIndex) ?? [])].sort((a, b) => a - b);
	}

	/**
	 * The number of dead-target reverse-index keys `relations.compact()` should
	 * reclaim: a dead epoch that at least one **live** epoch still lists as an
	 * ancestor, minus those already reclaimed.
	 *
	 * Only the orphan relation can contribute. Under `"clear"` a dying target
	 * unlinks every source, which empties and deletes its reverse key; under
	 * `"delete"` the sources die with it; and a dying *source* is purged from every
	 * reverse set, so a live target never holds a dead source.
	 */
	pendingOrphanKeys() {
		const dead = new Set();
		for (const idx of this.liveEpochs) {
			for (const a of this.epochs.get(idx).ancestors) {
				if (!this.epochs.get(a).alive && !this.compacted.has(a)) dead.add(a);
			}
		}
		return dead;
	}

	/** Record that `compact()` has reclaimed the currently-pending orphan keys. */
	noteCompacted(keys) {
		for (const k of keys) this.compacted.add(k);
		this.stats.compactReclaimed += keys.size;
	}

	/**
	 * A snapshot restore resurrects every reclaimed orphan key, so drop the
	 * already-compacted set.
	 *
	 * This is documented behaviour rather than a leak, and it is worth stating
	 * because it is genuinely surprising: the reverse index is *derived*, so
	 * `restore` rebuilds it from the surviving **forward** links — and under
	 * `"orphan"` those still carry the dangling dead handles by design. A
	 * `compact()` therefore does not survive a snapshot round-trip. The oracle only
	 * found this because it asserted the reclaim count exactly; a `>= 0` check would
	 * have sailed past it.
	 */
	noteRestored() {
		this.compacted.clear();
	}

	/** `cascadeOf(epoch, InEpoch)` should be the epoch followed by its records —
	 * breadth-first, parents before children. Chains here are depth 1. */
	expectedCascade(epochIndex) {
		return this.recordsIn(epochIndex);
	}
}
