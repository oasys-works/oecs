/**
 * The reference net. This is the model half of the oracle.
 *
 * It uses flat typed arrays and a LIFO free list. This representation is the most
 * simple representation that is possible, and this is intentional: it has no
 * archetypes, no relations, no observers, and no deferred operation. Its sequence for
 * the recycling of a slot does not need to be equal to the sequence of the ECS,
 * because the driver keeps a bijection of the ids between the two nets.
 *
 * This file also holds `Fresh` and `Age`, because the ECS holds them as components.
 * In the ECS, an add or a remove of those components is a true archetype transition.
 * `world.mjs` gives the reason that they exist.
 */
import { MAX_PORTS, NO_SLOT, PORTS, ROOT, TYPE_NAME, reduces } from "./spec.mjs";

const DEAD = -1;

export class RefNet {
	constructor(cap = 1024) {
		this._cap = cap;
		this._type = new Int8Array(cap).fill(DEAD);
		this._tgt = new Int32Array(cap * MAX_PORTS).fill(DEAD);
		this._slot = new Uint8Array(cap * MAX_PORTS).fill(NO_SLOT);
		this._free = [];
		this._next = 0;
		this.live = 0;
		this.loops = 0;
		/** Ids created since the last `takeCreated()` — the driver zips these
		 * against the ECS's to extend the id bijection. */
		this.created = [];
		this._fresh = new Set();
		this._age = new Map();
		// Incremental active-pair index. `redexes()` below is the full O(n) scan and
		// stays the authority — this exists only so redex *selection* is O(1) instead
		// of O(live) per rewrite, which is the difference between a thousand-rewrite
		// run and a ten-million-rewrite one. `assertRedexIndex` re-derives it from
		// the scan at every verification point, so it is checked, not trusted.
		this._dirty = new Set();
		this._rxA = [];
		this._rxB = [];
		this._rxOf = new Map(); // agent -> index into _rxA/_rxB (each agent is in <=1 pair)
	}

	// ── spec adapter ────────────────────────────────────────────────────────
	typeOf(a) {
		return this._type[a];
	}
	getLink(a, p) {
		const i = a * MAX_PORTS + p;
		return [this._tgt[i], this._slot[i]];
	}
	setLink(a, p, b, q) {
		const i = a * MAX_PORTS + p;
		const j = b * MAX_PORTS + q;
		this._tgt[i] = b;
		this._slot[i] = q;
		this._tgt[j] = a;
		this._slot[j] = p;
		this._dirty.add(a);
		this._dirty.add(b);
	}
	createAgent(type) {
		const id = this._free.length > 0 ? this._free.pop() : this._next++;
		if (id >= this._cap) this._grow(id + 1);
		this._type[id] = type;
		for (let p = 0; p < MAX_PORTS; p++) {
			this._tgt[id * MAX_PORTS + p] = DEAD;
			this._slot[id * MAX_PORTS + p] = NO_SLOT;
		}
		this.live++;
		this.created.push(id);
		this._fresh.add(id);
		this._dirty.add(id);
		return id;
	}
	destroyAgent(a) {
		this._type[a] = DEAD;
		for (let p = 0; p < MAX_PORTS; p++) {
			this._tgt[a * MAX_PORTS + p] = DEAD;
			this._slot[a * MAX_PORTS + p] = NO_SLOT;
		}
		this._free.push(a);
		this.live--;
		this._fresh.delete(a);
		this._age.delete(a);
		this._dirty.add(a);
	}
	settle() {
		/* nothing is deferred here */
	}
	onLoop() {
		this.loops++;
	}

	// ── growth ──────────────────────────────────────────────────────────────
	_grow(need) {
		let cap = this._cap;
		while (cap < need) cap *= 2;
		const type = new Int8Array(cap).fill(DEAD);
		type.set(this._type);
		const tgt = new Int32Array(cap * MAX_PORTS).fill(DEAD);
		tgt.set(this._tgt);
		const slot = new Uint8Array(cap * MAX_PORTS).fill(NO_SLOT);
		slot.set(this._slot);
		this._type = type;
		this._tgt = tgt;
		this._slot = slot;
		this._cap = cap;
	}

	takeCreated() {
		const c = this.created;
		this.created = [];
		return c;
	}

