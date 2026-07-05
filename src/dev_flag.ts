/**
 * The dev-mode flag, resolved once at module load.
 *
 * Bundled (npm) builds: Vite's `define` replaces the bare `__DEV__` global
 * below with a literal (`false` for `vite build`, `true` for dev/test), so
 * `DEV` constant-folds and dev-only branches are eliminated.
 *
 * Raw-source (JSR/Deno) consumers: no bundler defines `__DEV__`, the `typeof`
 * probe falls through, and `DEV` defaults to `true` (all dev checks on). To
 * opt out, set `globalThis.__DEV__ = false` before the first import of this
 * package.
 */
declare global {
	// eslint-disable-next-line no-var
	var __DEV__: boolean;
}

export const DEV: boolean = typeof __DEV__ !== "undefined" ? __DEV__ : true;
