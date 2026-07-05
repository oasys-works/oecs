/**
 * Reactive kernel gate: the signal/effect/batch fundamentals the dependency graph
 * depends on, and the two computed properties every consumer relies on —
 * glitch-freedom (a diamond join recomputes ONCE with consistent inputs) and the
 * equal-value cutoff (a recompute to an equal value wakes nobody). Ported from the
 * workbench correctness harness (#646) so the gate runs in CI.
 */
import { describe, expect, it } from "vitest";
import { signal, computed, effect, batch, untrack } from "../kernel";

describe("signal / effect", () => {
	it("drops a dynamically-unused dependency (unlink)", () => {
		const [a, setA] = signal(0);
		const [toggle, setToggle] = signal(true);
		const [b, setB] = signal(0);
		let runs = 0;
		effect(() => {
			runs++;
			a();
			if (toggle()) b();
		});
		expect(runs).toBe(1);
		setB(1); // toggle on -> b is a dep
		expect(runs).toBe(2);
		setToggle(false); // re-runs without reading b -> b unlinked
		expect(runs).toBe(3);
		setB(2); // b no longer a dep -> silent
		expect(runs).toBe(3);
		setA(5);
		expect(runs).toBe(4);
	});

	it("stops re-running after dispose, idempotently", () => {
		const [a, setA] = signal(0);
		let runs = 0;
		const dispose = effect(() => {
			runs++;
			a();
		});
		setA(1);
		expect(runs).toBe(2);
		dispose();
		setA(2);
		expect(runs).toBe(2);
		dispose(); // second dispose is a no-op
		expect(runs).toBe(2);
	});

	it("wakes once per dependency and coalesces a batch", () => {
		const [x, setX] = signal(0);
		const [y, setY] = signal(0);
		const [z, setZ] = signal(0);
		let runs = 0;
		effect(() => {
			runs++;
			x();
			y();
			z();
		});
		expect(runs).toBe(1);
		setX(1);
		setY(1);
		setZ(1);
		expect(runs).toBe(4); // each dep wakes once, no double-sub, no miss
		batch(() => {
			setX(2);
			setY(2);
			setZ(2);
		});
		expect(runs).toBe(5); // batched triple-write -> one run
	});

	it("fans in one signal to many effects, each woken exactly once", () => {
		const [s, setS] = signal(0);
		const counts = new Array(50).fill(0);
		for (let i = 0; i < 50; i++) {
			effect(() => {
				counts[i]++;
				s();
			});
		}
		expect(counts.every((c) => c === 1)).toBe(true);
		setS(1);
		expect(counts.every((c) => c === 2)).toBe(true);
	});

	it("does not duplicate a link on a consecutive re-read", () => {
		const [a, setA] = signal(0);
		let runs = 0;
		effect(() => {
			runs++;
			a();
			a(); // consecutive re-read
		});
		expect(runs).toBe(1);
		setA(1);
		expect(runs).toBe(2); // single write -> single re-run
	});

	it("skips a same-value write (Object.is no-op)", () => {
		const [a, setA] = signal(1);
		let runs = 0;
		effect(() => {
			runs++;
			a();
		});
		expect(runs).toBe(1);
		setA(1); // equal -> no-op
		expect(runs).toBe(1);
		setA(2);
		expect(runs).toBe(2);
	});

	it("isolates a throwing effect so it does not poison its siblings", () => {
		// Regression: the flush cleared QUEUED|NOTIFIED per effect as it reached it,
		// so a throw aborting the loop left the un-reached effects NOTIFIED forever —
		// notify() would never re-queue them and they went permanently dead. A throw
		// must let every sibling run, and still surface to the caller.
		const [a, setA] = signal(0);
		let goodRuns = 0;
		effect(() => {
			const v = a();
			if (v === 1) throw new Error("boom");
		});
		effect(() => {
			goodRuns++;
			a();
		});
		expect(goodRuns).toBe(1); // both primed
		// One coalesced flush wakes both; the first throws. The error surfaces...
		expect(() => batch(() => setA(1))).toThrow("boom");
		expect(goodRuns).toBe(2); // ...and the sibling still ran in the same flush
		setA(2); // a later clean change
		expect(goodRuns).toBe(3); // the sibling is still alive (was: dead at 2)
	});

	it("throws on a non-settling effect cycle instead of hanging forever", () => {
		// An effect that writes a signal it reads re-queues itself every run, so the
		// flush never drains. The backstop must turn that runaway into a thrown error
		// rather than an infinite loop.
		const [a, setA] = signal(0);
		expect(() =>
			effect(() => {
				setA(a() + 1); // writes a dep it reads -> never settles
			})
		).toThrow(/did not settle/i);
	});

	it("keeps a non-consecutively repeated read to a single wake (no duplicate-edge double-run)", () => {
		// `a(); b(); a()` reads `a` twice non-consecutively. The intrusive-cursor graph
		// tolerates a redundant edge here (deduping it would cost the hot path or break
		// endTracking ordering); the NOTIFIED guard keeps it to one run, and `b` must
		// stay tracked. This pins that harmless behavior so an "optimization" that
		// regressed it (double-run, or dropping `b`) gets caught.
		const [a, setA] = signal(0);
		const [b, setB] = signal(0);
		let runs = 0;
		effect(() => {
			runs++;
			a();
			b();
			a(); // non-consecutive re-read of a
		});
		expect(runs).toBe(1);
		setA(1);
		expect(runs).toBe(2); // single write -> single run despite the duplicate read
		setA(2);
		expect(runs).toBe(3); // stable across writes: no edge growth -> no extra runs
		setB(1);
		expect(runs).toBe(4); // b is still a tracked dependency
	});
});

