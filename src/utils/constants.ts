export const UNASSIGNED = -1;
export const NO_SWAP = -1;
export const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

// Bit-manipulation constants for iterating BitSet words (32-bit integers)
export const BITS_PER_WORD_SHIFT = 5; // log2(32)
export const BITS_PER_WORD_MASK = 31; // 32 - 1
export const BITS_PER_WORD = 32;

// FNV-1a hash constants (used by BitSet)
export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

// Hash multipliers for query cache key combining (golden-ratio derived)
export const HASH_GOLDEN_RATIO = 0x9e3779b9;
export const HASH_SECONDARY_PRIME = 0x517cc1b7;

// GrowableTypedArray defaults
export const DEFAULT_INITIAL_CAPACITY = 16;
export const GROWTH_FACTOR = 2;

// Default archetype column capacity (user can override via WorldOptions.initial_capacity)
export const DEFAULT_COLUMN_CAPACITY = 1024;

// Resource singleton row index
export const RESOURCE_ROW = 0;

// Entity generation
export const INITIAL_GENERATION = 0;
export const TOTAL_PACKED_BITS = 31; // usable signed-integer bits for JS bitwise ops

// Default ECS fixed-update configuration
export const DEFAULT_FIXED_TIMESTEP = 1 / 60;
export const DEFAULT_MAX_FIXED_STEPS = 4;

// Startup systems receive zero delta
export const STARTUP_DELTA_TIME = 0;
