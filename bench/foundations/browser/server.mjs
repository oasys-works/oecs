/**
 * A static server for the browser matrix, with the two cross-origin isolation
 * headers.
 *
 * `SharedArrayBuffer` exists in a page only when the response carries
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. Every world in this harness
 * needs the shared or the wasm backing, so every response carries both.
 *
 * The root is the repository, because the page reads three trees: the built
 * `dist/`, the probe helpers under `bench/foundations/`, and the checked-in
 * `store_reader.wasm` under `src/`. A path that leaves the root is refused.
 *
 * Run it alone with `node bench/foundations/browser/server.mjs [port]`, or let
 * `drive.mjs` start it.
 */
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".json": "application/json",
	".map": "application/json",
	".wasm": "application/wasm"
};

/** Start the server and resolve with its origin and a close function. Port 0
 * asks the operating system for a free port, so two runs never collide. */
export function startServer({ port = 0, root = REPO_ROOT } = {}) {
	const rootReal = root.endsWith(sep) ? root : root + sep;
	const server = createServer((req, res) => {
		void serve(req, res, rootReal);
	});
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				origin: `http://127.0.0.1:${address.port}`,
				close: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}

async function serve(req, res, rootReal) {
	const url = new URL(req.url, "http://127.0.0.1");
	let path = normalize(decodeURIComponent(url.pathname));
	if (path === "/") path = "/bench/foundations/browser/index.html";
	const headers = {
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cache-Control": "no-store"
	};
	try {
		const real = await realpath(join(rootReal, path));
		// A symlink can point outside the tree, so the check runs on the resolved
		// path and not on the requested one.
		if (!real.startsWith(rootReal)) throw new Error("outside the root");
		const info = await stat(real);
		if (!info.isFile()) throw new Error("not a file");
		const body = await readFile(real);
		res.writeHead(200, {
			...headers,
			"Content-Type": TYPES[extname(real)] ?? "application/octet-stream"
		});
		res.end(body);
	} catch {
		res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
		res.end(`404 ${path}`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { origin } = await startServer({ port: Number(process.argv[2] ?? 8765) });
	console.log(`serving ${REPO_ROOT} on ${origin}`);
}
