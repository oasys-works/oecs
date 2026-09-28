/**
 * An array-of-structs store, written as a third-party plugin. It imports the
 * root entry only. `integration/third_party_storage.test.ts` drives it.
 */

import {
	accessDomain,
	type AccessDomain,
	type EntityID,
	type Plugin,
	type PluginHost,
	type StorageHashFold,
	type StorageProvider,
	getEntityIndex
} from "../../../../index";

/** No owner in a slot. An entity id is never negative. */
const NONE = -1;

/** One array-of-structs store. Records are keyed by entity index, and each
 * slot remembers the full id of its owner, so a recycled index never reads a
 * dead owner's record. */
export class AosStore implements StorageProvider {
	public readonly domain: AccessDomain;
	/** Field name to its offset inside a record. */
	private readonly _offset: Map<string, number>;
	private readonly _stride: number;
	private _owner: Int32Array = new Int32Array(0).fill(NONE);
	private _data: Int32Array = new Int32Array(0);
	private _size = 0;
	/** How many times the core called `purge`. A test reads it. */
	public purged = 0;

	constructor(
		public readonly name: string,
		public readonly fields: readonly string[]
	) {
		this.domain = accessDomain(name);
		this._stride = fields.length;
		this._offset = new Map(fields.map((f, i) => [f, i]));
	}

	public get size(): number {
		return this._size;
	}

	/** Membership. Unchecked, the way `hasComponent` is. */
	public has(e: EntityID): boolean {
		const idx = getEntityIndex(e);
		return idx < this._owner.length && this._owner[idx] === (e as number);
	}

	public add(e: EntityID, values: Readonly<Record<string, number>>): void {
		this.domain.assertWrite();
		const idx = getEntityIndex(e);
		this._reserve(idx + 1);
		if (this._owner[idx] !== (e as number)) {
			this._owner[idx] = e as number;
			this._size++;
		}
		const base = idx * this._stride;
		for (let f = 0; f < this.fields.length; f++) {
			this._data[base + f] = values[this.fields[f]] ?? 0;
		}
	}

	public remove(e: EntityID): void {
		this.domain.assertWrite();
		if (this._drop(e)) return;
		throw new Error(`aos '${this.name}': entity ${e as number} holds no record`);
	}

	public get(e: EntityID, field: string): number {
		this.domain.assertRead();
		return this._data[this._slot(e) * this._stride + this._field(field)];
	}

	public set(e: EntityID, field: string, value: number): void {
		this.domain.assertWrite();
		this._data[this._slot(e) * this._stride + this._field(field)] = value;
	}

	/** Every member, ascending by entity index. */
	public members(): EntityID[] {
		const out: EntityID[] = [];
		for (let i = 0; i < this._owner.length; i++) {
			if (this._owner[i] !== NONE) out.push(this._owner[i] as EntityID);
		}
		return out;
	}

	// ── StorageProvider ─────────────────────────────────────────────────

	public purge(e: EntityID): void {
		this.purged++;
		this._drop(e);
	}

	/** Canonical: ascending entity index, whatever order the adds came in. */
	public hash(fold: StorageHashFold): void {
		fold(this._size);
		for (let i = 0; i < this._owner.length; i++) {
			if (this._owner[i] === NONE) continue;
			fold(i);
			fold(this._owner[i]);
			const base = i * this._stride;
			for (let f = 0; f < this._stride; f++) fold(this._data[base + f]);
		}
	}

	/** `[u32 stride][u32 count]` then per member `[i32 owner][i32 x stride]`,
	 * ascending by entity index. */
	public capture(): Uint8Array {
		const words = 2 + this._size * (1 + this._stride);
		const out = new Int32Array(words);
		out[0] = this._stride;
		out[1] = this._size;
		let at = 2;
		for (let i = 0; i < this._owner.length; i++) {
			if (this._owner[i] === NONE) continue;
			out[at++] = this._owner[i];
			const base = i * this._stride;
			for (let f = 0; f < this._stride; f++) out[at++] = this._data[base + f];
		}
		return new Uint8Array(out.buffer);
	}

	public validate(bytes: Uint8Array): void {
		if (bytes.byteLength < 8 || bytes.byteLength % 4 !== 0) {
			throw new Error(`aos '${this.name}': a section of ${bytes.byteLength} bytes is malformed`);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const stride = view.getInt32(0, true);
		const count = view.getInt32(4, true);
		if (stride !== this._stride) {
			throw new Error(
				`aos '${this.name}': the section holds ${stride} fields, the store ${this._stride}`
			);
		}
		if (bytes.byteLength !== 8 + count * (1 + stride) * 4) {
			throw new Error(`aos '${this.name}': the section length does not match its count`);
		}
	}

	public restore(bytes: Uint8Array): void {
		const words = new Int32Array(bytes.slice().buffer);
		const count = words[1];
		this._owner.fill(NONE);
		this._data.fill(0);
		this._size = 0;
		let at = 2;
		for (let m = 0; m < count; m++) {
			const owner = words[at++];
			const idx = getEntityIndex(owner as EntityID);
			this._reserve(idx + 1);
			this._owner[idx] = owner;
			this._size++;
			const base = idx * this._stride;
			for (let f = 0; f < this._stride; f++) this._data[base + f] = words[at++];
		}
	}

	// ── internals ───────────────────────────────────────────────────────

	private _drop(e: EntityID): boolean {
		const idx = getEntityIndex(e);
		if (idx >= this._owner.length || this._owner[idx] !== (e as number)) return false;
		this._owner[idx] = NONE;
		this._data.fill(0, idx * this._stride, (idx + 1) * this._stride);
		this._size--;
		return true;
	}

	private _slot(e: EntityID): number {
		if (!this.has(e)) throw new Error(`aos '${this.name}': entity ${e as number} holds no record`);
		return getEntityIndex(e);
	}

	private _field(field: string): number {
		const f = this._offset.get(field);
		if (f === undefined) throw new Error(`aos '${this.name}': no field '${field}'`);
		return f;
	}

	private _reserve(slots: number): void {
		if (slots <= this._owner.length) return;
		const cap = Math.max(slots, this._owner.length * 2, 16);
		const owner = new Int32Array(cap).fill(NONE);
		owner.set(this._owner);
		const data = new Int32Array(cap * this._stride);
		data.set(this._data);
		this._owner = owner;
		this._data = data;
	}
}

/** The surface the world gains. */
export interface AosPlugin {
	readonly aos: {
		/** Make a store and take it into the core's paths. Callable after
		 * construction, because a store needs no component to exist. */
		define(name: string, fields: readonly string[]): AosStore;
	};
}

/** The plugin, for `ECS.create({ plugins: [aos()] })`. */
export function aos(): Plugin<AosPlugin> {
	return {
		name: "aos",
		install(host: PluginHost): AosPlugin {
			return {
				aos: {
					define(name: string, fields: readonly string[]): AosStore {
						const store = new AosStore(name, fields);
						host.registerStorage(store);
						return store;
					}
				}
			};
		}
	};
}
