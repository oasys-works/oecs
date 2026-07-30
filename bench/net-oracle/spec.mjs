/**
 * The specification of the interaction combinators: the types of agent, the table of
 * rules, and the rewrite algorithm. No part of this file depends on the storage.
 *
 * THE REASON THAT THE REFERENCE NET AND THE ECS NET SHARE THIS FILE: the item under
 * test is the *storage* of a net in the ECS, which is archetype migration, relation
 * mutation and observers. It is not my ability to write the rules of an interaction
 * net two times. If each side calculated the connections itself, a difference
 * between the two sets of rules would look like a bug in the ECS. A bug in the ECS
 * could also stay hidden behind a bug in the rules that has the opposite effect.
 * Therefore the rewrite logic is in this file one time, and it operates through an
 * adapter. The adapter is the only difference between the two runs.
 *
 * The system is the interaction combinators of Lafont. It has three agents (γ or
 * CON, δ or DUP, and ε or ERA), and six rules over their unordered pairs. This
 * system gives the oracle its most important property, and it costs nothing: the
 * system is *strongly confluent*. Therefore each sequence of reductions reaches the
 * same normal form, and it uses the same number of rewrites. The ECS can give any
 * sequence of reductions, but that sequence must agree about both results. One
 * correct step by chance cannot give this result.
 *
 * A fourth agent, ROOT, holds the one free port of the net. It has no rules.
 * Therefore a pair that includes ROOT is inactive, and it never reduces.
 */

// ── Agent types ─────────────────────────────────────────────────────────────
export const CON = 0; // γ — constructor, 2 auxiliary ports
export const DUP = 1; // δ — duplicator, 2 auxiliary ports
export const ERA = 2; // ε — eraser, 0 auxiliary ports
export const ROOT = 3; // net interface anchor, 0 auxiliary ports, no rules

export const TYPE_NAME = ["CON", "DUP", "ERA", "ROOT"];

/** Total ports per type, principal included. Port 0 is always the principal;
 * ports 1..n are auxiliary. Fixed at 3 max, which is what lets both backings
 * use a flat stride-3 layout. */
export const PORTS = [3, 3, 1, 1];

/** The widest port count — the stride of every per-port array in both backings. */
export const MAX_PORTS = 3;

/** Slot value meaning "this port does not exist on this agent". Live ports always
 * hold 0..2, so 255 is unambiguous and fits the `u8` column the ECS uses. */
export const NO_SLOT = 255;

// ── The rule alphabet ───────────────────────────────────────────────────────
//
// A rule's wiring is written over two kinds of endpoint:
//
//   negative  — an *external* endpoint: one of the redex's own auxiliary ports,
//               standing for "whatever that port was connected to".
//   >= 0      — a port of an agent the rule creates, encoded `newIndex * 8 + port`.
//
// Keeping both in one integer space is what makes the resolver below a plain
// loop over integers instead of a tagged-union walk.
export const A1 = -1; // first agent's aux port 1
export const A2 = -2; // first agent's aux port 2
export const B1 = -3; // second agent's aux port 1
export const B2 = -4; // second agent's aux port 2

/** Encode "port `p` of the rule's `i`-th newly created agent". */
const N = (i, p) => i * 8 + p;

/** Map a redex-relative (agentSlot, port) back to its rule-alphabet code.
 * `agentSlot` is 0 for the first redex agent, 1 for the second. */
const EXT_CODE = [
	[undefined, A1, A2], // first agent: ports 1, 2
	[undefined, B1, B2], // second agent: ports 1, 2
];

/**
 * The six rules, keyed by `ta * 4 + tb` with `ta <= tb`. The caller canonicalises
 * the pair into that order, so each unordered pair needs exactly one entry —
 * which is also what makes the system unambiguous (a precondition of strong
 * confluence).
 *
 * Every rule is *linear*: each of the redex's auxiliary ports appears exactly
 * once on the right-hand side, and so does every port of every created agent.
 * `assertRulesLinear()` below checks that rather than trusting the reading.
 */
export const RULES = [];

// γ ⋈ γ — annihilation: the two agents vanish, their aux ports wire straight
// through. Same for δ ⋈ δ.
RULES[CON * 4 + CON] = { name: "CON~CON", news: [], wires: [[A1, B1], [A2, B2]] };
RULES[DUP * 4 + DUP] = { name: "DUP~DUP", news: [], wires: [[A1, B1], [A2, B2]] };

// ε ⋈ ε — annihilation with nothing left over.
RULES[ERA * 4 + ERA] = { name: "ERA~ERA", news: [], wires: [] };

