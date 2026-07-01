import { describe, expect, it } from "vitest";
import {
	Archetype,
	asArchetypeId,
	type ArchetypeColumnLayout,
	type ArchetypeEdge,
	type ColumnFactory
} from "../../archetype";
import { asComponentId, makeComponentDef } from "../../component";
import { createEntityId } from "../../entity";
import { BitSet, TypedArrayFor } from "../../../../type_primitives";

// Heap-backed column factory for unit tests that exercise the Archetype
// column surface directly without standing up a ColumnStore. The production
// path (`archGetOrCreateFromMask`) always goes through
// `Archetype.fromColumnStore` — these tests intentionally bypass that to
// pin per-method semantics in isolation. (#171 §6.1.9 Phase 4)
function makeHeapFactory(initialCapacity = 16): ColumnFactory {
	return (_cid, _fidx, tag) => new TypedArrayFor[tag](initialCapacity);
}

// Helpers
const archId = (n: number) => asArchetypeId(n);
const compId = (n: number) => asComponentId(n);
const entity = (index: number, gen: number = 0) => createEntityId(index, gen);

function makeMask(...ids: number[]): BitSet {
	const mask = new BitSet();
	for (const id of ids) mask.set(id);
	return mask;
}

function makeLayout(
	componentId: number,
	fields: string[],
	tag: "f32" | "f64" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32" = "f64"
): ArchetypeColumnLayout {
	const fieldIndex: Record<string, number> = Object.create(null);
	const fieldTypes: ("f32" | "f64" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32")[] = [];
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

describe("Archetype", () => {
	//=========================================================
	// Construction
	//=========================================================

	it("preserves component mask on construction", () => {
		const mask = makeMask(1, 2, 3);
		const a = new Archetype(archId(0), mask);
		expect(a.mask.has(1)).toBe(true);
		expect(a.mask.has(2)).toBe(true);
		expect(a.mask.has(3)).toBe(true);
		expect(a.mask.has(4)).toBe(false);
	});

	it("stores ArchetypeID", () => {
		const id = archId(42);
		const a = new Archetype(id, makeMask());
		expect(a.id).toBe(id);
	});

	it("handles empty mask", () => {
		const a = new Archetype(archId(0), makeMask());
		expect(a.mask.has(0)).toBe(false);
	});

	//=========================================================
	// Membership
	//=========================================================

	it("add_entity increases entity_count", () => {
		const a = new Archetype(archId(0), makeMask(1));
		expect(a.entityCount).toBe(0);

		a.addEntity(entity(0));
		expect(a.entityCount).toBe(1);

		a.addEntity(entity(1));
		expect(a.entityCount).toBe(2);
	});

	it("add_entity returns sequential rows", () => {
		const a = new Archetype(archId(0), makeMask(1));
		expect(a.addEntity(entity(0))).toBe(0);
		expect(a.addEntity(entity(1))).toBe(1);
		expect(a.addEntity(entity(2))).toBe(2);
	});

	it("entity_list returns added entities", () => {
		const a = new Archetype(archId(0), makeMask(1));
		const e0 = entity(0);
		const e1 = entity(1);
		a.addEntity(e0);
		a.addEntity(e1);

		expect(a.entityList).toContain(e0);
		expect(a.entityList).toContain(e1);
		// Exactly the two added — no ghost/duplicate entry.
		expect(a.entityList.length).toBe(2);
	});

	it("entity_list reflects presence of entities", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(5));
		expect(a.entityList.includes(entity(5))).toBe(true);
		expect(a.entityList.includes(entity(6))).toBe(false);
	});

	//=========================================================
	// Removal (swap-and-pop)
	//=========================================================

	it("remove_entity decreases count", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(0));
		a.addEntity(entity(1));
		a.removeEntity(0);
		expect(a.entityCount).toBe(1);
	});

	it("remove_entity returns swapped entity_index", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(10)); // row 0
		a.addEntity(entity(20)); // row 1
		a.addEntity(entity(30)); // row 2

		// Remove row 0 — entity(30) (row 2) swaps in
		const swapped = a.removeEntity(0);
		expect(swapped).toBe(30);
		expect(a.entityCount).toBe(2);
		expect(a.entityList.includes(entity(10))).toBe(false);
		expect(a.entityList.includes(entity(20))).toBe(true);
		expect(a.entityList.includes(entity(30))).toBe(true);
	});

	it("remove_entity returns -1 when removing last element", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(0));

		const swapped = a.removeEntity(0);
		expect(swapped).toBe(-1);
		expect(a.entityCount).toBe(0);
	});

	it("remove_entity returns -1 when removing the tail element", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(0)); // row 0
		a.addEntity(entity(1)); // row 1

		// Remove last row — no swap needed
		const swapped = a.removeEntity(1);
		expect(swapped).toBe(-1);
		expect(a.entityCount).toBe(1);
		expect(a.entityList.includes(entity(0))).toBe(true);
	});

	it("can add after remove", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(0));
		a.removeEntity(0);
		expect(a.entityCount).toBe(0);

		a.addEntity(entity(1));
		expect(a.entityCount).toBe(1);
		expect(a.entityList.includes(entity(1))).toBe(true);
	});

	//=========================================================
	// Bulk add (addEntities / addEntitiesTag) — #330
	//=========================================================

	it("add_entities_tag bulk-adds entities and returns starting row", () => {
		const a = new Archetype(archId(0), makeMask(1));
		const eids = new Uint32Array([entity(10), entity(20), entity(30)]);

		const start = a.addEntitiesTag(eids);

		expect(start).toBe(0);
		expect(a.entityCount).toBe(3);
		expect(a.entityList.includes(entity(10))).toBe(true);
		expect(a.entityList.includes(entity(20))).toBe(true);
		expect(a.entityList.includes(entity(30))).toBe(true);
	});

	it("add_entities_tag appends after existing entities", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(1));

		const eids = new Uint32Array([entity(2), entity(3)]);
		const start = a.addEntitiesTag(eids);

		expect(start).toBe(1);
		expect(a.entityCount).toBe(3);
	});

	it("add_entities_tag handles count=0 without changing state", () => {
		const a = new Archetype(archId(0), makeMask(1));
		a.addEntity(entity(0));

		const start = a.addEntitiesTag(new Uint32Array(0));
		expect(start).toBe(1);
		expect(a.entityCount).toBe(1);
	});

	it("add_entities zero-initialises every column for every new row", () => {
		const layoutA = makeLayout(1, ["x", "y"]);
		const layoutB = makeLayout(2, ["v"]);
		const a = new Archetype(
			archId(0),
			makeMask(1, 2),
			[layoutA, layoutB],
			16,
			makeHeapFactory()
		);

		// Pre-seed one entity so the batch isn't trivially at row 0.
		const seedRow = a.addEntity(entity(99));
		a.writeFields(seedRow, compId(1), { x: 42, y: 43 }, 0);
		a.writeFields(seedRow, compId(2), { v: 99 }, 0);

		const eids = new Uint32Array([entity(0), entity(1), entity(2)]);
		const start = a.addEntities(eids);

		expect(start).toBe(1);
		expect(a.entityCount).toBe(4);

		for (let i = 0; i < 3; i++) {
			const row = start + i;
			expect(a.readField(row, compId(1), "x")).toBe(0);
			expect(a.readField(row, compId(1), "y")).toBe(0);
			expect(a.readField(row, compId(2), "v")).toBe(0);
		}
		// Seed row untouched.
		expect(a.readField(seedRow, compId(1), "x")).toBe(42);
	});

	it("add_entities honours the optional count parameter", () => {
		const layout = makeLayout(1, ["x"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());

		// Pass a scratch buffer larger than the slice we want consumed.
		const scratch = new Uint32Array(8);
		scratch[0] = entity(0);
		scratch[1] = entity(1);

		const start = a.addEntities(scratch, 2);

		expect(start).toBe(0);
		expect(a.entityCount).toBe(2);
		expect(a.entityList.includes(entity(1))).toBe(true);
	});

	it("add_entities triggers grow_handler when batch exceeds capacity", () => {
		const layout = makeLayout(1, ["x"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory(16));

		// 50 > 16 → grow path fires inside the bulk-append.
		const eids = new Uint32Array(50);
		for (let i = 0; i < 50; i++) eids[i] = entity(i);

		const start = a.addEntities(eids);

		expect(start).toBe(0);
		expect(a.entityCount).toBe(50);
		// All 50 rows should be readable at zero.
		expect(a.readField(0, compId(1), "x")).toBe(0);
		expect(a.readField(49, compId(1), "x")).toBe(0);
	});

	it("add_entities handles count=0 without changing state", () => {
		const layout = makeLayout(1, ["x"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());
		a.addEntity(entity(0));

		const start = a.addEntities(new Uint32Array(0));
		expect(start).toBe(1);
		expect(a.entityCount).toBe(1);
	});

	//=========================================================
	// hasComponent
	//=========================================================

	it("has_component returns true for components in mask", () => {
		const a = new Archetype(archId(0), makeMask(2, 5, 8));
		expect(a.hasComponent(compId(2))).toBe(true);
		expect(a.hasComponent(compId(5))).toBe(true);
		expect(a.hasComponent(compId(8))).toBe(true);
	});

	it("has_component returns false for absent components", () => {
		const a = new Archetype(archId(0), makeMask(2, 5));
		expect(a.hasComponent(compId(0))).toBe(false);
		expect(a.hasComponent(compId(3))).toBe(false);
		expect(a.hasComponent(compId(99))).toBe(false);
	});

	it("has_component returns false on empty mask", () => {
		const a = new Archetype(archId(0), makeMask());
		expect(a.hasComponent(compId(0))).toBe(false);
	});

	//=========================================================
	// matches
	//=========================================================

	it("matches returns true for subset of mask", () => {
		const a = new Archetype(archId(0), makeMask(1, 2, 3));
		expect(a.matches(makeMask(1, 3))).toBe(true);
	});

	it("matches returns true for exact mask", () => {
		const a = new Archetype(archId(0), makeMask(1, 2));
		expect(a.matches(makeMask(1, 2))).toBe(true);
	});

	it("matches returns false when missing a required component", () => {
		const a = new Archetype(archId(0), makeMask(1));
		expect(a.matches(makeMask(1, 2))).toBe(false);
	});

	it("empty required matches everything", () => {
		const a = new Archetype(archId(0), makeMask(1, 2));
		expect(a.matches(makeMask())).toBe(true);
	});

	it("empty mask only matches empty required", () => {
		const a = new Archetype(archId(0), makeMask());
		expect(a.matches(makeMask())).toBe(true);
		expect(a.matches(makeMask(1))).toBe(false);
	});

	//=========================================================
	// Graph edges
	//=========================================================

	it("get_edge returns undefined for uncached component", () => {
		const a = new Archetype(archId(0), makeMask());
		expect(a.getEdge(compId(1))).toBeUndefined();
	});

	it("set_edge / get_edge round-trips", () => {
		const a = new Archetype(archId(0), makeMask());
		const edge: ArchetypeEdge = { add: archId(1), remove: null, addMap: null, removeMap: null };
		a.setEdge(compId(5), edge);

		const retrieved = a.getEdge(compId(5));
		expect(retrieved).toBe(edge);
		expect(retrieved!.add).toBe(archId(1));
		expect(retrieved!.remove).toBeNull();
	});

	//=========================================================
	// Column data
	//=========================================================

	it("write_fields and read_field round-trip", () => {
		const layout = makeLayout(1, ["x", "y"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());

		const row = a.addEntity(entity(0));
		a.writeFields(row, compId(1), { x: 10, y: 20 }, 0);

		expect(a.readField(row, compId(1), "x")).toBe(10);
		expect(a.readField(row, compId(1), "y")).toBe(20);
	});

	it("get_column_read returns dense array for iteration", () => {
		const layout = makeLayout(1, ["x"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());

		a.addEntity(entity(0));
		a.addEntity(entity(1));
		a.addEntity(entity(2));

		a.writeFields(0, compId(1), { x: 100 }, 0);
		a.writeFields(1, compId(1), { x: 200 }, 0);
		a.writeFields(2, compId(1), { x: 300 }, 0);

		const def = makeComponentDef<{ x: "f64" }>(compId(1));
		const col = a.getColumnRead(def, "x");
		expect(col[0]).toBe(100);
		expect(col[1]).toBe(200);
		expect(col[2]).toBe(300);
	});

	it("swap-and-pop preserves column data integrity", () => {
		const layout = makeLayout(1, ["x", "y"]);
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());

		// Add 3 entities with distinct data
		a.addEntity(entity(0)); // row 0
		a.writeFields(0, compId(1), { x: 10, y: 11 }, 0);

		a.addEntity(entity(1)); // row 1
		a.writeFields(1, compId(1), { x: 20, y: 21 }, 0);

		a.addEntity(entity(2)); // row 2
		a.writeFields(2, compId(1), { x: 30, y: 31 }, 0);

		// Remove row 0 — entity(2) (row 2) swaps into row 0
		a.removeEntity(0);

		expect(a.entityCount).toBe(2);

		// entity(2) is now at row 0, entity(1) stays at row 1
		expect(a.readField(0, compId(1), "x")).toBe(30);
		expect(a.readField(0, compId(1), "y")).toBe(31);

		expect(a.readField(1, compId(1), "x")).toBe(20);
		expect(a.readField(1, compId(1), "y")).toBe(21);
	});

	it("multiple component columns swap together", () => {
		const layoutA = makeLayout(1, ["a"]);
		const layoutB = makeLayout(2, ["b"]);
		const a = new Archetype(
			archId(0),
			makeMask(1, 2),
			[layoutA, layoutB],
			16,
			makeHeapFactory()
		);

		a.addEntity(entity(0)); // row 0
		a.writeFields(0, compId(1), { a: 100 }, 0);
		a.writeFields(0, compId(2), { b: -1 }, 0);

		a.addEntity(entity(1)); // row 1
		a.writeFields(1, compId(1), { a: 200 }, 0);
		a.writeFields(1, compId(2), { b: -2 }, 0);

		// Remove row 0 — entity(1) swaps into row 0
		a.removeEntity(0);

		expect(a.readField(0, compId(1), "a")).toBe(200);
		expect(a.readField(0, compId(2), "b")).toBe(-2);
	});

	it("copy_shared_from copies matching component data", () => {
		const layout = makeLayout(1, ["x"]);
		const src = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory());
		const dst = new Archetype(archId(1), makeMask(1), [layout], 16, makeHeapFactory());

		src.addEntity(entity(0));
		src.writeFields(0, compId(1), { x: 42 }, 0);

		const dstRow = dst.addEntity(entity(0));
		dst.copySharedFrom(src, 0, dstRow, 0);

		expect(dst.readField(dstRow, compId(1), "x")).toBe(42);
	});

	it("columns grow when capacity is exceeded", () => {
		const layout = makeLayout(1, ["v"]);
		// `makeHeapFactory(16)` produces GrowableTypedArrays that double
		// on overflow; pushing 50 entities crosses 16 → 32 → 64.
		const a = new Archetype(archId(0), makeMask(1), [layout], 16, makeHeapFactory(16));

		// Add more entities than initial capacity
		for (let i = 0; i < 50; i++) {
			const row = a.addEntity(entity(i));
			a.writeFields(row, compId(1), { v: i * 10 }, 0);
		}

		expect(a.entityCount).toBe(50);

		// Verify all data is preserved (no removes, so row === insertion index)
		for (let i = 0; i < 50; i++) {
			expect(a.readField(i, compId(1), "v")).toBe(i * 10);
		}
	});
});
