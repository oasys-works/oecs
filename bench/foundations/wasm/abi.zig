// The same reader as the hand-emitted module, written in Zig.
//
// One module proves that a compiler agrees with the layout. The hand-emitted
// twin proves that the layout needs no compiler. Both read the imported memory
// by absolute address, so neither owns any of the bytes it touches.
//
// Every offset the store writes is measured from the header. So a column
// address is `header + byte_off` and the descriptor region starts at
// `header + layout_descriptor_off`. Each entry adds the base it is given and
// never treats a stored offset as an address. A caller that passes a base of
// zero gets the addresses the store wrote.
//
// The module declares no global and it allocates nothing. That keeps its data
// segment empty, which matters: a data segment lands in the imported memory,
// and the store of oecs already owns those bytes.
//
// Build:
//   zig build-exe abi.zig -target wasm32-freestanding \
//     -mcpu=generic+atomics+bulk_memory -fno-entry -O ReleaseSmall \
//     --import-memory --shared-memory --max-memory=<bytes> -rdynamic

const HDR_ARCHETYPE_COUNT: u32 = 16;
const HDR_LAYOUT_OFF: u32 = 20;

const ARCH_ID: u32 = 0;
const ARCH_MASK: u32 = 4;
const ARCH_ROW_COUNT: u32 = 20;
const ARCH_COLUMN_COUNT: u32 = 28;
const ARCH_ENABLED_COUNT: u32 = 32;
const ARCH_BYTES: u32 = 36;

const COL_COMPONENT_ID: u32 = 0;
const COL_FIELD_ID: u32 = 2;
const COL_TYPE_TAG: u32 = 4;
const COL_BYTE_OFF: u32 = 8;
const COL_STRIDE: u32 = 12;
const COL_BYTES: u32 = 16;

const FNV_BASIS: u32 = 0x811c9dc5;
const FNV_PRIME: u32 = 16777619;

inline fn u8At(addr: u32) u8 {
    const p: *const u8 = @ptrFromInt(addr);
    return p.*;
}

inline fn u16At(addr: u32) u16 {
    const p: *align(1) const u16 = @ptrFromInt(addr);
    return p.*;
}

inline fn u32At(addr: u32) u32 {
    const p: *align(1) const u32 = @ptrFromInt(addr);
    return p.*;
}

inline fn f32At(addr: u32) f32 {
    const p: *align(1) const f32 = @ptrFromInt(addr);
    return p.*;
}

inline fn setF32(addr: u32, v: f32) void {
    const p: *align(1) f32 = @ptrFromInt(addr);
    p.* = v;
}

inline fn i32At(addr: u32) i32 {
    const p: *align(1) const i32 = @ptrFromInt(addr);
    return p.*;
}

inline fn setI32(addr: u32, v: i32) void {
    const p: *align(1) i32 = @ptrFromInt(addr);
    p.* = v;
}

inline fn fold(h: u32, w: u32) u32 {
    return (h ^ w) *% FNV_PRIME;
}

export fn fnv1a(off: u32, len: u32) u32 {
    var h: u32 = FNV_BASIS;
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        h = (h ^ @as(u32, u8At(off + i))) *% FNV_PRIME;
    }
    return h;
}

export fn walk(header: u32) u32 {
    var h: u32 = FNV_BASIS;
    const acount = u32At(header + HDR_ARCHETYPE_COUNT);
    var desc = header + u32At(header + HDR_LAYOUT_OFF);
    h = fold(h, acount);
    var a: u32 = 0;
    while (a < acount) : (a += 1) {
        const ncol = u32At(desc + ARCH_COLUMN_COUNT);
        h = fold(h, u32At(desc + ARCH_ID));
        h = fold(h, ncol);
        h = fold(h, u32At(desc + ARCH_ROW_COUNT));
        h = fold(h, u32At(desc + ARCH_ENABLED_COUNT));
        h = fold(h, u32At(desc + ARCH_MASK));
        var c: u32 = 0;
        while (c < ncol) : (c += 1) {
            const co = desc + ARCH_BYTES + c * COL_BYTES;
            h = fold(h, u16At(co + COL_COMPONENT_ID));
            h = fold(h, u16At(co + COL_FIELD_ID));
            h = fold(h, u8At(co + COL_TYPE_TAG));
            h = fold(h, u32At(co + COL_BYTE_OFF));
            h = fold(h, u16At(co + COL_STRIDE));
        }
        desc += ARCH_BYTES + ncol * COL_BYTES;
    }
    return h;
}

