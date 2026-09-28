/**
 * World snapshot and resume framing, and host-state serialization.
 *
 * `Store.snapshot()` and `Store.restore()` mount a captured world back onto a
 * live, ticking `Store` ("rewind a running world and keep ticking"). A full
 * snapshot is four sections:
 *
 *   1. **dense**, the store column bytes (`columnStoreBytesView`): every
 *      component column, the entity-index region (generations, archetype and row
 *      per slot, plus the high-water `length` header), and the layout
 *      descriptors. The section starts at the store's header and every offset
 *      inside it is relative, so it carries no store base. A world at one base
 *      therefore mounts a world captured at another.
 *   2. **sparse**, out-of-identity components + relations (`snapshotSparse`).
 *   3. **host-state**, the host-side bookkeeping the SAB does not carry: the
 *      world tick, the entity recycle free-list (in live LIFO order. There is no
 *      byte source for it, and its order is load-bearing for byte-identical
 *      resume, see below), the alive count, and per-archetype `length` and
 *      `enabledCount` (the SAB descriptor omits these for tag-only archetypes,
 *      so the capture takes them for every archetype uniformly).
 *   4. **storage**, one named entry for each plugin store. A version 1
 *      frame has no such section.
 *
 * **Why serialize the free-list rather than rescan it.** A scan of the restored
 * entity-index region recovers the *set* of recycled slots but not the *order*
 * they sit on the recycle stack, that order is pure destroy history with no byte
 * source. The order is load-bearing: a post-resume `spawn` reuses the stack top,
 * and the index it draws feeds the canonical-ordered sparse `stateHash` fold (and
 * the whole-SAB `columnStoreStateHash` via the entity-index region). A different
 * reuse order means a diverged hash on the first post-resume spawn that touches
 * a sparse store or relation. Serializing the list costs a small block off the
 * tick path, and it keeps the runtime LIFO allocator untouched while making
 * resume exact.
 *
 * This module holds only the *pure* framing and serialization, and the
 * registration guard. The mount itself (swap the SAB, republish views,
 * reconstruct host state) runs through the Store-owned closures on
 * `SnapshotHost`, where the live state is.
 */

import {
	ECS_SNAPSHOT_VERSION,
	type ArchetypeRowState,
	type HostState
} from "../../core/ecs/snapshot";
import {
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ENTITY_INDEX_HEADER_BYTES,
	ENTITY_INDEX_HEADER_OFFSETS,
	LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	readLayoutDescriptorRegion,
	readStoreHeader,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	LEGACY_ABSOLUTE_ABI_VERSION,
	type ArchetypeDescriptor,
	type ArchetypeViews
} from "../../core/store";

/** Magic for the combined world-snapshot frame (`"WRS0"` little-endian). Distinct
 * from the SAB `STORE_MAGIC` so a bare dense snapshot fed to `restore` is
 * rejected with a clear error instead of being mis-parsed as a combined frame. */
export const WORLD_SNAPSHOT_MAGIC = 0x30535257;

// `ECSRestoreError` lives in `utils/error.ts` and is re-exported here.
// The store's restore-time host-row rebuild throws it, and a value import of
// this module from the store would pin the framing and serialization code into
// every world, including one that installs no snapshot plugin.
import { ECSRestoreError } from "../../core/ecs/utils/error";
export { ECSRestoreError };

// The frame version and the host-state shapes are the core's, because `Store`
// rebuilds its rows from a `HostState` and the root entry reports the version.
export { ECS_SNAPSHOT_VERSION };
export type { ArchetypeRowState, HostState };

const U32 = 4;

/** Serialize host-state to a self-contained little-endian byte buffer. Layout:
 *
 *   [u32 tick][u32 highWater][u32 alive_count]
 *   [u32 freeCount][u32 free_index × freeCount]
 *   [u32 archCount][(u32 id, u32 length, u32 enabled_count) × archCount]
 */
