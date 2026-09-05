/***
 * The restore error classes, in one module both core layers import.
 *
 * A caller catches a restore failure by class, so there must be exactly one
 * `StoreRestoreError` and one `SparseRestoreError` in a program. The dense
 * half throws from `core/store`, the sparse half throws from `core/ecs`, and
 * the snapshot plugin ships in its own rollup graph. A class declared
 * beside either thrower would be copied into that graph. `err instanceof
 * StoreRestoreError` would then answer `false` against the class the package
 * root exports.
 *
 * One module holding both is what the plugin build marks external and
 * resolves to the core artifact. Keep it free of imports, so the mapping stays
 * a leaf and the module carries no state beyond the two classes.
 *
 * Cold path. A restore failure ends the call.
 ***/

/** Thrown when the dense half of a snapshot is malformed: too short for the
 * header, the wrong magic, an incompatible ABI version, or a layout region
 * that runs past the buffer. */
export class StoreRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreRestoreError";
	}
}

/** Thrown when the sparse half of a snapshot does not match the live world:
 * truncated bytes, a different store count, or a field schema that differs
 * from the one the bytes were written against. */
export class SparseRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SparseRestoreError";
	}
}
