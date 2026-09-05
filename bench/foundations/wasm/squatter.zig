// A module that behaves the way a compiled module normally behaves: it owns a
// data segment and it uses a stack. Neither is exotic. Every Rust, C, Go and
// AssemblyScript module has both.
//
// The probe instantiates this against the memory of the store and then asks
// which bytes of the store changed. The module never reads the store, so any
// change is a collision and not a write the host asked for.

var table = [_]u32{0xa5a5a5a5} ** 1024;

/// Address of the data segment, so the host can say where the collision is.
export fn data_addr() u32 {
    return @intFromPtr(&table);
}

export fn data_len() u32 {
    return table.len * 4;
}

/// Write through the data segment, the way a module with a lookup table does.
export fn touch_global(n: u32) u32 {
    const i = n % table.len;
    table[i] +%= 1;
    return table[i];
}

/// Address of a local. This is the shadow stack, which the linker places by
/// itself and which no host ever sees.
export fn stack_addr() u32 {
    var buf: [16]u32 = undefined;
    buf[0] = 1;
    return @intFromPtr(&buf[0]);
}

/// Spill a large local array to the shadow stack and read it back, so the
/// stack traffic is real and the optimizer cannot delete it.
export fn touch_stack(n: u32) u32 {
    var buf: [4096]u8 = undefined;
    var i: u32 = 0;
    while (i < buf.len) : (i += 1) buf[i] = @truncate(i +% n);
    var s: u32 = 0;
    i = 0;
    while (i < buf.len) : (i += 1) s +%= buf[i];
    return s;
}

/// Grow the memory from inside the module, without telling the host.
export fn grow_pages(pages: u32) i32 {
    const before = @wasmMemoryGrow(0, pages);
    return before;
}

export fn page_count() u32 {
    return @wasmMemorySize(0);
}
