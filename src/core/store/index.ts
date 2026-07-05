export {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS,
	type StoreHeader,
	writeStoreHeader,
	readStoreHeader,
	bumpViewStamp,
	isValidSab
} from "./header";

// Generic consumer-declared region registry (#623 — de-game the SAB
// substrate). The engine ships only the mechanism regions; a game declares its
// own regions as `StoreRegionSpec`s addressed by an opaque `region_id`.
export {
	type StoreRegionSpec,
	type RegionTableEntry,
	type ColumnStoreRegionHandle,
	RegionRegistryError,
	regionTableBytes,
	validateRegionSpecs,
	writeRegionTableEntry,
	readRegionTableEntry,
	writeRegionTable,
	readRegionTable,
	readHeaderRegionTable,
	findRegionOffset,
	findRegionEntry
} from "./region_table";

export {
	TYPE_TAG,
	type TypeTagValue,
	TYPE_TAG_STRIDE,
	TYPED_ARRAY_TAG_TO_TYPE_TAG,
	COLUMN_DESCRIPTOR_BYTES,
	COLUMN_DESCRIPTOR_OFFSETS,
	type ColumnDescriptor,
	writeColumnDescriptor,
	readColumnDescriptor,
	ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
	ARCHETYPE_DESCRIPTOR_OFFSETS,
	COMPONENT_MASK_WORDS,
	STORE_DESCRIPTOR_COMPONENT_LIMIT,
	type ArchetypeDescriptor,
	archetypeDescriptorBytes,
	writeArchetypeDescriptor,
	readArchetypeDescriptor,
	writeLayoutDescriptorRegion,
	readLayoutDescriptorRegion,
	layoutDescriptorRegionBytes
} from "./descriptor";

export {
	type ColumnSpec,
	type ArchetypeSpec,
	type ColumnView,
	type ArchetypeViews,
	type ColumnStore,
	type AnyTypedArray,
	type CreateColumnStoreOptions,
	alignUp,
	buildArchetypeViews,
	columnKey,
	createColumnStore,
	StoreLayoutOverflowError,
	STORE_MAX_BYTE_OFFSET,
	COMMAND_RING_DEFAULT_CAPACITY_SLOTS,
	ENTITY_INDEX_DEFAULT_CAPACITY,
	EVENT_RING_DEFAULT_CAPACITY_SLOTS
} from "./column_store";

export {
	EVENT_OP_EMPTY,
	EVENT_RING_HEADER_BYTES,
	EVENT_RING_SLOT_BYTES,
	EVENT_RING_HEADER_OFFSETS,
	EventRingError,
	drainEventRing,
	eventRingBytes,
	initEventRing,
	pendingEventCount,
	popEvent,
	pushEvent,
	ringCapacitySlots as eventRingCapacitySlots,
	ringOverflow as eventRingOverflow,
	ringReadHead as eventRingReadHead,
	ringWriteHead as eventRingWriteHead
} from "./event_ring";

export {
	ENTITY_INDEX_HEADER_BYTES,
	ENTITY_INDEX_BYTES_PER_SLOT,
	ENTITY_INDEX_HEADER_OFFSETS,
	EntityIndexError,
	buildEntityIndexViews,
	entityIndexCapacity,
	entityIndexLength,
	entityIndexRegionBytes,
	initEntityIndexRegion,
	setEntityIndexLength
} from "./entity_index";

export {
	COMMAND_OP_EMPTY,
	COMMAND_RING_HEADER_BYTES,
	COMMAND_RING_SLOT_BYTES,
	COMMAND_RING_HEADER_OFFSETS,
	CommandRingError,
	commandRingBytes,
	drainCommandRing,
	initCommandRing,
	pendingCommandCount,
	popCommand,
	pushCommand,
	ringCapacitySlots,
	ringOverflow,
	ringReadHead,
	ringWriteHead
} from "./command_ring";

// Generic command-dispatch surface (#624). A consumer binds a payload codec +
// handler per opcode; the engine owns no opcode names. The game's opcode enum
// (`COMMAND_OP`) and payload codecs (`SpawnUnitFields`, …) live in
// `@internal/sim`'s `command_payloads.ts`.
export { type PayloadCodec, CommandDispatcher } from "./command_dispatch";

export { BufferBackedColumn, StoreColumnOverflowError } from "./buffer_backed_column";

export {
	type ArchetypeGrowSpec,
	type GrowPlan,
	type GrowResult,
	StoreGrowError,
	growColumnStore
} from "./grow";

export {
	type ExtendPlan,
	type ExtendResult,
	StoreExtendError,
	extendColumnStore
} from "./extend";

// Shared grow/extend layout/realloc building blocks (H5) — one home for the
// tail-cursor layout rule, the realloc-and-republish choreography, and the
// snapshot helpers both resize paths use.
export { snapshotLiveColumns, restoreColumnSnapshots } from "./layout_ops";

export {
	type BufferAllocator,
	type InPlaceBufferAllocator,
	StoreCapExceededError,
	SabUnavailableError,
	DEFAULT_SAB_ALLOCATOR,
	wasmMemoryAllocator,
	growableSabAllocator,
	heapArraybufferAllocator
} from "./allocator";

export { StoreRestoreError, snapshotColumnStore, restoreColumnStore } from "./snapshot";

export {
	FNV1A_OFFSET_BASIS,
	FNV1A_PRIME,
	fnv1a32,
	fnv1aStep,
	fnv1aStepWord,
	columnStoreStateHash
} from "./state_hash";

export {
	ACTION_RING_DEFAULT_CAPACITY_SLOTS,
	ACTION_RING_HEADER_BYTES,
	ACTION_RING_HEADER_OFFSETS,
	ACTION_RING_MAX_PAYLOAD_BYTES,
	ACTION_RING_SLOT_BYTES,
	ActionRingError,
	actionRingBytes,
	actionRingCapacitySlots,
	actionRingOverflow,
	actionRingReadHead,
	actionRingWriteHead,
	clearActionRingOverflow,
	drainActionRing,
	initActionRing,
	pendingActionCount,
	popAction,
	pushAction
} from "./action_ring";

// terrain / spatial_grid / army_compositions / spawn_anchors / flow_field
// region modules MOVED to `@internal/sim` (packages/sim/src/regions/) in #623 —
// they are GAME data structures, not engine substrate. The engine now exposes
// only the generic region table above; consumers import the region builders +
// view helpers from `@internal/sim`.
