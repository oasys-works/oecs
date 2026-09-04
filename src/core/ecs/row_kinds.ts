/***
 * Kind-split element writes, and the width-canonical view.
 *
 * A row operation on an archetype touches each column one time. The archetype
 * holds its columns in one array, and a loop of the form `bufs[i][row] = v` has
 * one access site. That site sees every element kind that any archetype in the
 * process gives it, because every archetype runs the same loop. V8 keeps one
 * access site fast for at most four typed-array kinds. At the fifth kind the
 * site becomes megamorphic, and each element access then costs many times
 * more. JavaScriptCore charges a smaller cost from the second kind. The cost is
 * per process, and not per archetype: a fifth kind in any archetype makes the
 * row operations of every archetype slow. The library offers eight column
 * types, so a real schema reaches five kinds easily.
 *
 * Two remedies, for two kinds of row operation:
 *
 * 1. A copy, a move, a swap or a zero fill moves bits and converts nothing. For
 *    those, `widthView` gives each column a second view of the same bytes whose
 *    class depends on the element width alone: `Uint8Array` for one byte,
 *    `Uint16Array` for two, `Uint32Array` for four, `Float64Array` for eight.
 *    Four widths give at most four classes, so the archetype's structural loops
 *    (over `_rowBufs`) never cross the line, and they keep their plain shape
 *    with no call inside.
 * 2. A write of a number must convert to the column's type (an `i32` truncates,
 *    an `f32` rounds), so it must go through the true view. `writeElem` gives
 *    each kind its own access site: one `switch` over the numeric type tag, one
 *    case for each kind. A case only ever sees typed arrays of its own kind, so
 *    each site stays monomorphic. A template avoids the conversion at spawn
 *    time altogether: `toWidthBits` converts its defaults one time into the
 *    stored representation, and the append then takes remedy 1.
 *
 * The eight cases are copies of one statement with one type name changed, and
 * they must stay copies. A shared body reached from a helper would give the
 * kinds one site again, because V8 keys its feedback on the source position of
 * the access and not on the caller. The `as` cast in each case is erased. It
 * documents which kind that site sees. `f64` is first in each `switch`: it is
 * the default column type and the most common kind.
 ***/

import type { AnyTypedArray } from "../../type_primitives";
import { TYPE_TAG } from "../store/descriptor";

// Local copies of the tags. A `case` that reads an imported binding is not a
// constant to the optimizer, so the `switch` would be a chain of loads and
// compares. A local constant gives a jump table. Measured on the accessor keys
// (ref.ts), and the same rule.
const F64 = TYPE_TAG.f64;
const F32 = TYPE_TAG.f32;
const I32 = TYPE_TAG.i32;
const U32 = TYPE_TAG.u32;
const I16 = TYPE_TAG.i16;
const U16 = TYPE_TAG.u16;
const I8 = TYPE_TAG.i8;
const U8 = TYPE_TAG.u8;

/** A view of `buf`'s bytes whose class depends on the element width alone. The
 * unsigned class of each width, and `Float64Array` for eight bytes. A column
 * that already has that class is returned as is. The view has an explicit
 * length, so it is a fixed-length view on every backing. */
export function widthView(kind: number, buf: AnyTypedArray): AnyTypedArray {
	switch (kind) {
		case I8:
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
		case I16:
			return new Uint16Array(buf.buffer, buf.byteOffset, buf.length);
		case I32:
		case F32:
			return new Uint32Array(buf.buffer, buf.byteOffset, buf.length);
		default:
			return buf;
	}
}

// One scratch pair for the f32 bit pattern: a store through the Float32Array
// rounds, and the read through the Uint32Array gives the bits.
const F32_SCRATCH = new Float32Array(1);
const F32_BITS = new Uint32Array(F32_SCRATCH.buffer);

/** The stored representation of `v` in a column of kind `kind`, as the
 * width-canonical view of that column (`widthView`) reads it back. A store of
 * the result through that view leaves the same bytes as a store of `v` through
 * the true view: the integer kinds keep the low bits of `ToInt32(v)`, which is
 * what each typed array keeps. `f32` rounds through a scratch `Float32Array`
 * `f64` is itself. */
export function toWidthBits(kind: number, v: number): number {
	switch (kind) {
		case F64:
			return v;
		case F32:
			F32_SCRATCH[0] = v;
			return F32_BITS[0];
		case I32:
		case U32:
			return v >>> 0;
		case I16:
		case U16:
			return v & 0xffff;
		default:
			return v & 0xff;
	}
}

/** Read one element through the access site of the column's class, found from
 * the column itself. For the mixed-type accessor in ref.ts, which knows the
 * column but not its tag. */
export function readElemOf(buf: AnyTypedArray, row: number): number {
	switch (buf.constructor) {
		case Float64Array:
			return (buf as Float64Array)[row];
		case Float32Array:
			return (buf as Float32Array)[row];
		case Int32Array:
			return (buf as Int32Array)[row];
		case Uint32Array:
			return (buf as Uint32Array)[row];
		case Int16Array:
			return (buf as Int16Array)[row];
		case Uint16Array:
			return (buf as Uint16Array)[row];
		case Int8Array:
			return (buf as Int8Array)[row];
		default:
			return (buf as Uint8Array)[row];
	}
}

/** The pair of `readElemOf`. */
export function writeElemOf(buf: AnyTypedArray, row: number, v: number): void {
	switch (buf.constructor) {
		case Float64Array:
			(buf as Float64Array)[row] = v;
			return;
		case Float32Array:
			(buf as Float32Array)[row] = v;
			return;
		case Int32Array:
			(buf as Int32Array)[row] = v;
			return;
		case Uint32Array:
			(buf as Uint32Array)[row] = v;
			return;
		case Int16Array:
			(buf as Int16Array)[row] = v;
			return;
		case Uint16Array:
			(buf as Uint16Array)[row] = v;
			return;
		case Int8Array:
			(buf as Int8Array)[row] = v;
			return;
		default:
			(buf as Uint8Array)[row] = v;
			return;
	}
}

/** Write one element through the access site of its kind. For the per-field
 * paths (`writeFields`, `writeFlatElem`), where the column is known one at a
 * time. */
export function writeElem(kind: number, buf: AnyTypedArray, row: number, v: number): void {
	switch (kind) {
		case F64:
			(buf as Float64Array)[row] = v;
			return;
		case F32:
			(buf as Float32Array)[row] = v;
			return;
		case I32:
			(buf as Int32Array)[row] = v;
			return;
		case U32:
			(buf as Uint32Array)[row] = v;
			return;
		case I16:
			(buf as Int16Array)[row] = v;
			return;
		case U16:
			(buf as Uint16Array)[row] = v;
			return;
		case I8:
			(buf as Int8Array)[row] = v;
			return;
		case U8:
			(buf as Uint8Array)[row] = v;
			return;
	}
}
