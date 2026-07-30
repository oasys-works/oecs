/**
 * Golden-layout differential gate for the grow/extend consolidation.
 *
 * `layout_golden.json` was captured from the PRE-consolidation grow/extend
 * implementation over the full allocator matrix (growable SAB, resizable
 * heap ArrayBuffer, fresh-SAB default, shared WebAssembly.Memory). This test
 * re-runs the identical scenario matrix and requires byte-identical layouts:
 * descriptor placement, header fields, buffer sizes, view stamps, fast-path
 * selection, buffer identity, and live-data survival.
 *
 * If this fails after an intentional layout change, re-capture the fixture
 * (see layout_scenarios.ts's header) and justify the diff in review — a
 * silent relocation of a column is exactly the bug class this pins down.
 */
import { describe, expect, it } from "vitest";
import { runAllScenarios } from "./layout_scenarios";
import golden from "./layout_golden.json";

describe("grow/extend golden layouts", () => {
	const actual = runAllScenarios();

	for (const strategy of Object.keys(golden)) {
		it(`${strategy}: layouts are byte-identical to the pre-consolidation capture`, () => {
			expect(actual[strategy]).toEqual((golden as Record<string, unknown>)[strategy]);
		});
	}

	it("covers every strategy present in the fixture", () => {
		expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
	});
});
