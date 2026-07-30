/**
 * reactiveStruct gate — per-field channels for a fixed-shape record.
 * Adds the enumerable-proxy property `fromKernelStruct` relies on.
 */
import { describe, expect, it } from "vitest";
import { batch, computed, effect, root } from "../kernel";
import { reactiveStruct } from "../struct";

describe("reactiveStruct — per-field channels", () => {
	it("per-field isolation: a field write wakes only that field's reader", () => {
		root(() => {
			const [s, set] = reactiveStruct({ gold: 0, population: 0, food: 0 });
			let goldRuns = 0;
			let popRuns = 0;
			effect(() => {
				goldRuns++;
				void s.gold;
			});
			effect(() => {
				popRuns++;
				void s.population;
			});
			expect([goldRuns, popRuns]).toEqual([1, 1]);

			set.gold(100);
			expect([goldRuns, popRuns]).toEqual([2, 1]); // only gold woke

			set.gold(100); // equal → no-op skip
			expect(goldRuns).toBe(2);

			set.population(5);
			expect([goldRuns, popRuns]).toEqual([2, 2]); // only population woke
		});
	});

	it("the proxy read returns the current value and reflects writes", () => {
		const [s, set] = reactiveStruct({ name: "alice", level: 1 });
		expect(s.name).toBe("alice");
		expect(s.level).toBe(1);
		set.level(2);
		expect(s.level).toBe(2);
	});

	it("a per-field content eq dedups an object-valued field by content", () => {
		root(() => {
			const [s, set] = reactiveStruct(
				{ pos: { x: 0, y: 0 }, hp: 100 },
				{ pos: (a, b) => a.x === b.x && a.y === b.y }
			);
			let posRuns = 0;
			effect(() => {
				posRuns++;
				void s.pos;
			});
			expect(posRuns).toBe(1);

			set.pos({ x: 0, y: 0 }); // fresh object, equal content → no wake
			expect(posRuns).toBe(1);

			set.pos({ x: 1, y: 0 }); // content changed → wakes
			expect(posRuns).toBe(2);
		});
	});

	it("batch coalesces multi-field writes to one wake per affected field", () => {
		root(() => {
			const [s, set] = reactiveStruct({ a: 0, b: 0, c: 0 });
			const runs = { a: 0, b: 0, c: 0 };
			effect(() => {
				runs.a++;
				void s.a;
			});
			effect(() => {
				runs.b++;
				void s.b;
			});
			effect(() => {
				runs.c++;
				void s.c;
			});
			batch(() => {
				set.a(1);
				set.a(2); // two writes to a in the batch
				set.b(1);
			});
			expect(runs.a).toBe(2); // a's two writes coalesced to one wake
			expect(runs.b).toBe(2);
			expect(runs.c).toBe(1); // untouched field never woke
		});
	});

	it("the proxy is enumerable (Object.keys yields the fields) and enumeration does not subscribe", () => {
		root(() => {
			const [s, set] = reactiveStruct({ status: 0, latency: 0, fps: 0 });
			expect(Object.keys(s)).toEqual(["status", "latency", "fps"]);
			expect({ ...s }).toEqual({ status: 0, latency: 0, fps: 0 });

			// An effect that only ENUMERATES (no field read) must not subscribe — a
			// later field write wakes nobody.
			let runs = 0;
			effect(() => {
				runs++;
				void Object.keys(s);
			});
			expect(runs).toBe(1);
			set.latency(42);
			expect(runs).toBe(1); // enumeration tracked nothing
		});
	});

	describe("non-field key access", () => {
		it("JSON.stringify does not throw and yields the field values", () => {
			const [s] = reactiveStruct({ a: 1, b: 2 });
			expect(() => JSON.stringify(s)).not.toThrow();
			expect(JSON.parse(JSON.stringify(s))).toEqual({ a: 1, b: 2 });
		});

		it("String coercion (Symbol.toPrimitive / template) does not throw", () => {
			const [s] = reactiveStruct({ a: 1, b: 2 });
			expect(() => `${s}`).not.toThrow();
			expect(() => String(s)).not.toThrow();
			// the empty target stringifies as a plain object
			expect(String(s)).toBe("[object Object]");
		});

		it("`in` reports real fields but not non-fields or inherited keys", () => {
			const [s] = reactiveStruct({ a: 1, b: 2 });
			expect("a" in s).toBe(true);
			expect("b" in s).toBe(true);
			expect("nope" in s).toBe(false);
			expect("toString" in s).toBe(false); // inherited Object.prototype key isn't a field
		});

		it("a non-field key (then / Symbol.iterator) reads undefined and does not throw", () => {
			const [s] = reactiveStruct({ a: 1 });
			// `await proxy` probes `.then`; `for..of` probes `Symbol.iterator`.
			expect(() => (s as { then?: unknown }).then).not.toThrow();
			expect((s as { then?: unknown }).then).toBeUndefined();
			expect((s as { [Symbol.iterator]?: unknown })[Symbol.iterator]).toBeUndefined();
		});

		it("getOwnPropertyDescriptor is an accessor reading the live signal and reflects setter writes", () => {
			const [s, set] = reactiveStruct({ a: 1, b: 2 });
			// The descriptor is an ACCESSOR (get-based) whose getter reads the live
			// signal — so the value materializes through `.get()` (and through spread /
			// Object.values, which invoke it), reflecting the current value rather than
			// the static `undefined` a value-less descriptor would normalize to.
			const d1 = Object.getOwnPropertyDescriptor(s, "a");
			expect(d1?.enumerable).toBe(true);
			expect(d1?.get?.()).toBe(1);
			set.a(42);
			expect(Object.getOwnPropertyDescriptor(s, "a")?.get?.()).toBe(42);
			// non-field keys report no own descriptor
			expect(Object.getOwnPropertyDescriptor(s, "nope")).toBeUndefined();
		});

		it("spread and Object.values yield all fields with current values", () => {
			const [s, set] = reactiveStruct({ a: 1, b: 2, c: 3 });
			expect({ ...s }).toEqual({ a: 1, b: 2, c: 3 });
			expect(Object.values(s)).toEqual([1, 2, 3]);
			set.b(20);
			expect({ ...s }).toEqual({ a: 1, b: 20, c: 3 });
			expect(Object.values(s)).toEqual([1, 20, 3]);
		});

		it("reading a real field still tracks reactively after the trap changes", () => {
			root(() => {
				const [s, set] = reactiveStruct({ a: 1, b: 2 });
				let runs = 0;
				const doubled = computed(() => {
					runs++;
					return s.a * 2;
				});
				expect(doubled()).toBe(2);
				expect(runs).toBe(1);

				let effectRuns = 0;
				effect(() => {
					effectRuns++;
					void s.a;
				});
				expect(effectRuns).toBe(1);

				set.a(5); // a real field write must still wake field readers
				expect(doubled()).toBe(10);
				expect(effectRuns).toBe(2);

				set.b(99); // an untouched field still wakes nobody on `a`
				expect(effectRuns).toBe(2);
			});
		});
	});
});
