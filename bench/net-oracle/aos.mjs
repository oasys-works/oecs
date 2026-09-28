/**
 * An array-of-structs store, written as a third-party plugin. The seam is
 * under test, not this file.
 *
 * It uses the root exports of the built module only.
 *
 * A record is `[owner, f0, f1, ...]` at `index * (1 + fields)`. The owner is
 * the full entity id, so a recycled index never reads a dead owner's record.
 *
 * `fixtures/aos_plugin.ts` is an independent TypeScript store of the same shape.
 */

const EMPTY = -1;

export class AosStore {
	/**
	 * @param lib the built module
	 * @param name the store's name, which keys its snapshot section
	 * @param fields the field names, one `i32` each
	 */
	constructor(lib, name, fields) {
		this._index = lib.getEntityIndex;
		this.name = name;
		this.fields = fields;
		this.domain = lib.accessDomain(name);
		this._width = 1 + fields.length;
		this._at = new Map(fields.map((f, i) => [f, 1 + i]));
		this._rec = new Int32Array(0);
		this._slots = 0;
		this.size = 0;
		// Counters for the floors. A record the purge dropped, a record the
		// plugin removed by its own call.
		this.purgedRecords = 0;
		this.removed = 0;
	}

	has(e) {
		const i = this._index(e);
		return i < this._slots && this._rec[i * this._width] === e;
	}

	add(e, values) {
		this.domain.assertWrite();
		const i = this._index(e);
		this._grow(i + 1);
		const base = i * this._width;
		if (this._rec[base] !== e) {
			this._rec[base] = e;
			this.size++;
		}
		for (let f = 0; f < this.fields.length; f++)
			this._rec[base + 1 + f] = values[this.fields[f]] | 0;
	}

	remove(e) {
		this.domain.assertWrite();
		if (!this._drop(e)) throw new Error(`aos ${this.name}: remove(${e}), which holds no record`);
		this.removed++;
	}

	get(e, field) {
		this.domain.assertRead();
		return this._rec[this._base(e) + this._field(field)];
	}

	set(e, field, value) {
		this.domain.assertWrite();
		this._rec[this._base(e) + this._field(field)] = value;
	}

	/** Every member, ascending by index. */
	members() {
		const out = [];
		for (let i = 0; i < this._slots; i++) {
			const owner = this._rec[i * this._width];
			if (owner !== EMPTY) out.push(owner);
		}
		return out;
	}

	// ── the storage seam ───────────────────────────────────────────────────

	purge(e) {
		if (this._drop(e)) this.purgedRecords++;
	}

	hash(fold) {
		fold(this.size);
		for (let i = 0; i < this._slots; i++) {
			const base = i * this._width;
			if (this._rec[base] === EMPTY) continue;
			for (let k = 0; k < this._width; k++) fold(this._rec[base + k]);
		}
	}

	/** `[width][count]`, then the members' records in ascending index. */
	capture() {
		const out = new Int32Array(2 + this.size * this._width);
		out[0] = this._width;
		out[1] = this.size;
		let at = 2;
		for (let i = 0; i < this._slots; i++) {
			const base = i * this._width;
			if (this._rec[base] === EMPTY) continue;
			out.set(this._rec.subarray(base, base + this._width), at);
			at += this._width;
		}
		return new Uint8Array(out.buffer);
	}

	validate(bytes) {
		if (bytes.byteLength < 8 || bytes.byteLength % 4 !== 0) {
			throw new Error(`aos ${this.name}: a section of ${bytes.byteLength} bytes`);
		}
		const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const width = v.getInt32(0, true);
		const count = v.getInt32(4, true);
		if (width !== this._width) {
			throw new Error(
				`aos ${this.name}: records of width ${width}, the store's are ${this._width}`
			);
		}
		if (bytes.byteLength !== 8 + count * width * 4) {
			throw new Error(`aos ${this.name}: ${count} records do not fill ${bytes.byteLength} bytes`);
		}
	}

	restore(bytes) {
		const words = new Int32Array(bytes.slice().buffer);
		this._rec.fill(EMPTY);
		this.size = 0;
		const count = words[1];
		let at = 2;
		for (let m = 0; m < count; m++) {
			const owner = words[at];
			const i = this._index(owner);
			this._grow(i + 1);
			this._rec.set(words.subarray(at, at + this._width), i * this._width);
			this.size++;
			at += this._width;
		}
	}

	// ── internals ──────────────────────────────────────────────────────────

	_drop(e) {
		const i = this._index(e);
		if (i >= this._slots) return false;
		const base = i * this._width;
		if (this._rec[base] !== e) return false;
		this._rec.fill(EMPTY, base, base + this._width);
		this.size--;
		return true;
	}

	_base(e) {
		if (!this.has(e)) throw new Error(`aos ${this.name}: entity ${e} holds no record`);
		return this._index(e) * this._width;
	}

	_field(field) {
		const f = this._at.get(field);
		if (f === undefined) throw new Error(`aos ${this.name}: no field ${field}`);
		return f;
	}

	_grow(slots) {
		if (slots <= this._slots) return;
		let n = Math.max(this._slots, 64);
		while (n < slots) n *= 2;
		const rec = new Int32Array(n * this._width).fill(EMPTY);
		rec.set(this._rec);
		this._rec = rec;
		this._slots = n;
	}
}

/**
 * The plugin, for `ECS.create({ plugins: [aos(lib)()] })`. It adds
 * `world.aos.define(name, fields)`, which makes a store and hands it to the
 * core through `host.registerStorage`.
 */
export function aos(lib) {
	return () => ({
		name: "aos",
		install(host) {
			return {
				aos: {
					define(name, fields) {
						const store = new AosStore(lib, name, fields);
						host.registerStorage(store);
						return store;
					}
				}
			};
		}
	});
}
