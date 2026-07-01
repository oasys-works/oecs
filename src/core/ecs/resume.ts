/**
 * World snapshot/resume framing + host-state (de)serialization — #789.
 *
 * `Store.snapshot()` / `Store.restoreInto()` mount a captured world back onto a
 * live, ticking `Store` ("rewind a running world and keep ticking"). A full
 * snapshot is three sections:
 *
 *   1. **dense** — the SAB column bytes (`snapshotColumnStore`): every component
 *      column, the entity-index region (generations / archetype / row per slot,
 *      plus the high-water `length` header), and the layout descriptors.
 *   2. **sparse** — out-of-identity components + relations (`snapshotSparse`).
 *   3. **host-state** — the host-side bookkeeping the SAB does NOT carry: the
 *      world tick, the entity recycle free-list (in live LIFO order — there is no
 *      byte source for it, and its order is load-bearing for byte-identical
 *      resume, see below), the alive count, and per-archetype `length` /
 *      `enabledCount` (the SAB descriptor omits these for tag-only archetypes,
 *      so we capture them for every archetype uniformly).
 *
 * **Why serialize the free-list rather than rescan it.** A scan of the restored
 * entity-index region recovers the *set* of recycled slots but not the *order*
 * they sit on the recycle stack — that order is pure destroy history with no byte
 * source. The order is load-bearing: a post-resume `spawn` reuses the stack top,
 * and the index it draws feeds the canonical-ordered sparse `stateHash` fold (and
 * the whole-SAB `columnStoreStateHash` via the entity-index region). A different
 * reuse order ⇒ a diverged hash on the first post-resume spawn that touches a
 * sparse store / relation. Serializing the list (a few hundred bytes off the tick
 * path) keeps the runtime LIFO allocator untouched while making resume exact.
 *
 * This module holds only the *pure* framing/serialization + the registration
 * guard; the mount itself (swap the SAB, republish views, reconstruct host state)
 * lives on `Store` where the live state is.
 */

import {
	ENTITY_INDEX_HEADER_BYTES,
	ENTITY_INDEX_HEADER_OFFSETS,
	readLayoutDescriptorRegion,
	readStoreHeader,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	STORE_MAGIC,
	SIM_ABI_VERSION,
	type ArchetypeDescriptor,
	type ArchetypeViews
} from "../store";

/** Magic for the combined world-snapshot frame (`"WRS0"` little-endian). Distinct
 * from the SAB `STORE_MAGIC` so a bare dense snapshot fed to `restoreInto` is
 * rejected with a clear error instead of being mis-parsed as a combined frame. */
export const WORLD_SNAPSHOT_MAGIC = 0x30535257;

/** Combined-frame format version. Bumped if the section framing or host-state
 * layout changes. Independent of `SIM_ABI_VERSION` (which gates the dense bytes). */
export const WORLD_SNAPSHOT_VERSION = 1;

/** Thrown by `Store.restoreInto` (and the helpers here) when a combined snapshot
 * is malformed, carries the wrong magic/version, or targets a world whose
 * archetype/component registration doesn't match the snapshot. Mirrors
 * `StoreRestoreError` / `SparseRestoreError` so callers see one error class per
 * restore failure mode. */
export class WorldRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorldRestoreError";
	}
}

/** Per-archetype host-side row bookkeeping the SAB doesn't carry authoritatively. */
export interface ArchetypeRowState {
	readonly archetypeId: number;
	/** Total live rows (enabled + disabled). */
	readonly length: number;
	/** Enabled-row partition boundary (#577): rows `[0, enabledCount)` enabled. */
	readonly enabledCount: number;
}

/** The host-side state a snapshot captures alongside the dense + sparse bytes. */
export interface HostState {
	/** World tick at snapshot time (`Store._tick`). */
	readonly tick: number;
	/** Entity-index high-water (count of slots ever issued). Also mirrored in the
	 * SAB region's `length` header; carried here for a cross-check on restore. */
	readonly entityHighWater: number;
	/** Live entity count. */
	readonly entityAliveCount: number;
	/** Recycle free-list in live order (LIFO: the last element is the next slot
	 * `createEntity` hands out). */
	readonly freeIndices: readonly number[];
	/** Per-archetype row state, one entry per SAB-backed archetype. */
	readonly archetypeRows: readonly ArchetypeRowState[];
}

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
 * `WorldRestoreError` on truncation or a trailing-byte (non-canonical) buffer. */
