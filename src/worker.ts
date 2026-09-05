/***
 * The engine's worker entry, `@oasys/oecs/worker`.
 *
 * `attachWorkers` starts this file. It picks the runtime, builds the worker
 * body, and hands every message to it. It exports nothing, because a worker is
 * started and not imported.
 *
 * Node and the node-compatible runtimes take their start payload from
 * `workerData`, which is there before the first message. A browser worker takes
 * it from the first message instead.
 *
 * Every import below names the file with its extension. This entry ships as its
 * own bundle, and the tests load the source through plain node, which resolves
 * a relative specifier by its extension.
 ***/

import { loadNodeThreads } from "./core/ecs/parallel/node_threads.ts";
import { createWorkerRuntime, type WorkerRuntime } from "./core/ecs/parallel/worker_loop.ts";
import type { HostMessage, WorkerReply, WorkerStart } from "./core/ecs/parallel/protocol.ts";

interface WorkerScope {
	postMessage(reply: WorkerReply): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

function startBrowser(): void {
	const scope = globalThis as unknown as WorkerScope;
	let runtime: WorkerRuntime | null = null;
	scope.addEventListener("message", (event: MessageEvent) => {
		if (runtime === null) {
			runtime = createWorkerRuntime(event.data as WorkerStart, (reply) => scope.postMessage(reply));
			scope.postMessage({ type: "ready" });
			return;
		}
		runtime.onMessage(event.data as HostMessage);
	});
}

function startNode(): void {
	// Dynamic, and not a top-level await: the CommonJS build has no top-level
	// await. `loadNodeThreads` hides the specifier from a bundler, which would
	// otherwise report an externalized node builtin for a branch the browser
	// never runs.
	void loadNodeThreads().then((threads) => {
		const port = threads.parentPort;
		if (port === null) return;
		const runtime = createWorkerRuntime(threads.workerData as WorkerStart, (reply) =>
			port.postMessage(reply)
		);
		port.on("message", (message: HostMessage) => runtime.onMessage(message));
		port.postMessage({ type: "ready" });
	});
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined") {
	startBrowser();
} else {
	startNode();
}
