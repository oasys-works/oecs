/**
 * A minimal WebAssembly binary emitter, written for one purpose: to prove that
 * a module from no toolchain at all can read the store of oecs.
 *
 * A toolchain-built module proves that one toolchain agrees with the layout.
 * A module emitted here depends on nothing but the specification, so it tests
 * the claim "any module" instead of the claim "this compiler".
 *
 * The emitter covers the subset the probes need: one imported or one defined
 * memory, a type section, a function section, an export section and a code
 * section. It has no tables, no globals, no data segments and no validation.
 * An invalid instruction sequence fails at `WebAssembly.compile`, and the
 * message names the function index.
 */

const TYPE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

/** LEB128, unsigned. The length prefix of every section and every index. */
export function uleb(n) {
	const out = [];
	let v = n >>> 0;
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v !== 0) b |= 0x80;
		out.push(b);
	} while (v !== 0);
	return out;
}

/** LEB128, signed. `i32.const` carries this form, so a negative constant needs it. */
export function sleb(n) {
	const out = [];
	let v = n | 0;
	for (;;) {
		const b = v & 0x7f;
		v >>= 7;
		const signBit = (b & 0x40) !== 0;
		if ((v === 0 && !signBit) || (v === -1 && signBit)) {
			out.push(b);
			return out;
		}
		out.push(b | 0x80);
	}
}

function str(s) {
	const bytes = [...new TextEncoder().encode(s)];
	return [...uleb(bytes.length), ...bytes];
}

function vec(items) {
	return [...uleb(items.length), ...items.flat(Infinity)];
}

function section(id, payload) {
	const body = payload.flat(Infinity);
	return [id, ...uleb(body.length), ...body];
}

const f32Bytes = (x) => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setFloat32(0, x, true);
	return [...b];
};

/**
 * The instruction set the probes use. Each helper returns bytes, and a body is
 * a nested array that `addFunction` flattens. `align` is the log2 of the
 * alignment, so a naturally aligned i32 access passes 2.
 */
export const op = {
	i32: (n) => [0x41, ...sleb(n)],
	f32: (x) => [0x43, ...f32Bytes(x)],
	get: (i) => [0x20, ...uleb(i)],
	set: (i) => [0x21, ...uleb(i)],
	tee: (i) => [0x22, ...uleb(i)],
	drop: [0x1a],

	load_i32: (off = 0, align = 2) => [0x28, align, ...uleb(off)],
	load8_u: (off = 0) => [0x2d, 0, ...uleb(off)],
	load16_u: (off = 0) => [0x2f, 1, ...uleb(off)],
	load_f32: (off = 0, align = 2) => [0x2a, align, ...uleb(off)],
	store_i32: (off = 0, align = 2) => [0x36, align, ...uleb(off)],
	store_f32: (off = 0, align = 2) => [0x38, align, ...uleb(off)],

	add: [0x6a],
	sub: [0x6b],
	mul: [0x6c],
	and: [0x71],
	or: [0x72],
	xor: [0x73],
	shl: [0x74],
	shr_u: [0x76],
	eq: [0x46],
	ne: [0x47],
	lt_u: [0x49],
	gt_u: [0x4b],
	ge_u: [0x4f],
	eqz: [0x45],

	f32_add: [0x92],
	f32_mul: [0x94],

	block: (body) => [0x02, 0x40, ...body.flat(Infinity), 0x0b],
	loop: (body) => [0x03, 0x40, ...body.flat(Infinity), 0x0b],
	if_: (then, else_) =>
		else_ === undefined
			? [0x04, 0x40, ...then.flat(Infinity), 0x0b]
			: [0x04, 0x40, ...then.flat(Infinity), 0x05, ...else_.flat(Infinity), 0x0b],
	br: (depth) => [0x0c, ...uleb(depth)],
	br_if: (depth) => [0x0d, ...uleb(depth)],
	ret: [0x0f],

	memory_size: [0x3f, 0x00],
	memory_grow: [0x40, 0x00]
};

export class ModuleBuilder {
	constructor() {
		this._types = [];
		this._imports = [];
		this._funcs = [];
		this._exports = [];
		this._memory = null;
		this._importedFuncCount = 0;
	}

	/** Take the memory from the host. The store of oecs is the host memory. */
	importMemory(module, name, { minPages, maxPages, shared = true }) {
		// A shared memory must declare a maximum, so the limits flag is 0x03.
		const limits = shared ? [0x03, ...uleb(minPages), ...uleb(maxPages)] : [0x01, ...uleb(minPages), ...uleb(maxPages)];
		this._imports.push([...str(module), ...str(name), 0x02, ...limits]);
		return this;
	}

	/** Define the memory inside the module. The host then reads it back. */
	defineMemory({ minPages, maxPages, shared = true }) {
		this._memory = shared
			? [0x03, ...uleb(minPages), ...uleb(maxPages)]
			: [0x01, ...uleb(minPages), ...uleb(maxPages)];
		return this;
	}

	exportMemory(name) {
		this._exports.push([...str(name), 0x02, ...uleb(0)]);
		return this;
	}

	addFunction({ name, params = [], results = [], locals = [], body }) {
		const typeIdx = this._typeIndex(params, results);
		const index = this._importedFuncCount + this._funcs.length;
		// Locals are declared as runs of one type. The probes use few locals, so
		// one run per local keeps the encoder simple and the cost is a byte each.
		const localDecls = vec(locals.map((t) => [1, TYPE[t]]));
		const code = [...localDecls, ...body.flat(Infinity), 0x0b];
		this._funcs.push({ typeIdx, code });
		if (name) this._exports.push([...str(name), 0x00, ...uleb(index)]);
		return index;
	}

	_typeIndex(params, results) {
		const sig = [0x60, ...vec(params.map((p) => [TYPE[p]])), ...vec(results.map((r) => [TYPE[r]]))];
		const key = sig.join(",");
		for (let i = 0; i < this._types.length; i++) if (this._types[i].key === key) return i;
		this._types.push({ key, sig });
		return this._types.length - 1;
	}

	emit() {
		const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
		out.push(...section(1, [vec(this._types.map((t) => t.sig))]));
		if (this._imports.length > 0) out.push(...section(2, [vec(this._imports)]));
		out.push(...section(3, [vec(this._funcs.map((f) => uleb(f.typeIdx)))]));
		if (this._memory !== null) out.push(...section(5, [vec([this._memory])]));
		if (this._exports.length > 0) out.push(...section(7, [vec(this._exports)]));
		out.push(...section(10, [vec(this._funcs.map((f) => [...uleb(f.code.length), ...f.code]))]));
		return new Uint8Array(out);
	}
}
