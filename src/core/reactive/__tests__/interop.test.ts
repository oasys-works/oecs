/**
 * Interop contract gate: the two invariants a foreign UI framework relies on —
 * `subscribe` fires once per coalesced change (never on an equal write), and
 * `getSnapshot` is referentially stable (so React's useSyncExternalStore can't
 * storm). This is the zero-dep CI gate; the full proof against REAL mounted React
 * / Preact / Vue / Solid trees lives in workbench/reactive/framework_render_check.ts
 * (it needs those renderers + a DOM, which don't belong in engine's unit CI).
 *
 * The React model here mirrors useSyncExternalStore's actual mount/commit loop so
 * the negative control (an unstable snapshot) is a genuine storm, caught — the
 * same shape the real-framework harness confirms against React itself.
 */
import { describe, expect, it } from "vitest";
import { signal, computed, batch } from "../kernel";
import { subscribe, toExternalStore, type ExternalStore } from "../interop";

/** The shared drive: change / equal-skip / change / coalesced-batch = 3 real changes. */
function drive(setA: (v: number) => void): number {
	setA(1); // change
	setA(1); // equal -> skipped
	setA(2); // change
	batch(() => {
		setA(3);
		setA(4);
	}); // coalesced -> one change
	return 3;
}

describe("vanilla subscribe", () => {
	it("notifies once per coalesced change and never on an equal write", () => {
		const [a, setA] = signal(0);
		let notifications = 0;
		let lastValue = -1;
		const unsub = subscribe(a, (v) => {
			notifications++;
			lastValue = v;
		});
		const expected = drive(setA);
		expect(notifications).toBe(expected);
		expect(lastValue).toBe(4); // last notification carried the coalesced value
		unsub();
		setA(99);
		expect(notifications).toBe(expected); // unsubscribe stops notifications
	});

	it("passes a computed's equal-value cutoff through the bridge", () => {
		const [a, setA] = signal(1);
		const even = computed(() => a() % 2 === 0);
		let notifications = 0;
		const unsub = subscribe(even, () => notifications++);
		setA(3); // odd -> even stays false -> no change
		setA(4); // even -> change
		setA(6); // even -> still true -> no change
		setA(7); // odd -> change
		expect(notifications).toBe(2); // only the two parity flips
		unsub();
	});

	it("does not subscribe to accessors the consumer reads inside onChange", () => {
		// onChange runs inside the subscription effect; a kernel read in the consumer's
		// callback must NOT become a dependency of the subscription (else an unrelated
		// signal it touches would silently re-fire onChange). subscribe untracks it.
		const [a, setA] = signal(0);
		const [other, setOther] = signal(0);
		let notifications = 0;
		const unsub = subscribe(a, () => {
			notifications++;
			other(); // a foreign read inside the callback
		});
		setA(1); // real change -> one notification
		expect(notifications).toBe(1);
		setOther(1); // `other` must not be a dep of the subscription -> no notification
		expect(notifications).toBe(1);
		setA(2); // still tracking `a`
		expect(notifications).toBe(2);
		unsub();
	});
});

// React's useSyncExternalStore: on mount it reads getSnapshot during render, then
// re-reads in an effect; if the two differ it re-renders synchronously until they
// agree. A fresh-object snapshot never converges -> the render storm.
function reactMountRenders<T>(store: ExternalStore<T>, cap = 1000): number {
	let renders = 0;
	for (;;) {
		renders++;
		if (renders > cap) throw new Error("RENDER STORM: getSnapshot is not referentially stable");
		const rendered = store.getSnapshot();
		const recheck = store.getSnapshot();
		if (Object.is(rendered, recheck)) return renders;
	}
}
function reactDrive<T>(
	store: ExternalStore<T>,
	run: () => void
): { renders: number; notifications: number } {
	let committed = store.getSnapshot();
	let renders = 1; // mount
	let notifications = 0;
	const unsub = store.subscribe(() => {
		notifications++;
		const next = store.getSnapshot();
		if (!Object.is(next, committed)) {
			committed = next;
			renders++;
		}
	});
	run();
	unsub();
	return { renders, notifications };
}

describe("React external-store contract", () => {
	it("exposes a referentially-stable snapshot that mounts in one render", () => {
		const [a] = signal(0);
		const store = toExternalStore(a);
		expect(Object.is(store.getSnapshot(), store.getSnapshot())).toBe(true);
		expect(reactMountRenders(store)).toBe(1);
	});

	it("commits one render per change: 1 mount + 3 changes = 4", () => {
		const [a, setA] = signal(0);
		const { renders, notifications } = reactDrive(toExternalStore(a), () => drive(setA));
		expect(notifications).toBe(3);
		expect(renders).toBe(4);
	});

	it("NEGATIVE CONTROL: an unstable getSnapshot is caught as a render storm", () => {
		const [a] = signal(0);
		const broken: ExternalStore<{ v: number }> = {
			subscribe: toExternalStore(a).subscribe,
			getSnapshot: () => ({ v: a() }) // fresh object every call
		};
		expect(() => reactMountRenders(broken)).toThrow(/RENDER STORM/);
	});
});
