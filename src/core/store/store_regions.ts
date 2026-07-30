/**
 * STORE_PREFIX_REGIONS — the single source of truth for the engine's
 * genuinely-generic MECHANISM regions that sit between the SAB header and the
 * region-table directory: the SPSC command / event / action rings and the
 * entity-index. These are the regions the ENGINE ships for every consumer; a
 * game's own regions (terrain, spatial grid, … ) are NOT here — they are
 * consumer-declared `StoreRegionSpec`s laid out into the generic region table
 * (`region_table.ts`), keyed by an opaque `region_id` the engine never
 * interprets. This de-games the SAB substrate.
 *
 * Before this registry the region set was hand-mirrored across four places:
 *   - `createColumnStore` (column_store.ts) sized each region, computed its byte
 *     offset, and initialised its header;
 *   - `optionsFromOld` (extend.ts) read each region's capacity back out to
 *     recreate it on a realloc;
 *   - `snapshotPrefixRegions` (extend.ts) copied each region's live bytes
 *     before an allocator call that may detach views;
 *   - `restorePrefixRegions` (extend.ts) wrote those bytes back into the
 *     new SAB.
 * Adding a region meant editing all four in lockstep, and nothing enforced
 * that you did — a missed entry silently dropped that region's live state
 * across a grow (a real class of bug). This registry collapses the
 * four enumerations into one ordered list; each consumer is now a loop over it.
 *
 * ORDER IS LOAD-BEARING. The array order is the byte order of the regions in
 * the SAB: each region's offset is `STORE_HEADER_BYTES + Σ(prior region bytes)`.
 * Reordering entries changes every downstream offset — the header golden
 * tests (`header.test.ts`) pin the result, but treat a reorder as an ABI
 * change.
 *
 * Each region module (`command_ring.ts`, `entity_index.ts`, … ) still owns its
 * own byte math, header offsets, and init/read helpers; this registry only
 * wires those per-region primitives into the four generic passes.
 */

import { COMMAND_RING_HEADER_OFFSETS, commandRingBytes, initCommandRing } from "./command_ring";
import {
	ENTITY_INDEX_HEADER_OFFSETS,
	entityIndexRegionBytes,
	initEntityIndexRegion
} from "./entity_index";
import { EVENT_RING_HEADER_OFFSETS, eventRingBytes, initEventRing } from "./event_ring";
import { ACTION_RING_HEADER_OFFSETS, actionRingBytes, initActionRing } from "./action_ring";
import type { CreateColumnStoreOptions } from "./column_store";

/** The `StoreHeader` fields that hold a MECHANISM region's byte offset (0 ⇒
 * region absent). Exactly the four fields a `MechanismRegionSpec` can own; the
 * always-present `bindings_off` / `layout_descriptor_off` and the generic
 * `region_table_off` / `region_table_count` pair are not mechanism regions in
 * this sense and are computed directly outside the loop. */
export type StoreRegionOffsetField =
	| "command_ring_off"
	| "entity_index_off"
	| "event_ring_off"
	| "action_ring_off";

/** Mutable accumulator for building `CreateColumnStoreOptions` field by field as
 * each region reads itself back out of an existing SAB (`readOptions`). */
export type MutableColumnStoreOptions = {
	-readonly [K in keyof CreateColumnStoreOptions]: CreateColumnStoreOptions[K];
};

/** One engine MECHANISM region. The four closures are the per-region half of
 * each generic pass; see the module doc for which consumer drives which.
 *
 * (Consumer/game regions use the separate self-contained `StoreRegionSpec` in
 * `region_table.ts` — they carry a precomputed `bytes` + `init` and are
 * addressed by an opaque `region_id`, not a named header field.) */
export interface MechanismRegionSpec {
	/** Stable name — reads in diagnostics and keeps the array self-documenting. */
	readonly name: string;
	/** `StoreHeader` field this region's byte offset is written to. */
	readonly headerOff: StoreRegionOffsetField;
	/** Byte size implied by `options` (0 ⇒ region absent, so no offset/init). */
	readonly sizeFromOptions: (options: CreateColumnStoreOptions) => number;
	/** Initialise the region's header at `off`. Called by `createColumnStore`
	 * only when the region is present (`off !== 0`). */
	readonly init: (view: DataView, off: number, options: CreateColumnStoreOptions) => void;
	/** Byte length of an already-allocated region, read from its own header.
	 * Used to snapshot exactly the live bytes before a realloc. */
	readonly regionBytes: (view: DataView, off: number) => number;
	/** Re-derive the `CreateColumnStoreOptions` knobs that recreate this region
	 * from an existing SAB, so a realloc lays it out identically. */
	readonly readOptions: (view: DataView, off: number, out: MutableColumnStoreOptions) => void;
}

/** The engine mechanism prefix regions, in SAB byte order (see module doc). */
export const STORE_PREFIX_REGIONS: readonly MechanismRegionSpec[] = [
	{
		name: "command_ring",
		headerOff: "command_ring_off",
		sizeFromOptions: (o) =>
			o.commandRingCapacitySlots !== undefined
				? commandRingBytes(o.commandRingCapacitySlots)
				: 0,
		init: (view, off, o) => initCommandRing(view, off, o.commandRingCapacitySlots!),
		regionBytes: (view, off) =>
			commandRingBytes(view.getUint32(off + COMMAND_RING_HEADER_OFFSETS.capacity_slots, true)),
		readOptions: (view, off, out) => {
			out.commandRingCapacitySlots = view.getUint32(
				off + COMMAND_RING_HEADER_OFFSETS.capacity_slots,
				true
			);
		}
	},
	{
		name: "entity_index",
		headerOff: "entity_index_off",
		sizeFromOptions: (o) =>
			o.entityIndexCapacity !== undefined
				? entityIndexRegionBytes(o.entityIndexCapacity)
				: 0,
		init: (view, off, o) => initEntityIndexRegion(view, off, o.entityIndexCapacity!),
		regionBytes: (view, off) =>
			entityIndexRegionBytes(view.getUint32(off + ENTITY_INDEX_HEADER_OFFSETS.capacity, true)),
		readOptions: (view, off, out) => {
			out.entityIndexCapacity = view.getUint32(off + ENTITY_INDEX_HEADER_OFFSETS.capacity, true);
		}
	},
	{
		name: "event_ring",
		headerOff: "event_ring_off",
		sizeFromOptions: (o) =>
			o.eventRingCapacitySlots !== undefined ? eventRingBytes(o.eventRingCapacitySlots) : 0,
		init: (view, off, o) => initEventRing(view, off, o.eventRingCapacitySlots!),
		regionBytes: (view, off) =>
			eventRingBytes(view.getUint32(off + EVENT_RING_HEADER_OFFSETS.capacity_slots, true)),
		readOptions: (view, off, out) => {
			out.eventRingCapacitySlots = view.getUint32(
				off + EVENT_RING_HEADER_OFFSETS.capacity_slots,
				true
			);
		}
	},
	{
		name: "action_ring",
		headerOff: "action_ring_off",
		sizeFromOptions: (o) =>
			o.actionRingCapacitySlots !== undefined
				? actionRingBytes(o.actionRingCapacitySlots)
				: 0,
		init: (view, off, o) => initActionRing(view, off, o.actionRingCapacitySlots!),
		regionBytes: (view, off) =>
			actionRingBytes(view.getUint32(off + ACTION_RING_HEADER_OFFSETS.capacity_slots, true)),
		readOptions: (view, off, out) => {
			out.actionRingCapacitySlots = view.getUint32(
				off + ACTION_RING_HEADER_OFFSETS.capacity_slots,
				true
			);
		}
	}
];