// ε ⋈ γ — erasure propagates: the eraser is replaced by one eraser per aux port
// of the agent it consumed. Same for ε ⋈ δ. Canonical order puts CON/DUP first
// (type 0/1) and ERA second (type 2), so the *aux* ports here are A1/A2.
RULES[CON * 4 + ERA] = {
	name: "CON~ERA",
	news: [ERA, ERA],
	wires: [[N(0, 0), A1], [N(1, 0), A2]],
};
RULES[DUP * 4 + ERA] = {
	name: "DUP~ERA",
	news: [ERA, ERA],
	wires: [[N(0, 0), A1], [N(1, 0), A2]],
};

// γ ⋈ δ — commutation: each agent is duplicated across the other, and the four
// copies cross-connect. This is the only rule that *grows* the net (2 agents in,
// 4 out), and so the only source of the allocation pressure the soak needs.
//
//        A1  A2                    A1        A2
//         \  /                     |         |
//          γ            →         δ(n0)     δ(n1)
//          |                       | \      /  |
//          δ                       |  \    /   |
//         /  \                     | γ(n2)  γ(n3)
//        B1  B2                    ...B1     B2
RULES[CON * 4 + DUP] = {
	name: "CON~DUP",
	news: [DUP, DUP, CON, CON],
	wires: [
		[N(0, 0), A1],
		[N(1, 0), A2],
		[N(2, 0), B1],
		[N(3, 0), B2],
		[N(0, 1), N(2, 1)],
		[N(0, 2), N(3, 1)],
		[N(1, 1), N(2, 2)],
		[N(1, 2), N(3, 2)],
	],
};

/**
 * A stable small integer per rule, assigned in canonical `(ta, tb)` order.
 *
 * The provenance layer stores "which rule fired" in a `u8` column, and a
 * deterministic world forbids anything else; deriving the ids from the table
 * rather than hand-numbering them keeps the two in step if a rule is ever added.
 */
export const RULE_ID = {};
{
	let n = 0;
	for (let ta = 0; ta < 4; ta++) {
		for (let tb = ta; tb < 4; tb++) {
			const r = RULES[ta * 4 + tb];
			if (r !== undefined) RULE_ID[r.name] = n++;
		}
	}
}

/** Look up the rule for an unordered type pair, or `undefined` if the pair is
 * inert (anything involving ROOT). */
export function ruleFor(ta, tb) {
	return ta <= tb ? RULES[ta * 4 + tb] : RULES[tb * 4 + ta];
}

/** True if two agents of these types form a reducible active pair. */
export function reduces(ta, tb) {
	return ruleFor(ta, tb) !== undefined;
}

// ── Rewrite ─────────────────────────────────────────────────────────────────

/**
 * Rewrite the active pair `(a, b)` in `net`.
 *
 * `net` is an adapter with:
 *   typeOf(a) -> type
 *   getLink(a, p) -> [agent, port]        // the port this one is wired to
 *   setLink(a, p, b, q)                   // writes BOTH directions
 *   createAgent(type) -> id
 *   destroyAgent(id)
 *   settle()                              // make created/destroyed agents usable
 *   onLoop()                              // a wire closed on itself; count it
 *
 * Returns the rule that fired, or `null` for an inert pair.
 *
 * The interesting part is endpoint resolution. A rule says "wire A1 to B1",
 * meaning "wire whatever a's port 1 was attached to, to whatever b's port 1 was
 * attached to". But a's port 1 may have been attached to *b's port 2* — a wire
 * internal to the redex — in which case the endpoint is itself a port of an
 * agent we are about to destroy, and the real target is found by following that
 * port's own rule wire. Chasing those chains is what `resolve` does; a chain
 * that closes on itself is a wire loop with no agents left on it, which is a
 * real (if unobservable) part of the net state, so it gets counted rather than
 * dropped.
 */
