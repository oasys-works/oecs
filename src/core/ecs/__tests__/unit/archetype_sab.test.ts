import { describe, expect, it } from "vitest";

import {
	Archetype,
	asArchetypeId,
	type ArchetypeColumnLayout,
	type ColumnFactory
} from "../../archetype";
import { asComponentId, makeComponentDef } from "../../component";
import { createEntityId } from "../../entity";
import {
	BitSet,
	TypedArrayFor,
	type TypedArrayTag
} from "../../../../type_primitives";

import {
	columnKey,
	createColumnStore,
	TYPE_TAG,
	type ArchetypeSpec,
	type TypeTagValue
} from "../../../store";
import { StoreColumnOverflowError } from "../../../store/buffer_backed_column";

const archId = (n: number) => asArchetypeId(n);
const compId = (n: number) => asComponentId(n);
const entity = (index: number, gen: number = 0) => createEntityId(index, gen);

const TAG_TO_SAB: Record<TypedArrayTag, TypeTagValue> = {
	u8: TYPE_TAG.u8,
	i8: TYPE_TAG.i8,
	u16: TYPE_TAG.u16,
	i16: TYPE_TAG.i16,
	u32: TYPE_TAG.u32,
	i32: TYPE_TAG.i32,
	f32: TYPE_TAG.f32,
	f64: TYPE_TAG.f64
};

function makeMask(...ids: number[]): BitSet {
	const mask = new BitSet();
	for (const id of ids) mask.set(id);
	return mask;
}

function makeLayout(
	componentId: number,
	fields: string[],
	tag: TypedArrayTag = "f64"
): ArchetypeColumnLayout {
	const fieldIndex: Record<string, number> = Object.create(null);
	const fieldTypes: TypedArrayTag[] = [];
	for (let i = 0; i < fields.length; i++) {
		fieldIndex[fields[i]] = i;
		fieldTypes.push(tag);
	}
	return {
		componentId: compId(componentId),
		fieldNames: fields,
		fieldIndex,
		fieldTypes
	};
}

function specFromLayouts(
	archetypeId: number,
	rowCapacity: number,
	layouts: ArchetypeColumnLayout[],
	maskLo = 0,
	maskHi = 0
): ArchetypeSpec {
	const columns = layouts.flatMap((layout) =>
		layout.fieldNames.map((_, fieldIdx) => ({
			componentId: layout.componentId as unknown as number,
			fieldId: fieldIdx,
			typeTag: TAG_TO_SAB[layout.fieldTypes[fieldIdx]]
		}))
	);
	return {
		archetypeId,
		componentMask: [maskLo, maskHi, 0, 0],
		rowCapacity,
		columns
	};
}

describe("Archetype.from_column_store", () => {
	it("builds an Archetype whose columns are SAB views", () => {
		const layouts = [makeLayout(1, ["x", "y"], "f64")];
		const columnStore = createColumnStore([specFromLayouts(0, 16, layouts)]);

		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		expect(a.hasColumns).toBe(true);
		// Buf for each field IS the SAB view; mutating one is visible via the other.
		const def = makeComponentDef<{ x: "f64"; y: "f64" }>(compId(1));
		const colX = a.getColumn(def, "x", 0);
		const sabX = columnStore.archetypes.get(0)!.columns.get(columnKey(1, 0))!.view;
		expect(colX.buffer).toBe(columnStore.buffer);
		expect(colX).toBe(sabX);
	});

	it("rejects construction when ColumnStore has no matching archetype", () => {
		const layouts = [makeLayout(1, ["x"])];
		const columnStore = createColumnStore([specFromLayouts(0, 8, layouts)]);
		expect(() =>
			Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 99)
		).toThrow(/ColumnStore has no archetype 99/);
	});

	it("rejects construction when a layout field has no matching SAB column", () => {
		const layouts = [makeLayout(1, ["x", "y"])];
		// Spec covers only field_id 0 for component 1
		const spec: ArchetypeSpec = {
			archetypeId: 0,
			componentMask: [0, 0, 0, 0],
			rowCapacity: 8,
			columns: [{ componentId: 1, fieldId: 0, typeTag: TYPE_TAG.f64 }]
		};
		const columnStore = createColumnStore([spec]);
		expect(() => Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0)).toThrow(
			/has no column for/
		);
	});

	it("push past row_capacity throws StoreColumnOverflowError", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 2, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		expect(() => a.addEntity(entity(2))).toThrow(StoreColumnOverflowError);
		expect(a.entityCount).toBe(2);
	});
});