export function parseHostState(bytes: Uint8Array): HostState {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.byteLength;
	let off = 0;
	const need = (n: number): void => {
		if (off + n > end) {
			throw new WorldRestoreError(
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
		throw new WorldRestoreError(
			`host-state has ${end - off} trailing bytes after the last archetype (not a canonical encoding)`
		);
	}
	return { tick, entityHighWater, entityAliveCount, freeIndices, archetypeRows };
}

/** Assemble the combined world-snapshot frame from its three sections. Layout:
 *
 *   [u32 magic][u32 version][u32 denseLen][u32 sparseLen][u32 hostLen]
 *   [dense][sparse][host]
 */
export function frameWorldSnapshot(
	dense: Uint8Array,
	sparse: Uint8Array,
	host: Uint8Array
): Uint8Array {
	const header = U32 * 5;
	const out = new Uint8Array(header + dense.length + sparse.length + host.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, WORLD_SNAPSHOT_MAGIC, true);
	view.setUint32(4, WORLD_SNAPSHOT_VERSION, true);
	view.setUint32(8, dense.length, true);
	view.setUint32(12, sparse.length, true);
	view.setUint32(16, host.length, true);
	out.set(dense, header);
	out.set(sparse, header + dense.length);
	out.set(host, header + dense.length + sparse.length);
	return out;
}

/** The three sections of a combined frame, as zero-copy subviews over `bytes`. */
export interface WorldSnapshotSections {
	readonly dense: Uint8Array;
	readonly sparse: Uint8Array;
	readonly host: Uint8Array;
}

/** Split a combined frame back into its sections. Validates magic, version, and
 * an exact (no trailing bytes) frame; throws `WorldRestoreError` otherwise. */
export function unframeWorldSnapshot(bytes: Uint8Array): WorldSnapshotSections {
	const header = U32 * 5;
	if (bytes.byteLength < header) {
		throw new WorldRestoreError(
			`world snapshot too small: ${bytes.byteLength} bytes (frame header needs ${header})`
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0, true);
	if (magic !== WORLD_SNAPSHOT_MAGIC) {
		throw new WorldRestoreError(
			`bad world-snapshot magic: 0x${magic.toString(16).padStart(8, "0")} ` +
				`(expected 0x${WORLD_SNAPSHOT_MAGIC.toString(16).padStart(8, "0")}). ` +
				`A bare dense (SAB) snapshot is not a combined world snapshot — pass the ` +
				`bytes from ECS.snapshot(), not snapshotColumnStore().`
		);
	}
	const version = view.getUint32(4, true);
	if (version !== WORLD_SNAPSHOT_VERSION) {
		throw new WorldRestoreError(
			`incompatible world-snapshot version: snapshot=${version}, build=${WORLD_SNAPSHOT_VERSION}`
		);
	}
	const denseLen = view.getUint32(8, true);
	const sparseLen = view.getUint32(12, true);
	const hostLen = view.getUint32(16, true);
	if (header + denseLen + sparseLen + hostLen !== bytes.byteLength) {
		throw new WorldRestoreError(
			`world-snapshot frame mismatch: header declares ${header}+${denseLen}+${sparseLen}+` +
				`${hostLen}=${header + denseLen + sparseLen + hostLen} bytes, buffer is ${bytes.byteLength}`
		);
	}
	const base = bytes.byteOffset;
	const buf = bytes.buffer;
	return {
		dense: new Uint8Array(buf, base + header, denseLen),
		sparse: new Uint8Array(buf, base + header + denseLen, sparseLen),
		host: new Uint8Array(buf, base + header + denseLen + sparseLen, hostLen)
	};
}

/**
 * Fail-closed registration guard, read **directly from the snapshot's dense
 * bytes** so it can run BEFORE the dense backing is touched. `restoreInto`
 * builds the restored store through the live world's in-place allocator
 * (ADR-0008), which reuses the live backing buffer — so validating a
 * *materialised* `ColumnStore` would already have overwritten live column data
 * (the buffer is overwritten inside `restoreColumnStore`, before any post-build
 * check could run). Parsing the descriptors off the raw `dense` `Uint8Array`
 * keeps the check non-mutating, so a mismatch leaves the live world untouched.
 *
 * Asserts: the dense section's SAB magic + ABI, that its archetype set +
 * per-archetype `componentMask` + per-column `(componentId, fieldId, typeTag)`
 * match the live store's exactly (so every live `Archetype.refreshViews` finds
 * its region and no snapshot archetype is orphaned), and that the entity-index
 * capacity matches (the region is sized once at construction). The archetype
 * graph is rebuilt from registration code, not the snapshot (mirroring
 * `restoreSparse`'s "registered in the same order" contract). Throws
 * `WorldRestoreError` on any mismatch / malformed section.
 */
export function assertDenseLayoutMatchesLive(
	dense: Uint8Array,
	live: ReadonlyMap<number, ArchetypeViews>,
	liveEntityIndexCapacity: number
): void {
	if (dense.byteLength < STORE_HEADER_BYTES) {
		throw new WorldRestoreError(
			`dense section too small: ${dense.byteLength} bytes (SAB header needs ${STORE_HEADER_BYTES})`
		);
	}
	const view = new DataView(dense.buffer, dense.byteOffset, dense.byteLength);
	const magic = view.getUint32(STORE_HEADER_OFFSETS.magic, true);
	if (magic !== STORE_MAGIC) {
		throw new WorldRestoreError(
			`dense section bad magic: 0x${magic.toString(16).padStart(8, "0")} ` +
				`(expected SAB magic 0x${STORE_MAGIC.toString(16).padStart(8, "0")})`
		);
	}
	const abi = view.getUint32(STORE_HEADER_OFFSETS.sim_abi_version, true);
	if (abi !== SIM_ABI_VERSION) {
		throw new WorldRestoreError(
			`dense section incompatible sim_abi_version: snapshot=${abi}, build=${SIM_ABI_VERSION}`
		);
	}
	const header = readStoreHeader(view);
	if (header.layoutDescriptorOff < 0 || header.layoutDescriptorOff > dense.byteLength) {
		throw new WorldRestoreError(
			`dense layoutDescriptorOff ${header.layoutDescriptorOff} is outside the section ` +
				`(${dense.byteLength} bytes)`
		);
	}
	// Entity-index capacity is host-fixed (the region is sized once at
	// construction); a mismatch means the target world was sized differently and
	// the restored region wouldn't line up. Bounds-check the header read first.
	const eiOff = header.entityIndexOff;
	if (eiOff < 0 || eiOff + ENTITY_INDEX_HEADER_BYTES > dense.byteLength) {
		throw new WorldRestoreError(
			`dense entityIndexOff ${eiOff} is outside the section (${dense.byteLength} bytes)`
		);
	}
	const capacity = view.getUint32(eiOff + ENTITY_INDEX_HEADER_OFFSETS.capacity, true);
	if (capacity !== liveEntityIndexCapacity) {
		throw new WorldRestoreError(
			`entity-index capacity mismatch: live=${liveEntityIndexCapacity}, snapshot=${capacity}`
		);
	}
	let descriptors: readonly ArchetypeDescriptor[];
	try {
		descriptors = readLayoutDescriptorRegion(
			view,
			header.layoutDescriptorOff,
			header.archetypeCount
		);
	} catch (e) {
		if (e instanceof RangeError) {
			throw new WorldRestoreError(
				`dense section layout is corrupt or truncated: a descriptor reads past the ` +
					`${dense.byteLength}-byte section (${e.message})`
			);
		}
		throw e;
	}
	if (live.size !== descriptors.length) {
		throw new WorldRestoreError(
			`archetype-set mismatch: the live world has ${live.size} SAB archetypes, the ` +
				`snapshot has ${descriptors.length}. restoreInto requires an identical archetype set ` +
				`(prewarm the world so its archetype set is stable, per ADR on no-lazy archetypes).`
		);
	}
	for (let d = 0; d < descriptors.length; d++) {
		const desc = descriptors[d];
		const here = live.get(desc.archetypeId);
		if (here === undefined) {
			throw new WorldRestoreError(
				`archetype-set mismatch: snapshot archetype ${desc.archetypeId} is absent from the live world`
			);
		}
		if (!maskEqual(here.componentMask, desc.componentMask)) {
			throw new WorldRestoreError(
				`archetype ${desc.archetypeId} component-mask mismatch between the live world and the ` +
					`snapshot (different component registration)`
			);
		}
		const a = here.columnsInOrder;
		const b = desc.columns;
		if (a.length !== b.length) {
			throw new WorldRestoreError(
				`archetype ${desc.archetypeId} column-count mismatch: live=${a.length}, snapshot=${b.length}`
			);
		}
		for (let i = 0; i < a.length; i++) {
			if (
				a[i].componentId !== b[i].componentId ||
				a[i].fieldId !== b[i].fieldId ||
				a[i].typeTag !== b[i].typeTag
			) {
				throw new WorldRestoreError(
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
