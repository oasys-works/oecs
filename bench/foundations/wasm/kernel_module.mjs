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
 * The module carries the four bodies the fixture set carries, and the last two
 * own bytes of the memory:
 *
 *   - `integrate_i32` and `mix_i32` declare no global and no data, so they own
 *     nothing at all,
 *   - `stack_i32` pushes a frame below `__stack_pointer`, which is the rule a
 *     compiled module follows, written by hand,
 *   - `table_i32` reads a constant table the module writes at instantiation.
 *
 * So the module declares `__heap_base` and `__stack_pointer` the way a linker
 * would, and everything it owns sits below `__heap_base`. A store based above
 * that address never overlaps it.
 */

import { ModuleBuilder, op } from "./emit.mjs";
import { MIX_ROUNDS, SLOTS, TABLE } from "./engine-kernels.mjs";

/** Where the constant table lands. Off address 0, because a safe build of a
 * compiled toolchain cannot read that address and the layout mirrors one. */
export const TABLE_BASE = 1024;
/** The module's own stack, the span the linked `__stack_pointer` grows down
 * through. It clears the table and it ends on a page boundary. */
export const STACK_TOP = 131_072;
/** Everything the module owns sits below this address. */
export const HEAP_BASE = STACK_TOP;
/** Bytes one call of `stack_i32` pushes: one slot for each scratch entry. */
const FRAME_BYTES = SLOTS * 4;

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
 * A body that pushes a frame, so the shadow-stack rule has a hand-written case.
 *
 * The prologue moves `__stack_pointer` down by one frame and the epilogue puts
 * it back, which is what a compiler emits. The scratch the frame holds is
 * gathered from with an index the scratch itself decides, so no reader folds
 * the array away and the twin in `engine-kernels.mjs` computes the same value.
 *
 * Two instances over one memory with one stack pointer write the same frame.
 * That is the corruption the pool removes by giving each worker a region.
 *
 * `sp` is the global index of `__stack_pointer`.
 */
function stackBody(sp) {
	const I = 7;
	const OFF = 8;
	const H = 9;
	const ACC = 10;
	const K = 11;
	const BY = 12;
	const FRAME = 13;
	const TMP = 14;
	const fill = [
		op.block([
			op.loop([
				op.get(K), op.i32(SLOTS), op.ge_u, op.br_if(1),
				op.get(FRAME), op.get(K), op.i32(4), op.mul, op.add,
				op.get(H), op.i32(1103515245), op.mul, op.i32(12345), op.add, op.tee(H),
				op.store_i32(0),
				op.get(K), op.i32(1), op.add, op.set(K),
				op.br(0)
			])
		])
	];
	const gather = [
		op.block([
			op.loop([
				op.get(K), op.i32(SLOTS), op.ge_u, op.br_if(1),
				op.get(FRAME), op.get(K), op.i32(4), op.mul, op.add, op.load_i32(0),
				op.get(BY), op.xor, op.i32(SLOTS - 1), op.and, op.set(TMP),
				op.get(ACC),
				op.get(FRAME), op.get(TMP), op.i32(4), op.mul, op.add, op.load_i32(0),
				op.add, op.set(ACC),
				op.get(K), op.i32(1), op.add, op.set(K),
				op.br(0)
			])
		])
	];
	return [
		op.global_get(sp), op.i32(FRAME_BYTES), op.sub, op.tee(FRAME), op.global_set(sp),
		op.get(BEGIN), op.set(I),
		op.block([
			op.loop([
				op.get(I), op.get(END), op.ge_u, op.br_if(1),
				op.get(I), op.i32(4), op.mul, op.set(OFF),
				op.get(VY), op.get(OFF), op.add, op.load_i32(0), op.set(BY),
				op.get(PX), op.get(OFF), op.add, op.load_i32(0),
				op.get(VX), op.get(OFF), op.add, op.load_i32(0),
				op.get(DT), op.mul, op.add, op.set(H),
				op.i32(0), op.set(K),
				fill,
				op.i32(0), op.set(ACC),
				op.i32(0), op.set(K),
				gather,
				op.get(PX), op.get(OFF), op.add, op.get(ACC), op.store_i32(0),
				op.get(PY), op.get(OFF), op.add,
				op.get(PY), op.get(OFF), op.add, op.load_i32(0),
				op.get(ACC), op.i32(255), op.and, op.add,
				op.store_i32(0),
				op.get(I), op.i32(1), op.add, op.set(I),
				op.br(0)
			])
		]),
		op.get(FRAME), op.i32(FRAME_BYTES), op.add, op.global_set(sp)
	];
}

