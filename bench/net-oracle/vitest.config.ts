/**
 * The vitest configuration for the oracle alone.
 *
 * The root `vitest.config.ts` collects `src/**` and NOTHING ELSE. That is
 * deliberate: `bench/` is a local tool, it is not a part of the package, and the
 * oracle must not run in the release gate. A file outside the `include` list of a
 * configuration cannot run, not even by its name, so this second configuration is
 * what makes `oracle.test.mjs` reachable.
 *
 * Run it like this, from the root of the repository:
 *
 *   pnpm exec vitest run --config bench/net-oracle/vitest.config.ts
 *
 * Nothing calls this file for you. No script in `package.json` names it, and no
 * workflow names it. `pnpm test` therefore does not run the oracle.
 *
 * Use this tool only for local work, as you use the other tools in `bench/`.
 */
import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
	// The oracle needs the guards of a development build: the access checker and each
	// internal assertion give more mechanisms a chance to find a fault. `run.mjs`
	// builds a bundle and takes `--prod` for the other arm.
	define: {
		__DEV__: true,
	},
	test: {
		environment: "node",
		root,
		include: ["bench/net-oracle/*.test.mjs"],
		// The oracle reduces nets with tens of thousands of rewrites, and it verifies at
		// each tick. That is much slower than a unit test, so the default limit of five
		// seconds for each test is too small.
		testTimeout: 120000,
		alias: Object.fromEntries(
			fs
				.readdirSync(path.join(root, "src"), { withFileTypes: true })
				.filter((dirent) => dirent.isDirectory())
				.map((dirent) => [dirent.name, path.join(root, "src", dirent.name)])
		),
	},
});