describe("computed", () => {
	it("is lazy, cached, and recomputes only after a source change", () => {
		const [a, setA] = signal(1);
		let computeRuns = 0;
		const b = computed(() => {
			computeRuns++;
			return a() * 10;
		});
		expect(computeRuns).toBe(0); // lazy: nothing before first read
		expect(b()).toBe(10);
		expect(computeRuns).toBe(1);
		expect(b()).toBe(10); // cached
		expect(computeRuns).toBe(1);
		setA(2);
		expect(b()).toBe(20);
		expect(computeRuns).toBe(2);
	});

	it("propagates through a chain a -> b -> c", () => {
		const [a, setA] = signal(1);
		const b = computed(() => a() + 1);
		const c = computed(() => b() + 1);
		expect(c()).toBe(3);
		setA(10);
		expect(c()).toBe(12);
	});

	it("is glitch-free across a diamond: the join recomputes exactly once", () => {
		const [a, setA] = signal(1);
		const b = computed(() => a() + 1);
		const c = computed(() => a() + 2);
		let dRuns = 0;
		let sawInconsistent = false;
		const d = computed(() => {
			dRuns++;
			const bv = b();
			const cv = c();
			// b and c both derive from the SAME a; a half-updated graph would break bv-cv == -1.
			if (bv - cv !== -1) sawInconsistent = true;
			return bv + cv;
		});
		let effectRuns = 0;
		effect(() => {
			effectRuns++;
			d();
		});
		expect(d()).toBe(5);
		expect(dRuns).toBe(1);
		expect(effectRuns).toBe(1);
		setA(10); // b=11, c=12, d=23
		expect(d()).toBe(23);
		expect(sawInconsistent).toBe(false); // glitch-free
		expect(dRuns).toBe(2); // join recomputed exactly once, not twice
		expect(effectRuns).toBe(2);
	});

	it("does not wake subscribers on a recompute to an equal value (cutoff)", () => {
		const [a, setA] = signal(5);
		const isPositive = computed(() => a() > 0);
		let effectRuns = 0;
		effect(() => {
			effectRuns++;
			isPositive();
		});
		expect(effectRuns).toBe(1);
		setA(7); // still > 0 -> recomputes to the same `true`
		expect(effectRuns).toBe(1); // equal result -> no wake
		setA(-1); // now false -> genuine change
		expect(effectRuns).toBe(2);
	});

	it("unsubscribes a branch dependency when the branch is not taken", () => {
		const [toggle, setToggle] = signal(true);
		const [x, setX] = signal(1);
		const [y, setY] = signal(100);
		let runs = 0;
		const pick = computed(() => {
			runs++;
			return toggle() ? x() : y();
		});
		let eRuns = 0;
		effect(() => {
			eRuns++;
			pick();
		});
		expect(pick()).toBe(1);
		expect(runs).toBe(1);
		setY(200); // y untracked while toggle on
		expect(runs).toBe(1);
		expect(eRuns).toBe(1);
		setToggle(false); // now picks y
		expect(pick()).toBe(200);
		expect(eRuns).toBe(2);
		setX(9); // x no longer a dep
		expect(eRuns).toBe(2);
	});

	it("coalesces a batch of writes through a computed into one effect run", () => {
		const [a, setA] = signal(0);
		const [b, setB] = signal(0);
		const sum = computed(() => a() + b());
		let eRuns = 0;
		let lastSeen = -1;
		effect(() => {
			eRuns++;
			lastSeen = sum();
		});
		expect(eRuns).toBe(1);
		batch(() => {
			setA(3);
			setB(4);
		});
		expect(eRuns).toBe(2); // two writes -> one run
		expect(lastSeen).toBe(7);
	});

	it("stops waking an effect through a computed after dispose", () => {
		const [a, setA] = signal(0);
		const dbl = computed(() => a() * 2);
		let eRuns = 0;
		const dispose = effect(() => {
			eRuns++;
			dbl();
		});
		setA(1);
		expect(eRuns).toBe(2);
		dispose();
		setA(2);
		expect(eRuns).toBe(2);
	});
});

