/**
 * The generators for an initial net.
 *
 * A generator returns a `NetSpec` that does not depend on the storage, and both
 * implementations load it. Therefore the two nets start with an equal meaning, and
 * neither implementation needs data about the structure of the other:
 *
 *   { name, types: [type, …], wires: [[a, pa, b, pb], …], expectRewrites?, expectAgents? }
 *
 * `types[i]` is the type of agent `i`. `wires` is the matching of the ports. The net
 * must have one ROOT exactly, and each port of each agent must be in one wire
 * exactly. `assertNetSpecValid` makes both checks.
 *
 * The generator sets `expectRewrites` only if you can calculate the number by hand.
 * That number is the part of the oracle that comes from outside: it comes from
 * neither implementation. Therefore the two implementations can be incorrect
 * together, and the run still fails.
 */
import { CON, DUP, ERA, ROOT, PORTS, TYPE_NAME, rng } from "./spec.mjs";

/** Builder that accumulates a NetSpec. */
class Builder {
	constructor() {
		this.types = [];
		this.wires = [];
	}
	add(type) {
		this.types.push(type);
		return this.types.length - 1;
	}
	wire(a, pa, b, pb) {
		this.wires.push([a, pa, b, pb]);
	}
	/** Perfect binary tree of CON nodes with ERA leaves, `depth` levels of CON.
	 * Returns the root agent, whose port 0 is the tree's upward-facing port.
	 * `depth === 0` degenerates to a single ERA. */
	tree(depth) {
		if (depth === 0) return this.add(ERA);
		const c = this.add(CON);
		const l = this.tree(depth - 1);
		const r = this.tree(depth - 1);
		this.wire(c, 1, l, 0);
		this.wire(c, 2, r, 0);
		return c;
	}
	done(name, extra = {}) {
		return { name, types: this.types, wires: this.wires, ...extra };
	}
}

/**
 * An eraser aimed at a perfect binary CON tree.
 *
 * This is the generator with a **closed-form answer**, which makes it the only
 * oracle in the harness that neither implementation can influence:
 *
 *   - a tree of `depth` CON levels has `2^depth - 1` CON nodes and `2^depth` ERA
 *     leaves;
 *   - each CON costs exactly one ERA~CON rewrite (and re-emits two erasers),
 *     each leaf ERA exactly one ERA~ERA rewrite;
 *   - plus one rewrite for the top CON that holds the net's ROOT branch.
 *
 * Total: `2 * (2^depth - 1) + 2` = **2^(depth+1)** rewrites, terminating in a
 * 2-agent normal form (ROOT wired to the single eraser that fell out of the top
 * CON) with zero wire loops.
 */
export function erasureTree(depth) {
	const b = new Builder();
	const root = b.add(ROOT);
	const eraser = b.add(ERA);
	const top = b.add(CON);
	b.wire(top, 0, eraser, 0); // the one active pair that starts the cascade
	b.wire(root, 0, top, 1); // ROOT hangs off an aux port, so it survives
	const sub = b.tree(depth);
	b.wire(top, 2, sub, 0);
	return b.done(`erasureTree(${depth})`, {
		expectRewrites: 2 ** (depth + 1),
		expectAgents: 2, // ROOT + one ERA
		expectLoops: 0,
	});
}

/**
 * A duplicator aimed at a CON tree, with one copy fed to an eraser.
 *
 * The commutation rule is the only one that grows the net, so this is the
 * allocation-pressure generator: the tree is duplicated node by node (each CON
 * becoming two CONs and spawning two DUPs) and one copy is then erased. Peak
 * live agents run several times the initial count before collapsing back.
 *
 * No closed form is claimed — the reference reducer is the oracle here, backed by
 * the rewrite-count invariance check across reduction orders.
 */
export function dupTree(depth) {
	const b = new Builder();
	const root = b.add(ROOT);
	const dup = b.add(DUP);
	const sink = b.add(ERA);
	const top = b.tree(depth);
	b.wire(dup, 0, top, 0); // the active pair
	b.wire(root, 0, dup, 1); // one copy surfaces at ROOT
	b.wire(dup, 2, sink, 0); // the other is erased
	return b.done(`dupTree(${depth})`);
}

