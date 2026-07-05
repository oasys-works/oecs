/**
 * Layout-scenario runner for the H5 grow/extend consolidation.
 *
 * Runs a fixed matrix of create → extend → grow sequences over every
 * allocator strategy and serializes the resulting store layouts (descriptor
 * placement, header fields, buffer sizes, view stamps, fast-path flags, and
 * live data read-back) into a plain JSON structure. The golden fixture
 * (`layout_golden.json`) was captured from the pre-consolidation
 * implementation; `layout_golden.test.ts` asserts the current implementation
 * reproduces it byte-for-byte, so any layout drift in the shared helpers is
 * a loud failure rather than a silently relocated column.
 */

import {
	DEFAULT_SAB_ALLOCATOR,
	growableSabAllocator,
	heapArraybufferAllocator,
	wasmMemoryAllocator,
	type BufferAllocator
} from "../allocator";
import { createColumnStore, type ArchetypeSpec, type ColumnStore } from "../column_store";
import type { TypeTagValue } from "../descriptor";
import { extendColumnStore } from "../extend";
import { growColumnStore } from "../grow";

interface ColumnLayout {
	componentId: number;
	fieldId: number;
	typeTag: number;
	byteOff: number;
	stride: number;
}

interface ArchetypeLayout {
	archetypeId: number;
	rowCapacity: number;
	columns: ColumnLayout[];
}

interface StoreLayout {
	byteLength: number;
	headerCapacity: number;
	headerViewStamp: number;
	headerArchetypeCount: number;
	archetypes: ArchetypeLayout[];
}

export interface ScenarioStep {
	label: string;
	layout: StoreLayout;
	viewsPreserved?: boolean;
	oldViewStamp?: number;
	newViewStamp?: number;
	bufferIdentityKept?: boolean;
	/** Read-back of the seeded rows after the op — proves data survived. */
	dataProbe?: number[];
}

function dumpLayout(store: ColumnStore): StoreLayout {
	const archetypes: ArchetypeLayout[] = [];
	for (const [archetypeId, arch] of store.archetypes) {
		archetypes.push({
			archetypeId,
			rowCapacity: arch.rowCapacity,
			columns: arch.columnsInOrder.map((c) => ({
				componentId: c.componentId,
				fieldId: c.fieldId,
				typeTag: c.typeTag,
				byteOff: c.byteOff,
				stride: c.stride
			}))
		});
	}
	archetypes.sort((a, b) => a.archetypeId - b.archetypeId);
	return {
		byteLength: store.buffer.byteLength,
		headerCapacity: store.header.capacity,
		headerViewStamp: store.header.viewStamp,
		headerArchetypeCount: store.header.archetypeCount,
		archetypes
	};
}

const MASK = [0, 0, 0, 0];

function spec(archetypeId: number, rowCapacity: number, columnCount: number): ArchetypeSpec {
	const columns = [];
	for (let i = 0; i < columnCount; i++) {
		// Alternate f32 (tag 0-ish) and f64 strides via typeTag values the
		// descriptor layer understands: 6 = f32, 7 = f64 in TYPE_TAG order —
		// resolved through TYPE_TAG_STRIDE at layout time, so mixing tags
		// exercises alignUp with heterogeneous strides.
		columns.push({ componentId: archetypeId * 10 + i, fieldId: i, typeTag: (i % 2 === 0 ? 6 : 7) as TypeTagValue });
	}
	return { archetypeId, componentMask: MASK, rowCapacity, columns };
}

/** Seed recognizable values into the first live rows of archetype 0's first
 * column, so post-op probes prove live data survived the resize. */
function seedRows(store: ColumnStore, archetypeId: number, rows: number): void {
	const arch = store.archetypes.get(archetypeId);
	if (arch === undefined) return;
	const col = arch.columnsInOrder[0];
	const view = new DataView(store.buffer);
	for (let r = 0; r < rows; r++) {
		view.setFloat32(col.byteOff + r * col.stride, archetypeId * 1000 + r, true);
	}
}

function probeRows(store: ColumnStore, archetypeId: number, rows: number): number[] {
	const arch = store.archetypes.get(archetypeId);
	if (arch === undefined) return [];
	const col = arch.columnsInOrder[0];
	const view = new DataView(store.buffer);
	const out: number[] = [];
	for (let r = 0; r < rows; r++) {
		out.push(view.getFloat32(col.byteOff + r * col.stride, true));
	}
	return out;
}

