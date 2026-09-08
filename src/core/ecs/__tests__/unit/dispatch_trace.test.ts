import { afterEach, describe, expect, it } from "vitest";
import { _dispatchTraceInternals } from "../../dispatch_trace";

const { parseFrameFile, resolveCallsiteFromStack, create } = _dispatchTraceInternals;

describe("dispatch_trace.parseFrameFile", () => {
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

describe("dispatch_trace.resolveCallsiteFromStack", () => {
	// Synthetic stack: the tracer's own frames (a source checkout of the engine)
	// stacked above the actual user dispatch site. The walk must drop every
	// engine frame and attribute the first non-engine (user) frame.
	const engineFrames = [
		"Error",
		"    at DispatchTrace.record (/repo/oecs/src/core/ecs/dispatch_trace.ts:130:20)",
		"    at World.emit (/repo/oecs/src/core/ecs/ecs.ts:822:5)"
	];
	const userFrame = "    at deathSystem (/repo/game/src/systems/combat/death.ts:42:10)";

	it("skips engine ECS frames and attributes the first user frame", () => {
		const stack = [...engineFrames, userFrame].join("\n");
		// Regression guard: if the engine frame skip is removed
		// (or its marker string drifts), the first engine frame
		// (dispatch_trace.ts) is attributed instead and this assertion fails.
		expect(resolveCallsiteFromStack(stack, "/repo")).toBe("game/src/systems/combat/death.ts");
	});

	it("skips the installed package under node_modules and attributes the first app frame", () => {
		const stack = [
			"Error",
			"    at DispatchTrace.record (/app/node_modules/@oasys/oecs/dist/internal.development.js:1301:20)",
			"    at ECS.emit (/app/node_modules/@oasys/oecs/dist/index.development.js:822:5)",
			"    at deathSystem (/app/src/systems/death.ts:42:10)"
		].join("\n");
		expect(resolveCallsiteFromStack(stack, "/app")).toBe("src/systems/death.ts");
	});

	it("strips a file:// scheme and trims the repo root on the attributed frame", () => {
		const stack = [
			...engineFrames,
			"    at deathSystem (file:///repo/game/src/systems/combat/death.ts:42:10)"
		].join("\n");
		expect(resolveCallsiteFromStack(stack, "/repo")).toBe("game/src/systems/combat/death.ts");
	});

	it("returns null when every frame is inside the engine ECS package", () => {
		const stack = engineFrames.join("\n");
		expect(resolveCallsiteFromStack(stack, "/repo")).toBeNull();
	});

	it("returns null for an empty or missing stack", () => {
		expect(resolveCallsiteFromStack(null, "/repo")).toBeNull();
		expect(resolveCallsiteFromStack("Error", "/repo")).toBeNull();
	});

	it("memoises per-line results in the supplied cache", () => {
		const cache = new Map<string, string | null>();
		const stack = [...engineFrames, userFrame].join("\n");
		const first = resolveCallsiteFromStack(stack, "/repo", cache);
		expect(first).toBe("game/src/systems/combat/death.ts");
		// An engine frame caches as null, because it is skipped. The user frame caches its
		// repo-relative path. A second walk hits the cache and agrees.
		expect(cache.get(engineFrames[1]!)).toBeNull();
		expect(cache.get(userFrame)).toBe("game/src/systems/combat/death.ts");
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

	it("isActive reflects VISUAL_INTEL_TRACE and caches until reset", () => {
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
		// record() is unconditional, the isActive() gate lives at the call
		// sites, `ecs.ts` and `query.ts`, not here, so a fresh tracer records with
		// no env setup. All three calls share one callsite → two distinct keys.
		t.recordEventEmit("Death");
		t.recordEventEmit("Death");
		t.recordEventEmit("Damage");
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

	it("records resource removes on the dedicated 'remove' op", () => {
		const t = create();
		t.recordResourceRemove("Mode");
		const snap = t.snapshot();
		expect(snap.channels.resources.remove.length).toBe(1);
		expect(snap.channels.resources.remove[0]!.key).toBe("Mode");
		// A remove is its own op. It does not leak into register or write.
		expect(snap.channels.resources.register.length).toBe(0);
		expect(snap.channels.resources.write.length).toBe(0);
	});

	it("separates an event read from an event emit of the same key", () => {
		const t = create();
		t.recordEventEmit("Death");
		t.recordEventRead("Death");
		t.recordEventRead("Death");
		const snap = t.snapshot();
		expect(snap.channels["ecs-events"].emit.length).toBe(1);
		expect(snap.channels["ecs-events"].emit[0]!.count).toBe(1);
		expect(snap.channels["ecs-events"].read.length).toBe(1);
		expect(snap.channels["ecs-events"].read[0]!.key).toBe("Death");
		expect(snap.channels["ecs-events"].read[0]!.count).toBe(2);
	});

	it("keeps an action key numeric, and separates send from handle", () => {
		const t = create();
		t.recordSendAction(7);
		t.recordHandleAction(7);
		t.recordHandleAction(9);
		const snap = t.snapshot();
		const send = snap.channels.actions.send_action;
		const handle = snap.channels.actions.handle_action;
		expect(send.length).toBe(1);
		// The actions channel is the one that reads its key back as a number.
		// Every other channel carries a label.
		expect(send[0]!.key).toBe(7);
		expect(handle.map((e) => e.key).sort()).toEqual([7, 9]);
	});
});
