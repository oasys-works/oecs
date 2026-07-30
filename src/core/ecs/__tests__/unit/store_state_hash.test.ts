/**
 * Store.stateHash — live-row FNV-1a state digest.
 *
 * `Store.stateHash()` folds (archetype_id, live row count, live column
 * bytes) for every archetype in id order. It's the canonical "live ECS
 * state digest" used by `compute_state_hash` for cross-replay determinism:
 * strictly broader than the earlier per-networked-component fold (every
 * column contributes), strictly tighter than `columnStoreStateHash` (skips
 * trailing unused SAB capacity).
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { ECS_ERROR } from "../../utils/error";

const Position = { x: "i32", y: "i32" } as const;
const Velocity = { vx: "i32", vy: "i32" } as const;
// Component shapes used by the per-word-fold tail-byte regression test.
// A u8 column with an odd row count produces 1–3 tail bytes after
// the word-aligned chunk; a u16 column with an odd row count produces 2.
const ByteFlags = { flag: "u8" } as const;
const HalfWord = { v: "u16" } as const;

describe("Store.state_hash — live-row FNV-1a", () => {
	it("two identically-built stores produce identical hashes", () => {
		const a = new Store({ deterministic: true });
		const b = new Store({ deterministic: true });
		const Pos_a = a.registerComponent(Position);
		const Pos_b = b.registerComponent(Position);
		for (let i = 0; i < 5; i++) {
			const ea = a.createEntity();
			const eb = b.createEntity();
			a.addComponent(ea, Pos_a, { x: i, y: i * 2 });
			b.addComponent(eb, Pos_b, { x: i, y: i * 2 });
		}
		expect(a.stateHash()).toBe(b.stateHash());
	});

	it("mutating a column field shifts the hash", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e0 = s.createEntity();
		const e1 = s.createEntity();
		s.addComponent(e0, Pos, { x: 1, y: 2 });
		s.addComponent(e1, Pos, { x: 3, y: 4 });

		const before = s.stateHash();
		// Mutate e1's row directly through its archetype column.
		const arch = s.getEntityArchetype(e1);
		const row = s.getEntityRow(e1);
		arch.getColumn(Pos, "x", 1)[row] = 999;
		expect(s.stateHash()).not.toBe(before);
	});

	it("adding an entity shifts the hash via row-count fold", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e0 = s.createEntity();
		s.addComponent(e0, Pos, { x: 0, y: 0 });

		const before = s.stateHash();
		const e1 = s.createEntity();
		s.addComponent(e1, Pos, { x: 0, y: 0 });
		// Even though the new row's bytes match e0's, the row-count fold
		// distinguishes "1 row of zeros" from "2 rows of zeros".
		expect(s.stateHash()).not.toBe(before);
	});

	it("destroying an entity shifts the hash", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e0 = s.createEntity();
		const e1 = s.createEntity();
		s.addComponent(e0, Pos, { x: 1, y: 2 });
		s.addComponent(e1, Pos, { x: 3, y: 4 });

		const before = s.stateHash();
		s.destroyEntity(e0);
		expect(s.stateHash()).not.toBe(before);
	});

	it("registering a component (no entities use it) leaves the hash unchanged", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const e0 = s.createEntity();
		s.addComponent(e0, Pos, { x: 1, y: 2 });

		const before = s.stateHash();
		// Registering a NEW component doesn't add an archetype until some
		// entity gets it; the archetype graph is unchanged.
		s.registerComponent(Velocity);
		expect(s.stateHash()).toBe(before);
	});

	it("creating a new archetype via add_component shifts the hash", () => {
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		const Vel = s.registerComponent(Velocity);
		const e0 = s.createEntity();
		s.addComponent(e0, Pos, { x: 1, y: 2 });

		const before = s.stateHash();
		// Adding Vel transitions e0 into a new [Pos, Vel] archetype:
		// archetype graph grows (a new (id, len) pair appears in the fold)
		// AND the [Pos]-only archetype's row count drops to 0.
		s.addComponent(e0, Vel, { vx: 5, vy: 6 });
		expect(s.stateHash()).not.toBe(before);
	});

	it("per-word fold notices a flip in a u8 tail byte", () => {
		// Three u8 rows ⇒ 3 tail bytes, no word-aligned chunk. The per-word
		// fold must still hash those bytes — otherwise mutations in a
		// non-aligned tail would silently match across replays.
		const s = new Store({ deterministic: true });
		const F = s.registerComponent(ByteFlags);
		const es: ReturnType<typeof s.createEntity>[] = [];
		for (let i = 0; i < 3; i++) {
			const e = s.createEntity();
			s.addComponent(e, F, { flag: i });
			es.push(e);
		}
		const before = s.stateHash();
		// Flip the last (tail) row's byte.
		const last = es[2];
		const arch = s.getEntityArchetype(last);
		const row = s.getEntityRow(last);
		arch.getColumn(F, "flag", 1)[row] = 255;
		expect(s.stateHash()).not.toBe(before);
	});

	it("per-word fold notices a flip in a u16 tail", () => {
		// One u16 row ⇒ 2 tail bytes. Same reasoning as the u8 case but at
		// the 2-byte residue branch of the tail folder.
		const s = new Store({ deterministic: true });
		const H = s.registerComponent(HalfWord);
		const e = s.createEntity();
		s.addComponent(e, H, { v: 1 });
		const before = s.stateHash();
		const arch = s.getEntityArchetype(e);
		const row = s.getEntityRow(e);
		arch.getColumn(H, "v", 1)[row] = 0xff01;
		expect(s.stateHash()).not.toBe(before);
	});

	it("scales with live entity count — fast even when SAB is large", () => {
		// 10k entities on a single archetype. The live-row hash walks ~80KB
		// of data; `columnStoreStateHash` would walk the full SAB capacity (much
		// larger). This test asserts correctness on a non-trivial size;
		// perf is validated by replay.test.ts and determinism.test.ts.
		const s = new Store({ deterministic: true });
		const Pos = s.registerComponent(Position);
		for (let i = 0; i < 10_000; i++) {
			const e = s.createEntity();
			s.addComponent(e, Pos, { x: i, y: -i });
		}
		const h1 = s.stateHash();
		const h2 = s.stateHash();
		expect(h1).toBe(h2);
	});
});

describe("determinism surface is opt-in", () => {
	// Build identical state under both modes so the only variable under test is
	// the `deterministic` flag, not the contents.
	function seed(s: Store): void {
		const Pos = s.registerComponent(Position);
		for (let i = 0; i < 5; i++) {
			const e = s.createEntity();
			s.addComponent(e, Pos, { x: i, y: i * 2 });
		}
	}

	it("defaults to off — `deterministic` is false without the opt-in", () => {
		expect(new Store().deterministic).toBe(false);
		expect(new Store({ deterministic: true }).deterministic).toBe(true);
	});

	it("state_hash throws DETERMINISM_DISABLED when determinism is off", () => {
		const s = new Store();
		seed(s);
		expect(() => s.stateHash()).toThrow(
			expect.objectContaining({ category: ECS_ERROR.DETERMINISM_DISABLED })
		);
	});

	it("snapshot_sparse / restore_sparse throw DETERMINISM_DISABLED when off", () => {
		const s = new Store();
		s.registerSparseComponent(Position);
		expect(() => s.snapshotSparse()).toThrow(
			expect.objectContaining({ category: ECS_ERROR.DETERMINISM_DISABLED })
		);
		expect(() => s.restoreSparse(new Uint8Array(8))).toThrow(
			expect.objectContaining({ category: ECS_ERROR.DETERMINISM_DISABLED })
		);
	});

	it("opting in reproduces the canonical digest — off-vs-on never diverges the bytes", () => {
		// The flag gates availability, not the digest algorithm: two deterministic
		// stores built identically agree (the canonical fold is unchanged from the
		// always-on era).
		const a = new Store({ deterministic: true });
		const b = new Store({ deterministic: true });
		seed(a);
		seed(b);
		expect(a.stateHash()).toBe(b.stateHash());
	});
});
