/**
 * The empty archetype is rowless — a component-less entity has ONE canonical
 * form.
 *
 * An entity with no components is "alive but unplaced": it points at the empty
 * archetype via `entityArchetype` but carries `entityRow === UNASSIGNED` and
 * occupies no row, exactly like a freshly `createEntity`'d one. Before the fix,
 * an entity that *reached* the empty archetype by losing its last component was
 * instead given a real row there, so the empty archetype's live row count — and
 * therefore `stateHash` and zero-require query iteration — depended on add/
 * remove history rather than logical state. These tests pin every path into the
 * empty archetype (bare create, single/multi/tag remove, batch remove, empty
 * template spawn) to the same rowless form, plus the destroy / re-add lifecycle.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { UNASSIGNED } from "../../utils/constants";

const Position = { x: "i32", y: "i32" } as const;
const Velocity = { vx: "i32", vy: "i32" } as const;

/** The empty archetype, reached via any unplaced entity. */
function emptyArchOf(s: Store, e: ReturnType<Store["createEntity"]>) {
	return s.getEntityArchetype(e);
}

describe("empty archetype is rowless", () => {
	it("a freshly created entity is unplaced and the empty archetype holds no rows", () => {
		const s = new Store({ deterministic: true });
		const e = s.createEntity();
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		const empty = emptyArchOf(s, e);
		expect(empty.materializesRows).toBe(false);
		expect(empty.length).toBe(0);
		expect(empty.entityCount).toBe(0);
	});

	it("dropping the last (columned) component returns the entity to the unplaced form", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e = s.createEntity();
		s.addComponent(e, Pos, { x: 1, y: 2 });
		expect(s.getEntityRow(e)).not.toBe(UNASSIGNED); // placed while it had Pos

		s.removeComponent(e, Pos);
		expect(s.isAlive(e)).toBe(true);
		expect(s.hasComponent(e, Pos)).toBe(false);
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		expect(emptyArchOf(s, e).length).toBe(0);
	});

	it("dropping the last TAG component uses the rowless tag-move path", () => {
		const s = new Store({ deterministic: true });
		const Tag = s.registerComponent({});
		const e = s.createEntity();
		s.addComponent(e, Tag);
		s.removeComponent(e, Tag);
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		expect(emptyArchOf(s, e).length).toBe(0);
	});

	it("remove_components dropping ALL components lands in the rowless empty archetype", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const Vel = s.registerComponent(Velocity);
		const e = s.createEntity();
		s.addComponents(e, [
			{ def: Pos, values: { x: 1, y: 2 } },
			{ def: Vel, values: { vx: 3, vy: 4 } }
		]);
		s.removeComponents(e, [Pos, Vel]);
		expect(s.hasComponent(e, Pos)).toBe(false);
		expect(s.hasComponent(e, Vel)).toBe(false);
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		expect(emptyArchOf(s, e).length).toBe(0);
	});

	it("batch_remove_component to the empty archetype unplaces every entity", () => {
		const s = new Store({ deterministic: true });
		const Tag = s.registerComponent({});
		const es = [s.createEntity(), s.createEntity(), s.createEntity()];
		for (const e of es) s.addComponent(e, Tag);
		const tagArch = s.getEntityArchetype(es[0]); // capture before draining

		s.batchRemoveComponent(tagArch.id, Tag);

		expect(tagArch.length).toBe(0); // src archetype drained
		for (const e of es) {
			expect(s.isAlive(e)).toBe(true);
			expect(s.hasComponent(e, Tag)).toBe(false);
			expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		}
		expect(emptyArchOf(s, es[0]).length).toBe(0);
	});

	it("spawning from an empty template yields an unplaced entity", () => {
		const s = new Store({ deterministic: true });
		const p = s.resolveTemplate([]);
		const e = s.spawn(p);
		expect(s.isAlive(e)).toBe(true);
		expect(s.entityCount).toBe(1);
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		expect(emptyArchOf(s, e).length).toBe(0);
	});

	it("spawn_many from an empty template yields unplaced entities", () => {
		const s = new Store({ deterministic: true });
		const p = s.resolveTemplate([]);
		const es = s.spawnMany(p, 4);
		expect(s.entityCount).toBe(4);
		for (const e of es) {
			expect(s.isAlive(e)).toBe(true);
			expect(s.getEntityRow(e)).toBe(UNASSIGNED);
		}
		expect(emptyArchOf(s, es[0]).length).toBe(0);
	});

	it("a removed-to-empty entity can be destroyed", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e = s.createEntity();
		s.addComponent(e, Pos, { x: 1, y: 2 });
		s.removeComponent(e, Pos);

		s.destroyEntity(e);
		expect(s.isAlive(e)).toBe(false);
		expect(s.entityCount).toBe(0);
	});

	it("a component can be re-added after the entity dropped to empty", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e = s.createEntity();
		s.addComponent(e, Pos, { x: 1, y: 2 });
		s.removeComponent(e, Pos);
		expect(s.getEntityRow(e)).toBe(UNASSIGNED);

		s.addComponent(e, Pos, { x: 7, y: 8 });
		expect(s.hasComponent(e, Pos)).toBe(true);
		expect(s.getEntityRow(e)).not.toBe(UNASSIGNED); // placed again
		expect(s.getEntityArchetype(e).getColumnRead(Pos, "x")[s.getEntityRow(e)]).toBe(7);
	});
});

describe("state_hash is independent of add/remove history", () => {
	it("losing the last component returns to the create-time hash", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		// A filler keeps the [Pos] archetype materialised, so the archetype
		// graph is identical before and after the round-trip below — the only
		// thing that could move the hash is `e`'s representation.
		const filler = s.createEntity();
		s.addComponent(filler, Pos, { x: 1, y: 2 });
		const e = s.createEntity(); // bare → unplaced
		const bareHash = s.stateHash();

		// `e` gains then loses Pos. Post-fix it returns to the exact create-time
		// (unplaced) representation, so the digest is unchanged. Pre-fix the
		// empty archetype's row count went 0 → 1 and the hash drifted.
		s.addComponent(e, Pos, { x: 9, y: 9 });
		s.removeComponent(e, Pos);
		expect(s.stateHash()).toBe(bareHash);
	});

	it("two worlds reaching one component-less entity by different paths hash equal", () => {
		// Identical archetype graph in both worlds (filler holds [Pos]); the
		// only difference is whether `e` was created bare or round-tripped
		// through [Pos]. Logically identical ⇒ identical digest.
		const build = (viaRemove: boolean): number => {
			const s = new Store({ deterministic: true });
			const Pos = s.registerComponent(Position);
			const filler = s.createEntity();
			s.addComponent(filler, Pos, { x: 1, y: 2 });
			const e = s.createEntity();
			if (viaRemove) {
				s.addComponent(e, Pos, { x: 5, y: 6 });
				s.removeComponent(e, Pos);
			}
			return s.stateHash();
		};
		expect(build(true)).toBe(build(false));
	});
});
