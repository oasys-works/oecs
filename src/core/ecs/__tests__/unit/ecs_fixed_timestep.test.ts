/**
 * `fixedTimestep` is validated at the configuration boundary.
 *
 * `update()` drives a `while (accumulator >= fixedTimestep)` catch-up loop. A
 * non-positive timestep makes that loop non-terminating (the accumulator never
 * decreases), and a non-finite one poisons `fixedAlpha`. Both are rejected by
 * the constructor and the setter rather than hanging mid-tick.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECS_ERROR, isEcsError } from "../../utils/error";

const BAD = [0, -1, -1 / 60, NaN, Infinity, -Infinity];

describe("ECS — fixed_timestep validation", () => {
	for (const bad of BAD) {
		it(`constructor rejects fixed_timestep = ${bad}`, () => {
			expect(() => new ECS({ fixedTimestep: bad })).toThrow(/fixedTimestep must be/);
		});

		it(`setter rejects fixed_timestep = ${bad}`, () => {
			const w = new ECS();
			const before = w.fixedTimestep;
			expect(() => {
				w.fixedTimestep = bad;
			}).toThrow(/fixedTimestep must be/);
			expect(w.fixedTimestep).toBe(before); // unchanged after a rejected set
		});
	}

	it("the rejection is a categorised ECSError", () => {
		try {
			new ECS({ fixedTimestep: 0 });
			expect.unreachable("constructor should have thrown");
		} catch (err) {
			expect(isEcsError(err)).toBe(true);
			expect((err as { category: ECS_ERROR }).category).toBe(ECS_ERROR.INVALID_FIXED_TIMESTEP);
		}
	});

	it("accepts positive finite values via constructor and setter", () => {
		const w = new ECS({ fixedTimestep: 1 / 120 });
		expect(w.fixedTimestep).toBe(1 / 120);
		w.fixedTimestep = 1 / 30;
		expect(w.fixedTimestep).toBe(1 / 30);
	});
});

// ============================================================================
// `maxFixedSteps` is validated at the configuration boundary too.
//
// `update()` clamps the spiral-of-death with `maxAcc = maxFixedSteps *
// fixedTimestep`. A non-integer / < 1 / non-finite `maxFixedSteps` either
// makes that clamp never fire (`Infinity`/`NaN` ⇒ the `while (accumulator >=
// fixedTimestep)` catch-up loop runs unboundedly for a large `dt`) or freezes
// fixed systems (`0` clamps the accumulator to 0). The constructor rejects them
// the same way `fixedTimestep` does: an integer ≥ 1 is required.
// ============================================================================

// `1.5` (non-integer) and `Infinity` are the two new shapes beyond the
// fixedTimestep set; `0`, `-1`, `NaN`, `-Infinity` are shared.
const BAD_MAX_STEPS = [0, -1, 1.5, NaN, Infinity, -Infinity];

describe("ECS — max_fixed_steps validation", () => {
	for (const bad of BAD_MAX_STEPS) {
		it(`constructor rejects max_fixed_steps = ${bad}`, () => {
			expect(() => new ECS({ maxFixedSteps: bad })).toThrow(/maxFixedSteps must be/);
		});
	}

	it("the rejection is a categorised ECSError (INVALID_MAX_FIXED_STEPS)", () => {
		try {
			new ECS({ maxFixedSteps: Infinity });
			expect.unreachable("constructor should have thrown");
		} catch (err) {
			expect(isEcsError(err)).toBe(true);
			expect((err as { category: ECS_ERROR }).category).toBe(ECS_ERROR.INVALID_MAX_FIXED_STEPS);
		}
	});

	it("accepts a valid integer >= 1 via constructor", () => {
		expect(() => new ECS({ maxFixedSteps: 5 })).not.toThrow();
		expect(() => new ECS({ maxFixedSteps: 1 })).not.toThrow();
	});
});