	// ── loading ─────────────────────────────────────────────────────────────
	static load(spec) {
		const net = new RefNet(Math.max(1024, spec.types.length * 2));
		for (const t of spec.types) net.createAgent(t);
		for (const [a, pa, b, pb] of spec.wires) net.setLink(a, pa, b, pb);
		net.takeCreated();
		// The initial net is not "fresh" in the churn sense — it predates tick 0,
		// and the ECS loads it host-side where no observer fires. Both sides start
		// from the same baseline: everything aged 0, nothing fresh.
		net._fresh.clear();
		for (let a = 0; a < net._next; a++) if (net._type[a] !== DEAD) net._age.set(a, 0);
		net.settleRedex();
		return net;
	}

	// ── per-tick component maintenance (mirrors `world.mjs`) ────────────────
	//
	// Split into two calls, in the same relative order as the two ECS systems that
	// do this work — promotion in PRE_UPDATE, ageing in POST_UPDATE. The split is
	// not cosmetic: it is what leaves an agent carrying `Fresh` across the tick
	// boundary where the oracle compares, so `Fresh` is actually checked instead of
	// being promoted away before anyone looks.

	/** Promote agents that were created during the PREVIOUS tick to `Age(0)`.
	 * Mirrors the PRE_UPDATE system. */
	promoteFresh() {
		for (const a of this._fresh) this._age.set(a, 0);
		this._fresh.clear();
	}

	/** Bump every agent that carries `Age`. Mirrors the POST_UPDATE system; agents
	 * created this tick have no `Age` yet and so are correctly skipped. */
	ageTick() {
		for (const [a, t] of this._age) this._age.set(a, t + 1);
	}
	isFresh(a) {
		return this._fresh.has(a);
	}
	ageOf(a) {
		return this._age.has(a) ? this._age.get(a) : null;
	}

	// ── reads the oracle compares against ───────────────────────────────────
	// ── incremental active-pair index ───────────────────────────────────────
	_rxAdd(a, b) {
		const i = this._rxA.length;
		this._rxA.push(a);
		this._rxB.push(b);
		this._rxOf.set(a, i);
		this._rxOf.set(b, i);
	}
	_rxRemoveAt(i) {
		this._rxOf.delete(this._rxA[i]);
		this._rxOf.delete(this._rxB[i]);
		const last = this._rxA.length - 1;
		if (i !== last) {
			const la = this._rxA[last];
			const lb = this._rxB[last];
			this._rxA[i] = la;
			this._rxB[i] = lb;
			this._rxOf.set(la, i);
			this._rxOf.set(lb, i);
		}
		this._rxA.pop();
		this._rxB.pop();
	}

	/**
	 * Bring the active-pair index up to date after a batch of link edits.
	 *
	 * A pair's status depends only on its two members' principal links and types,
	 * and every write to either marks the agent dirty — so tearing down each pair
	 * that touches a dirty agent and re-deriving from the union of (dirty agents ∪
	 * their ex-partners) is exact. Ex-partners matter because a torn-down pair
	 * leaves its other member unindexed even though it was never itself dirty.
	 */
	settleRedex() {
		if (this._dirty.size === 0) return;
		const work = this._dirty;
		this._dirty = new Set();
		const partners = [];
		for (const a of work) {
			const i = this._rxOf.get(a);
			if (i === undefined) continue;
			partners.push(this._rxA[i], this._rxB[i]);
			this._rxRemoveAt(i);
		}
		for (const x of partners) work.add(x);
		for (const a of work) {
			if (this._type[a] === DEAD) continue;
			if (this._rxOf.has(a)) continue; // already indexed via its partner
			const b = this._tgt[a * MAX_PORTS];
			if (b === DEAD || this._slot[a * MAX_PORTS] !== 0) continue;
			if (this._type[b] === DEAD) continue;
			if (!reduces(this._type[a], this._type[b])) continue;
			this._rxAdd(a < b ? a : b, a < b ? b : a);
		}
	}

	get redexCount() {
		return this._rxA.length;
	}

	/** Pick an active pair. `rand` decides which, so the reduction ORDER is a
	 * function of the seed — which is exactly the knob the confluence check turns. */
	pickRedex(rand) {
		const i = (rand() * this._rxA.length) | 0;
		return [this._rxA[i], this._rxB[i]];
	}

	/** Re-derive the incremental index from the full scan and compare. */
	assertRedexIndex(where) {
		const want = this.redexes()
			.map(([a, b]) => `${a},${b}`)
			.sort();
		const got = this._rxA.map((a, i) => `${a},${this._rxB[i]}`).sort();
		if (want.length !== got.length || want.some((v, i) => v !== got[i])) {
			throw new Error(
				`${where}: ref redex index [${got}] disagrees with full scan [${want}]`
			);
		}
	}

