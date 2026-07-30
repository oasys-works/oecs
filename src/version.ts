/**
 * The package version, readable at runtime.
 *
 * A literal, not a build-time injection, so raw-source (JSR) consumers get the
 * same value as the npm bundle. Kept in lock-step with `package.json` /
 * `jsr.json` by `src/__tests__/version_sync.test.ts` — bump all three
 * together.
 */
export const VERSION = "0.5.4";
