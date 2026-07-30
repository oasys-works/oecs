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
 *
 * It holds four more facts. Each one has one purpose: to be the model for a
 * mechanism that the net alone does not reach.
 *
 *   - `Touch.seq` — a count of the times a `setLink` used this agent as an endpoint.
 *     This file increases the count in its OWN `setLink`. Therefore the set of agents
 *     that a tick writes comes from this file, and it does not come from the ECS.
 *     That set is the expected value for an `onSet` observer with the granularity of
 *     an entity, and for a `changed()` query. Refer to `driver.mjs::changeCheck`.
 *   - `disabled` — the quarantine. A default query must not show a disabled agent.
 *     Therefore a disabled agent must not age, and it must keep `Fresh`.
 *     `promoteFresh` and `ageTick` below copy that rule. `compare()` then compares
 *     `Age.ticks`, and that comparison is the proof that the row partition of the ECS
 *     kept the row out of `eachChunk`.
 *   - `_quar` — the value of the `Quar.count` column. The HOST writes that column
 *     through the write seam, and not a system. Therefore the comparison of the value
 *     is the check on the `set_field` command of the seam.
 *   - `refSignature` — the archetype of an agent, as a string. This file knows the
 *     five facts that select the archetype: the tag for the type, `Redex`, `Fresh`,
 *     `Age` and `Tainted`. Therefore it can say which archetypes a tick must report
 *     as changed.
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
		/** refId -> `Touch.seq`. This is the count of the times a `setLink` used the
		 * agent as an endpoint. The ECS keeps the same count through
		 * `ctx.updateField`. Therefore `compare()` compares the value, and
		 * `driver.changeCheck` compares the SET of agents that a tick wrote. */
		this._touch = new Map();
		/** The agents whose `Touch` this tick wrote, until `takeTouched()`. */
		this.touched = new Set();
		/** The quarantine: the agents that the harness disabled. A default query does
		 * not show a disabled agent. Therefore it must not age, and it must keep
		 * `Fresh`. */
		this.disabled = new Set();
		/** refId -> `Quar.count`. This is the count of the times the quarantine
		 * disabled the agent. The HOST writes the same column, through
		 * `queue.setField` on the write seam, so `compare()` compares the value. The
		 * column is a `u8`, so the count wraps at 256. */
		this._quar = new Map();
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
		// This is the model of "which agents did this tick write". It counts both
		// endpoints, because the adapter in `world.mjs` writes `Touch` on both.
		this._bumpTouch(a);
		this._bumpTouch(b);
	}
	_bumpTouch(a) {
		this._touch.set(a, (this._touch.get(a) ?? 0) + 1);
		this.touched.add(a);
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
		// A new row starts at zero. The ECS attaches `Touch` with the same value. An
		// ATTACH does not mark the dirty list for the row; only `setField` and
		// `updateField` do that. Therefore this code does not put a new agent in
		// `touched`. `applyRewrite` wires each port of each agent that it creates, so
		// the `setLink` calls that come after add the agent through the same path that
		// an older agent uses.
		this._touch.set(id, 0);
		this._quar.set(id, 0);
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
		this._touch.delete(a);
		// A dead row leaves the model of the change detection. The dispatch of the
		// per-entity `onSet` in the ECS also drops a dead entity from its dirty list.
		// Refer to `driver.mjs::changeCheck`.
		this.touched.delete(a);
		// A dead entity is not disabled. The ECS gives a new generation to a recycled
		// id, and that new entity starts enabled.
		this.disabled.delete(a);
		this._quar.delete(a);
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

	/** Give `Age(0)` to each agent that the PREVIOUS tick created. This is the model
	 * of the system in UPDATE that runs before the rewrites.
	 *
	 * A DISABLED agent keeps `Fresh`. The ECS system reads `qFresh`, which is a
	 * default query, and a default query does not show a disabled row. Therefore this
	 * skip is not a rule of the harness. It is the behaviour that the row partition
	 * of the ECS must give, and `compare()` reads `Fresh` at each tick.
	 *
	 * The skip does work only because the ECS system is in UPDATE. A `disable` from
	 * the write seam lands at the flush at the end of PRE_UPDATE. With the promotion
	 * in PRE_UPDATE, no agent is `Fresh` and disabled at one time, and this rule has
	 * no test. `freshDisabledCount` below is the floor that keeps the state
	 * reachable. */
	promoteFresh() {
		const go = [];
		for (const a of this._fresh) if (!this.disabled.has(a)) go.push(a);
		for (const a of go) {
			this._age.set(a, 0);
			this._fresh.delete(a);
		}
	}

	/** Bump every agent that carries `Age`. Mirrors the POST_UPDATE system. An agent
	 * that this tick created has no `Age` yet, so this code correctly skips it.
	 *
	 * A DISABLED agent does not age, for the reason that `promoteFresh` gives: the
	 * ECS system uses `qAge.eachChunk`, and that loop stops at `entityCount`, which
	 * excludes the disabled rows. `compare()` compares `Age.ticks` exactly. Therefore
	 * a disabled row that the loop still visits gives a divergence at the next tick. */
	ageTick() {
		for (const [a, t] of this._age) if (!this.disabled.has(a)) this._age.set(a, t + 1);
	}
	isFresh(a) {
		return this._fresh.has(a);
	}
	/**
	 * The count of the agents that are `Fresh` AND disabled now.
	 *
	 * `promoteFresh` must keep `Fresh` on each one. `qFresh` in the ECS is a default
	 * query, and a default query does not show a disabled row. The floor for
	 * non-vacuity reads this number, and it needs to. The state occurs only because
	 * the promotion runs in UPDATE, which is one phase AFTER the flush where a
	 * deferred `disable` lands. With the promotion in PRE_UPDATE, the count is always
	 * zero. An assertion about a state that cannot occur shows nothing.
	 */
	freshDisabledCount() {
		let n = 0;
		for (const a of this._fresh) if (this.disabled.has(a)) n++;
		return n;
	}
	ageOf(a) {
		return this._age.has(a) ? this._age.get(a) : null;
	}
	touchOf(a) {
		return this._touch.get(a);
	}
	quarOf(a) {
		return this._quar.get(a);
	}
	isDisabled(a) {
		return this.disabled.has(a);
	}

	// ── the quarantine (mirrors the host write seam in `world.mjs`) ──────────
	/**
	 * Apply one quarantine plan. The driver makes the plan from its seed, and it
	 * gives the same plan to both sides.
	 *
	 * `plan.churn` is a list of agents that go disable, then enable, then disable
	 * again, in ONE drain. The ECS must collapse that sequence to one `onDisable`
	 * call, because an observer fires one time for each NET transition. This model
	 * therefore applies the last state only, which is "disabled".
	 */
	applyQuarantine(plan) {
		if (plan === null) return;
		for (const a of plan.enable) if (this._type[a] !== DEAD) this.disabled.delete(a);
		for (const a of plan.disable) {
			if (this._type[a] !== DEAD) this.disabled.add(a);
		}
		for (const a of plan.churn) {
			if (this._type[a] !== DEAD) this.disabled.add(a);
		}
		// The count that the host writes into the `u8` column. The plan carries the
		// new value, so both sides write one number and neither derives it twice.
		for (const [a, n] of plan.count) if (this._type[a] !== DEAD) this._quar.set(a, n);
	}

	/** The agents that a default query must show: live, and not disabled. */
	enabledAgents() {
		const out = [];
		for (let a = 0; a < this._next; a++) {
			if (this._type[a] !== DEAD && !this.disabled.has(a)) out.push(a);
		}
		return out;
	}

	// ── the model of the archetype ──────────────────────────────────────────
	/**
	 * The archetype of an agent, as a string. It must be equal to the string that
	 * `world.archetypeSignatures` makes from the ECS.
	 *
	 * Five facts select the archetype of an agent: the tag for the type, `Redex`,
	 * `Fresh`, `Age` and `Tainted`. `Slot`, `Touch` and `Quar` are on each agent, so
	 * they do not change the string. `Redex` comes from the index of the active pairs,
	 * and `assertRedexIndex` re-derives that index from a full scan at each
	 * verification point. `Tainted` is present if and only if the agent is disabled,
	 * because the host adds and removes the tag with the same command that toggles the
	 * row. Therefore this string is a model, and it is not a copy of the ECS.
	 */
	refSignature(a) {
		const t = this._type[a];
		return (
			`${TYPE_NAME[t]}|${this._rxOf.has(a) ? "R" : ""}` +
			`${this._fresh.has(a) ? "F" : ""}${this._age.has(a) ? "A" : ""}` +
			`${this.disabled.has(a) ? "T" : ""}`
		);
	}

	/** Take the set of agents that this tick wrote, and empty it. */
	takeTouched() {
		const t = this.touched;
		this.touched = new Set();
		return t;
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
