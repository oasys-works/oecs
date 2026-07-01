export const UNASSIGNED = -1;
export const NO_SWAP = -1;
export const EMPTY_VALUES: Record<string, number> = Object.freeze(Object.create(null));

// Hash multipliers for query cache key combining (golden-ratio derived)
export const HASH_GOLDEN_RATIO = 0x9e3779b9;
export const HASH_SECONDARY_PRIME = 0x517cc1b7;

// Default archetype column capacity (user can override via ECSOptions.initialCapacity)
export const DEFAULT_COLUMN_CAPACITY = 1024;

// Entity generation
export const INITIAL_GENERATION = 0;
export const TOTAL_PACKED_BITS = 31; // usable signed-integer bits for JS bitwise ops

// Default ECS fixed-update configuration
export const DEFAULT_FIXED_TIMESTEP = 1 / 60;
export const DEFAULT_MAX_FIXED_STEPS = 4;

// Startup systems receive zero delta
export const STARTUP_DELTA_TIME = 0;
