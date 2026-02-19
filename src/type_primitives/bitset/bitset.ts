/***
 *
 * BitSet - number[]-backed bit set with auto-grow
 *
 * Used as the archetype signature representation. Each bit position
 * corresponds to a ComponentID. Operations like has/set/clear are
 * constant-time, and superset checks (contains) and equality are
 * O(words) where words = ceil(maxComponentId / 32).
 *
 ***/

const INITIAL_WORD_COUNT = 4; // 128 component IDs

export class BitSet {
  _words: number[];

  constructor(words?: number[]) {
    this._words = words ?? new Array(INITIAL_WORD_COUNT).fill(0);
  }

  has(bit: number): boolean {
    const word_index = bit >>> 5;
    if (word_index >= this._words.length) return false;
    return (this._words[word_index] & (1 << (bit & 31))) !== 0;
  }

  set(bit: number): void {
    const word_index = bit >>> 5;
    if (word_index >= this._words.length) this.grow(word_index + 1);
    this._words[word_index] |= 1 << (bit & 31);
  }

  clear(bit: number): void {
    const word_index = bit >>> 5;
    if (word_index >= this._words.length) return;
    this._words[word_index] &= ~(1 << (bit & 31));
  }

  /** Intersection check: does this BitSet share any bit with `other`? */
  overlaps(other: BitSet): boolean {
    const a = this._words,
      b = other._words;
    const len = a.length < b.length ? a.length : b.length;
    for (let i = 0; i < len; i++) {
      if ((a[i] & b[i]) !== 0) return true;
    }
    return false;
  }

  /** Superset check: does this BitSet contain all bits set in `other`? */
  contains(other: BitSet): boolean {
    const other_words = other._words;
    const this_words = this._words;
    const this_len = this_words.length;

    for (let i = 0; i < other_words.length; i++) {
      const o = other_words[i];
      if (o === 0) continue;
      if (i >= this_len) return false;
      if ((this_words[i] & o) !== o) return false;
    }
    return true;
  }

  equals(other: BitSet): boolean {
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

  copy(): BitSet {
    return new BitSet(this._words.slice());
  }

  copy_with_set(bit: number): BitSet {
    const word_index = bit >>> 5;
    const min_len = word_index + 1;
    const len = this._words.length > min_len ? this._words.length : min_len;
    const words = new Array(len).fill(0);
    for (let i = 0; i < this._words.length; i++) words[i] = this._words[i];
    words[word_index] |= 1 << (bit & 31);
    return new BitSet(words);
  }

  copy_with_clear(bit: number): BitSet {
    const words = this._words.slice();
    const word_index = bit >>> 5;
    if (word_index < words.length) {
      words[word_index] &= ~(1 << (bit & 31));
    }
    return new BitSet(words);
  }

  /** FNV-1a hash over the words array. */
  hash(): number {
    let h = 0x811c9dc5;
    const words = this._words;
    // Find the last non-zero word to ensure equal bitsets produce equal hashes
    // regardless of trailing zeros from different array lengths
    let last = words.length - 1;
    while (last >= 0 && words[last] === 0) last--;

    for (let i = 0; i <= last; i++) {
      h ^= words[i];
      h = Math.imul(h, 0x01000193);
    }
    return h;
  }

  /** Iterate all set bits, calling fn(bit) for each. */
  for_each(fn: (bit: number) => void): void {
    const words = this._words;
    for (let i = 0; i < words.length; i++) {
      let word = words[i];
      if (word === 0) continue;
      const base = i << 5;
      while (word !== 0) {
        // Find lowest set bit
        const t = word & (-word >>> 0);
        const bit_pos = 31 - Math.clz32(t);
        fn(base + bit_pos);
        word ^= t;
      }
    }
  }

  private grow(min_words: number): void {
    let cap = this._words.length;
    while (cap < min_words) cap *= 2;
    const next = new Array(cap).fill(0);
    for (let i = 0; i < this._words.length; i++) next[i] = this._words[i];
    this._words = next;
  }
}
