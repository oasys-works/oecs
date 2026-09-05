// The parallel kernels of the engine probe, written in Zig.
//
// The hand-emitted twin in `kernel_module.mjs` proves that the kernel shape
// needs no toolchain. This one proves that a compiler that knows nothing about
// the engine produces a kernel the pool can run, and it gives the probe a
// second module lane to measure against the first.
//
// The engine hands a kernel one absolute byte offset for each declared column,
// then `begin`, `end` and `dt`. Row `r` of a column sits at `ptr + r * 4`,
// because every column is i32. The kernel reads no header and walks no
// descriptor.
//
// `dt` is i32. The engine passes a JavaScript number, so the declared parameter
// type decides the conversion, and an integer world needs an integer step.
//
// The module must own no byte of the memory it imports, because the store owns
// them. The build passes `--export=__heap_base` and the probe puts the store
// above that address.
//
// Build:
//   zig build-exe kernel.zig -target wasm32-freestanding \
//     -mcpu=generic+atomics+bulk_memory -fno-entry -O ReleaseFast \
//     --import-memory --shared-memory --max-memory=<bytes> \
//     --export=__heap_base -rdynamic

/// The rounds the heavy body runs for each row. Keep in step with `MIX_ROUNDS`
/// in `engine-kernels.mjs`, or the three lanes stop computing one function.
const MIX_ROUNDS: u32 = 4;

inline fn load(addr: u32) i32 {
    const p: *align(1) const i32 = @ptrFromInt(addr);
    return p.*;
}

inline fn store(addr: u32, v: i32) void {
    const p: *align(1) i32 = @ptrFromInt(addr);
    p.* = v;
}

export fn integrate_i32(px: u32, py: u32, vx: u32, vy: u32, begin: u32, end: u32, dt: i32) void {
    var i: u32 = begin;
    while (i < end) : (i += 1) {
        const o = i * 4;
        store(px + o, load(px + o) +% load(vx + o) *% dt);
        store(py + o, load(py + o) +% load(vy + o) *% dt);
    }
}

export fn mix_i32(px: u32, py: u32, vx: u32, vy: u32, begin: u32, end: u32, dt: i32) void {
    var i: u32 = begin;
    while (i < end) : (i += 1) {
        const o = i * 4;
        const bx = load(vx + o);
        const by = load(vy + o);
        var h: i32 = load(px + o) +% bx *% dt;
        var r: u32 = 0;
        while (r < MIX_ROUNDS) : (r += 1) {
            h = h *% 1103515245 +% 12345;
            h = h ^ @as(i32, @bitCast(@as(u32, @bitCast(h)) >> 15));
            // The branch is taken for about half the rows, so the body cannot
            // run one instruction stream for every row.
            if ((h & 1023) > 512) {
                h = h *% 3 +% by;
            } else {
                h = h ^ bx;
            }
        }
        store(px + o, h);
        store(py + o, load(py + o) +% (h & 255));
    }
}
