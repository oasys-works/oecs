/**
 * Dev-mode dispatch tracer.
 *
 * Singleton buffer that captures `(callsite, channel, op, key)` per ECS /
 * action dispatch when `VISUAL_INTEL_TRACE=1` is set in the environment.
 * Compile-time gated by `__DEV__`, so production builds dead-code-eliminate
 * every record() call. Output is a deterministic JSON snapshot the
 * `visual-intel` service can ingest as a third channel of evidence
 * alongside the existing static + symbol-propagation scans.
 *
 * Identity model. The engine has no access to source-level binding names
 * (`ContactEvent`, `ConfigRes`) at runtime — `eventKey("Contact")` returns
 * `Symbol("Contact")` and the variable name is erased. The tracer records the
 * runtime-available identifier:
 *
 *   - ECS events / resources → the Symbol description (`label`).
 *   - Actions → the numeric `def.id`.
 *
 * Resolution back to bindings happens in `visual-intel`, which already
 * extracts `{ binding, label }` declarations for events / resources and
 * `{ binding, id_expr }` for actions; the matching there is unambiguous.
 *
 * Callsite resolution. `new Error().stack` inside `record()`, walk the
 * frames, drop everything inside `packages/engine/src/core/ecs/` (this
 * file + the dispatcher seam), return the first repo-relative path. Stack-
 * line strings are cached so repeat dispatches from the same site are
 * O(1) after the first hit. The walk itself lives in the pure
 * `resolveCallsiteFromStack()` helper so it can be driven by a synthetic
 * stack in tests.
 *
 * Activation. `record()` is *unconditional* — it records on every call. The
 * `isActive()` env-var gate is applied by the *callers* (`ecs.ts` /
 * `query.ts`, all `if (__DEV__ && dispatchTrace.isActive())`), not inside
 * `record()`. This keeps the gate in one place — the dispatch hot path —
 * where `__DEV__ === false` dead-code-eliminates the whole branch in prod.
 */

// This module holds only the in-memory tracer — no filesystem access. It is
// transitively reachable from the browser `client` bundle (via core/ecs), so it
// must stay free of `node:fs` / `node:path`. Persisting a snapshot to disk is a
// server-only concern and lives in `services/server` (#384).

export type DispatchChannel = "ecs-events" | "actions" | "resources";
export type EcsEventOp = "emit" | "read";
export type ActionOp = "send_action" | "handle_action";
export type ResourceOp = "read" | "write" | "register" | "remove";

export interface DispatchTraceEntry {
	/** Symbol description (events / resources) or numeric `def.id` (actions). */
	readonly key: string | number;
	/** Repo-relative POSIX path of the calling file. */
	readonly file: string;
	readonly count: number;
}

export interface DispatchTraceSnapshot {
	readonly schemaVersion: 1;
	readonly capturedAt: string;
	readonly channels: {
		readonly "ecs-events": Record<EcsEventOp, DispatchTraceEntry[]>;
		readonly actions: Record<ActionOp, DispatchTraceEntry[]>;
		readonly resources: Record<ResourceOp, DispatchTraceEntry[]>;
	};
}

const ENGINE_FRAME_MARKER = "/packages/engine/src/core/ecs/";

class DispatchTrace {
	private activeCache: boolean | null = null;
	private repoRootCache: string | null = null;
	private buf = new Map<string, number>();
	private callsiteCache = new Map<string, string | null>();

	isActive(): boolean {
		if (this.activeCache !== null) return this.activeCache;
		// Reading process.env at every dispatch would be wasteful — cache once.
		// `globalThis.process` is checked because the engine is also browser-
		// reachable; if there's no process (browser bundles never include this
		// code, but be defensive) the tracer is inert.
		const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
		const envValue = proc?.env?.VISUAL_INTEL_TRACE;
		return (this.activeCache = envValue === "1" || envValue === "true");
	}

	private repoRoot(): string {
		if (this.repoRootCache !== null) return this.repoRootCache;
		const proc = (globalThis as { process?: { cwd?: () => string } }).process;
		return (this.repoRootCache = proc?.cwd?.() ?? "");
	}

	private resolveCallsite(): string | null {
		// `new Error().stack` is the cheap-but-not-free part; the walk itself
		// is the pure helper below so tests can feed a synthetic stack.
		return resolveCallsiteFromStack(
			new Error().stack ?? null,
			this.repoRoot(),
			this.callsiteCache
		);
	}

	private record(channel: DispatchChannel, op: string, key: string | number): void {
		const file = this.resolveCallsite();
		if (!file) return;
		const composite = `${channel}\t${op}\t${key}\t${file}`;
		this.buf.set(composite, (this.buf.get(composite) ?? 0) + 1);
	}

