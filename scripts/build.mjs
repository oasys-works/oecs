/**
 * Dual-variant library build.
 *
 * Emits two production artifacts from the single `vite.config.ts`:
 *   1. `production` , `__DEV__:false`, dev guards DCE'd, plain `*.js` and `*.cjs`
 *      (the package default, `main` and `module` and the no-condition `exports`
 *      fallback point here). Runs first: clears `dist` and emits declarations.
 *   2. `development`, `__DEV__:true`, guards retained, `*.development.js`/
 *      `*.development.cjs` (served by the `/dev` subpath and the `development`
 *      export condition). Runs second: adds its artifacts without clearing.
 *
 * The variant is passed to `vite.config.ts` via `OECS_VARIANT`. `vite`'s config
 * factory is re-evaluated on each `build()` call, so it reads the current value.
 * Declaration files are identical across variants and are emitted once (in the
 * production pass); `scripts/postbuild.mjs` then fixes them up.
 */
import { build } from "vite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the core pass records its module list and its entry exports. The
// plugin pass reads them back. Outside `dist`, because it is a note between
// two passes and not a shipped file. `scripts/core_boundary.ts` fails the build
// when this is unset, so the guard cannot be skipped by accident.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oecs-build-"));
process.env.OECS_CORE_MANIFEST = path.join(scratch, "core-graph.json");

for (const variant of ["production", "development"]) {
	process.env.OECS_VARIANT = variant;
	// The core entries first. `emptyOutDir` clears `dist` on the production pass
	// alone, and the declarations are emitted there.
	process.env.OECS_ENTRIES = "core";
	await build();
	// Then the plugins, in their own rollup graph. Declaring them beside
	// the core entries let rollup split `index.js` into small shared chunks, and
	// those splits cost real time at run time. `vite.config.ts` carries the
	// measurement note.
	process.env.OECS_ENTRIES = "plugins";
	await build();
	// Then the worker entry, in a third graph. It shares no module instance with
	// anything, because it runs in another thread, so it needs no binding pass.
	// Declared beside the core entries it would split `index.js` the same way the
	// plugins did.
	process.env.OECS_ENTRIES = "worker";
	await build();
	console.log(`build: ${variant} variant emitted`);
}
fs.rmSync(scratch, { recursive: true, force: true });
delete process.env.OECS_CORE_MANIFEST;
delete process.env.OECS_ENTRIES;
