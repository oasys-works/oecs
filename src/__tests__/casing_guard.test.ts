import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findStaleComments } from "./casing_codemod";

// `src/` — this file lives in `src/__tests__/`, so one level up is the source root.
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("casing guard", () => {
	// oecs is camelCase (the engine re-derive is snake_case); the identifier
	// rename shipped but doc-comments lagged. This guard fails a port that
	// reintroduces stale snake_case API names in comments. See port log §5 and
	// `casing_codemod.ts` for the (string-safe, ABI-safe) discrimination.
	it("has no stale snake_case API references in comments", () => {
		const stale = findStaleComments(SRC_DIR);
		const sample = stale.slice(0, 20).map((r) => `${r.token} → ${r.camel} (${r.file})`);
		expect(
			stale,
			`Found ${stale.length} stale snake_case comment ref(s). Run the comment codemod ` +
				`(applyComments from casing_codemod.ts). First offenders:\n  ${sample.join("\n  ")}`
		).toHaveLength(0);
	});
});
