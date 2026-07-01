/**
 * Sparse storage class — determinism surface (#470 / ADR-0011).
 *
 * Brings the sparse store into `stateHash` + snapshot/restore. The load-
 * bearing property is **canonical ordering**: the sparse store iterates in
 * SparseMap insertion/swap order, so the determinism paths sort by source
 * entity index before hashing/serializing. These tests pin the epic's
 * acceptance criteria:
 *
 *  - snapshot → restore round-trips membership + data with full equality.
 *  - Two worlds with identical sparse contents inserted in DIFFERENT orders
 *    produce the SAME `stateHash` (and the same snapshot bytes).
 *  - `stateHash` changes when any sparse datum changes (no false-equal).
 *  - Determinism holds across destroy / generation bump: a purged (stale)
 *    source is excluded canonically, so a world that destroyed an entity and
 *    a world that never held it agree.
 */

import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { SparseRestoreError } from "../../sparse_store";
import { MAX_INDEX } from "../../entity";

const Hp = { hp: "i32" } as const;
// Mixed field widths so the hash fold covers more than one field per row.
const Cooldown = { ready_at: "i16", charges: "i32" } as const;

describe("sparse state_hash — canonical ordering (#470)", () => {
	it("is independent of sparse insertion order", () => {
		const a = new Store({ deterministic: true });
		const b = new Store({ deterministic: true });
		const Ha = a.registerSparseComponent(Hp);
		const Hb = b.registerSparseComponent(Hp);

		// Same indices (createEntity hands out 0..4 in both), same data —
		// only the order of the sparse adds differs.
		const ea = [0, 1, 2, 3, 4].map(() => a.createEntity());
		const eb = [0, 1, 2, 3, 4].map(() => b.createEntity());
		const data = [10, 20, 30, 40, 50];

		// World A: ascending. World B: descending. SparseMap's dense key order
		// ends up different; canonical sort must erase that.
		for (let i = 0; i < ea.length; i++) a.addSparse(ea[i], Ha, { hp: data[i] });
		for (let i = eb.length - 1; i >= 0; i--) b.addSparse(eb[i], Hb, { hp: data[i] });

		expect(a.stateHash()).toBe(b.stateHash());
		// Bytes too, not just the digest — the snapshot is canonical-ordered.
		expect(a.snapshotSparse()).toEqual(b.snapshotSparse());
	});

	it("is independent of add/remove churn that reorders the dense backing", () => {
		const a = new Store({ deterministic: true });
		const b = new Store({ deterministic: true });
		const Ha = a.registerSparseComponent(Hp);
		const Hb = b.registerSparseComponent(Hp);
		const ea = [0, 1, 2, 3].map(() => a.createEntity());
		const eb = [0, 1, 2, 3].map(() => b.createEntity());

		// A: straight inserts. B: insert all, churn the middle ones (which
		// swap-pops the dense arrays into a scrambled order), then restore the
		// same logical contents.
		for (const e of ea) a.addSparse(e, Ha, { hp: (e as number) + 1 });

		for (const e of eb) b.addSparse(e, Hb, { hp: 999 });
		b.removeSparse(eb[1], Hb);
		b.removeSparse(eb[2], Hb);
		b.addSparse(eb[2], Hb, { hp: (eb[2] as number) + 1 });
		b.addSparse(eb[1], Hb, { hp: (eb[1] as number) + 1 });
		b.setSparseField(eb[0], Hb, "hp", (eb[0] as number) + 1);
		b.setSparseField(eb[3], Hb, "hp", (eb[3] as number) + 1);

		expect(b.stateHash()).toBe(a.stateHash());
	});

	it("changes when a sparse datum changes (no false-equal)", () => {
		const s = new Store({ deterministic: true });
		const Health = s.registerSparseComponent(Hp);
		const e = s.createEntity();
		s.addSparse(e, Health, { hp: 100 });

		const before = s.stateHash();
		s.setSparseField(e, Health, "hp", 101);
		expect(s.stateHash()).not.toBe(before);
	});

	it("changes when sparse membership changes", () => {
		const s = new Store({ deterministic: true });
		const Health = s.registerSparseComponent(Hp);
		const e = s.createEntity();
		const baseline = s.stateHash();

		s.addSparse(e, Health, { hp: 5 });
		const withMember = s.stateHash();
		expect(withMember).not.toBe(baseline);

		s.removeSparse(e, Health);
		// Removing the only member returns to the membership-empty digest.
		expect(s.stateHash()).toBe(baseline);
	});

	it("distinguishes identical data on different source entities", () => {
		const a = new Store({ deterministic: true });
		const b = new Store({ deterministic: true });
		const Ha = a.registerSparseComponent(Hp);
		const Hb = b.registerSparseComponent(Hp);
		a.createEntity();
		const a1 = a.createEntity();
		b.createEntity();
		b.createEntity();
		const b2 = b.createEntity();

		// Same value, different source index (1 vs 2) → different digest,
		// because the source entity index is folded into the hash.
		a.addSparse(a1, Ha, { hp: 7 });
		b.addSparse(b2, Hb, { hp: 7 });
		expect(a.stateHash()).not.toBe(b.stateHash());
	});
});

