/**
 * The `Mix` component: one column of each integer kind, and the model of each
 * column.
 *
 * The net itself holds `u8` and `i32` columns, and the float arm adds one `f64`.
 * The row plane of the engine moves each row through views that depend on the
 * width of the element, and the value paths convert through the type of the
 * element. A store that holds three kinds does not reach the other five. This
 * component puts each kind on each agent, so each row move and each write in the
 * simulation goes through each kind, and the reference has an exact value for each
 * one.
 *
 * Two groups of fields:
 *
 *   - The mirrors (`m8`, `m16`, `mu16`, `mu32`, and `mf32` in the float arm).
 *     `setLink` writes them after each increase of `Touch.seq`, and each one is a
 *     function of the new value. Therefore the model is `mirrorOf(seq)`, and the
 *     reference keeps no new state. The functions give a negative number, a wrap,
 *     and a rounding, so a write that converts through the wrong type gives a
 *     different value. The writes go through `ctx.ref` and `ctx.cursor`, which are
 *     the accessors that share one prototype.
 *   - The born constants (`b8`, `b16`, `bu16`, `bu32`, and `bf32` in the float
 *     arm). The template of an agent gives them, and no code writes them after
 *     that. Therefore the value that a comparison reads is the value that the
 *     spawn path stored: the template converts its defaults one time into the
 *     stored bits, and the append copies bits. A conversion that keeps the wrong
 *     bits for one kind is visible on each agent, at each comparison.
 *
 * A deterministic world rejects a float column, so the `f32` fields exist in the
 * float arm alone. `mixSchema(float)` gives the schema for each arm.
 */

/** The integer mirrors, in schema order. */
export const MIRROR_INT_FIELDS = ["m8", "m16", "mu16", "mu32"];

/** The integer constants, in schema order. */
export const BORN_INT_FIELDS = ["b8", "b16", "bu16", "bu32"];

/** The constants that the template gives. Each one is a value that a store
 * through the wrong width or the wrong sign changes: `-7` has its high bits set,
 * `-300` has a high byte, `65535` and `4294967295` have each bit set. */
export const BORN = { b8: -7, b16: -300, bu16: 65535, bu32: 4294967295 };

/** The `f32` constant of the float arm. `-0.7` has no exact `f32` value, so the
 * stored value is a rounding, and a store through `f64` gives a different one. */
export const BORN_F32 = Math.fround(-0.7);

/** The schema of `Mix` for one arm. */
export function mixSchema(float) {
	const s = {
		m8: "i8",
		m16: "i16",
		mu16: "u16",
		mu32: "u32",
		b8: "i8",
		b16: "i16",
		bu16: "u16",
		bu32: "u32",
	};
	if (float) {
		s.mf32 = "f32";
		s.bf32 = "f32";
	}
	return s;
}

/** The integer mirrors of one `Touch.seq` value, as the columns store them. */
export function mirrorOf(seq) {
	return {
		m8: ((seq * 37 - 3) << 24) >> 24,
		m16: ((seq * 7919 - 300) << 16) >> 16,
		mu16: (seq * 40503 + 65535) & 0xffff,
		mu32: (Math.imul(seq, 0x9e3779b1) ^ 0xffffffff) >>> 0,
	};
}

/** The `f32` mirror of one `Touch.seq` value, as the column stores it. */
export function mirrorF32Of(seq) {
	return Math.fround(seq * 0.1 - 0.7);
}

/** The values that the template and the spawn of an agent give to `Mix`: the
 * mirrors of a `seq` of zero, and the constants. */
export function mixDefaults(float) {
	const v = { ...mirrorOf(0), ...BORN };
	if (float) {
		v.mf32 = mirrorF32Of(0);
		v.bf32 = BORN_F32;
	}
	return v;
}