/**
 * A random net: a random perfect matching over the ports of a random agent mix.
 *
 * Unlike the structured generators this has no reason to terminate — interaction
 * combinators are Turing-complete, and a random net can loop forever or grow
 * without bound. That is deliberate: the step cap turns it into an open-ended
 * churn source, and the lockstep oracle does not need termination (only the
 * rewrite-count invariance check does, and it skips nets that do not normalise).
 */
export function randomNet(seed, nCon, nDup, nEra) {
	const rand = rng(seed);
	const b = new Builder();
	b.add(ROOT);
	for (let i = 0; i < nCon; i++) b.add(CON);
	for (let i = 0; i < nDup; i++) b.add(DUP);
	for (let i = 0; i < nEra; i++) b.add(ERA);
	// A perfect matching needs an even port count; ERA contributes one port each,
	// so one extra eraser fixes the parity.
	let ports = [];
	const collect = () => {
		ports = [];
		for (let a = 0; a < b.types.length; a++) {
			for (let p = 0; p < PORTS[b.types[a]]; p++) ports.push(a * 8 + p);
		}
	};
	collect();
	if (ports.length % 2 === 1) {
		b.add(ERA);
		collect();
	}
	// Fisher-Yates with the seeded generator, then pair adjacent entries. Self
	// loops (two ports of one agent wired together) are legal and worth having.
	for (let i = ports.length - 1; i > 0; i--) {
		const j = (rand() * (i + 1)) | 0;
		const t = ports[i];
		ports[i] = ports[j];
		ports[j] = t;
	}
	for (let i = 0; i < ports.length; i += 2) {
		const u = ports[i];
		const v = ports[i + 1];
		b.wire((u / 8) | 0, u % 8, (v / 8) | 0, v % 8);
	}
	return b.done(`randomNet(${seed},${nCon},${nDup},${nEra})`);
}

/**
 * Validate a NetSpec before either backing loads it — one ROOT, every port
 * matched exactly once, no port out of range. A malformed spec would otherwise
 * surface as a mismatch deep in a soak, blamed on the ECS.
 */
export function assertNetSpecValid(spec) {
	const { types, wires, name } = spec;
	let roots = 0;
	for (const t of types) if (t === ROOT) roots++;
	if (roots !== 1) throw new Error(`${name}: ${roots} ROOT agents, want exactly 1`);

	const seen = new Map(); // "a:p" -> times matched
	const key = (a, p) => `${a}:${p}`;
	for (const [a, pa, bb, pb] of wires) {
		for (const [g, q] of [
			[a, pa],
			[bb, pb],
		]) {
			if (g < 0 || g >= types.length) throw new Error(`${name}: wire to unknown agent ${g}`);
			if (q < 0 || q >= PORTS[types[g]]) {
				throw new Error(`${name}: agent ${g} (${TYPE_NAME[types[g]]}) has no port ${q}`);
			}
			seen.set(key(g, q), (seen.get(key(g, q)) ?? 0) + 1);
		}
	}
	for (let a = 0; a < types.length; a++) {
		for (let p = 0; p < PORTS[types[a]]; p++) {
			const n = seen.get(key(a, p)) ?? 0;
			if (n !== 1) {
				throw new Error(
					`${name}: agent ${a} (${TYPE_NAME[types[a]]}) port ${p} matched ${n}× (want 1)`
				);
			}
		}
	}
	return spec;
}

/** Parse a `--net=` value into a spec. */
export function netFromArg(arg, seed) {
	const m = /^(\w+)(?::(.+))?$/.exec(arg);
	const kind = m?.[1];
	const args = (m?.[2] ?? "").split(",").filter(Boolean).map(Number);
	switch (kind) {
		case "erase":
			return assertNetSpecValid(erasureTree(args[0] ?? 8));
		case "dup":
			return assertNetSpecValid(dupTree(args[0] ?? 5));
		case "random":
			return assertNetSpecValid(
				randomNet(args[0] ?? seed, args[1] ?? 24, args[2] ?? 12, args[3] ?? 16)
			);
		default:
			throw new Error(`unknown --net=${arg} (want erase:D | dup:D | random:seed,nCon,nDup,nEra)`);
	}
}
