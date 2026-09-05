/** Declarations for the kernel bodies the parallel tests run. The bodies live
 * in a plain module, because a worker imports them by URL. */
export declare const KERNEL_MARK: number;
export declare const SEQUENTIAL_MARK: number;
export declare function integrateI32(
	px: Int32Array,
	py: Int32Array,
	vx: Int32Array,
	vy: Int32Array,
	begin: number,
	end: number,
	dt: number
): void;
export declare function integrateF32(
	px: Float32Array,
	py: Float32Array,
	vx: Float32Array,
	vy: Float32Array,
	begin: number,
	end: number,
	dt: number
): void;
export declare function markKernel(
	px: Int32Array,
	py: Int32Array,
	vx: Int32Array,
	vy: Int32Array,
	begin: number,
	end: number
): void;
export declare function throwing(): void;
export declare function spinning(): void;