function runMatrixFor(
	name: string,
	makeAllocator: () => BufferAllocator | undefined
): ScenarioStep[] {
	const steps: ScenarioStep[] = [];

	// --- Scenario A: create → in-place-eligible extend → grow one archetype.
	{
		const allocator = makeAllocator();
		let store = createColumnStore([spec(0, 8, 2), spec(1, 4, 1)], allocator, {
			reservedDescriptorBytes: 256
		});
		seedRows(store, 0, 3);
		steps.push({ label: `${name}/A/create`, layout: dumpLayout(store) });

		const ext = extendColumnStore(store, { newArchetypes: [spec(2, 16, 3)] }, allocator);
		steps.push({
			label: `${name}/A/extend`,
			layout: dumpLayout(ext.store),
			viewsPreserved: ext.viewsPreserved,
			oldViewStamp: ext.oldViewStamp,
			newViewStamp: ext.newViewStamp,
			bufferIdentityKept: ext.store.buffer === store.buffer,
			dataProbe: probeRows(ext.store, 0, 3)
		});
		store = ext.store;

		const grown = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 0, newRowCapacity: 32, rowCount: 3 }] },
			allocator
		);
		steps.push({
			label: `${name}/A/grow`,
			layout: dumpLayout(grown.store),
			viewsPreserved: grown.viewsPreserved,
			oldViewStamp: grown.oldViewStamp,
			newViewStamp: grown.newViewStamp,
			bufferIdentityKept: grown.store.buffer === store.buffer,
			dataProbe: probeRows(grown.store, 0, 3)
		});
	}

	// --- Scenario B: descriptor headroom exhaustion → realloc fallback.
	{
		const allocator = makeAllocator();
		// Zero reserved headroom: the first extend cannot take the in-place
		// descriptor-append path and must realloc-and-republish.
		let store = createColumnStore([spec(0, 8, 2)], allocator, {
			reservedDescriptorBytes: 0
		});
		seedRows(store, 0, 5);
		const ext = extendColumnStore(store, { newArchetypes: [spec(1, 8, 2)] }, allocator);
		steps.push({
			label: `${name}/B/extend-realloc`,
			layout: dumpLayout(ext.store),
			viewsPreserved: ext.viewsPreserved,
			oldViewStamp: ext.oldViewStamp,
			newViewStamp: ext.newViewStamp,
			dataProbe: probeRows(ext.store, 0, 5)
		});
		store = ext.store;

		// Extend again carrying live rows via `existing` — realloc path must
		// copy them into the republished store.
		const ext2 = extendColumnStore(
			store,
			{
				newArchetypes: [spec(2, 4, 1)],
				existing: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 5 }]
			},
			allocator
		);
		steps.push({
			label: `${name}/B/extend-existing-rows`,
			layout: dumpLayout(ext2.store),
			viewsPreserved: ext2.viewsPreserved,
			newViewStamp: ext2.newViewStamp,
			dataProbe: probeRows(ext2.store, 0, 5)
		});
	}

	// --- Scenario C: grow with no capacity change (no grow targets) — must
	// take the realloc path even under an in-place allocator.
	{
		const allocator = makeAllocator();
		const store = createColumnStore([spec(0, 8, 1)], allocator);
		seedRows(store, 0, 2);
		const grown = growColumnStore(
			store,
			{ archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 2 }] },
			allocator
		);
		steps.push({
			label: `${name}/C/grow-no-targets`,
			layout: dumpLayout(grown.store),
			viewsPreserved: grown.viewsPreserved,
			newViewStamp: grown.newViewStamp,
			dataProbe: probeRows(grown.store, 0, 2)
		});
	}

	return steps;
}

export function runAllScenarios(): Record<string, ScenarioStep[]> {
	const out: Record<string, ScenarioStep[]> = {};
	out.growable_sab = runMatrixFor("growable_sab", () => growableSabAllocator(4 * 1024 * 1024));
	out.heap_arraybuffer = runMatrixFor("heap_arraybuffer", () =>
		heapArraybufferAllocator(4 * 1024 * 1024)
	);
	out.default_fresh_sab = runMatrixFor("default_fresh_sab", () => DEFAULT_SAB_ALLOCATOR);
	out.wasm_memory = runMatrixFor("wasm_memory", () =>
		wasmMemoryAllocator(new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true }))
	);
	return out;
}
