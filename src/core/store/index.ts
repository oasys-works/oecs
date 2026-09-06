export {
	STORE_MAGIC,
	SIM_ABI_VERSION,
	LEGACY_ABSOLUTE_ABI_VERSION,
	STORE_HEADER_BYTES,
	STORE_HEADER_OFFSETS,
	REGION_TABLE_ENTRY_BYTES,
	REGION_TABLE_ENTRY_OFFSETS,
	type StoreHeader,
	writeStoreHeader,
	readStoreHeader,
	bumpViewStamp,
	isValidStoreHeader
} from "./header";

// Generic consumer-declared region registry (it de-games the SAB
// substrate). The engine ships only the mechanism regions. A game declares its
// own regions as `StoreRegionSpec`s addressed by an opaque `region_id`.
export {
	type StoreRegionSpec,
	type RegionTableEntry,
	type ColumnStoreRegionHandle,
	RegionRegistryError,
	regionTableBytes,
	assertRegionSpecs,
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
	LEGACY_ARCHETYPE_DESCRIPTOR_HEADER_BYTES,
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
	createArchetypeViews,
	columnKey,
	createColumnStore,
	StoreLayoutOverflowError,
	STORE_MAX_BYTE_OFFSET,
	STORE_BASE_ALIGNMENT,
	assertStoreBase,
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
	eventRingCapacitySlots,
	eventRingOverflow,
	eventRingReadHead,
	eventRingWriteHead
} from "./event_ring";

export {
	ENTITY_INDEX_HEADER_BYTES,
	ENTITY_INDEX_BYTES_PER_SLOT,
	ENTITY_INDEX_HEADER_OFFSETS,
	EntityIndexError,
	createEntityIndexViews,
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
	commandRingCapacitySlots,
	commandRingOverflow,
	commandRingReadHead,
	commandRingWriteHead
} from "./command_ring";

// Generic command-dispatch surface. A consumer binds a payload codec and a
// handler for each opcode. The engine owns no opcode name. A consumer's opcode
// enum and payload codecs live in the consumer's own module.
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

// Shared grow and extend layout and realloc building blocks, one home for the
// tail-cursor layout rule, the realloc-and-republish choreography, and the
// snapshot helpers both resize paths use.
export { snapshotLiveColumns, restoreLiveColumns } from "./layout_ops";

export {
	type BufferAllocator,
	type InPlaceBufferAllocator,
	StoreCapExceededError,
	SabUnavailableError,
	DEFAULT_SAB_ALLOCATOR,
	wasmMemoryAllocator,
	growableSabAllocator,
	heapArrayBufferAllocator,
	fixedSabAllocator
} from "./allocator";

export {
	StoreRestoreError,
	type RestoreColumnStoreOptions,
	columnStoreBytesView,
	restoreColumnStore
} from "./snapshot";

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

// The engine exposes the generic region table above and nothing narrower. A
// named region, such as a terrain grid or a spawn anchor list, is a game data
// structure and not engine substrate, so it lives in the consumer that owns
// its shape and reaches the bytes through the table.
