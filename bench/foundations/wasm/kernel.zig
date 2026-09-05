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

/// The slot count of the scratch array and of the constant table. One power of
/// two, so a mask picks a slot and no branch does.
const SLOTS: u32 = 64;

/// A constant table, so the module carries a data segment.
///
/// A build for shared memory turns a data segment passive and initialises it
/// once, behind a guard word the linker places in the same memory. Every
/// instance over one memory must then read the same bytes. The table sits below
/// `__heap_base`, so a store based above that address never overlaps it.
const TABLE: [SLOTS]i32 = blk: {
    var t: [SLOTS]i32 = undefined;
    for (&t, 0..) |*slot, k| {
        const kk: u32 = @intCast(k);
        slot.* = @bitCast((kk *% 2654435761) ^ (kk << 3));
    }
    break :blk t;
};

/// A body that spills to the shadow stack, on purpose.
///
/// `scratch` is addressed by a value the compiler cannot know, so it lands in
/// linear memory below `__stack_pointer` and never in a wasm local. Two
/// instances of this module over one memory with one stack pointer overwrite
/// each other's frames, and every row both touched comes out wrong.
export fn stack_i32(px: u32, py: u32, vx: u32, vy: u32, begin: u32, end: u32, dt: i32) void {
    var i: u32 = begin;
    while (i < end) : (i += 1) {
        const o = i * 4;
        const bx = load(vx + o);
        const by = load(vy + o);
        var h: i32 = load(px + o) +% bx *% dt;
        var scratch: [SLOTS]i32 = undefined;
        var k: u32 = 0;
        while (k < SLOTS) : (k += 1) {
            h = h *% 1103515245 +% 12345;
            scratch[k] = h;
        }
        var acc: i32 = 0;
        k = 0;
        while (k < SLOTS) : (k += 1) {
            // The gather index comes from the bytes just written, so no compiler
            // folds the array into locals and no reader predicts the order.
            const idx: u32 = @intCast((scratch[k] ^ by) & 63);
            acc = acc +% scratch[idx];
        }
        store(px + o, acc);
        store(py + o, load(py + o) +% (acc & 255));
    }
}

/// A body that reads the module's own data segment.
export fn table_i32(px: u32, py: u32, vx: u32, vy: u32, begin: u32, end: u32, dt: i32) void {
    var i: u32 = begin;
    while (i < end) : (i += 1) {
        const o = i * 4;
        const bx = load(vx + o);
        const by = load(vy + o);
        var h: i32 = load(px + o) +% bx *% dt;
        const idx: u32 = @intCast((h ^ by) & 63);
        h = h +% TABLE[idx];
        store(px + o, h);
        store(py + o, load(py + o) +% (h & 255));
    }
}
