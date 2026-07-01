/**
 * `Store.publishRowCountsToDescriptor` correctness and idempotence
 * (#323 + #324).
 *
 * #323 — the lockstep descriptor walk must stamp every SAB-backed
 * archetype's live `length` into its descriptor's `row_count` field
 * without allocating a per-call lookup Map. Equivalence with the prior
 * behaviour is verified by reading back the descriptor region and
 * checking each archetype's `row_count` matches `Archetype.length`.
 *
 * #324 — the publish path is gated by an internal `_rowCountsDirty`
 * flag set by every mutation site (`_mark_queries_dirty` + immediate
 * `Store.destroyEntity`) and cleared by publish. Read-only tick phases
 * call `ctx.flush()` which drains empty buffers and then invokes
 * publish; the descriptor walk must skip the work entirely when nothing
 * has changed. Verified by overwriting a descriptor's `row_count` with a
 * sentinel and confirming a no-op publish leaves the sentinel intact.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import {
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	STORE_HEADER_OFFSETS,
	readLayoutDescriptorRegion
} from "../../../store";

const Position = { x: "f64", y: "f64" } as const;
const Velocity = { vx: "f64", vy: "f64" } as const;

function rowCountByArchId(store: Store): Map<number, number> {
	const view = store.columnStore.view;
	const regionOff = view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
	const archCount = view.getUint32(STORE_HEADER_OFFSETS.archetype_count, true);
	const region = readLayoutDescriptorRegion(view, regionOff, archCount);
	const out = new Map<number, number>();
	for (const d of region) out.set(d.archetypeId, d.rowCount);
	return out;
}

describe("Store.publish_row_counts_to_descriptor (#323 + #324)", () => {
	it("stamps live archetype length into every SAB descriptor's row_count", () => {
		const store = new Store(8);
		const Pos = store.registerComponent(Position);
		const Vel = store.registerComponent(Velocity);

		// Mix two archetypes: [Pos] with 3 rows, [Pos,Vel] with 2 rows.
		const posEntities = [];
		for (let i = 0; i < 3; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
			posEntities.push(e);
		}
		const posVelEntities = [];
		for (let i = 0; i < 2; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
			store.addComponent(e, Vel, { vx: i, vy: i });
			posVelEntities.push(e);
		}

		store.publishRowCountsToDescriptor();

		const counts = rowCountByArchId(store);
		// Every SAB-backed archetype must be represented in the descriptor region.
		for (const arch of store.columnStore.archetypes.keys()) {
			expect(counts.has(arch)).toBe(true);
		}
		// Assert the LITERAL row counts the test arranged — 3 in the [Pos]-only
		// archetype, 2 in [Pos,Vel] — not values re-derived from
		// `Archetype.length` (which `publish` itself stamps with the same rule,
		// so a shared off-by-one would pass). Locate each archetype by an
		// entity known to live in it.
		const posOnlyArch = store.getEntityArchetype(posEntities[0]).id as number;
		const posVelArch = store.getEntityArchetype(posVelEntities[0]).id as number;
		expect(posOnlyArch).not.toBe(posVelArch);
		expect(counts.get(posOnlyArch)).toBe(3);
		expect(counts.get(posVelArch)).toBe(2);
	});

	it("is a no-op when nothing has changed since the last publish (#324)", () => {
		const store = new Store(8);
		const Pos = store.registerComponent(Position);

		for (let i = 0; i < 4; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
		}
		store.publishRowCountsToDescriptor();

		// Overwrite every descriptor's row_count with a sentinel value.
		// A real publish would clobber these; a no-op publish must not.
		const view = store.columnStore.view;
		const regionOff = view.getUint32(STORE_HEADER_OFFSETS.layout_descriptor_off, true);
		const archCount = view.getUint32(STORE_HEADER_OFFSETS.archetype_count, true);
		const SENTINEL = 0xdeadbeef >>> 0;
		const descs = readLayoutDescriptorRegion(view, regionOff, archCount);
		let off = regionOff;
		for (const d of descs) {
			view.setUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, SENTINEL, true);
			// advance by descriptor size (header + column_count * column_size)
			off += 24 + d.columns.length * 16;
		}

		// No mutations between this and the previous publish — flag is clean.
		store.publishRowCountsToDescriptor();

		// Sentinel must survive: every descriptor still reads SENTINEL.
		off = regionOff;
		for (const d of descs) {
			const rc = view.getUint32(off + ARCHETYPE_DESCRIPTOR_OFFSETS.row_count, true);
			expect(rc).toBe(SENTINEL);
			off += 24 + d.columns.length * 16;
		}
	});

	it("re-marks dirty after deferred destroy + flush, re-stamps on next publish", () => {
		const store = new Store(8);
		const Pos = store.registerComponent(Position);
		const entities = [];
		for (let i = 0; i < 5; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
			entities.push(e);
		}
		store.publishRowCountsToDescriptor();
		expect(
			rowCountByArchId(store).get(store.getEntityArchetype(entities[0]).id as number)
		).toBe(5);

		// Defer-destroy two; flush; publish. Descriptor row_count must drop.
		store.destroyEntityDeferred(entities[0]);
		store.destroyEntityDeferred(entities[1]);
		store.flushDestroyed();
		store.publishRowCountsToDescriptor();
		expect(
			rowCountByArchId(store).get(store.getEntityArchetype(entities[2]).id as number)
		).toBe(3);
	});

	it("re-marks dirty after immediate destroy_entity, re-stamps on next publish", () => {
		const store = new Store(8);
		const Pos = store.registerComponent(Position);
		const entities = [];
		for (let i = 0; i < 4; i++) {
			const e = store.createEntity();
			store.addComponent(e, Pos, { x: i, y: i });
			entities.push(e);
		}
		store.publishRowCountsToDescriptor();
		const archId = store.getEntityArchetype(entities[0]).id as number;
		expect(rowCountByArchId(store).get(archId)).toBe(4);

		// Immediate-mode destroy bypasses _mark_queries_dirty (known bug
		// #316) but MUST still flag row_counts dirty — otherwise the SAB
		// descriptor would silently keep the pre-destroy count and any
		// WASM tick reading it would loop over a freed slot.
		store.destroyEntity(entities[0]);
		store.publishRowCountsToDescriptor();
		expect(rowCountByArchId(store).get(archId)).toBe(3);
	});
});
