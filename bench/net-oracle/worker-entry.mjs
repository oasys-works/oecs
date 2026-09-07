/**
 * The worker entry of the oracle. It starts the loop from a named bundle.
 *
 * `src/worker.ts` is the entry the package ships, and it imports the sources of
 * the tree. A worker started from it therefore runs the sources, whatever bundle
 * the host loaded. `mutants.mjs` puts a fault into the bundle alone, so a fault
 * inside the worker was out of its reach. The split of the rows between the
 * workers lives there, in `worker_loop.ts`.
 *
 * This entry closes that. It imports the bundle that the host named and calls
 * `createWorkerRuntime` from it, exactly as `src/worker.ts` calls the one it
 * imported. So the host half and the worker half run one build.
 *
 * How the bundle path arrives. `OECS_NET_ORACLE_LIB` holds it, as a file URL. A
 * worker inherits the environment of the process that started it, and a query
 * string on the worker URL does not survive: node resolves the specifier to a
 * path and drops the search, so `import.meta.url` here spells no query.
 *
 * Node alone. The oracle runs no browser worker, and the pool starts this file
 * through `node:worker_threads`.
 */
import { parentPort, workerData } from "node:worker_threads";

const lib = process.env.OECS_NET_ORACLE_LIB;
if (lib === undefined || lib === "") {
	throw new Error(
		"worker-entry: OECS_NET_ORACLE_LIB names no bundle. Set it to the file URL of the build the host loaded"
	);
}
const { createWorkerRuntime } = await import(lib);
if (typeof createWorkerRuntime !== "function") {
	throw new Error(
		`worker-entry: ${lib} exports no createWorkerRuntime. Add it to ENTRY_SHIM in bench/build.mjs`
	);
}

// The node arm of `src/worker.ts`, line for line. The host writes `workerData`
// before the first message, so the runtime exists before a message arrives.
if (parentPort !== null) {
	const port = parentPort;
	const runtime = createWorkerRuntime(workerData, (reply) => port.postMessage(reply));
	port.on("message", (message) => runtime.onMessage(message));
	port.postMessage({ type: "ready" });
}
