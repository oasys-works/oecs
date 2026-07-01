import { afterEach, describe, expect, it } from "vitest";
import { _dispatchTraceInternals } from "../../dispatch_trace";

const { parseFrameFile, resolveCallsiteFromStack, create } = _dispatchTraceInternals;

describe("dispatch_trace.parse_frame_file", () => {
	it("parses parenthesised V8 frame format", () => {
		const line = "    at fn_name (file:///abs/path/foo.ts:12:34)";
		expect(parseFrameFile(line)).toBe("file:///abs/path/foo.ts");
	});

	it("parses bare 'at file:line:col' format", () => {
		const line = "    at file:///abs/path/foo.ts:12:34";
		expect(parseFrameFile(line)).toBe("file:///abs/path/foo.ts");
	});

	it("parses absolute paths without scheme", () => {
		const line = "    at fn (/abs/path/foo.ts:12:34)";
		expect(parseFrameFile(line)).toBe("/abs/path/foo.ts");
	});

	it("returns null for non-frame lines", () => {
		expect(parseFrameFile("Error: oops")).toBeNull();
		expect(parseFrameFile("")).toBeNull();
	});
});

describe("dispatch_trace.resolve_callsite_from_stack", () => {
	// Synthetic stack: the tracer's own frames (inside the engine ECS package)
	// stacked above the actual user dispatch site. The walk must drop every
	// engine frame and attribute the first non-engine (user) frame.
	const engineFrames = [
		"Error",
		"    at DispatchTrace.record (/repo/packages/engine/src/core/ecs/dispatch_trace.ts:130:20)",
		"    at World.emit (/repo/packages/engine/src/core/ecs/ecs.ts:822:5)"
	];
	const userFrame = "    at deathSystem (/repo/packages/game/src/systems/combat/death.ts:42:10)";

	it("skips engine ECS frames and attributes the first user frame", () => {
		const stack = [...engineFrames, userFrame].join("\n");
		// Regression guard from #546: if the ENGINE_FRAME_MARKER skip is removed
		// (or its marker string drifts), the first engine frame
		// (dispatch_trace.ts) is attributed instead and this assertion fails.
		expect(resolveCallsiteFromStack(stack, "/repo")).toBe(
			"packages/game/src/systems/combat/death.ts"
		);
	});

	it("strips a file:// scheme and trims the repo root on the attributed frame", () => {
		const stack = [
			...engineFrames,
			"    at deathSystem (file:///repo/packages/game/src/systems/combat/death.ts:42:10)"
		].join("\n");
		expect(resolveCallsiteFromStack(stack, "/repo")).toBe(
			"packages/game/src/systems/combat/death.ts"
		);
	});

	it("returns null when every frame is inside the engine ECS package", () => {
		const stack = engineFrames.join("\n");
		expect(resolveCallsiteFromStack(stack, "/repo")).toBeNull();
	});

	it("returns null for an empty / missing stack", () => {
		expect(resolveCallsiteFromStack(null, "/repo")).toBeNull();
		expect(resolveCallsiteFromStack("Error", "/repo")).toBeNull();
	});

	it("memoises per-line results in the supplied cache", () => {
		const cache = new Map<string, string | null>();
		const stack = [...engineFrames, userFrame].join("\n");
		const first = resolveCallsiteFromStack(stack, "/repo", cache);
		expect(first).toBe("packages/game/src/systems/combat/death.ts");
		// Engine frames cache as null (skipped); the user frame caches its
		// repo-relative path. A second walk hits the cache and agrees.
		expect(cache.get(engineFrames[1]!)).toBeNull();
		expect(cache.get(userFrame)).toBe("packages/game/src/systems/combat/death.ts");
		expect(resolveCallsiteFromStack(stack, "/repo", cache)).toBe(first);
	});
});

describe("dispatch_trace tracer (constructed instance)", () => {
	afterEach(() => {
		delete process.env.VISUAL_INTEL_TRACE;
	});

	it("snapshot is empty before any record", () => {
		const t = create();
		const snap = t.snapshot();
		expect(snap.schemaVersion).toBe(1);
		expect(snap.channels["ecs-events"].emit).toEqual([]);
		expect(snap.channels.actions.handle_action).toEqual([]);
		expect(snap.channels.resources.read).toEqual([]);
	});

	it("is_active reflects VISUAL_INTEL_TRACE and caches until reset", () => {
		const t = create();
		delete process.env.VISUAL_INTEL_TRACE;
		t.reset();
		expect(t.isActive()).toBe(false);
		// Flipping the env var does not take effect until the cache is cleared.
		process.env.VISUAL_INTEL_TRACE = "1";
		expect(t.isActive()).toBe(false);
		t.reset();
		expect(t.isActive()).toBe(true);
	});

	it("counts repeated dispatches from the same site", () => {
		const t = create();
		// record() is unconditional — the isActive() gate lives at the call
		// sites (ecs.ts / query.ts), not here — so a fresh tracer records with
		// no env setup. All three calls share one callsite → two distinct keys.
		t.recordEmit("Death");
		t.recordEmit("Death");
		t.recordEmit("Damage");
		const snap = t.snapshot();
		const emits = snap.channels["ecs-events"].emit;
		const keys = emits.map((e) => e.key).sort();
		expect(keys).toEqual(["Damage", "Death"]);
		const death = emits.find((e) => e.key === "Death")!;
		expect(death.count).toBe(2);
	});

	it("snapshot output is deterministic per (file, key)", () => {
		const t = create();
		t.recordResourceRead("PlayerState");
		t.recordResourceWrite("PlayerState");
		t.recordResourceRegister("PlayerState");
		const snap = t.snapshot();
		expect(snap.channels.resources.read.length).toBe(1);
		expect(snap.channels.resources.write.length).toBe(1);
		expect(snap.channels.resources.register.length).toBe(1);
		expect(snap.channels.resources.read[0]!.key).toBe("PlayerState");
	});

	it("records resource removes on the dedicated 'remove' op (#798)", () => {
		const t = create();
		t.recordResourceRemove("Mode");
		const snap = t.snapshot();
		expect(snap.channels.resources.remove.length).toBe(1);
		expect(snap.channels.resources.remove[0]!.key).toBe("Mode");
		// A remove is its own op — it does not leak into register/write.
		expect(snap.channels.resources.register.length).toBe(0);
		expect(snap.channels.resources.write.length).toBe(0);
	});
});
