// The parallel kernels of the fixture set, written in AssemblyScript.
//
// AssemblyScript carries two of the four bodies and not four. It has no shadow
// stack a host can move, because it keeps every value in a wasm local and puts
// everything else on the heap of its runtime. A heap is shared by every
// instance over one memory, so a kernel may not use one. `stack_i32` and
// `table_i32` have no honest AssemblyScript form, and this file says so instead
// of shipping one that races.
//
// The engine hands a kernel one absolute byte offset for each declared column,
// then `begin`, `end` and `dt`. Row `r` of a column sits at `ptr + r * 4`,
// because every column here is i32.
//
// Build:
//   npx --yes --package=assemblyscript asc kernel_as.ts \
//     --outFile kernel_as.wasm --optimize --runtime stub \
//     --importMemory --sharedMemory 512 --initialMemory 1 \
//     --maximumMemory 512 --noAssert --exportStart _start_as

/** The rounds the heavy body runs for each row. */
const MIX_ROUNDS: u32 = 4;

// @ts-ignore: the AssemblyScript decorator
@inline
function ld(addr: u32): i32 {
	return load<i32>(addr);
}

// @ts-ignore: the AssemblyScript decorator
@inline
function st(addr: u32, v: i32): void {
	store<i32>(addr, v);
}

export function integrate_i32(
	px: u32,
	py: u32,
	vx: u32,
	vy: u32,
	begin: u32,
	end: u32,
	dt: i32
): void {
	for (let i: u32 = begin; i < end; i++) {
		const o: u32 = i * 4;
		st(px + o, ld(px + o) + ld(vx + o) * dt);
		st(py + o, ld(py + o) + ld(vy + o) * dt);
	}
}

export function mix_i32(
	px: u32,
	py: u32,
	vx: u32,
	vy: u32,
	begin: u32,
	end: u32,
	dt: i32
): void {
	for (let i: u32 = begin; i < end; i++) {
		const o: u32 = i * 4;
		const bx: i32 = ld(vx + o);
		const by: i32 = ld(vy + o);
		let h: i32 = ld(px + o) + bx * dt;
		for (let r: u32 = 0; r < MIX_ROUNDS; r++) {
			h = h * 1103515245 + 12345;
			h = h ^ <i32>((<u32>h) >> 15);
			// The branch is taken for about half the rows, so the body cannot run
			// one instruction stream for every row.
			if ((h & 1023) > 512) {
				h = h * 3 + by;
			} else {
				h = h ^ bx;
			}
		}
		st(px + o, h);
		st(py + o, ld(py + o) + (h & 255));
	}
}
