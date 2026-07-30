/**
 * Ownership-scope gate: cleanups fire before each re-run and on dispose; a `root`
 * tears down its whole subtree; a parent re-run disposes the children its previous
 * run created (the nested-effect leak guard).
 */
import { describe, expect, it } from "vitest";
import { signal, computed, effect, root, onCleanup } from "../kernel";

describe("ownership scopes", () => {
	it("runs onCleanup before each re-run and on dispose", () => {
		const [a, setA] = signal(0);
		let runs = 0;
		let cleanups = 0;
		const dispose = effect(() => {
			runs++;
			a();
			onCleanup(() => cleanups++);
		});
		expect(runs).toBe(1);
		expect(cleanups).toBe(0); // nothing torn down on first run
		setA(1);
		expect(runs).toBe(2);
		expect(cleanups).toBe(1); // previous cleanup runs before the re-run
		setA(2);
		expect(cleanups).toBe(2);
		dispose();
		expect(cleanups).toBe(3); // final cleanup on dispose
		setA(3);
		expect(runs).toBe(3); // disposed effect is silent
		expect(cleanups).toBe(3);
	});

	it("tears down a nested effect when its root is disposed", () => {
		const [a, setA] = signal(0);
		let runs = 0;
		const disposeRoot = root((dispose) => {
			effect(() => {
				runs++;
				a();
			});
			return dispose;
		});
		expect(runs).toBe(1);
		setA(1);
		expect(runs).toBe(2);
		disposeRoot();
		setA(2);
		expect(runs).toBe(2); // scope disposal disposed the nested effect
	});

	it("runs a root-level onCleanup on root disposal", () => {
		let cleaned = false;
		const disposeRoot = root((dispose) => {
			onCleanup(() => {
				cleaned = true;
			});
			return dispose;
		});
		expect(cleaned).toBe(false);
		disposeRoot();
		expect(cleaned).toBe(true);
	});

	it("disposes the inner effect a parent re-run recreates (no leak)", () => {
		const [outer, setOuter] = signal(0);
		const [inner, setInner] = signal(0);
		let innerRuns = 0;
		effect(() => {
			outer(); // re-run the parent when outer changes
			effect(() => {
				innerRuns++;
				inner();
			});
		});
		expect(innerRuns).toBe(1);
		setInner(1);
		expect(innerRuns).toBe(2); // the single inner reacts
		setOuter(1); // parent re-runs: old inner disposed, new inner created
		expect(innerRuns).toBe(3);
		setInner(2); // a leaked old inner would bump this by 2
		expect(innerRuns).toBe(4); // exactly one live inner -> no leak
	});

	it("runs a computed's onCleanup before it recomputes", () => {
		const [a, setA] = signal(1);
		let cleanups = 0;
		const doubled = computed(() => {
			const v = a();
			onCleanup(() => cleanups++);
			return v * 2;
		});
		let eRuns = 0;
		effect(() => {
			eRuns++;
			doubled();
		});
		expect(eRuns).toBe(1);
		expect(cleanups).toBe(0);
		setA(2);
		expect(cleanups).toBe(1); // previous cleanup runs before recompute
	});
});