	/** Every active pair, as `[a, b]` with `a < b`, in ascending `a` order. */
	redexes() {
		const out = [];
		for (let a = 0; a < this._next; a++) {
			const ta = this._type[a];
			if (ta === DEAD) continue;
			const b = this._tgt[a * MAX_PORTS];
			// principal-to-principal only, and taken once per pair
			if (this._slot[a * MAX_PORTS] !== 0 || b < a) continue;
			if (!reduces(ta, this._type[b])) continue;
			out.push([a, b]);
		}
		return out;
	}

	/** Live agent ids, ascending. */
	liveAgents() {
		const out = [];
		for (let a = 0; a < this._next; a++) if (this._type[a] !== DEAD) out.push(a);
		return out;
	}

	census() {
		const c = [0, 0, 0, 0];
		for (let a = 0; a < this._next; a++) if (this._type[a] !== DEAD) c[this._type[a]]++;
		return c;
	}

	/**
	 * Self-check: every live port is wired to a live port that wires back.
	 *
	 * This validates the SHARED rewrite spec without reference to the ECS — if the
	 * wire-chasing in `applyRewrite` were wrong, it would show up here first, and
	 * a shared-spec bug is the one failure mode a two-implementation oracle cannot
	 * otherwise see.
	 */
	assertConsistent(where) {
		for (let a = 0; a < this._next; a++) {
			const ta = this._type[a];
			if (ta === DEAD) continue;
			for (let p = 0; p < MAX_PORTS; p++) {
				const i = a * MAX_PORTS + p;
				const b = this._tgt[i];
				const q = this._slot[i];
				if (p >= PORTS[ta]) {
					if (b !== DEAD || q !== NO_SLOT) {
						throw new Error(`${where}: ref agent ${a} (${TYPE_NAME[ta]}) port ${p} should not exist`);
					}
					continue;
				}
				if (b === DEAD) throw new Error(`${where}: ref agent ${a} port ${p} unwired`);
				if (this._type[b] === DEAD) {
					throw new Error(`${where}: ref agent ${a} port ${p} -> dead agent ${b}`);
				}
				if (q >= PORTS[this._type[b]]) {
					throw new Error(`${where}: ref agent ${a} port ${p} -> ${b} port ${q}, which does not exist`);
				}
				const j = b * MAX_PORTS + q;
				if (this._tgt[j] !== a || this._slot[j] !== p) {
					throw new Error(
						`${where}: ref link not symmetric: ${a}:${p} -> ${b}:${q} but ${b}:${q} -> ${this._tgt[j]}:${this._slot[j]}`
					);
				}
			}
		}
	}

	/**
	 * Canonical encoding of the part of the net reachable from ROOT, up to
	 * isomorphism: BFS from ROOT visiting ports in index order, renumbering agents
	 * by first visit. Two nets with the same string are the same net regardless of
	 * how their ids were allocated — which is what lets the rewrite-count
	 * invariance check compare normal forms produced under different reduction
	 * orders.
	 */
	canonical() {
		let root = -1;
		for (let a = 0; a < this._next; a++) {
			if (this._type[a] === ROOT) {
				root = a;
				break;
			}
		}
		if (root === -1) return { form: "<no root>", reachable: 0, unreachable: this.live };
		const idx = new Map();
		const order = [];
		const push = (a) => {
			if (a !== DEAD && !idx.has(a)) {
				idx.set(a, order.length);
				order.push(a);
			}
		};
		push(root);
		// Index assignment pass — BFS, ports in order, so numbering is canonical.
		for (let i = 0; i < order.length; i++) {
			const a = order[i];
			for (let p = 0; p < PORTS[this._type[a]]; p++) push(this._tgt[a * MAX_PORTS + p]);
		}
		// Emission pass — every index is now known.
		const parts = [];
		for (let i = 0; i < order.length; i++) {
			const a = order[i];
			const ta = this._type[a];
			const links = [];
			for (let p = 0; p < PORTS[ta]; p++) {
				const j = a * MAX_PORTS + p;
				links.push(`${idx.get(this._tgt[j])}.${this._slot[j]}`);
			}
			parts.push(`${TYPE_NAME[ta]}[${links.join(" ")}]`);
		}
		return {
			form: parts.join(" "),
			reachable: order.length,
			unreachable: this.live - order.length,
		};
	}
}
