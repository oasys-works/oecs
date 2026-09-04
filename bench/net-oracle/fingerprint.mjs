/**
 * The fingerprint of the agents: one number for the complete state of the net, on
 * each side, at a cost that permits a check at each tick and at each phase of a
 * tick.
 *
 * `compare()` in `driver.mjs` reads each agent through the relation API, then it
 * reads the reverse index three times for each agent, and then it builds the
 * canonical form. That is the deep check, and its cost is what makes a soak verify
 * on a cadence of hundreds of ticks. Between two verification ticks a fault can
 * stay hidden, and when the deep check finds it the tick of the fault is unknown.
 *
 * This fingerprint reads the same facts in one linear scan. For each live agent:
 * its reference id, its type, the flags of its archetype (`Redex`, `Fresh`, `Age`,
 * `Tainted`), its position in the row partition, the `Watch` sparse component,
 * each `Slot`, `Touch.seq`, `Quar.count`, `Age.ticks`, each field of `Mix`, and
 * the target of each port as A reference ID. It folds these into one word for
 * the agent, and it adds the words of all agents in a way that does not depend
 * on the order. The reference does the same scan over its own arrays. The two
 * results must be equal.
 *
 * The bijection of the ids is what makes the two scans comparable. The ECS side
 * reads `refOfIndex` (the bijection, by entity index) for its own entity and for
 * each target, so a link to an entity that is not a live agent gives a value that
 * the reference never gives.
 *
 * A fingerprint that differs names no agent. Therefore the driver calls
 * `compare()` after a mismatch, and that call gives the message with the agent,
 * the port and the values on both sides. The fingerprint gives the tick, and the
 * phase of the tick, at which the two sides first disagree.
 *
 * The same scan runs inside a tick, at each `phaseBoundary` of the frame trace
 * (`world.mjs`). The driver takes the reference fingerprint at the matching point
 * of its own sequence: after the quarantine and before the promotion (the state
 * after PRE_UPDATE), after the plan (the state after UPDATE), and after the age
 * bump (the state after POST_UPDATE). The `Redex` and `Watch` flags are absent
 * from the first checkpoint, because the ECS derives them one tick after the
 * initial load, and the reference holds them from the start.
 */
import { MAX_PORTS } from "./spec.mjs";
import { BORN, BORN_F32, mirrorF32Of, mirrorOf } from "./mirror.mjs";

const DEAD = -1;
/** "No link", and "no Age". */
const NONE = 0xffffffff;
/** A link to an entity that the bijection does not know. The reference never
 * gives this value, so any such link is a mismatch. */
const BROKEN = 0xfffffffe;

// The flags of an agent.
const R = 1; // Redex
const F = 2; // Fresh
const A = 4; // Age
const T = 8; // Tainted
const DIS = 16; // in the disabled region of the row partition
const W = 32; // Watch (sparse)

const F32_SCRATCH = new Float32Array(1);
const F32_BITS = new Uint32Array(F32_SCRATCH.buffer);

/** The bits of an `f32` value, as one unsigned word. */
function f32bits(v) {
	F32_SCRATCH[0] = v;
	return F32_BITS[0];
}

function step(h, v) {
	h = Math.imul(h ^ (v >>> 0), 0x9e3779b1);
	return (h ^ (h >>> 15)) >>> 0;
}