// The single symmetric diamond above is the easy case. These are the shapes that
// actually distinguish a correct glitch-free kernel from a naive one — asymmetric
// (short + long path), stacked joins, and an equal-recompute on one arm that must
// not swallow a real change on the other. Each asserts no half-updated intermediate
// is ever observed AND the join recomputes exactly once per settled change.
describe("glitch-free diamonds (discriminating shapes)", () => {
	it("asymmetric: the join reads the source directly AND through an intermediate", () => {
		const [a, setA] = signal(2);
		const b = computed(() => a() + 1);
		let dRuns = 0;
		let glitch = false;
		const d = computed(() => {
			dRuns++;
			const av = a();
			const bv = b();
			if (bv !== av + 1) glitch = true; // b must reflect the SAME a that d just read
			return av * 100 + bv;
		});
		let seen = -1;
		effect(() => {
			seen = d();
		});
		const base = dRuns;
		setA(5); // a=5, b=6, d=506
		expect(seen).toBe(506);
		expect(glitch).toBe(false);
		expect(dRuns - base).toBe(1); // join recomputed exactly once
	});

	it("stacked: a glitch cannot propagate through a second join", () => {
		const [a, setA] = signal(1);
		const b = computed(() => a() + 1);
		const c = computed(() => a() + 2);
		let mGlitch = false;
		const m = computed(() => {
			const bv = b();
			const cv = c();
			if (bv - cv !== -1) mGlitch = true;
			return bv + cv; // = 2a + 3
		});
		const p = computed(() => m());
		const q = computed(() => m());
		let dRuns = 0;
		let dGlitch = false;
		const d = computed(() => {
			dRuns++;
			const pv = p();
			const qv = q();
			if (pv !== qv) dGlitch = true; // p and q are both exactly m
			return pv + qv; // = 2m
		});
		let seen = -1;
		effect(() => {
			seen = d();
		});
		const base = dRuns;
		setA(4); // m = 11, d = 22
		expect(seen).toBe(22);
		expect(mGlitch).toBe(false);
		expect(dGlitch).toBe(false);
		expect(dRuns - base).toBe(1); // the final join recomputed exactly once
	});

	it("equal-cutoff on one arm does not swallow a real change on the other", () => {
		const [a, setA] = signal(1);
		const sign = computed(() => a() > 0); // stays `true` across a: 1 -> 2 (equal recompute)
		const scaled = computed(() => a() * 10); // genuinely changes
		let dRuns = 0;
		const d = computed(() => {
			dRuns++;
			return sign() ? scaled() : -scaled();
		});
		let seen = -1;
		effect(() => {
			seen = d();
		});
		const base = dRuns;
		setA(2); // sign stays true (version frozen), scaled 10 -> 20, d must update to 20
		expect(seen).toBe(20);
		expect(dRuns - base).toBe(1);
	});
});

describe("untrack", () => {
	it("reads inside untrack without subscribing the enclosing effect", () => {
		const [a, setA] = signal(0);
		const [b, setB] = signal(0);
		let runs = 0;
		let seen = -1;
		effect(() => {
			runs++;
			a(); // tracked
			seen = untrack(() => b()); // read, but not a dependency
		});
		expect(runs).toBe(1);
		expect(seen).toBe(0);
		setB(5); // b is not tracked -> no re-run
		expect(runs).toBe(1);
		setA(1); // a is tracked -> re-run, and it reads b's latest value
		expect(runs).toBe(2);
		expect(seen).toBe(5);
	});

	it("returns fn's value and restores tracking afterward", () => {
		const [a, setA] = signal(1);
		const [b, setB] = signal(10);
		let runs = 0;
		let total = -1;
		effect(() => {
			runs++;
			const untracked = untrack(() => b()); // 10, not a dep
			total = a() + untracked; // a tracked again after untrack returns
		});
		expect(total).toBe(11);
		setB(99); // untracked -> no re-run
		expect(runs).toBe(1);
		setA(2); // tracked -> re-run; reads the current b (99)
		expect(runs).toBe(2);
		expect(total).toBe(101);
	});
});
