/** Declarations for the staggered kernel the join-wake test runs. The body
 * lives in a plain module, because a worker imports it by URL. */
export declare function staggered(px: Int32Array, vx: Int32Array, begin: number, end: number): void;
