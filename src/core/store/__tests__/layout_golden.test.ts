/**
 * Golden-layout differential gate for the grow and extend consolidation.
 *
 * `layout_golden.json` was captured from the pre-consolidation grow and extend
 * implementation over the full allocator matrix (growable SAB, resizable
 * heap ArrayBuffer, fresh-SAB default, shared WebAssembly.Memory). This test
 * re-runs the identical scenario matrix and requires byte-identical layouts:
 * descriptor placement, header fields, buffer sizes, view stamps, fast-path
 * selection, buffer identity, and live-data survival.
 *
 * If this fails after an intentional layout change, re-capture the fixture
 * (see layout_scenarios.ts's header) and justify the diff in review, a
 * silent relocation of a column is exactly the bug class this pins down.
 *
 * Store base: every scenario here runs at base 0. At base 0 the store writes
 * the same bytes it wrote before offsets became store relative, apart from the
 * `sim_abi_version` field, and this fixture records no version field, so it is
 * unchanged by that move. `store_base.test.ts` covers a nonzero base.
 */
import { describe, expect, it } from "vitest";
import { runAllScenarios } from "./layout_scenarios";
import golden from "./layout_golden.json";

describe("grow and extend golden layouts", () => {
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