const Cols = struct {
    px: u32 = 0,
    py: u32 = 0,
    pz: u32 = 0,
    vx: u32 = 0,
    vy: u32 = 0,
    vz: u32 = 0,
    nrow: u32 = 0,
    ncol: u32 = 0,

    inline fn complete(self: Cols) bool {
        return self.px != 0 and self.py != 0 and self.pz != 0 and
            self.vx != 0 and self.vy != 0 and self.vz != 0;
    }
};

/// Resolve the six columns of one archetype by (component_id, field_id).
inline fn resolve(base: u32, desc: u32, pos_id: u32, vel_id: u32) Cols {
    var out = Cols{};
    out.ncol = u32At(desc + ARCH_COLUMN_COUNT);
    out.nrow = u32At(desc + ARCH_ENABLED_COUNT);
    var c: u32 = 0;
    while (c < out.ncol) : (c += 1) {
        const co = desc + ARCH_BYTES + c * COL_BYTES;
        const cid = u16At(co + COL_COMPONENT_ID);
        const fid = u16At(co + COL_FIELD_ID);
        const boff = base + u32At(co + COL_BYTE_OFF);
        if (cid == pos_id) {
            if (fid == 0) out.px = boff;
            if (fid == 1) out.py = boff;
            if (fid == 2) out.pz = boff;
        }
        if (cid == vel_id) {
            if (fid == 0) out.vx = boff;
            if (fid == 1) out.vy = boff;
            if (fid == 2) out.vz = boff;
        }
    }
    return out;
}

export fn step(header: u32, pos_id: u32, vel_id: u32, dt: f32) u32 {
    const acount = u32At(header + HDR_ARCHETYPE_COUNT);
    var desc = header + u32At(header + HDR_LAYOUT_OFF);
    var rows: u32 = 0;
    var a: u32 = 0;
    while (a < acount) : (a += 1) {
        const cols = resolve(header, desc, pos_id, vel_id);
        if (cols.complete()) {
            var r: u32 = 0;
            while (r < cols.nrow) : (r += 1) {
                const o = r * 4;
                setF32(cols.px + o, f32At(cols.px + o) + f32At(cols.vx + o) * dt);
                setF32(cols.py + o, f32At(cols.py + o) + f32At(cols.vy + o) * dt);
                setF32(cols.pz + o, f32At(cols.pz + o) + f32At(cols.vz + o) * dt);
            }
            rows += cols.nrow;
        }
        desc += ARCH_BYTES + cols.ncol * COL_BYTES;
    }
    return rows;
}

export fn step_at(base: u32, desc: u32, pos_id: u32, vel_id: u32, dt: f32) u32 {
    const cols = resolve(base, desc, pos_id, vel_id);
    if (!cols.complete()) return 0;
    var r: u32 = 0;
    while (r < cols.nrow) : (r += 1) {
        const o = r * 4;
        setF32(cols.px + o, f32At(cols.px + o) + f32At(cols.vx + o) * dt);
        setF32(cols.py + o, f32At(cols.py + o) + f32At(cols.vy + o) * dt);
        setF32(cols.pz + o, f32At(cols.pz + o) + f32At(cols.vz + o) * dt);
    }
    return cols.nrow;
}

export fn step_i32(header: u32, pos_id: u32, vel_id: u32, dt: i32) u32 {
    const acount = u32At(header + HDR_ARCHETYPE_COUNT);
    var desc = header + u32At(header + HDR_LAYOUT_OFF);
    var rows: u32 = 0;
    var a: u32 = 0;
    while (a < acount) : (a += 1) {
        const cols = resolve(header, desc, pos_id, vel_id);
        if (cols.complete()) {
            var r: u32 = 0;
            while (r < cols.nrow) : (r += 1) {
                const o = r * 4;
                setI32(cols.px + o, i32At(cols.px + o) +% i32At(cols.vx + o) *% dt);
                setI32(cols.py + o, i32At(cols.py + o) +% i32At(cols.vy + o) *% dt);
                setI32(cols.pz + o, i32At(cols.pz + o) +% i32At(cols.vz + o) *% dt);
            }
            rows += cols.nrow;
        }
        desc += ARCH_BYTES + cols.ncol * COL_BYTES;
    }
    return rows;
}

/// The empty body. Calling it measures the crossing and nothing else, so it
/// carries the argument list of `step_at` and compares against it.
export fn nop(base: u32, desc: u32, pos_id: u32, vel_id: u32, dt: f32) u32 {
    _ = base;
    _ = desc;
    _ = pos_id;
    _ = vel_id;
    _ = dt;
    return 0;
}
