/**
 * Golden-layout differential gate for the grow and extend consolidation.
 *
 * `layout_golden.json` pins the layout of the full allocator matrix (growable
 * SAB, resizable heap ArrayBuffer, fresh-SAB default, shared
 * WebAssembly.Memory). This test re-runs the identical scenario matrix and
 * requires byte-identical layouts: descriptor placement, header fields, buffer
 * sizes, view stamps, fast-path selection, buffer identity, and live-data
 * survival.
 *
 * If this fails after an intentional layout change, re-capture the fixture
 * (see layout_scenarios.ts's header) and justify the diff in review, a
 * silent relocation of a column is exactly the bug class this pins down.
 *
 * The last test keeps a re-capture honest. It checks the pinned offsets
 * against the layout rule itself: a column starts past the descriptor region,
 * on its own stride, and ends inside the capacity. A capture of a broken
 * layout fails there.
 *
 * The archetype descriptor header widened when `entity_ids_off` joined it, so
 * the region grew by four bytes for each archetype and every column below it
 * moved up by that much, plus the realignment an f64 column needs when the
 * move is not a multiple of its stride. The fixture was re-captured for that
 * change, and the deltas match the rule.
 *
 * Store base: every scenario here runs at base 0. At base 0 the store writes
 * the same bytes it wrote before offsets became store relative, apart from the
 * `sim_abi_version` field, and this fixture records no version field, so it is
 * unchanged by that move. `store_base.test.ts` covers a nonzero base.
 */
import { describe, expect, it } from "vitest";
import { runAllScenarios } from "./layout_scenarios";
import golden from "./layout_golden.json";
import { archetypeDescriptorBytes } from "../descriptor";

/** The part of one fixture step the layout rule constrains. */
interface PinnedStep {
	label: string;
	layout: {
		headerCapacity: number;
		headerLayoutDescriptorOff: number;
		archetypes: {
			archetypeId: number;
			rowCapacity: number;
			columns: { componentId: number; byteOff: number; stride: number }[];
		}[];
	};
}

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

	// The fixture says where every column landed. This says why those places are
	// the legal ones, from the layout rule and not from a run, so a fixture that
	// recorded a bad layout cannot pass by being a fixture. It reads the pinned
	// bytes, and the equality above carries the result to the live run.
	it("every pinned column clears the descriptor region and sits on its own stride", () => {
		const pinned = golden as unknown as Record<string, PinnedStep[]>;
		for (const strategy of Object.keys(pinned)) {
			for (const step of pinned[strategy]) {
				const layout = step.layout;
				let regionEnd = layout.headerLayoutDescriptorOff;
				for (const arch of layout.archetypes) {
					regionEnd += archetypeDescriptorBytes(arch.columns.length);
				}
				for (const arch of layout.archetypes) {
					for (const col of arch.columns) {
						const where = `${step.label} archetype ${arch.archetypeId} column ${col.componentId}`;
						expect([where, col.byteOff >= regionEnd]).toEqual([where, true]);
						expect([where, col.byteOff % col.stride]).toEqual([where, 0]);
						const end = col.byteOff + col.stride * arch.rowCapacity;
						expect([where, end <= layout.headerCapacity]).toEqual([where, true]);
					}
				}
			}
		}
	});
});