export function serializeHostState(hs: HostState): Uint8Array {
	const freeCount = hs.freeIndices.length;
	const archCount = hs.archetypeRows.length;
	const bytes = U32 * (3 + 1 + freeCount + 1 + archCount * 3);
	const out = new Uint8Array(bytes);
	const view = new DataView(out.buffer);
	let off = 0;
	const put = (v: number): void => {
		view.setUint32(off, v, true);
		off += U32;
	};
	put(hs.tick);
	put(hs.entityHighWater);
	put(hs.entityAliveCount);
	put(freeCount);
	for (let i = 0; i < freeCount; i++) put(hs.freeIndices[i]);
	put(archCount);
	for (let i = 0; i < archCount; i++) {
		const a = hs.archetypeRows[i];
		put(a.archetypeId);
		put(a.length);
		put(a.enabledCount);
	}
	return out;
}

/** Parse host-state bytes produced by `serializeHostState`. Throws
 * `ECSRestoreError` on truncation or a trailing-byte (non-canonical) buffer. */
export function parseHostState(bytes: Uint8Array): HostState {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.byteLength;
	let off = 0;
	const need = (n: number): void => {
		if (off + n > end) {
			throw new ECSRestoreError(
				`host-state truncated: need ${n} more bytes at offset ${off}, have ${end - off}`
			);
		}
	};
	const get = (): number => {
		need(U32);
		const v = view.getUint32(off, true);
		off += U32;
		return v;
	};
	const tick = get();
	const entityHighWater = get();
	const entityAliveCount = get();
	const freeCount = get();
	const freeIndices = new Array<number>(freeCount);
	for (let i = 0; i < freeCount; i++) freeIndices[i] = get();
	const archCount = get();
	const archetypeRows = new Array<ArchetypeRowState>(archCount);
	for (let i = 0; i < archCount; i++) {
		const archetypeId = get();
		const length = get();
		const enabledCount = get();
		archetypeRows[i] = { archetypeId, length, enabledCount };
	}
	if (off !== end) {
		throw new ECSRestoreError(
			`host-state has ${end - off} trailing bytes after the last archetype (not a canonical encoding)`
		);
	}
	return { tick, entityHighWater, entityAliveCount, freeIndices, archetypeRows };
}

/** Assemble the combined world-snapshot frame from its four sections. Layout:
 *
 *   [u32 magic][u32 version][u32 denseLen][u32 sparseLen][u32 hostLen][u32 storageLen]
 *   [dense][sparse][host][storage]
 */
export function frameWorldSnapshot(
	dense: Uint8Array,
	sparse: Uint8Array,
	host: Uint8Array,
	storage: Uint8Array
): Uint8Array {
	const header = U32 * 6;
	const out = new Uint8Array(header + dense.length + sparse.length + host.length + storage.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, WORLD_SNAPSHOT_MAGIC, true);
	view.setUint32(4, ECS_SNAPSHOT_VERSION, true);
	view.setUint32(8, dense.length, true);
	view.setUint32(12, sparse.length, true);
	view.setUint32(16, host.length, true);
	view.setUint32(20, storage.length, true);
	let at = header;
	out.set(dense, at);
	at += dense.length;
	out.set(sparse, at);
	at += sparse.length;
	out.set(host, at);
	at += host.length;
	out.set(storage, at);
	return out;
}

/** The frame version with no storage section and a five-word header. */
export const LEGACY_ECS_SNAPSHOT_VERSION = 1;

/** The sections of a combined frame, as zero-copy subviews over `bytes`.
 * `storage` is `null` for a version 1 frame. */
export interface WorldSnapshotSections {
	readonly dense: Uint8Array;
	readonly sparse: Uint8Array;
	readonly host: Uint8Array;
	readonly storage: Uint8Array | null;
}

/** Split a combined frame back into its sections. Validates magic, version, and
 * an exact (no trailing bytes) frame. Throws `ECSRestoreError` otherwise. */