describe("sparse determinism across destroy / generation bump (#470)", () => {
	it("excludes a destroyed (purged) source canonically", () => {
		// World A holds three members then destroys the middle one.
		const a = new Store({ deterministic: true });
		const Ha = a.registerSparseComponent(Hp);
		const a0 = a.createEntity();
		const a1 = a.createEntity();
		const a2 = a.createEntity();
		a.addSparse(a0, Ha, { hp: 10 });
		a.addSparse(a1, Ha, { hp: 20 });
		a.addSparse(a2, Ha, { hp: 30 });
		a.destroyEntity(a1);

		// World B holds the same two live members (indices 0 and 2) and never
		// touched index 1. Purge must make these worlds agree.
		const b = new Store({ deterministic: true });
		const Hb = b.registerSparseComponent(Hp);
		const b0 = b.createEntity();
		b.createEntity(); // index 1, no sparse data
		const b2 = b.createEntity();
		b.addSparse(b0, Hb, { hp: 10 });
		b.addSparse(b2, Hb, { hp: 30 });

		expect(a.stateHash()).toBe(b.stateHash());
	});

	it("a recycled slot carries fresh data, not the prior occupant's", () => {
		// Destroy index 0's occupant, recycle it (generation bumps), give the
		// recycled entity different data. The digest must match a world built
		// directly with that data — the stale row must not leak in.
		const a = new Store({ deterministic: true });
		const Ha = a.registerSparseComponent(Hp);
		const a0 = a.createEntity();
		a.addSparse(a0, Ha, { hp: 111 });
		a.destroyEntity(a0);
		const a0b = a.createEntity(); // recycles index 0
		a.addSparse(a0b, Ha, { hp: 222 });

		const b = new Store({ deterministic: true });
		const Hb = b.registerSparseComponent(Hp);
		const b0 = b.createEntity();
		b.addSparse(b0, Hb, { hp: 222 });

		expect(a.stateHash()).toBe(b.stateHash());
	});

	it("destroying a sparse holder shifts the hash", () => {
		const s = new Store({ deterministic: true });
		const Health = s.registerSparseComponent(Hp);
		const keep = s.createEntity();
		const drop = s.createEntity();
		s.addSparse(keep, Health, { hp: 1 });
		s.addSparse(drop, Health, { hp: 2 });

		const before = s.stateHash();
		s.destroyEntity(drop);
		expect(s.stateHash()).not.toBe(before);
	});
});

describe("sparse snapshot / restore round-trip (#470)", () => {
	function build(): { store: Store; health: ReturnType<Store["registerSparseComponent"]> } {
		const store = new Store({ deterministic: true });
		const health = store.registerSparseComponent(Hp);
		const cooldown = store.registerSparseComponent(Cooldown);
		const e = [0, 1, 2, 3].map(() => store.createEntity());
		store.addSparse(e[0], health, { hp: 12 });
		store.addSparse(e[2], health, { hp: 34 });
		store.addSparse(e[1], cooldown, { ready_at: 2, charges: 3 });
		store.addSparse(e[3], cooldown, { ready_at: -3, charges: 7 });
		return { store, health };
	}

	it("round-trips membership + data with full equality", () => {
		const src = build().store;
		const bytes = src.snapshotSparse();

		// A fresh world with the same registrations restored from the bytes
		// must produce the same digest (membership + every field).
		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		dst.registerSparseComponent(Cooldown);
		dst.restoreSparse(bytes);

		expect(dst.stateHash()).toBe(src.stateHash());
		expect(dst.snapshotSparse()).toEqual(bytes);
	});

	it("restore replaces pre-existing sparse data (idempotent into a dirty world)", () => {
		const src = build().store;
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		const h = dst.registerSparseComponent(Hp);
		dst.registerSparseComponent(Cooldown);
		const e = dst.createEntity();
		dst.addSparse(e, h, { hp: 9999 }); // stale data, must be wiped

		dst.restoreSparse(bytes);
		expect(dst.snapshotSparse()).toEqual(bytes);
		expect(dst.stateHash()).toBe(src.stateHash());
	});

	it("an empty world round-trips to empty", () => {
		const src = new Store({ deterministic: true });
		src.registerSparseComponent(Hp);
		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		dst.restoreSparse(src.snapshotSparse());
		expect(dst.stateHash()).toBe(src.stateHash());
	});

	it("rejects a snapshot whose store count doesn't match", () => {
		const src = build().store;
		const bytes = src.snapshotSparse();
		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp); // only one store, snapshot has two
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("rejects a snapshot whose field count doesn't match", () => {
		const src = new Store({ deterministic: true });
		src.registerSparseComponent(Cooldown); // store 0 has 2 fields
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp); // store 0 has 1 field — shape mismatch
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});
});