	recordEmit(label: string): void {
		this.record("ecs-events", "emit", label);
	}
	recordRead(label: string): void {
		this.record("ecs-events", "read", label);
	}
	recordResourceRead(label: string): void {
		this.record("resources", "read", label);
	}
	recordResourceWrite(label: string): void {
		this.record("resources", "write", label);
	}
	recordResourceRegister(label: string): void {
		this.record("resources", "register", label);
	}
	recordResourceRemove(label: string): void {
		this.record("resources", "remove", label);
	}
	recordSendAction(actId: number): void {
		this.record("actions", "send_action", actId);
	}
	recordHandleAction(actId: number): void {
		this.record("actions", "handle_action", actId);
	}

	snapshot(): DispatchTraceSnapshot {
		const channels: DispatchTraceSnapshot["channels"] = {
			"ecs-events": { emit: [], read: [] },
			actions: { send_action: [], handle_action: [] },
			resources: { read: [], write: [], register: [], remove: [] }
		};
		for (const [composite, count] of this.buf.entries()) {
			const [channel, op, keyStr, file] = composite.split("\t");
			if (!channel || !op || file === undefined) continue;
			const key: string | number = channel === "actions" ? Number(keyStr) : (keyStr as string);
			const entry: DispatchTraceEntry = { key, file, count };
			const channelRecord = channels[channel as DispatchChannel] as Record<
				string,
				DispatchTraceEntry[]
			>;
			const list = channelRecord[op];
			if (list) list.push(entry);
		}
		for (const opMap of Object.values(channels) as Record<string, DispatchTraceEntry[]>[]) {
			for (const list of Object.values(opMap)) {
				list.sort((a, b) => {
					if (a.file !== b.file) return a.file < b.file ? -1 : 1;
					const ak = String(a.key);
					const bk = String(b.key);
					return ak < bk ? -1 : ak > bk ? 1 : 0;
				});
			}
		}
		return {
			schemaVersion: 1,
			capturedAt: new Date().toISOString(),
			channels
		};
	}

	reset(): void {
		this.buf.clear();
		this.callsiteCache.clear();
		this.activeCache = null;
		this.repoRootCache = null;
	}
}

// Frame format examples:
//   "    at fn_name (file:///abs/path/foo.ts:12:34)"
//   "    at file:///abs/path/foo.ts:12:34"
//   "    at fn_name (/abs/path/foo.ts:12:34)"
function parseFrameFile(line: string): string | null {
	// Try parenthesised form first.
	const paren = /\(([^)]+):\d+:\d+\)\s*$/.exec(line);
	if (paren) return paren[1] ?? null;
	const bare = /at\s+([^\s][^()]*?):\d+:\d+\s*$/.exec(line);
	if (bare) return (bare[1] ?? "").trim() || null;
	return null;
}

/**
 * Walk a stack string, drop frames inside the engine ECS package, and return
 * the first non-engine frame as a repo-relative POSIX path (or `null` if the
 * stack has no attributable frame). Pure so tests can drive it with a
 * synthetic stack; the optional `cache` memoises per-line results for the hot
 * dispatch path. Mutates `cache` when supplied.
 */
function resolveCallsiteFromStack(
	stack: string | null,
	repoRoot: string,
	cache?: Map<string, string | null>
): string | null {
	if (!stack) return null;
	const lines = stack.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const cached = cache?.get(line);
		if (cached !== undefined) {
			if (cached === null) continue;
			return cached;
		}
		const abs = parseFrameFile(line);
		if (!abs) {
			cache?.set(line, null);
			continue;
		}
		if (abs.includes(ENGINE_FRAME_MARKER)) {
			// Engine-internal frame — keep walking. Cache as null so we
			// don't reparse this line next time.
			cache?.set(line, null);
			continue;
		}
		const rel = toRepoRelative(abs, repoRoot);
		cache?.set(line, rel);
		return rel;
	}
	return null;
}

function toRepoRelative(abs: string, root: string): string {
	let p = abs;
	if (p.startsWith("file://")) {
		// Strip the URL prefix without pulling in node:url — the Bun /
		// V8 stack format always uses `file://` + an absolute path.
		p = p.slice("file://".length);
	}
	if (root && p.startsWith(root + "/")) {
		p = p.slice(root.length + 1);
	}
	return p.replace(/\\/g, "/");
}

export const dispatchTrace: DispatchTrace = new DispatchTrace();

// Test seam — exposes the parser, the pure callsite walk, and the tracer
// constructor without exposing the singleton's internals to production code.
export const _dispatchTraceInternals = {
	parseFrameFile,
	resolveCallsiteFromStack,
	create: () => new DispatchTrace()
};
