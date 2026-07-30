/**
 * reactiveArray gate — ordered per-slot channels + structural-sharing reconcile.
 */
import { describe, expect, it } from "vitest";
import { batch, effect, root } from "../kernel";
import { reactiveArray } from "../array";

describe("reactiveArray — ordered per-slot channels", () => {
	it("per-slot isolation: changing one slot wakes only its reader; equal set is a no-op", () => {
		root(() => {
			const a = reactiveArray<number>([0, 10, 20, 30, 40]);
			const runs = [0, 0, 0, 0, 0];
			for (let i = 0; i < 5; i++) {
				effect(() => {
					runs[i]++;
					a.get(i);
				});
			}
			expect(runs).toEqual([1, 1, 1, 1, 1]);
			a.set(2, 999);
			expect(runs[2]).toBe(2);
			expect(runs.filter((_, i) => i !== 2)).toEqual([1, 1, 1, 1]);
			a.set(2, 999); // equal → no-op skip
			expect(runs[2]).toBe(2);
		});
	});

	it("structure vs value: length tracks length only, not per-slot updates", () => {
		root(() => {
			const a = reactiveArray<number>([1, 2]);
			let lenRuns = 0;
			let lastLen = -1;
			effect(() => {
				lenRuns++;
				lastLen = a.length();
			});
			expect([lastLen, lenRuns]).toEqual([2, 1]);
			a.set(0, 9); // value update → structure unchanged
			expect(lenRuns).toBe(1);
			a.push(3);
			expect([lastLen, lenRuns]).toEqual([3, 2]);
			a.pop();
			expect([lastLen, lenRuns]).toEqual([2, 3]);
		});
	});

	it("out-of-range → grow lifecycle wakes a slot's reader", () => {
		root(() => {
			const a = reactiveArray<number>([10]);
			let value: number | undefined = -1;
			let runs = 0;
			effect(() => {
				runs++;
				value = a.get(1);
			});
			expect([value, runs]).toEqual([undefined, 1]);
			a.push(20);
			expect([value, runs]).toEqual([20, 2]);
			a.set(1, 21);
			expect([value, runs]).toEqual([21, 3]);
		});
	});

	it("shrink wakes the dropped slot's reader, and a re-grow into it wakes again", () => {
		root(() => {
			const a = reactiveArray<number>([10, 20, 30]);
			let value: number | undefined = -1;
			let runs = 0;
			effect(() => {
				runs++;
				value = a.get(2);
			});
			expect([value, runs]).toEqual([30, 1]);
			a.reconcile([10, 20]); // shrink: slot 2 dropped
			expect([value, runs]).toEqual([undefined, 2]);
			a.reconcile([10, 20, 99]); // grow back
			expect([value, runs]).toEqual([99, 3]);
		});
	});

	it("reconcile is O(changed): M-of-N changed wakes M; equal reconcile wakes 0", () => {
		root(() => {
			const N = 200;
			const a = reactiveArray<number>(Array.from({ length: N }, (_, i) => i));
			const runs = new Array<number>(N).fill(0);
			for (let i = 0; i < N; i++) {
				effect(() => {
					runs[i]++;
					a.get(i);
				});
			}
			a.reconcile(Array.from({ length: N }, (_, i) => i)); // equal
			expect(runs.every((r) => r === 1)).toBe(true);

			const next = Array.from({ length: N }, (_, i) => i);
			const changed = new Set<number>();
			for (let i = 0; i < N; i += 10) {
				next[i] = i + 1000;
				changed.add(i);
			}
			a.reconcile(next);
			let woke = 0;
			for (let i = 0; i < N; i++) if (runs[i] === 2) woke++;
			expect(woke).toBe(changed.size);
			expect([...changed].every((i) => runs[i] === 2)).toBe(true);
		});
	});

	it("structural sharing: equal-content elements keep their references", () => {
		root(() => {
			const a = reactiveArray<{ hp: number }>([{ hp: 100 }, { hp: 50 }], (x, y) => x.hp === y.hp);
			const ref0 = a.get(0);
			const ref1 = a.get(1);
			a.reconcile([{ hp: 100 }, { hp: 50 }]); // fresh objects, equal content
			expect(a.get(0)).toBe(ref0);
			expect(a.get(1)).toBe(ref1);
			a.reconcile([{ hp: 100 }, { hp: 40 }]); // slot 1 changed
			expect(a.get(0)).toBe(ref0);
			expect(a.get(1)).not.toBe(ref1);
			expect(a.get(1)?.hp).toBe(40);
		});
	});

	it("splice shifts the tail and leaves the head; batch coalesces per slot", () => {
		root(() => {
			const a = reactiveArray<string>(["a", "b", "c", "d"]);
			const runs = [0, 0, 0, 0];
			for (let i = 0; i < 4; i++) {
				effect(() => {
					runs[i]++;
					a.get(i);
				});
			}
			a.splice(1, 1); // ["a","c","d"]
			expect(a.snapshot().join("")).toBe("acd");
			expect(runs[0]).toBe(1); // head unchanged
			expect([runs[1], runs[2], runs[3]]).toEqual([2, 2, 2]); // shifted/dropped woke

			const b = reactiveArray<number>([0, 0, 0]);
			const r = [0, 0, 0];
			for (let i = 0; i < 3; i++) {
				effect(() => {
					r[i]++;
					b.get(i);
				});
			}
			batch(() => {
				b.set(0, 1);
				b.set(0, 2);
				b.set(1, 1);
			});
			expect(r[0]).toBe(2); // two writes coalesced
			expect([r[1], r[2]]).toEqual([2, 1]);
		});
	});
});
