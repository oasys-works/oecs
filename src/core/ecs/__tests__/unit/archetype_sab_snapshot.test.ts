import { describe, expect, it } from "vitest";

import { Archetype, asArchetypeId, type ArchetypeColumnLayout } from "../../archetype";
import { asComponentId } from "../../component";
import { createEntityId } from "../../entity";
import { BitSet, type TypedArrayTag } from "../../../../type_primitives";

import {
	createColumnStore,
	restoreColumnStore,
	snapshotColumnStore,
	TYPE_TAG,
	type ArchetypeSpec,
	type TypeTagValue
} from "../../../store";

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

describe("Archetype data through snapshot/restore", () => {
	it("a restored SAB-backed archetype reads the same column values", () => {
		const layouts = [makeLayout(1, ["x", "y"], "f64"), makeLayout(2, ["hp"], "i32")];
		const store = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1, 2), layouts, store, 0);

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		a.writeFieldsPositional(0, compId(1), [1.5, 2.5], 1);
		a.writeFieldsPositional(0, compId(2), [100], 1);
		a.writeFieldsPositional(1, compId(1), [3.5, 4.5], 1);
		a.writeFieldsPositional(1, compId(2), [200], 1);

		// Snapshot now; rebuild the world from bytes.
		const restoredStore = restoreColumnStore(snapshotColumnStore(store));
		const restored = Archetype.fromColumnStore(
			archId(0),
			makeMask(1, 2),
			layouts,
			restoredStore,
			0
		);

		// The restored archetype starts at length 0 (Archetype.length lives
		// on the host, not in the SAB) — but the column values themselves
		// are in the SAB, so reads by row come back identical.
		expect(restored.readField(0, compId(1), "x")).toBeCloseTo(1.5);
		expect(restored.readField(0, compId(1), "y")).toBeCloseTo(2.5);
		expect(restored.readField(0, compId(2), "hp")).toBe(100);
		expect(restored.readField(1, compId(1), "x")).toBeCloseTo(3.5);
		expect(restored.readField(1, compId(1), "y")).toBeCloseTo(4.5);
		expect(restored.readField(1, compId(2), "hp")).toBe(200);
	});

	it("restored archetype writes go into the new SAB only", () => {
		const layouts = [makeLayout(1, ["x"], "i32")];
		const store = createColumnStore([specFromLayouts(0, 4, layouts)]);
		const a = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, store, 0);

		a.addEntity(entity(0));
		a.writeFieldsPositional(0, compId(1), [10], 1);

		const restoredStore = restoreColumnStore(snapshotColumnStore(store));
		const restored = Archetype.fromColumnStore(archId(0), makeMask(1), layouts, restoredStore, 0);

		// Mutate the original archetype's column.
		a.addEntity(entity(1));
		a.writeFieldsPositional(1, compId(1), [999], 1);

		// The restored side sees the snapshot state (row 0 = 10), unaffected
		// by the original side's later writes.
		expect(restored.readField(0, compId(1), "x")).toBe(10);
		expect(restored.readField(1, compId(1), "x")).toBe(0);
	});
});
