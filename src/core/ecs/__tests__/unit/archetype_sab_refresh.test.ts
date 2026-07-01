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

// Heap factory for the "heap vs SAB" comparison cases below. The
// production path no longer takes the heap branch (#171 §6.1.9 Phase 4);
// this factory is purely a test convenience to keep `isBufferBacked` and
// `refreshViews` invariants pinned against a heap counterpart.
const heapFactory: ColumnFactory = (_cid, _fidx, tag) => new TypedArrayFor[tag](16);

import {
	createColumnStore,
	growColumnStore,
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
	layouts: ArchetypeColumnLayout[]
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
		componentMask: [0, 0, 0, 0],
		rowCapacity,
		columns
	};
}

describe("Archetype.refresh_views", () => {
	it("is_buffer_backed reports true only for from_column_store archetypes", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);

		const heap = new Archetype(archId(0), makeMask(1), layouts, 4, heapFactory);
		const buffer = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		expect(heap.isBufferBacked).toBe(false);
		expect(buffer.isBufferBacked).toBe(true);
	});

	it("refresh_views on a heap-backed archetype throws", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const heap = new Archetype(archId(0), makeMask(1), layouts, 4, heapFactory);
		expect(() => heap.refreshViews(columnStore)).toThrow(/is not SAB-backed/);
	});

	it("refresh repoints columns at the new SAB and preserves data", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const columnStore = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, columnStore, 0);

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		a.addEntity(entity(2));
		a.writeFieldsPositional(0, compId(1), [10], 1);
		a.writeFieldsPositional(1, compId(1), [20], 1);
		a.writeFieldsPositional(2, compId(1), [30], 1);

		const { store: bigger } = growColumnStore(columnStore, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 3 }]
		});
		a.refreshViews(bigger);

		expect(a.entityCount).toBe(3);
		expect(a.readField(0, compId(1), "x")).toBe(10);
		expect(a.readField(1, compId(1), "x")).toBe(20);
		expect(a.readField(2, compId(1), "x")).toBe(30);

		// The column buffer is now a view into the NEW SAB.
		const def = makeComponentDef<{ x: "i32" }>(compId(1));
		const col = a.getColumn(def, "x", 1);
		expect(col.buffer).toBe(bigger.buffer);
		expect(col.length).toBe(16);
	});

	it("refresh raises capacity so we can keep adding past the old limit", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const initial = createColumnStore([specFromLayouts(0, 2, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, initial, 0);

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		// Hit the cap
		expect(() => a.addEntity(entity(2))).toThrow(StoreColumnOverflowError);

		const { store: bigger } = growColumnStore(initial, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 8, rowCount: 2 }]
		});
		a.refreshViews(bigger);

		// Continue adding past the original limit; data already in the
		// archetype is preserved.
		a.addEntity(entity(2));
		a.addEntity(entity(3));
		a.writeFieldsPositional(2, compId(1), [300], 1);
		a.writeFieldsPositional(3, compId(1), [400], 1);

		expect(a.entityCount).toBe(4);
		expect(a.readField(2, compId(1), "x")).toBe(300);
		expect(a.readField(3, compId(1), "x")).toBe(400);
	});

	it("refresh on a multi-component archetype preserves every column", () => {
		const layouts = [makeLayout(1, ["x", "y"], "f64"), makeLayout(2, ["hp"], "i32")];
		const initial = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1, 2), layouts, initial, 0);

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		a.writeFieldsPositional(0, compId(1), [1.5, 2.5], 1);
		a.writeFieldsPositional(0, compId(2), [100], 1);
		a.writeFieldsPositional(1, compId(1), [3.5, 4.5], 1);
		a.writeFieldsPositional(1, compId(2), [200], 1);

		const { store: bigger } = growColumnStore(initial, {
			archetypes: [{ archetypeId: 0, newRowCapacity: 16, rowCount: 2 }]
		});
		a.refreshViews(bigger);

		expect(a.readField(0, compId(1), "x")).toBeCloseTo(1.5);
		expect(a.readField(0, compId(1), "y")).toBeCloseTo(2.5);
		expect(a.readField(0, compId(2), "hp")).toBe(100);
		expect(a.readField(1, compId(1), "x")).toBeCloseTo(3.5);
		expect(a.readField(1, compId(1), "y")).toBeCloseTo(4.5);
		expect(a.readField(1, compId(2), "hp")).toBe(200);
	});

	it("refresh against a SAB missing the archetype throws", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const initial = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, initial, 0);

		// Build a wholly unrelated SAB store (no archetype 0).
		const other = createColumnStore([specFromLayouts(99, 4, layouts)]);

		expect(() => a.refreshViews(other)).toThrow(/has no archetype 0/);
	});
});
