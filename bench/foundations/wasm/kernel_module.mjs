/**
 * The kernel module the engine probe registers, emitted byte by byte.
 *
 * `emit.mjs` writes the binary, so this module needs no toolchain. What the
 * probe measures is then the claim "any module runs on the pool", and not the
 * claim "this compiler runs on the pool".
 *
 * The engine hands a `wasm` kernel one absolute byte offset for each declared
 * column, then `begin`, `end` and `dt`. Row `r` of a column sits at
 * `ptr + r * 4`, because every column here is `i32`. The kernel reads no
 * header, walks no descriptor and names no entity. It receives addresses, a
 * range and a step.
 *
 * `dt` is declared `i32`. The engine reads `dt` from an f64 control word and
 * passes the JavaScript number, so the declared parameter type decides the
 * conversion. An integer world needs an integer step, and the twin in
 * `engine-kernels.mjs` reads the same value.
 *
 * The module declares no global, no data segment and no table. So it owns no
 * byte of the memory it imports, which is the store of the world.
 */

import { ModuleBuilder, op } from "./emit.mjs";
import { MIX_ROUNDS } from "./engine-kernels.mjs";

/** The parameter slots the engine fills, in `parallel.columns` order. */
const PX = 0;
const PY = 1;
const VX = 2;
const VY = 3;
const BEGIN = 4;
const END = 5;
const DT = 6;

/** `pos += vel * dt` over four `i32` columns, addressed by byte offset. */
function integrateBody() {
	const I = 7;
	const OFF = 8;
	const ADDR = 9;
	// The address is computed once for each column, then used twice: as the
	// destination of the store and as the source of the load. `i32.store` takes
	// the address first, so the address is pushed before the value.
	const column = (posArg, velArg) => [
		op.get(posArg), op.get(OFF), op.add, op.set(ADDR),
		op.get(ADDR),
		op.get(ADDR), op.load_i32(0),
		op.get(velArg), op.get(OFF), op.add, op.load_i32(0),
		op.get(DT), op.mul,
		op.add,
		op.store_i32(0)
	];
	return [
		op.get(BEGIN), op.set(I),
		op.block([
			op.loop([
				op.get(I), op.get(END), op.ge_u, op.br_if(1),
				op.get(I), op.i32(4), op.mul, op.set(OFF),
				column(PX, VX),
				column(PY, VY),
				op.get(I), op.i32(1), op.add, op.set(I),
				op.br(0)
			])
		])
	];
}

/**
 * The heavy body: a hash mix with a branch, over the same four columns.
 *
 * The rounds are unrolled at emit time, because the emitter has no counted
 * loop helper and a nested loop here would add a compare the twin does not
 * run. The count comes from `engine-kernels.mjs`, so the two lanes cannot
 * drift apart.
 */
function mixBody() {
	const I = 7;
	const OFF = 8;
	const H = 9;
	const PXA = 10;
	const PYA = 11;
	const BX = 12;
	const BY = 13;
	const round = [
		op.get(H), op.i32(1103515245), op.mul, op.i32(12345), op.add, op.set(H),
		op.get(H), op.get(H), op.i32(15), op.shr_u, op.xor, op.set(H),
		op.get(H), op.i32(1023), op.and, op.i32(512), op.gt_u,
		op.if_(
			[op.get(H), op.i32(3), op.mul, op.get(BY), op.add, op.set(H)],
			[op.get(H), op.get(BX), op.xor, op.set(H)]
		)
	];
	return [
		op.get(BEGIN), op.set(I),
		op.block([
			op.loop([
				op.get(I), op.get(END), op.ge_u, op.br_if(1),
				op.get(I), op.i32(4), op.mul, op.set(OFF),
				op.get(PX), op.get(OFF), op.add, op.set(PXA),
				op.get(PY), op.get(OFF), op.add, op.set(PYA),
				op.get(VX), op.get(OFF), op.add, op.load_i32(0), op.set(BX),
				op.get(VY), op.get(OFF), op.add, op.load_i32(0), op.set(BY),
				op.get(PXA), op.load_i32(0),
				op.get(BX), op.get(DT), op.mul,
				op.add, op.set(H),
				...new Array(MIX_ROUNDS).fill(round),
				op.get(PXA), op.get(H), op.store_i32(0),
				op.get(PYA),
				op.get(PYA), op.load_i32(0),
				op.get(H), op.i32(255), op.and,
				op.add,
				op.store_i32(0),
				op.get(I), op.i32(1), op.add, op.set(I),
				op.br(0)
			])
		])
	];
}

/**
 * Emit the module. `maxPages` must be at least the maximum of the memory the
 * world holds, or the instantiation inside the worker fails. `minPages` must be
 * no larger than the memory's current size at that moment.
 */
export function emitKernelModule({ minPages = 1, maxPages }) {
	const m = new ModuleBuilder();
	m.importMemory("env", "memory", { minPages, maxPages, shared: true });
	m.addFunction({
		name: "integrate_i32",
		params: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		results: [],
		locals: ["i32", "i32", "i32"],
		body: integrateBody()
	});
	m.addFunction({
		name: "mix_i32",
		params: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		results: [],
		locals: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		body: mixBody()
	});
	return m.emit();
}
