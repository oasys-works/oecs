import type { ECS } from "./ecs";
import { ECS_ERROR, ECSError } from "./utils/error";

type FrameCallback = (timestampMs: number) => void;
type RequestFrame = (callback: FrameCallback) => number;
type CancelFrame = (handle: number) => void;
type FrameGlobal = {
	requestAnimationFrame?: RequestFrame;
	cancelAnimationFrame?: CancelFrame;
};

export interface FrameStepperOptions {
	/** Delta used by `step()` when no dt is supplied, in seconds. Default 1/60. */
	readonly fixedDt?: number;
	/** Clamp browser-frame deltas before forwarding them to `ECS.update()`, in
	 * seconds. Default 0.25. A backgrounded tab suspends rAF; the first frame
	 * after it resumes carries the whole suspended interval as one delta, and
	 * without the clamp that lands in `update()`'s accumulator as a giant
	 * catch-up burst (bounded by `maxFixedSteps`, but still a burst). Manual
	 * `step()` deltas are deliberately not clamped — an explicit dt is trusted. */
	readonly maxDt?: number;
	/** Dependency injection for tests or non-browser hosts. Defaults to `requestAnimationFrame`. */
	readonly requestFrame?: RequestFrame;
	/** Dependency injection for tests or non-browser hosts. Defaults to `cancelAnimationFrame`. */
	readonly cancelFrame?: CancelFrame;
	/** Start the automatic frame loop immediately. */
	readonly autoStart?: boolean;
}

function validateDt(name: string, value: number): number {
	if (!(value >= 0) || !Number.isFinite(value)) {
		throw new ECSError(
			ECS_ERROR.INVALID_FRAME_STEP,
			`${name} must be a finite number >= 0, got ${value}`
		);
	}
	return value;
}

function validateFrameCount(count: number): number {
	if (!Number.isInteger(count) || count < 0) {
		throw new ECSError(
			ECS_ERROR.INVALID_FRAME_STEP,
			`frame count must be an integer >= 0, got ${count}`
		);
	}
	return count;
}

/**
 * Small host-side controller for manual ECS frame stepping.
 *
 * `ECS.update(dt)` is already the authoritative "run one frame" primitive.
 * This class wraps it with pause/play controls for browser loops and an explicit
 * `step()` method for debuggers, tests, editor tools, and rollback playback.
 */
export class FrameStepper {
	private readonly ecs: ECS;
	private readonly requestFrame?: RequestFrame;
	private readonly cancelFrame?: CancelFrame;
	private frameHandle: number | null = null;
	private lastTimestampMs: number | null = null;
	private running = false;
	private _fixedDt: number;
	private _maxDt: number;

	public constructor(ecs: ECS, options: FrameStepperOptions = {}) {
		this.ecs = ecs;
		this._fixedDt = validateDt("fixedDt", options.fixedDt ?? 1 / 60);
		this._maxDt = validateDt("maxDt", options.maxDt ?? 0.25);
		const frameGlobal = globalThis as FrameGlobal;
		this.requestFrame =
			options.requestFrame ?? frameGlobal.requestAnimationFrame?.bind(globalThis);
		this.cancelFrame = options.cancelFrame ?? frameGlobal.cancelAnimationFrame?.bind(globalThis);
		if (options.autoStart === true) this.play();
	}

	public get fixedDt(): number {
		return this._fixedDt;
	}

	public set fixedDt(value: number) {
		this._fixedDt = validateDt("fixedDt", value);
	}

	public get maxDt(): number {
		return this._maxDt;
	}

	public set maxDt(value: number) {
		this._maxDt = validateDt("maxDt", value);
	}

	public get isRunning(): boolean {
		return this.running;
	}

	/** Advance exactly one ECS frame. */
	public step(dt: number = this._fixedDt): void {
		this.ecs.update(validateDt("dt", dt));
	}

	/** Advance several fixed-size frames, useful for replaying a paused sim. */
	public stepFrames(count: number, dt: number = this._fixedDt): void {
		validateFrameCount(count);
		const frameDt = validateDt("dt", dt);
		for (let i = 0; i < count; i++) this.ecs.update(frameDt);
	}

	/** Start ticking with `requestAnimationFrame`; no-op when already running. */
	public play(): void {
		if (this.running) return;
		if (this.requestFrame === undefined) {
			throw new ECSError(
				ECS_ERROR.INVALID_FRAME_STEP,
				"FrameStepper.play() requires requestAnimationFrame or a requestFrame option"
			);
		}
		this.running = true;
		this.lastTimestampMs = null;
		this.scheduleNextFrame();
	}

	/** Stop the automatic frame loop. Manual `step()` still works while paused. */
	public pause(): void {
		this.running = false;
		this.lastTimestampMs = null;
		if (this.frameHandle !== null && this.cancelFrame !== undefined) {
			this.cancelFrame(this.frameHandle);
		}
		this.frameHandle = null;
	}

	public toggle(): void {
		if (this.running) this.pause();
		else this.play();
	}

	public dispose(): void {
		this.pause();
	}

	private scheduleNextFrame(): void {
		this.frameHandle = this.requestFrame?.(this.onFrame) ?? null;
	}

	private readonly onFrame = (timestampMs: number): void => {
		if (!this.running) return;
		// First frame after play() has no previous timestamp — use fixedDt.
		const rawDt =
			this.lastTimestampMs === null ? this._fixedDt : (timestampMs - this.lastTimestampMs) / 1000;
		this.lastTimestampMs = timestampMs;
		this.ecs.update(Math.min(validateDt("dt", rawDt), this._maxDt));
		if (this.running) this.scheduleNextFrame();
	};
}