describe("sparse restore validation — defensive hardening (#494)", () => {
	it("rejects a field-identity swap with matching shape (relation backing vs user component)", () => {
		// SRC registers a user {hp} (sparse id 0) then a relation, whose exclusive
		// backing {target:f64} is sparse id 1 (the relation target bypasses the #777
		// float guard). Both stores are single-field, so their snapshot record shape
		// is identical. DST registers them in the OPPOSITE order, so slot 0 is the
		// relation backing and slot 1 is {hp}. Field count matches per slot; the field
		// identity (name + type) differs. Pre-#494 a count-only check passed validation
		// and loaded hp into the relation's target field (a bogus handle) while the
		// real target landed in the Hp store. The schema fingerprint must reject it.
		const src = new Store({ deterministic: true });
		const hp = src.registerSparseComponent(Hp);
		const rel = src.registerRelation();
		const e0 = src.createEntity();
		const e1 = src.createEntity();
		src.addSparse(e0, hp, { hp: 7 });
		src.addRelation(e1, rel, e0);
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		dst.registerRelation(); // slot 0 = {target:f64}
		dst.registerSparseComponent(Hp); // slot 1 = {hp:i32}
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("rejects a field-type swap with matching name + count", () => {
		// Same field name + count, different type tag. Field count alone can't tell
		// {hp:i16} from {hp:i32} apart; the fingerprint folds the type, so it does.
		const src = new Store({ deterministic: true });
		src.registerSparseComponent({ hp: "i16" });
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent({ hp: "i32" });
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("rejects a field-name swap with matching type + count", () => {
		// The complement of the type-swap case: same type + count, different NAME.
		// Two single-field user stores of the SAME integer type isolate the name
		// axis (the relation-backing-vs-user case above can't — its f64 target also
		// differs in type). The fingerprint folds the name, so {hp:i32} ≠ {mp:i32}.
		const src = new Store({ deterministic: true });
		src.registerSparseComponent({ hp: "i32" });
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent({ mp: "i32" });
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("accepts a matching field identity (fingerprint is not over-eager)", () => {
		// Guard against a false-positive: identical registration must still restore.
		const src = new Store({ deterministic: true });
		const hp = src.registerSparseComponent(Hp);
		const e = src.createEntity();
		src.addSparse(e, hp, { hp: 42 });
		const bytes = src.snapshotSparse();

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		expect(() => dst.restoreSparse(bytes)).not.toThrow();
		expect(dst.stateHash()).toBe(src.stateHash());
	});

	it("rejects an entity index past MAX_INDEX without allocating for it", () => {
		// A raw u32 index keys a SparseMap whose backing array grows to `index`
		// length; an unvalidated ~4.29e9 index allocates multi-GB. Patch a valid
		// one-member snapshot's index to MAX_INDEX + 1 and confirm restore rejects
		// it rather than OOMing.
		const src = new Store({ deterministic: true });
		const hp = src.registerSparseComponent(Hp);
		const e = src.createEntity(); // entity index 0
		src.addSparse(e, hp, { hp: 1 });
		const bytes = src.snapshotSparse();

		// Sparse-section offsets after the 8-byte outer frame: storeCount(4) +
		// fieldCount(4) + schemaHash(4) + memberCount(4) = 24 → first member's
		// entityIndex u32.
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		view.setUint32(24, MAX_INDEX + 1, true);

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});

	it("rejects a buffer longer than the declared frame (trailing bytes)", () => {
		// Two buffers differing only in trailing padding must NOT restore
		// identically — the snapshot is a canonical encoding, so the outer frame
		// check is exact (`!==`), not a lower bound.
		const src = new Store({ deterministic: true });
		const h = src.registerSparseComponent(Hp);
		const e = src.createEntity();
		src.addSparse(e, h, { hp: 5 });
		const bytes = src.snapshotSparse();

		const padded = new Uint8Array(bytes.length + 4);
		padded.set(bytes, 0); // 4 trailing zero bytes

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		expect(() => dst.restoreSparse(padded)).toThrow(SparseRestoreError);
	});

	it("rejects a mis-split frame that hides trailing bytes inside the sparse section", () => {
		// The outer frame total still matches, but sparseLen is inflated and
		// relLen shrunk to compensate, so the sparse section carries trailing bytes
		// the outer `!==` can't see. The per-section exact-exhaustion check (off ===
		// end) catches it.
		const src = new Store({ deterministic: true });
		src.registerSparseComponent(Hp); // empty store; rel section is just the count
		const bytes = src.snapshotSparse();
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const sparseLen = view.getUint32(0, true);
		const relLen = view.getUint32(4, true);
		expect(relLen).toBeGreaterThanOrEqual(4); // u32 relationCount = 0
		view.setUint32(0, sparseLen + 4, true); // shift 4 bytes from rel into sparse
		view.setUint32(4, relLen - 4, true); // total length unchanged

		const dst = new Store({ deterministic: true });
		dst.registerSparseComponent(Hp);
		expect(() => dst.restoreSparse(bytes)).toThrow(SparseRestoreError);
	});
});
