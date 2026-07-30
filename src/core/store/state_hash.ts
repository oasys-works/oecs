/**
 * SAB state hash.
 *
 * One pass of FNV-1a (32-bit) over the SAB snapshot. Replaces the per-column
 * hash traversal: with every column already living inside a single
 * `SharedArrayBuffer`, "the simulation state" is exactly the bytes
 * of the SAB, and the hash collapses to a single scan over that contiguous
 * region.
 *
 * Why FNV-1a-32:
 *   - Avalanches well enough for the cross-replay equality check this hash
 *     exists to power; we are NOT using it as a security or sharding hash.
 *   - One round per byte; no table or seed state — fits a single tight loop
 *     readable next to the SAB it scans.
 *   - 32-bit fits a JS `number` exactly (kept unsigned via `>>> 0`), so it
 *     prints cleanly in test failures and serialises without BigInt fuss.
 *
 * The constants come from Fowler/Noll/Vo:
 *   offset basis = 0x811c9dc5 (2166136261)
 *   prime        = 0x01000193 (16777619)
 *
 * `Math.imul` performs the 32-bit C-style multiplication; the trailing
 * `>>> 0` on the result keeps the unsigned interpretation that callers
 * (test goldens, log lines, equality compares) expect.
 *
 * Determinism: this function reads only the snapshot bytes. The SAB header
 * field `view_stamp` IS part of the snapshot — two stores at the same
 * logical state but different realloc generations will hash differently.
 * That matches the cross-replay model where both replays share the same
 * grow trajectory; if you need a logical-only hash, slice the snapshot to
 * skip the header before passing it in.
 */

import { snapshotColumnStore } from "./snapshot";
import type { ColumnStore } from "./column_store";

/** FNV-1a 32-bit offset basis (Fowler/Noll/Vo). */
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
export const FNV1A_PRIME = 0x01000193;

/** One FNV-1a round folding a single **byte** (the low 8 bits of `b`) into the
 * running `hash`: `hash = imul((hash ^ (b & 0xff)) >>> 0, PRIME) >>> 0`. The
 * single canonical definition of the byte step — reused by `fnv1a32`
 * here, by the sparse-store `schemaFingerprint`, and by the server determinism
 * byte/u32 folds, so the constants and the round live in exactly one place.
 *
 * Trivially inlinable (monomorphic, no allocation); the intermediate `>>> 0`s
 * never change a later round (xor/imul see the same 32-bit pattern signed or
 * unsigned), they just keep the value unsigned for readers. */
export function fnv1aStep(hash: number, b: number): number {
	hash = (hash ^ (b & 0xff)) >>> 0;
	return Math.imul(hash, FNV1A_PRIME) >>> 0;
}

/** One FNV-1a round folding a full 32-bit **word** into `hash` — the whole word
 * xored at once, not four byte rounds. A coarser fold than per-byte FNV-1a, but
 * equally deterministic and ~4× cheaper, which is why `Store.stateHash` folds
 * its columns this way. This is the canonical word-step definition its
 * cold sparse/relation folds call; its hot dense-column inner loop inlines this
 * exact step for speed and must stay in sync. Same `>>> 0` reasoning as
 * `fnv1aStep`. */
export function fnv1aStepWord(hash: number, word: number): number {
	hash = (hash ^ (word >>> 0)) >>> 0;
	return Math.imul(hash, FNV1A_PRIME) >>> 0;
}

/** FNV-1a 32-bit hash of a byte buffer. Returned as an unsigned 32-bit
 * `number` (i.e. always in `[0, 2^32)`).
 *
 * Standalone export so callers that already have a `Uint8Array` (a sliced
 * snapshot, bytes off disk, a hot subrange) can hash without round-tripping
 * through `ColumnStore`. */
export function fnv1a32(bytes: Uint8Array): number {
	let hash = FNV1A_OFFSET_BASIS;
	for (let i = 0; i < bytes.length; i++) hash = fnv1aStep(hash, bytes[i]!);
	return hash >>> 0;
}

/** FNV-1a 32-bit hash of the entire SAB region — header + descriptors +
 * column bytes. The canonical state identifier for cross-replay determinism
 * checks.
 *
 * The snapshot view is zero-copy (`snapshotColumnStore` is a view, not a
 * copy), so this is one scan over the live SAB with no allocation. */
export function columnStoreStateHash(store: ColumnStore): number {
	return fnv1a32(snapshotColumnStore(store));
}