describe("Archetype.from_column_store parity with heap-backed Archetype", () => {
	const heapFactory: ColumnFactory = (_cid, _fidx, tag) => new TypedArrayFor[tag](64);

	function buildPair(rowCapacity: number): { heap: Archetype; buffer: Archetype } {
		const layouts = [makeLayout(1, ["x", "y"], "f64"), makeLayout(2, ["hp"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, rowCapacity, layouts)]);
		const heap = new Archetype(archId(0), makeMask(1, 2), layouts, rowCapacity, heapFactory);
		const buffer = Archetype.fromColumnStore(archId(0), makeMask(1, 2), layouts, columnStore, 0);
		return { heap, buffer };
	}

	function snapshotColumns(a: Archetype): { x: number[]; y: number[]; hp: number[] } {
		const len = a.entityCount;
		const x = a._flatColumns[0].buf;
		const y = a._flatColumns[1].buf;
		const hp = a._flatColumns[2].buf;
		return {
			x: Array.from(x.subarray(0, len)),
			y: Array.from(y.subarray(0, len)),
			hp: Array.from(hp.subarray(0, len))
		};
	}

	function applyOps(a: Archetype): void {
		a.addEntity(entity(10));
		a.writeFieldsPositional(0, compId(1), [1.5, 2.5], 1);
		a.writeFieldsPositional(0, compId(2), [100], 1);

		a.addEntity(entity(20));
		a.writeFieldsPositional(1, compId(1), [3.5, 4.5], 2);
		a.writeFieldsPositional(1, compId(2), [200], 2);

		a.addEntity(entity(30));
		a.writeFieldsPositional(2, compId(1), [5.5, 6.5], 3);
		a.writeFieldsPositional(2, compId(2), [300], 3);

		// swap-remove the middle row
		a.removeEntity(1);
	}

	it("entity_count and column state match after add/write/remove sequence", () => {
		const { heap, buffer } = buildPair(8);
		applyOps(heap);
		applyOps(buffer);

		expect(buffer.entityCount).toBe(heap.entityCount);
		expect(snapshotColumns(buffer)).toEqual(snapshotColumns(heap));
		expect(Array.from(buffer.entityList)).toEqual(Array.from(heap.entityList));
	});

	it("read_field round-trips through SAB columns", () => {
		const layouts = [makeLayout(1, ["x", "y"], "f64")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		a.addEntity(entity(0));
		a.writeFieldsPositional(0, compId(1), [3.25, -7.5], 1);

		expect(a.readField(0, compId(1), "x")).toBeCloseTo(3.25);
		expect(a.readField(0, compId(1), "y")).toBeCloseTo(-7.5);
	});

	it("get_column (mutable) returns the SAB view (writes visible in the SAB)", () => {
		const layouts = [makeLayout(1, ["x"], "f32")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);
		a.addEntity(entity(0));
		a.addEntity(entity(1));

		const def = makeComponentDef<{ x: "f32" }>(compId(1));
		const col = a.getColumn(def, "x", 1);
		col[0] = 11;
		col[1] = 22;

		// Read back through a fresh SAB view at the same offset
		const sabViewInfo = columnStore.archetypes.get(0)!.columns.get(columnKey(1, 0))!;
		const fresh = new Float32Array(columnStore.buffer, sabViewInfo.byteOff, 4);
		expect(fresh[0]).toBe(11);
		expect(fresh[1]).toBe(22);
	});

	it("add_entities bulk-zero-fills SAB-backed columns", () => {
		const layouts = [makeLayout(1, ["x", "y"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 8, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		// Pre-seed one row with non-zero data so the bulk-zero-fill is observable.
		a.addEntity(entity(99));
		a.writeFieldsPositional(0, compId(1), [42, 43], 1);

		const eids = new Uint32Array([entity(0), entity(1), entity(2)]);
		const start = a.addEntities(eids);

		expect(start).toBe(1);
		expect(a.entityCount).toBe(4);
		// Seed row preserved; batch rows all zero.
		expect(Array.from(a._flatColumns[0].buf.subarray(0, 4))).toEqual([42, 0, 0, 0]);
		expect(Array.from(a._flatColumns[1].buf.subarray(0, 4))).toEqual([43, 0, 0, 0]);
	});

	it("bulk_move_all_from copies between two SAB-backed archetypes", () => {
		const layoutsSrc = [makeLayout(1, ["x"], "i32")];
		const layoutsDst = [makeLayout(1, ["x"], "i32")];

		const columnStore = createColumnStore([
			specFromLayouts(0, 8, layoutsSrc),
			specFromLayouts(1, 8, layoutsDst)
		]);
		const src = Archetype.fromColumnStore(archId(0), makeMask(1), layoutsSrc, columnStore, 0);
		const dst = Archetype.fromColumnStore(archId(1), makeMask(1), layoutsDst, columnStore, 1);

		src.addEntity(entity(0));
		src.addEntity(entity(1));
		src.addEntity(entity(2));
		src.writeFieldsPositional(0, compId(1), [7], 1);
		src.writeFieldsPositional(1, compId(1), [8], 1);
		src.writeFieldsPositional(2, compId(1), [9], 1);

		// Identity transition map: column j in dst comes from column j in src
		const map = new Int16Array([0]);
		const dstStart = dst.bulkMoveAllFrom(src, map, 2);

		expect(dstStart).toBe(0);
		expect(dst.entityCount).toBe(3);
		expect(src.entityCount).toBe(0);
		expect(Array.from(dst._flatColumns[0].buf.subarray(0, 3))).toEqual([7, 8, 9]);
	});

	it("writes through one Archetype's view are visible across SAB", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		a.addEntity(entity(0));
		a.writeFieldsPositional(0, compId(1), [42], 1);

		// A second TypedArray view over the same SAB offset sees the write.
		const sabViewInfo = columnStore.archetypes.get(0)!.columns.get(columnKey(1, 0))!;
		const otherView = new Int32Array(columnStore.buffer, sabViewInfo.byteOff, 4);
		expect(otherView[0]).toBe(42);
	});
});
