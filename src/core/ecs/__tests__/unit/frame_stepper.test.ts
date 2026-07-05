/**
 * FrameStepper — the optional host-side driver over `ECS.update(dt)`. Asserts
 * the stepping contract (explicit `step`/`stepFrames` deltas, validation via
 * `INVALID_FRAME_STEP`), and the rAF loop contract through injected
 * `requestFrame`/`cancelFrame`: first frame after `play()` uses `fixedDt`
 * (no previous timestamp), subsequent frames forward the real delta, and raw
 * browser deltas are clamped to `maxDt` (a resumed background tab must not
 * feed the whole suspension into the accumulator as one update).
 */
import { describe, expect, it, vi } from "vitest";
import { ECS } from "../../ecs";
import { FrameStepper } from "../../frame_stepper";
import { ECS_ERROR, isEcsError } from "../../utils/error";

/** A hand-pumped rAF: `pump(ts)` runs the single pending callback, if any. */
function fakeRaf() {
	let next: ((ts: number) => void) | null = null;
	let handle = 0;
	const cancelled: number[] = [];
	return {
		requestFrame: (cb: (ts: number) => void): number => {
			next = cb;
			return ++handle;
		},
		cancelFrame: (h: number): void => {
			cancelled.push(h);
			next = null;
		},
		pump(ts: number): void {
			const cb = next;
			next = null;
			cb?.(ts);
		},
		get pending(): boolean {
			return next !== null;
		},
		cancelled
	};
}

function world(): { ecs: ECS; dts: () => number[] } {
	const ecs = new ECS();
	const update = vi.spyOn(ecs, "update");
	return { ecs, dts: () => update.mock.calls.map((c) => c[0]) };
}

describe("FrameStepper", () => {
	it("step() forwards fixedDt by default and an explicit dt verbatim", () => {
		const { ecs, dts } = world();
		const stepper = new FrameStepper(ecs, { fixedDt: 1 / 30 });
		stepper.step();
		stepper.step(0.5);
		expect(dts()).toEqual([1 / 30, 0.5]);
	});

	it("stepFrames(n) runs n fixed-size frames", () => {
		const { ecs, dts } = world();
		const stepper = new FrameStepper(ecs);
		stepper.stepFrames(3);
		expect(dts()).toEqual([1 / 60, 1 / 60, 1 / 60]);
	});

	it("validates dt and frame counts with INVALID_FRAME_STEP", () => {
		const { ecs } = world();
		const stepper = new FrameStepper(ecs);
		for (const bad of [() => stepper.step(-1), () => stepper.step(NaN), () => stepper.stepFrames(1.5), () => stepper.stepFrames(-1), () => new FrameStepper(ecs, { fixedDt: Infinity }), () => (stepper.maxDt = -0.1)]) {
			try {
				bad();
				expect.unreachable("expected INVALID_FRAME_STEP");
			} catch (e) {
				expect(isEcsError(e) && e.category === ECS_ERROR.INVALID_FRAME_STEP).toBe(true);
			}
		}
	});

	it("play(): first frame uses fixedDt, later frames forward the real delta, maxDt clamps", () => {
		const { ecs, dts } = world();
		const raf = fakeRaf();
		const stepper = new FrameStepper(ecs, {
			fixedDt: 1 / 60,
			maxDt: 0.25,
			requestFrame: raf.requestFrame,
			cancelFrame: raf.cancelFrame
		});
		stepper.play();
		expect(stepper.isRunning).toBe(true);
		raf.pump(1000); // no previous timestamp → fixedDt
		raf.pump(1016); // 16 ms
		raf.pump(6016); // 5 s suspension → clamped to maxDt
		expect(dts()).toEqual([1 / 60, 0.016, 0.25]);
		expect(raf.pending).toBe(true); // loop keeps rescheduling
	});

	it("pause() cancels the pending frame and resets the timestamp; play() resumes fresh", () => {
		const { ecs, dts } = world();
		const raf = fakeRaf();
		const stepper = new FrameStepper(ecs, {
			requestFrame: raf.requestFrame,
			cancelFrame: raf.cancelFrame
		});
		stepper.play();
		raf.pump(1000);
		stepper.pause();
		expect(stepper.isRunning).toBe(false);
		expect(raf.pending).toBe(false);
		expect(raf.cancelled.length).toBe(1);
		stepper.step(); // manual stepping still works while paused
		stepper.play();
		raf.pump(9000); // fresh start: fixedDt again, not an 8 s delta
		expect(dts()).toEqual([1 / 60, 1 / 60, 1 / 60]);
	});

	it("toggle() flips run state; play() is a no-op while running; dispose() pauses", () => {
		const { ecs } = world();
		const raf = fakeRaf();
		const stepper = new FrameStepper(ecs, {
			requestFrame: raf.requestFrame,
			cancelFrame: raf.cancelFrame
		});
		stepper.toggle();
		expect(stepper.isRunning).toBe(true);
		stepper.play(); // no-op
		expect(stepper.isRunning).toBe(true);
		stepper.toggle();
		expect(stepper.isRunning).toBe(false);
		stepper.toggle();
		stepper.dispose();
		expect(stepper.isRunning).toBe(false);
		expect(raf.pending).toBe(false);
	});

	it("autoStart starts the loop from the constructor", () => {
		const { ecs, dts } = world();
		const raf = fakeRaf();
		const stepper = new FrameStepper(ecs, {
			autoStart: true,
			requestFrame: raf.requestFrame,
			cancelFrame: raf.cancelFrame
		});
		expect(stepper.isRunning).toBe(true);
		raf.pump(0);
		expect(dts()).toEqual([1 / 60]);
		stepper.dispose();
	});

	it("play() without a frame source throws INVALID_FRAME_STEP", () => {
		const { ecs } = world();
		const stepper = new FrameStepper(ecs, {
			// simulate a non-browser host: no rAF injected, none on globalThis
			requestFrame: undefined,
			cancelFrame: undefined
		});
		// only meaningful where globalThis lacks rAF (vitest node env)
		if (typeof globalThis.requestAnimationFrame === "function") return;
		try {
			stepper.play();
			expect.unreachable("expected INVALID_FRAME_STEP");
		} catch (e) {
			expect(isEcsError(e) && e.category === ECS_ERROR.INVALID_FRAME_STEP).toBe(true);
		}
	});
});
