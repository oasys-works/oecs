/**
 * Relations — `addRelation` endpoint-liveness guard in a *production* build (#495).
 *
 * `Store.addRelation` rejects a dead `src`/`tgt` by throwing in `__DEV__` and
 * no-opping in production (symmetric). The dev throw is the only behaviour the
 * normal suite can observe: vitest hard-codes `define: { __DEV__: true }`
 * (vitest.config.ts), so `if (__DEV__)` is substituted to `if (true)` at
 * transform time and the production no-op branch is *unreachable* from an
 * ordinary test — `vi.stubGlobal("__DEV__", …)` cannot reach a statically
 * substituted identifier.
 *
 * Before the fix the target check was `__DEV__`-only; a production build linked
 * a reverse-index entry keyed by the already-dead target handle, which no
 * destroy path can ever clean (`sourcesOf(deadTgt)` listed `src` forever).
 *
 * To exercise the real production branch we bundle a tiny harness with
 * `define: { __DEV__: false }` + `minifySyntax` (the same substitute→DCE
 * pipeline the shipped build uses) and run it. On the buggy code this reports
 * `leaked: [<src>]`; the fix makes it `[]`.
 *
 * esbuild is the bundler vite already runs for every module transform, so it is
 * always present (and lockfile-pinned). Under pnpm's strict node_modules it is
 * a *non-hoisted* transitive dependency, so a bare `import "esbuild"` fails to
 * resolve from this package; we instead resolve it through vite (a direct
 * dev-dependency whose hard dependency on esbuild is guaranteed). No new
 * dependency is introduced.
 */

import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = resolve(HERE, "../../store.ts");

type Outcome = { threw: boolean; leaked: number[] };

// Minimal structural type for the sliver of esbuild's `build` we use (bundle to
// in-memory output). Declared locally so tsc needn't resolve the `esbuild`
// module in a type position — it isn't a direct dependency of this package.
type EsbuildBuild = (opts: {
	entryPoints: string[];
	bundle: boolean;
	format: "esm";
	platform: "node";
	define: Record<string, string>;
	minifySyntax: boolean;
	write: false;
}) => Promise<{ outputFiles: { text: string }[] }>;

/** Resolve esbuild's `build` through vite's dependency tree (see file header). */
async function loadEsbuildBuild(): Promise<EsbuildBuild> {
	const esbuildPath = require.resolve("esbuild", { paths: [require.resolve("vite")] });
	const mod = await import(esbuildPath);
	return mod.build as EsbuildBuild;
}

// Bundle + run a harness that links a relation to an already-dead target, once
// per cardinality, against a `__DEV__: false` (production) build of the engine.
async function runProdHarness(): Promise<Record<"exclusive" | "multi", Outcome>> {
	const build = await loadEsbuildBuild();
	const dir = mkdtempSync(join(tmpdir(), "ecs-prod-guard-"));
	try {
		const entry = join(dir, "harness.mjs");
		writeFileSync(
			entry,
			`import { Store } from ${JSON.stringify(STORE)};
export function run() {
	const out = {};
	for (const [name, opts] of [["exclusive", {}], ["multi", { multi: true }]]) {
		const s = new Store();
		const R = s.registerRelation(opts);
		const src = s.createEntity();
		const tgt = s.createEntity();
		s.destroyEntity(tgt); // tgt is now a dead handle
		let threw = false;
		try { s.addRelation(src, R, tgt); } catch { threw = true; }
		// A leaked reverse entry keyed by the dead target surfaces here.
		out[name] = { threw, leaked: s.sourcesOf(tgt, R).map((e) => Number(e)) };
	}
	return out;
}
`
		);
		const result = await build({
			entryPoints: [entry],
			bundle: true,
			format: "esm",
			platform: "node",
			// The production substitution: every `__DEV__` identifier → `false`,
			// then minify-syntax DCEs the resulting `if (false) { … }` guards.
			define: { __DEV__: "false" },
			minifySyntax: true,
			write: false
		});
		const out = join(dir, "out.mjs");
		writeFileSync(out, result.outputFiles[0].text);
		const mod: { run: () => Record<"exclusive" | "multi", Outcome> } = await import(
			pathToFileURL(out).href
		);
		return mod.run();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("addRelation production endpoint-liveness guard (#495)", () => {
	it("linking a dead target no-ops and leaks no reverse entry (exclusive + multi)", async () => {
		const out = await runProdHarness();

		// Production must not throw (the dev-only ENTITY_NOT_ALIVE is DCE'd out)…
		expect(out.exclusive.threw).toBe(false);
		expect(out.multi.threw).toBe(false);

		// …and, critically, must not link a reverse-index entry keyed by the
		// already-dead target. Pre-fix this was `[<src>]` and uncleanable.
		expect(out.exclusive.leaked).toEqual([]);
		expect(out.multi.leaked).toEqual([]);
	});
});
