/***
 * `node:worker_threads`, reached without a specifier a bundler can see.
 *
 * The pool and the worker entry both need the node threads module, and both
 * ship in a bundle an app may compile for the browser. A literal
 * `import("node:worker_threads")` is visible to the bundler, so the bundler
 * reports an externalized node builtin and ships a stub module in its place.
 * The report is noise, because the browser branch never evaluates the call, and
 * an app author cannot act on it.
 *
 * `process.getBuiltinModule` reads the builtin with no specifier for a bundler
 * to resolve. Node gained it after the version this package supports, so the
 * fallback builds the specifier at run time, which no bundler resolves either.
 ***/

type NodeThreads = typeof import("node:worker_threads");

interface BuiltinHost {
	getBuiltinModule?: (id: string) => unknown;
}

/**
 * The node threads module, on a node-compatible runtime.
 *
 * The caller decides that the runtime is node-compatible. On a browser this
 * rejects, because there is no builtin to read. Cold path, and a caller runs it
 * once for each pool and once for each worker.
 */
export async function loadNodeThreads(): Promise<NodeThreads> {
	const proc = (globalThis as { process?: BuiltinHost }).process;
	const builtin = proc?.getBuiltinModule;
	if (typeof builtin === "function") return builtin.call(proc, "node:worker_threads") as NodeThreads;
	// Joined, and not written out, so no bundler and no minifier can fold the
	// argument back into a literal it would then resolve.
	const specifier = ["node", "worker_threads"].join(":");
	return (await import(/* @vite-ignore */ specifier)) as NodeThreads;
}
