/***
 * BitSet — number[]-backed bit set with auto-grow.
 *
 * Used as the archetype component signature. Each bit position corresponds
 * to a ComponentID. Operations (has/set/clear) are O(1), and mask
 * comparisons (contains, equals, overlaps) are O(words) where
 * words = ceil(maxComponentId / 32).
 *
 * Bit layout within each 32-bit word:
 *   wordIndex = bit >>> BITS_PER_WORD_SHIFT   (divide by 32)
 *   bit_offset = bit & BITS_PER_WORD_MASK      (mod 32)
 *   test:  word & (1 << offset)
 *   set:   word |= (1 << offset)
 *   clear: word &= ~(1 << offset)
 *
 ***/

// Bit-manipulation constants for 32-bit word operations
export const BITS_PER_WORD = 32;
export const BITS_PER_WORD_SHIFT = 5; // log2(32)
export const BITS_PER_WORD_MASK = 31; // 32 - 1

// FNV-1a hash constants
export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

const INITIAL_WORD_COUNT = 4; // 128 component IDs before first grow

/**
 * number[]-backed bit set with auto-grow. Used as the archetype component signature.
 *
 */
export class BitSet {
	public _words: number[];

	constructor(words?: number[]) {
		this._words = words ?? new Array(INITIAL_WORD_COUNT).fill(0);
	}

	public has(bit: number): boolean {
		const wordIndex = bit >>> BITS_PER_WORD_SHIFT;
		if (wordIndex >= this._words.length) return false;
		return (this._words[wordIndex] & (1 << (bit & BITS_PER_WORD_MASK))) !== 0;
	}

	public set(bit: number): void {
		const wordIndex = bit >>> BITS_PER_WORD_SHIFT;
		if (wordIndex >= this._words.length) this.grow(wordIndex + 1);
		this._words[wordIndex] |= 1 << (bit & BITS_PER_WORD_MASK);
	}

	public clear(bit: number): void {
		const wordIndex = bit >>> BITS_PER_WORD_SHIFT;
		if (wordIndex >= this._words.length) return;
		this._words[wordIndex] &= ~(1 << (bit & BITS_PER_WORD_MASK));
	}

	/** True if no bit is set. */
	public isEmpty(): boolean {
		const w = this._words;
		for (let i = 0; i < w.length; i++) {
			if (w[i] !== 0) return false;
		}
		return true;
	}

	/** True if any bit is set in both this and other (non-empty intersection). */
	public overlaps(other: BitSet): boolean {
		const a = this._words,
			b = other._words;
		const len = a.length < b.length ? a.length : b.length;
		for (let i = 0; i < len; i++) {
			if ((a[i] & b[i]) !== 0) return true;
		}
		return false;
	}

	/** True if this is a superset of other (all bits in other are set in this). */
	public contains(other: BitSet): boolean {
		const otherWords = other._words;
		const thisWords = this._words;
		const thisLen = thisWords.length;

		for (let i = 0; i < otherWords.length; i++) {
			const o = otherWords[i];
			if (o === 0) continue;
			if (i >= thisLen) return false;
			// (this & other) must equal other for every word
			if ((thisWords[i] & o) !== o) return false;
		}
		return true;
	}

	public equals(other: BitSet): boolean {
		const a = this._words;
		const b = other._words;
		const max = a.length > b.length ? a.length : b.length;

		for (let i = 0; i < max; i++) {
			const va = i < a.length ? a[i] : 0;
			const vb = i < b.length ? b[i] : 0;
			if (va !== vb) return false;
		}
		return true;
	}

	public copy(): BitSet {
		return new BitSet(this._words.slice());
	}

	/** Mutate `target` so it has the same set bits as `this`. Reuses
	 * `target._words` storage when capacity allows (no allocation) and
	 * grows it only when `this` is wider. Designed for hot-path scratch
	 * BitSets where callers want `.copy()` semantics without the
	 * per-call allocation. Returns `target` for chaining. */
	public copyInto(target: BitSet): BitSet {
		const src = this._words;
		const dst = target._words;
		const srcLen = src.length;
		const dstLen = dst.length;
		if (dstLen >= srcLen) {
			for (let i = 0; i < srcLen; i++) dst[i] = src[i];
			for (let i = srcLen; i < dstLen; i++) dst[i] = 0;
		} else {
			// `target` is narrower — grow it to fit (matches `grow`'s policy:
			// double until covered, fill with zeros, then copy).
			let cap = dstLen > 0 ? dstLen : 1;
			while (cap < srcLen) cap *= 2;
			const next = new Array(cap).fill(0);
			for (let i = 0; i < srcLen; i++) next[i] = src[i];
			target._words = next;
		}
		return target;
	}

	public copyWithSet(bit: number): BitSet {
		const wordIndex = bit >>> BITS_PER_WORD_SHIFT;
		const minLen = wordIndex + 1;
		const len = this._words.length > minLen ? this._words.length : minLen;
		const words = new Array(len).fill(0);
		for (let i = 0; i < this._words.length; i++) words[i] = this._words[i];
		words[wordIndex] |= 1 << (bit & BITS_PER_WORD_MASK);
		return new BitSet(words);
	}

	public copyWithClear(bit: number): BitSet {
		const words = this._words.slice();
		const wordIndex = bit >>> BITS_PER_WORD_SHIFT;
		if (wordIndex < words.length) {
			words[wordIndex] &= ~(1 << (bit & BITS_PER_WORD_MASK));
		}
		return new BitSet(words);
	}

	/** FNV-1a hash. Skips trailing zero words so differently-sized arrays with the same bits hash equally. */
	public hash(): number {
		let h = FNV_OFFSET_BASIS;
		const words = this._words;
		let last = words.length - 1;
		while (last >= 0 && words[last] === 0) last--;

		for (let i = 0; i <= last; i++) {
			h ^= words[i];
			h = Math.imul(h, FNV_PRIME);
		}
		return h;
	}

	/** Iterate all set bits via lowest-set-bit extraction. */
	public forEach(fn: (bit: number) => void): void {
		const words = this._words;
		for (let i = 0; i < words.length; i++) {
			let word = words[i];
			if (word === 0) continue;
			const base = i << BITS_PER_WORD_SHIFT; // i * 32
			while (word !== 0) {
				// Isolate lowest set bit: e.g. 0b1010 → 0b0010
				// (-word >>> 0) converts to unsigned to handle the sign bit correctly
				const t = word & (-word >>> 0);
				// Count leading zeros to find bit position: clz32(0b0010) = 30 → bit = 31-30 = 1
				const bitPos = BITS_PER_WORD_MASK - Math.clz32(t);
				fn(base + bitPos);
				// Clear the bit we just processed
				word ^= t;
			}
		}
	}

	private grow(minWords: number): void {
		let cap = this._words.length;
		while (cap < minWords) cap *= 2;
		const next = new Array(cap).fill(0);
		for (let i = 0; i < this._words.length; i++) next[i] = this._words[i];
		this._words = next;
	}
}