function fmix(h) {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** One word for one agent. Both scans call this function with the same
 * arguments in the same order, so the function is the definition of "the state
 * of an agent". */
function hashAgent(
	r, t, flags, hits,
	s0, s1, s2,
	seq, quar, age,
	m8, m16, mu16, mu32, mf,
	b8, b16, bu16, bu32, bf,
	l0, l1, l2
) {
	let h = 0x811c9dc5;
	h = step(h, r);
	h = step(h, t);
	h = step(h, flags);
	h = step(h, hits);
	h = step(h, s0);
	h = step(h, s1);
	h = step(h, s2);
	h = step(h, seq);
	h = step(h, quar);
	h = step(h, age);
	h = step(h, m8);
	h = step(h, m16);
	h = step(h, mu16);
	h = step(h, mu32);
	h = step(h, mf);
	h = step(h, b8);
	h = step(h, b16);
	h = step(h, bu16);
	h = step(h, bu32);
	h = step(h, bf);
	h = step(h, l0);
	h = step(h, l1);
	h = step(h, l2);
	return fmix(h);
}

/** The sum of the words, in three lanes that do not depend on the order, and
 * the count. */
class Fold {
	constructor() {
		this.lo = 0;
		this.hi = 0;
		this.x = 0;
		this.n = 0;
	}
	add(h) {
		this.lo = (this.lo + h) >>> 0;
		this.hi = (this.hi + Math.imul(h, 0x2545f491)) >>> 0;
		this.x = (this.x ^ fmix(h + 0x632be5ab)) >>> 0;
		this.n++;
	}
	key() {
		return `${this.n}:${this.lo.toString(16)}:${this.hi.toString(16)}:${this.x.toString(16)}`;
	}
}

/**
 * The fingerprint of the reference.
 *
 * `redex` selects the `Redex` and `Watch` flags. The checkpoint after PRE_UPDATE
 * leaves them out.
 */
export function fingerprintRef(ref, { redex = true, float = false } = {}) {
	const fold = new Fold();
	const type = ref._type;
	const tgt = ref._tgt;
	const slot = ref._slot;
	const bf = float ? f32bits(BORN_F32) : 0;
	for (let a = 0; a < ref._next; a++) {
		const t = type[a];
		if (t === DEAD) continue;
		let flags = 0;
		if (redex && ref._rxOf.has(a)) flags |= R | W;
		if (ref._fresh.has(a)) flags |= F;
		if (ref._age.has(a)) flags |= A;
		if (ref.disabled.has(a)) flags |= T | DIS;
		const i = a * MAX_PORTS;
		const seq = ref._touch.get(a);
		const m = mirrorOf(seq);
		const l0 = tgt[i] === DEAD ? NONE : tgt[i];
		const l1 = tgt[i + 1] === DEAD ? NONE : tgt[i + 1];
		const l2 = tgt[i + 2] === DEAD ? NONE : tgt[i + 2];
		// `Watch.hits` is the low byte of `seq` for each member of an active pair,
		// and absent otherwise. The PRE_UPDATE checkpoint leaves it out with the
		// flags.
		const hits = redex && ref._rxOf.has(a) ? seq & 0xff : NONE;
		fold.add(
			hashAgent(
				a, t, flags, hits,
				slot[i], slot[i + 1], slot[i + 2],
				seq, ref._quar.get(a), ref._age.has(a) ? ref._age.get(a) : NONE,
				m.m8, m.m16, m.mu16, m.mu32, float ? f32bits(mirrorF32Of(seq)) : 0,
				BORN.b8, BORN.b16, BORN.bu16, BORN.bu32, bf,
				l0, l1, l2
			)
		);
	}
	return fold.key();
}

/**
 * The fingerprint of the ECS. One pass over the archetypes of the agents, the
 * disabled rows included. The columns come from the archetype view, so the scan
 * reads typed arrays and not one field at a time. The links come from the
 * relation API, one call for each port, and the bijection maps each target.
 */
export function fingerprintEcs(world, { redex = true } = {}) {
	const { ecs, P, Slot, Touch, Quar, Age, Mix, Watch } = world;
	const watchRead = world.watchRead;
	const refOf = world.refOfIndex;
	const indexOf = world._getEntityIndex;
	const float = world.float;
	const rel = ecs.relations;
	const tagIds = world.TAG.map((d) => d.id);
	const redexId = world.Redex.id;
	const freshId = world.Fresh.id;
	const ageId = world.Age.id;
	const taintId = world.Tainted.id;
	const fold = new Fold();
	const links = [NONE, NONE, NONE];
	let unmapped = 0;
	let brokenLinks = 0;
	// `qOptionalAge` spans each archetype of the agents, the disabled rows included,
	// and it declares `Age` as optional. The fetch of an optional column checks that
	// declaration, so this is the query that the scan must walk.
	world.qOptionalAge.forEach((arch) => {
		const total = arch.totalCount;
		if (total === 0) return;
		const enabled = total - arch.disabledCount;
		let t = -1;
		for (let k = 0; k < 4; k++) if (arch.hasComponent(tagIds[k])) t = k;
		let base = 0;
		if (redex && arch.hasComponent(redexId)) base |= R;
		if (arch.hasComponent(freshId)) base |= F;
		if (arch.hasComponent(ageId)) base |= A;
		if (arch.hasComponent(taintId)) base |= T;
		const s0 = arch.getColumnRead(Slot, "s0");
		const s1 = arch.getColumnRead(Slot, "s1");
		const s2 = arch.getColumnRead(Slot, "s2");
		const seq = arch.getColumnRead(Touch, "seq");
		const quar = arch.getColumnRead(Quar, "count");
		const age = arch.getOptionalColumnRead(Age, "ticks");
		const m8 = arch.getColumnRead(Mix, "m8");
		const m16 = arch.getColumnRead(Mix, "m16");
		const mu16 = arch.getColumnRead(Mix, "mu16");
		const mu32 = arch.getColumnRead(Mix, "mu32");
		const b8 = arch.getColumnRead(Mix, "b8");
		const b16 = arch.getColumnRead(Mix, "b16");
		const bu16 = arch.getColumnRead(Mix, "bu16");
		const bu32 = arch.getColumnRead(Mix, "bu32");
		const mf = float ? arch.getColumnRead(Mix, "mf32") : null;
		const bf = float ? arch.getColumnRead(Mix, "bf32") : null;
		const ids = arch.entityIds;
		for (let row = 0; row < total; row++) {
			const e = ids[row];
			let r = refOf[indexOf(e)];
			if (r < 0) {
				unmapped++;
				r = BROKEN;
			}
			let flags = base;
			if (row >= enabled) flags |= DIS;
			let hits = NONE;
			if (redex && ecs.hasSparse(e, Watch)) {
				flags |= W;
				// Through the read cursor: one mask and one load on the sparse column.
				hits = watchRead.at(e).hits;
			}
			for (let p = 0; p < MAX_PORTS; p++) {
				links[p] = NONE;
				const tgt = rel.targetOf(e, P[p]);
				if (tgt === undefined) continue;
				const rt = refOf[indexOf(tgt)];
				if (rt < 0) {
					brokenLinks++;
					links[p] = BROKEN;
				} else {
					links[p] = rt;
				}
			}
			fold.add(
				hashAgent(
					r, t, flags, hits,
					s0[row], s1[row], s2[row],
					seq[row], quar[row], age === undefined ? NONE : age[row],
					m8[row], m16[row], mu16[row], mu32[row], float ? f32bits(mf[row]) : 0,
					b8[row], b16[row], bu16[row], bu32[row], float ? f32bits(bf[row]) : 0,
					links[0], links[1], links[2]
				)
			);
		}
	});
	world.fpUnmapped = unmapped;
	world.fpBrokenLinks = brokenLinks;
	return fold.key();
}
