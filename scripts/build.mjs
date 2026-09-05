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

for (const variant of ["production", "development"]) {
	process.env.OECS_VARIANT = variant;
	// The core entries first. `emptyOutDir` clears `dist` on the production pass
	// alone, and the declarations are emitted there.
	process.env.OECS_ENTRIES = "core";
	await build();
	// Then the capabilities, in their own rollup graph. Declaring them beside
	// the core entries let rollup split `index.js` into small shared chunks, and
	// those splits cost real time at run time. `vite.config.ts` carries the
	// measurement note.
	process.env.OECS_ENTRIES = "capabilities";
	await build();
	console.log(`build: ${variant} variant emitted`);
}
delete process.env.OECS_ENTRIES;