export function unframeWorldSnapshot(bytes: Uint8Array): WorldSnapshotSections {
	const legacyHeader = U32 * 5;
	if (bytes.byteLength < legacyHeader) {
		throw new ECSRestoreError(
			`world snapshot too small: ${bytes.byteLength} bytes (frame header needs ${legacyHeader})`
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0, true);
	if (magic !== WORLD_SNAPSHOT_MAGIC) {
		throw new ECSRestoreError(
			`bad world-snapshot magic: 0x${magic.toString(16).padStart(8, "0")} ` +
				`(expected 0x${WORLD_SNAPSHOT_MAGIC.toString(16).padStart(8, "0")}). ` +
				`A bare dense (SAB) snapshot is not a combined world snapshot, pass the ` +
				`bytes from ECS.snapshot(), not columnStoreBytesView().`
		);
	}
	const version = view.getUint32(4, true);
	if (version !== ECS_SNAPSHOT_VERSION && version !== LEGACY_ECS_SNAPSHOT_VERSION) {
		throw new ECSRestoreError(
			`incompatible world-snapshot version: snapshot=${version}, build=${ECS_SNAPSHOT_VERSION}`
		);
	}
	const legacy = version === LEGACY_ECS_SNAPSHOT_VERSION;
	const header = legacy ? legacyHeader : U32 * 6;
	if (bytes.byteLength < header) {
		throw new ECSRestoreError(
			`world snapshot too small: ${bytes.byteLength} bytes (frame header needs ${header})`
		);
	}
	const denseLen = view.getUint32(8, true);
	const sparseLen = view.getUint32(12, true);
	const hostLen = view.getUint32(16, true);
	const storageLen = legacy ? 0 : view.getUint32(20, true);
	const total = header + denseLen + sparseLen + hostLen + storageLen;
	if (total !== bytes.byteLength) {
		throw new ECSRestoreError(
			`world-snapshot frame mismatch: header declares ${header}+${denseLen}+${sparseLen}+` +
				`${hostLen}+${storageLen}=${total} bytes, buffer is ${bytes.byteLength}`
		);
	}
	const base = bytes.byteOffset;
	const buf = bytes.buffer;
	let at = base + header;
	const dense = new Uint8Array(buf, at, denseLen);
	at += denseLen;
	const sparse = new Uint8Array(buf, at, sparseLen);
	at += sparseLen;
	const host = new Uint8Array(buf, at, hostLen);
	at += hostLen;
	const storage = legacy ? null : new Uint8Array(buf, at, storageLen);
	return { dense, sparse, host, storage };
}

/** One section of a plugin store, as a subview over the frame. */
export interface StorageSection {
	readonly name: string;
	readonly bytes: Uint8Array;
}

const utf8Encoder = new TextEncoder();
// `fatal`, so a damaged name refuses.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Serialize the plugin stores' sections. Layout:
 *
 *   [u32 count] then, per store, [u32 nameLen][name utf-8][u32 dataLen][data]
 *
 * In registration order. */
export function serializeStorageSections(sections: readonly StorageSection[]): Uint8Array {
	const names = sections.map((s) => utf8Encoder.encode(s.name));
	let len = U32;
	for (let i = 0; i < sections.length; i++)
		len += U32 + names[i].length + U32 + sections[i].bytes.length;
	const out = new Uint8Array(len);
	const view = new DataView(out.buffer);
	view.setUint32(0, sections.length, true);
	let at = U32;
	for (let i = 0; i < sections.length; i++) {
		view.setUint32(at, names[i].length, true);
		at += U32;
		out.set(names[i], at);
		at += names[i].length;
		view.setUint32(at, sections[i].bytes.length, true);
		at += U32;
		out.set(sections[i].bytes, at);
		at += sections[i].bytes.length;
	}
	return out;
}

/** Parse the storage section into subviews over `bytes`. Throws
 * `ECSRestoreError` on a bad length or trailing bytes. */
export function parseStorageSections(bytes: Uint8Array): StorageSection[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const need = (at: number, n: number, what: string): void => {
		if (at + n > bytes.byteLength) {
			throw new ECSRestoreError(
				`storage section truncated: ${what} needs ${n} bytes at ${at}, section is ${bytes.byteLength}`
			);
		}
	};
	need(0, U32, "the store count");
	const count = view.getUint32(0, true);
	const out: StorageSection[] = [];
	let at = U32;
	for (let i = 0; i < count; i++) {
		need(at, U32, `the name length of store ${i}`);
		const nameLen = view.getUint32(at, true);
		at += U32;
		need(at, nameLen, `the name of store ${i}`);
		let name: string;
		try {
			name = utf8Decoder.decode(bytes.subarray(at, at + nameLen));
		} catch {
			throw new ECSRestoreError(`storage section: the name of store ${i} is not valid UTF-8`);
		}
		at += nameLen;
		need(at, U32, `the data length of store '${name}'`);
		const dataLen = view.getUint32(at, true);
		at += U32;
		need(at, dataLen, `the data of store '${name}'`);
		out.push({ name, bytes: bytes.subarray(at, at + dataLen) });
		at += dataLen;
	}
	if (at !== bytes.byteLength) {
		throw new ECSRestoreError(
			`storage section frame mismatch: ${count} stores end at byte ${at}, section is ${bytes.byteLength}`
		);
	}
	return out;
}

/**
 * Fail-closed registration guard, read **directly from the snapshot's dense
 * bytes** so it can run before the dense backing is touched. `restore`
 * builds the restored store through the live world's in-place allocator,
 * which reuses the live backing buffer, so validating a
 * *materialised* `ColumnStore` would already have overwritten live column data
 * (the buffer is overwritten inside `restoreColumnStore`, before any post-build
 * check could run). Parsing the descriptors off the raw `dense` `Uint8Array`
 * keeps the check non-mutating, so a mismatch leaves the live world untouched.
 *
 * Asserts: the dense section's SAB magic and ABI, and that its archetype set,
 * its per-archetype `componentMask` and its per-column
 * `(componentId, fieldId, typeTag)`
 * match the live store's exactly (so every live `Archetype.refreshViews` finds
 * its region and no snapshot archetype is orphaned), and that the entity-index
 * capacity matches (the region is sized once at construction). The archetype
 * graph is rebuilt from registration code, not the snapshot (mirroring
 * `restoreSparse`'s "registered in the same order" contract). Throws
 * `ECSRestoreError` on any mismatch and malformed section.
 */
export function assertDenseMatchesLive(
	dense: Uint8Array,
	live: ReadonlyMap<number, ArchetypeViews>,
	liveEntityIndexCapacity: number
): void {
	if (dense.byteLength < STORE_HEADER_BYTES) {
		throw new ECSRestoreError(
			`dense section too small: ${dense.byteLength} bytes (SAB header needs ${STORE_HEADER_BYTES})`
		);
	}
	const view = new DataView(dense.buffer, dense.byteOffset, dense.byteLength);
	const magic = view.getUint32(STORE_HEADER_OFFSETS.magic, true);
	if (magic !== STORE_MAGIC) {
		throw new ECSRestoreError(
			`dense section bad magic: 0x${magic.toString(16).padStart(8, "0")} ` +
				`(expected SAB magic 0x${STORE_MAGIC.toString(16).padStart(8, "0")})`
		);
	}
	const abi = view.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true);
	// Version 0 reads as version 1: a version 0 store always sat at byte 0, so
	// its offsets are offsets from the header. The 0.5 line wrote version 0.
	if (abi !== SIM_ABI_VERSION && abi !== LEGACY_ABSOLUTE_ABI_VERSION) {
		throw new ECSRestoreError(
			`dense section incompatible sim_abi_version: snapshot=${abi}, build=${SIM_ABI_VERSION}`
		);
	}
	const header = readStoreHeader(view);
	if (header.layoutDescriptorOff < 0 || header.layoutDescriptorOff > dense.byteLength) {
		throw new ECSRestoreError(
			`dense layoutDescriptorOff ${header.layoutDescriptorOff} is outside the section ` +
				`(${dense.byteLength} bytes)`
		);
	}
	// Entity-index capacity is host-fixed (the region is sized once at
	// construction). A mismatch means the target world was sized differently and
	// the restored region wouldn't line up. Bounds-check the header read first.
	const eiOff = header.entityIndexOff;
	if (eiOff < 0 || eiOff + ENTITY_INDEX_HEADER_BYTES > dense.byteLength) {
		throw new ECSRestoreError(
			`dense entityIndexOff ${eiOff} is outside the section (${dense.byteLength} bytes)`
		);
	}
	const capacity = view.getUint32(eiOff + ENTITY_INDEX_HEADER_OFFSETS.capacity, true);
	if (capacity !== liveEntityIndexCapacity) {
		throw new ECSRestoreError(
			`entity-index capacity mismatch: live=${liveEntityIndexCapacity}, snapshot=${capacity}`
		);
	}
	let descriptors: readonly ArchetypeDescriptor[];
	try {
		// This guard runs on the raw section, before `restoreColumnStore` rewrites
		// a version 0 region at the current archetype header width, so it walks
		// the width the section was written with.
		descriptors = readLayoutDescriptorRegion(
			view,
			header.layoutDescriptorOff,
			header.archetypeCount,
			abi === LEGACY_ABSOLUTE_ABI_VERSION
				? LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES
				: ARCHETYPE_DESCRIPTOR_HEADER_BYTES
		);
	} catch (e) {
		if (e instanceof RangeError) {
			throw new ECSRestoreError(
				`dense section layout is corrupt or truncated: a descriptor reads past the ` +
					`${dense.byteLength}-byte section (${e.message})`
			);
		}
		throw e;
	}
	if (live.size !== descriptors.length) {
		throw new ECSRestoreError(
			`archetype-set mismatch: the live world has ${live.size} SAB archetypes, the ` +
				`snapshot has ${descriptors.length}. restore requires an identical archetype set. ` +
				`Prewarm the world so its archetype set is stable.`
		);
	}
	for (let d = 0; d < descriptors.length; d++) {
		const desc = descriptors[d];
		const here = live.get(desc.archetypeId);
		if (here === undefined) {
			throw new ECSRestoreError(
				`archetype-set mismatch: snapshot archetype ${desc.archetypeId} is absent from the live world`
			);
		}
		if (!maskEqual(here.componentMask, desc.componentMask)) {
			throw new ECSRestoreError(
				`archetype ${desc.archetypeId} component-mask mismatch between the live world and the ` +
					`snapshot (different component registration)`
			);
		}
		const a = here.columnsInOrder;
		const b = desc.columns;
		if (a.length !== b.length) {
			throw new ECSRestoreError(
				`archetype ${desc.archetypeId} column-count mismatch: live=${a.length}, snapshot=${b.length}`
			);
		}
		for (let i = 0; i < a.length; i++) {
			if (
				a[i].componentId !== b[i].componentId ||
				a[i].fieldId !== b[i].fieldId ||
				a[i].typeTag !== b[i].typeTag
			) {
				throw new ECSRestoreError(
					`archetype ${desc.archetypeId} column ${i} layout mismatch: ` +
						`live=(c${a[i].componentId},f${a[i].fieldId},t${a[i].typeTag}), ` +
						`snapshot=(c${b[i].componentId},f${b[i].fieldId},t${b[i].typeTag})`
				);
			}
		}
	}
}

function maskEqual(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