/** A body that reads the module's own data segment, one slot for each row. */
function tableBody() {
	const I = 7;
	const OFF = 8;
	const H = 9;
	const BY = 10;
	return [
		op.get(BEGIN), op.set(I),
		op.block([
			op.loop([
				op.get(I), op.get(END), op.ge_u, op.br_if(1),
				op.get(I), op.i32(4), op.mul, op.set(OFF),
				op.get(VY), op.get(OFF), op.add, op.load_i32(0), op.set(BY),
				op.get(PX), op.get(OFF), op.add, op.load_i32(0),
				op.get(VX), op.get(OFF), op.add, op.load_i32(0),
				op.get(DT), op.mul, op.add, op.set(H),
				op.get(H),
				op.get(H), op.get(BY), op.xor, op.i32(SLOTS - 1), op.and,
				op.i32(4), op.mul, op.i32(TABLE_BASE), op.add, op.load_i32(0),
				op.add, op.set(H),
				op.get(PX), op.get(OFF), op.add, op.get(H), op.store_i32(0),
				op.get(PY), op.get(OFF), op.add,
				op.get(PY), op.get(OFF), op.add, op.load_i32(0),
				op.get(H), op.i32(255), op.and, op.add,
				op.store_i32(0),
				op.get(I), op.i32(1), op.add, op.set(I),
				op.br(0)
			])
		])
	];
}

/** The constant table, as the bytes the data segment carries. */
function tableBytes() {
	const out = new Uint8Array(SLOTS * 4);
	const view = new DataView(out.buffer);
	for (let k = 0; k < SLOTS; k++) view.setInt32(k * 4, TABLE[k], true);
	return [...out];
}

const KERNEL_PARAMS = ["i32", "i32", "i32", "i32", "i32", "i32", "i32"];

/**
 * Emit the module. `maxPages` must be at least the maximum of the memory the
 * world holds, or the instantiation inside the worker fails. `minPages` must be
 * no larger than the memory's current size at that moment.
 */
export function emitKernelModule({ minPages = 1, maxPages }) {
	const m = new ModuleBuilder();
	m.importMemory("env", "memory", { minPages, maxPages, shared: true });
	// The order matters: `__stack_pointer` is global 0, and `stackBody` names it.
	const sp = m.addGlobal({ name: "__stack_pointer", init: STACK_TOP, mutable: true });
	m.addGlobal({ name: "__heap_base", init: HEAP_BASE });
	m.addData({ offset: TABLE_BASE, bytes: tableBytes() });
	m.addFunction({
		name: "integrate_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32"],
		body: integrateBody()
	});
	m.addFunction({
		name: "mix_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		body: mixBody()
	});
	m.addFunction({
		name: "stack_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		body: stackBody(sp)
	});
	m.addFunction({
		name: "table_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32", "i32"],
		body: tableBody()
	});
	return m.emit();
}

/**
 * Five modules the pool must refuse, one fault each.
 *
 * A negative fixture has to be a real module, and none of these can be built by
 * a toolchain that follows the contract. The emitter writes them because it
 * follows no contract.
 *
 *   - `badImport` asks the host for a function as well as the memory,
 *   - `noMemory` defines a memory of its own, so it never addresses the store,
 *   - `badArity` exports a kernel that takes one parameter too few,
 *   - `frozenStack` exports an immutable `__stack_pointer`, which no host moves,
 *   - `noHeapBase` exports a stack pointer and no address the regions can start
 *     from.
 */
export function emitRefusedModules({ minPages = 1, maxPages }) {
	const badImport = new ModuleBuilder();
	badImport.importFunction("env", "log", { params: ["i32"], results: [] });
	badImport.importMemory("env", "memory", { minPages, maxPages, shared: true });
	badImport.addFunction({
		name: "integrate_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32"],
		body: integrateBody()
	});

	const noMemory = new ModuleBuilder();
	noMemory.defineMemory({ minPages: 1, maxPages, shared: true });
	noMemory.addFunction({
		name: "integrate_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32"],
		body: integrateBody()
	});

	const badArity = new ModuleBuilder();
	badArity.importMemory("env", "memory", { minPages, maxPages, shared: true });
	// Six parameters, and the system that names it declares four columns, so the
	// worker wants seven. The body writes nothing, because it never runs.
	badArity.addFunction({
		name: "integrate_i32",
		params: ["i32", "i32", "i32", "i32", "i32", "i32"],
		results: [],
		locals: [],
		body: []
	});

	// A body that wrote an immutable global would not validate, so this one uses
	// no global at all. The fault is the export the pool cannot move.
	const frozenStack = new ModuleBuilder();
	frozenStack.importMemory("env", "memory", { minPages, maxPages, shared: true });
	frozenStack.addGlobal({ name: "__stack_pointer", init: STACK_TOP });
	frozenStack.addGlobal({ name: "__heap_base", init: HEAP_BASE });
	frozenStack.addFunction({
		name: "integrate_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32"],
		body: integrateBody()
	});

	const noHeapBase = new ModuleBuilder();
	noHeapBase.importMemory("env", "memory", { minPages, maxPages, shared: true });
	const looseSp = noHeapBase.addGlobal({ name: "__stack_pointer", init: STACK_TOP, mutable: true });
	noHeapBase.addFunction({
		name: "stack_i32",
		params: KERNEL_PARAMS,
		results: [],
		locals: ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"],
		body: stackBody(looseSp)
	});

	return {
		badImport: badImport.emit(),
		noMemory: noMemory.emit(),
		badArity: badArity.emit(),
		frozenStack: frozenStack.emit(),
		noHeapBase: noHeapBase.emit()
	};
}