export function applyRewrite(net, a, b) {
	let ta = net.typeOf(a);
	let tb = net.typeOf(b);
	// Canonicalise into the rule table's `ta <= tb` order. Both backings run this
	// same swap on the same types, so both agree on which agent is "first" — that
	// is what keeps the created-agent order identical and the id map trivial.
	if (ta > tb) {
		const t = a;
		a = b;
		b = t;
		const tt = ta;
		ta = tb;
		tb = tt;
	}
	const rule = RULES[ta * 4 + tb];
	if (rule === undefined) return null; // inert (ROOT); the pair just stands

	// 1. Snapshot the redex's external endpoints BEFORE anything is destroyed.
	const pair = [a, b];
	const types = [ta, tb];
	const ext = new Map();
	for (let s = 0; s < 2; s++) {
		for (let p = 1; p < PORTS[types[s]]; p++) {
			ext.set(EXT_CODE[s][p], net.getLink(pair[s], p));
		}
	}

	// 2. Index the rule's wires by external code, so a chain can hop from one
	//    redex aux port to the endpoint the rule pairs it with.
	const partner = new Map();
	for (let i = 0; i < rule.wires.length; i++) {
		const [u, v] = rule.wires[i];
		if (u < 0) partner.set(u, v);
		if (v < 0) partner.set(v, u);
	}

	// 3. Create the right-hand side, then retire the pair. Order matters for the
	//    ECS adapter: it spawns deferred, despawns deferred, and `settle()` is the
	//    single flush that applies both and fires the structural observers.
	const ids = [];
	for (let i = 0; i < rule.news.length; i++) ids.push(net.createAgent(rule.news[i]));
	net.destroyAgent(a);
	net.destroyAgent(b);
	net.settle();

	// 4. Resolve every rule endpoint to a concrete live `(agent, port)`, or to
	//    `null` when the chain closes into a loop.
	const resolve = (endpoint) => {
		let cur = endpoint;
		let guard = 0;
		const seen = new Set();
		for (;;) {
			if (cur >= 0) return [ids[(cur / 8) | 0], cur % 8]; // a created agent's port
			if (seen.has(cur)) return null; // closed wire loop
			seen.add(cur);
			const [g, q] = ext.get(cur);
			// Is this endpoint a port of one of the two agents we just destroyed?
			// If so it is a pass-through: hop to the endpoint the rule wires it to.
			const s = g === a ? 0 : g === b ? 1 : -1;
			if (s === -1) return [g, q]; // a live agent outside the redex
			cur = partner.get(EXT_CODE[s][q]);
			// Linearity guarantees every redex aux port appears in the rule, so a
			// miss here is a broken rule table, not a reachable state.
			if (cur === undefined) throw new Error(`spec: rule ${rule.name} drops port ${q}`);
			if (++guard > 16) throw new Error(`spec: endpoint chain did not settle`);
		}
	};

	// 5. Apply. A wire whose two ends both resolve into the redex collapses to a
	//    loop; because the chain graph is a permutation, that happens to both ends
	//    together or to neither — asserted rather than assumed.
	for (let i = 0; i < rule.wires.length; i++) {
		const [u, v] = rule.wires[i];
		const pu = resolve(u);
		const pv = resolve(v);
		if ((pu === null) !== (pv === null)) {
			throw new Error(`spec: half-resolved wire in ${rule.name}`);
		}
		if (pu === null) {
			net.onLoop();
			continue;
		}
		net.setLink(pu[0], pu[1], pv[0], pv[1]);
	}
	return rule;
}

// ── Self-checks on the rule table ───────────────────────────────────────────

/**
 * Verify every rule is linear — each redex auxiliary port and each created
 * agent's port used exactly once. Linearity is what makes the system strongly
 * confluent, so the rewrite-count oracle is only as sound as this check. Run it
 * once at startup; it is pure table inspection.
 */
export function assertRulesLinear() {
	for (let ta = 0; ta < 4; ta++) {
		for (let tb = ta; tb < 4; tb++) {
			const rule = RULES[ta * 4 + tb];
			if (rule === undefined) continue;
			const uses = new Map();
			const bump = (k) => uses.set(k, (uses.get(k) ?? 0) + 1);
			for (const [u, v] of rule.wires) {
				bump(u);
				bump(v);
			}
			// every auxiliary port of the redex, exactly once
			const expect = [];
			for (let p = 1; p < PORTS[ta]; p++) expect.push(EXT_CODE[0][p]);
			for (let p = 1; p < PORTS[tb]; p++) expect.push(EXT_CODE[1][p]);
			// every port of every created agent, exactly once
			for (let i = 0; i < rule.news.length; i++) {
				for (let p = 0; p < PORTS[rule.news[i]]; p++) expect.push(N(i, p));
			}
			for (const k of expect) {
				if (uses.get(k) !== 1) {
					throw new Error(
						`spec: rule ${rule.name} uses endpoint ${k} ${uses.get(k) ?? 0}× (want 1)`
					);
				}
			}
			if (uses.size !== expect.length) {
				throw new Error(
					`spec: rule ${rule.name} wires ${uses.size} endpoints, want ${expect.length}`
				);
			}
		}
	}
}

// ── Deterministic RNG ───────────────────────────────────────────────────────

/** xorshift32 — the same generator `bench/fuzz.mjs` uses, so seeds are
 * comparable across the two harnesses. */
export function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}
