/*
 * The parallel kernels of the fixture set, written in C.
 *
 * Apple clang has no wasm32 target, so `zig cc` drives clang and wasm-ld here.
 * The Zig twin, the Rust twin and the hand-emitted twin carry the same four
 * bodies, and every one of them agrees with the JavaScript twin bit for bit.
 *
 * The engine hands a kernel one absolute byte offset for each declared column,
 * then `begin`, `end` and `dt`. Row `r` of a column sits at `ptr + r * 4`,
 * because every column here is i32. The kernel reads no header and walks no
 * descriptor.
 *
 * `dt` is int32. The engine passes a JavaScript number and the declared
 * parameter type decides the conversion, so an integer world takes an integer
 * step.
 *
 * No libc and no allocator, because every instance of one module shares one
 * linear memory and so shares one heap. A kernel allocates nothing.
 *
 * Signed overflow is undefined in C, so every wrapping step runs on the
 * unsigned twin and converts back.
 *
 * Build:
 *   zig cc -target wasm32-freestanding -O3 -nostdlib \
 *     -matomics -mbulk-memory -mmutable-globals \
 *     -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
 *     -Wl,--max-memory=<bytes> \
 *     -Wl,--export=integrate_i32 -Wl,--export=mix_i32 \
 *     -Wl,--export=stack_i32 -Wl,--export=table_i32 \
 *     -Wl,--export=__heap_base -Wl,--export=__stack_pointer \
 *     -o kernel_c.wasm kernel.c
 */

typedef unsigned int u32;
typedef signed int i32;

/* The rounds the heavy body runs for each row. */
#define MIX_ROUNDS 4u
/* The slot count of the scratch array and of the constant table. */
#define SLOTS 64u

/* The constant table, so the module carries a data segment. The initialisers
 * are written out because C has no compile-time loop. */
#define T(k) (i32)(((u32)(k) * 2654435761u) ^ ((u32)(k) << 3))
static const i32 TABLE[SLOTS] = {
	T(0),  T(1),  T(2),  T(3),  T(4),  T(5),  T(6),  T(7),  T(8),  T(9),  T(10), T(11), T(12),
	T(13), T(14), T(15), T(16), T(17), T(18), T(19), T(20), T(21), T(22), T(23), T(24), T(25),
	T(26), T(27), T(28), T(29), T(30), T(31), T(32), T(33), T(34), T(35), T(36), T(37), T(38),
	T(39), T(40), T(41), T(42), T(43), T(44), T(45), T(46), T(47), T(48), T(49), T(50), T(51),
	T(52), T(53), T(54), T(55), T(56), T(57), T(58), T(59), T(60), T(61), T(62), T(63)
};

static inline i32 load(u32 addr) {
	i32 v;
	__builtin_memcpy(&v, (const void *)(unsigned long)addr, sizeof(v));
	return v;
}

static inline void store(u32 addr, i32 v) {
	__builtin_memcpy((void *)(unsigned long)addr, &v, sizeof(v));
}

void integrate_i32(u32 px, u32 py, u32 vx, u32 vy, u32 begin, u32 end, i32 dt) {
	for (u32 i = begin; i < end; i++) {
		u32 o = i * 4;
		store(px + o, (i32)((u32)load(px + o) + (u32)load(vx + o) * (u32)dt));
		store(py + o, (i32)((u32)load(py + o) + (u32)load(vy + o) * (u32)dt));
	}
}

void mix_i32(u32 px, u32 py, u32 vx, u32 vy, u32 begin, u32 end, i32 dt) {
	for (u32 i = begin; i < end; i++) {
		u32 o = i * 4;
		i32 bx = load(vx + o);
		i32 by = load(vy + o);
		u32 h = (u32)load(px + o) + (u32)bx * (u32)dt;
		for (u32 r = 0; r < MIX_ROUNDS; r++) {
			h = h * 1103515245u + 12345u;
			h = h ^ (h >> 15);
			/* The branch is taken for about half the rows, so the body cannot run
			 * one instruction stream for every row. */
			if (((i32)h & 1023) > 512) {
				h = h * 3u + (u32)by;
			} else {
				h = h ^ (u32)bx;
			}
		}
		store(px + o, (i32)h);
		store(py + o, (i32)((u32)load(py + o) + ((u32)h & 255u)));
	}
}

/* A body that spills to the shadow stack, on purpose. `scratch` is gathered
 * from with an index the scratch itself decides, so no compiler folds it into
 * registers. It lands in linear memory below `__stack_pointer`. */
void stack_i32(u32 px, u32 py, u32 vx, u32 vy, u32 begin, u32 end, i32 dt) {
	for (u32 i = begin; i < end; i++) {
		u32 o = i * 4;
		i32 by = load(vy + o);
		u32 h = (u32)load(px + o) + (u32)load(vx + o) * (u32)dt;
		i32 scratch[SLOTS];
		for (u32 k = 0; k < SLOTS; k++) {
			h = h * 1103515245u + 12345u;
			scratch[k] = (i32)h;
		}
		u32 acc = 0;
		for (u32 k = 0; k < SLOTS; k++) {
			u32 idx = (u32)((scratch[k] ^ by) & 63);
			acc = acc + (u32)scratch[idx];
		}
		store(px + o, (i32)acc);
		store(py + o, (i32)((u32)load(py + o) + (acc & 255u)));
	}
}

/* A body that reads the module's own data segment. */
void table_i32(u32 px, u32 py, u32 vx, u32 vy, u32 begin, u32 end, i32 dt) {
	for (u32 i = begin; i < end; i++) {
		u32 o = i * 4;
		i32 by = load(vy + o);
		u32 h = (u32)load(px + o) + (u32)load(vx + o) * (u32)dt;
		u32 idx = (u32)(((i32)h ^ by) & 63);
		h = h + (u32)TABLE[idx];
		store(px + o, (i32)h);
		store(py + o, (i32)((u32)load(py + o) + (h & 255u)));
	}
}
