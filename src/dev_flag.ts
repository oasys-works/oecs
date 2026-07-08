/**
 * The dev-mode flag, resolved once at module load.
 *
 * Bundled (npm) builds: Vite's `define` replaces the bare `__DEV__` global
 * below with a literal — `false` for the default/production build (`vite build`
 * of the production variant) and `true` for the `/dev` build and dev/test — so
 * `DEV` constant-folds and, in the production build, dev-only branches are
 * eliminated.
 *
 * Raw-source (JSR/Deno) consumers: no bundler defines `__DEV__`, the `typeof`
 * probe falls through, and `DEV` defaults to `false` (production — all dev
 * checks off, no per-frame tax). To turn the safety net ON while developing,
 * set `globalThis.__DEV__ = true` before the first import of this package.
 */
// Module-local ambient declaration, deliberately NOT `declare global` — JSR
// rejects packages that modify global types. This form type-checks the bare
// `__DEV__` reference below without touching the global scope; Vite's `define`
// still substitutes the token at build, and raw-source consumers resolve it
// off `globalThis` at runtime (unchanged emitted JS either way).
declare const __DEV__: boolean;

export const DEV: boolean = typeof __DEV__ !== "undefined" ? __DEV__ : false;
