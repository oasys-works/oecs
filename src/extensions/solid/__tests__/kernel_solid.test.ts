/**
 * kernel_solid adapter gate — the kernel→Solid bridge's value contract: a kernel
 * change is reflected in the bridged accessor, an equal write doesn't move it,
 * batches coalesce, and disposal (the surrounding Solid owner tearing down) stops
 * updates so nothing leaks.
 *
 * Scope note: the root vitest runs under the `node` condition, where solid-js
 * resolves to its SSR build and *effect* scheduling no-ops — so these assert the
 * VALUE contract (kernel change → accessor value), which flows through our kernel's
 * `subscribe` (fully functional) into solid's signal get/set (value storage works
 * regardless of build). That a real Solid `<For>` / component RE-RENDERS off these
 * accessors is proven under browser conditions.
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { batch, reactiveArray, reactiveMap, reactiveStruct } from "../../../reactive";
import { fromKernel, fromKernelArray, fromKernelMap, fromKernelStruct } from "../index";

describe("fromKernel", () => {
	it("bridges the initial value and reflects kernel changes", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, number>();
			map.set(0, 10);
			const v = fromKernel(() => map.get(0) ?? -1);
			expect(v()).toBe(10);
			map.set(0, 20);
			expect(v()).toBe(20);
			dispose();
		});
	});

	it("coalesces a batch to the final value", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, number>();
			map.set(0, 0);
			const v = fromKernel(() => map.get(0) ?? -1);
			batch(() => {
				map.set(0, 1);
				map.set(0, 2);
			});
			expect(v()).toBe(2);
			dispose();
		});
	});

	it("stops updating after its owner is disposed (no leak)", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, number>();
			map.set(0, 1);
			const v = fromKernel(() => map.get(0) ?? -1);
			map.set(0, 2);
			expect(v()).toBe(2);
			dispose(); // tears down the bridge subscription via onCleanup
			map.set(0, 99);
			expect(v()).toBe(2); // frozen at the last pre-dispose value
		});
	});
});

describe("fromKernelMap", () => {
	it("tracks the key set across spawn and despawn", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, { hp: number }>();
			map.set(0, { hp: 100 });
			map.set(1, { hp: 100 });
			const view = fromKernelMap(map);
			expect([...view.keys()]).toEqual([0, 1]);
			map.set(2, { hp: 100 }); // spawn
			expect([...view.keys()]).toEqual([0, 1, 2]);
			map.delete(1); // despawn
			expect([...view.keys()]).toEqual([0, 2]);
			dispose();
		});
	});

	it("gives each key a bridged value accessor that reflects only that key", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, { hp: number }>();
			map.set(7, { hp: 100 });
			map.set(8, { hp: 100 });
			const view = fromKernelMap(map);
			const c7 = view.cell(7);
			const c8 = view.cell(8);
			expect(c7()?.hp).toBe(100);
			map.set(7, { hp: 40 }); // change entity 7
			expect(c7()?.hp).toBe(40);
			expect(c8()?.hp).toBe(100); // entity 8 untouched
			dispose();
		});
	});

	it("a key's cell reads undefined once that key is deleted", () => {
		createRoot((dispose) => {
			const map = reactiveMap<number, number>();
			map.set(3, 30);
			const view = fromKernelMap(map);
			const c3 = view.cell(3);
			expect(c3()).toBe(30);
			map.delete(3);
			expect(c3()).toBeUndefined();
			dispose();
		});
	});
});

describe("fromKernelStruct", () => {
	it("bridges each field and reflects per-field kernel changes", () => {
		createRoot((dispose) => {
			const [s, set] = reactiveStruct({ status: 2, latency: 20, fps: 60 });
			const view = fromKernelStruct(s);
			expect(view.status).toBe(2);
			expect(view.latency).toBe(20);
			set.latency(35); // change one field
			expect(view.latency).toBe(35);
			expect(view.fps).toBe(60); // untouched field unchanged
			dispose();
		});
	});

	it("coalesces a batch of field writes to the final values", () => {
		createRoot((dispose) => {
			const [s, set] = reactiveStruct({ a: 0, b: 0 });
			const view = fromKernelStruct(s);
			batch(() => {
				set.a(1);
				set.a(2);
				set.b(9);
			});
			expect(view.a).toBe(2);
			expect(view.b).toBe(9);
			dispose();
		});
	});

	it("stops updating after its owner is disposed (no leak)", () => {
		createRoot((dispose) => {
			const [s, set] = reactiveStruct({ latency: 1 });
			const view = fromKernelStruct(s);
			set.latency(2);
			expect(view.latency).toBe(2);
			dispose(); // tears down each field's bridge subscription via onCleanup
			set.latency(99);
			expect(view.latency).toBe(2); // frozen at the last pre-dispose value
		});
	});

	describe("bridged view is enumerable and safe on non-field keys", () => {
		it("Object.keys returns the field names", () => {
			createRoot((dispose) => {
				const [s] = reactiveStruct({ status: 2, latency: 20, fps: 60 });
				const view = fromKernelStruct(s);
				expect(Object.keys(view)).toEqual(["status", "latency", "fps"]);
				dispose();
			});
		});

		it("JSON.stringify does not throw and includes the fields", () => {
			createRoot((dispose) => {
				const [s] = reactiveStruct({ status: 2, latency: 20 });
				const view = fromKernelStruct(s);
				expect(() => JSON.stringify(view)).not.toThrow();
				expect(JSON.parse(JSON.stringify(view))).toEqual({ status: 2, latency: 20 });
				dispose();
			});
		});

		it("a non-field key (then / Symbol.iterator) reads undefined and does not throw", () => {
			createRoot((dispose) => {
				const [s] = reactiveStruct({ status: 2 });
				const view = fromKernelStruct(s);
				// Solid reconcile + `await` probe `.then`; `for..of` probes `Symbol.iterator`.
				expect(() => (view as { then?: unknown }).then).not.toThrow();
				expect((view as { then?: unknown }).then).toBeUndefined();
				expect((view as { [Symbol.iterator]?: unknown })[Symbol.iterator]).toBeUndefined();
				dispose();
			});
		});

		it("reading a real field inside the Solid scope returns the value and tracks", () => {
			createRoot((dispose) => {
				const [s, set] = reactiveStruct({ status: 2, latency: 20 });
				const view = fromKernelStruct(s);
				expect(view.status).toBe(2);
				set.status(7); // a real-field change still reflects through the bridge
				expect(view.status).toBe(7);
				expect(view.latency).toBe(20); // untouched field unchanged
				dispose();
			});
		});
	});
});

describe("fromKernelArray", () => {
	it("bridges the snapshot and reflects slot changes + length changes", () => {
		createRoot((dispose) => {
			const a = reactiveArray<number>([255, 255, 255]);
			const view = fromKernelArray(a);
			expect([...view()]).toEqual([255, 255, 255]);
			a.set(1, 7); // one slot
			expect([...view()]).toEqual([255, 7, 255]);
			a.reconcile([1, 2]); // shrink
			expect([...view()]).toEqual([1, 2]);
			dispose();
		});
	});

	it("coalesces a batch of slot writes to the final snapshot", () => {
		createRoot((dispose) => {
			const a = reactiveArray<number>([0, 0, 0]);
			const view = fromKernelArray(a);
			batch(() => {
				a.set(0, 1);
				a.set(0, 2);
				a.set(2, 9);
			});
			expect([...view()]).toEqual([2, 0, 9]);
			dispose();
		});
	});
});
