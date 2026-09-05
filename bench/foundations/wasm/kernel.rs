//! The parallel kernels of the fixture set, written in Rust.
//!
//! The Zig twin and the hand-emitted twin carry the same four bodies. Three
//! toolchains that know nothing about each other agree bit for bit with the
//! JavaScript twin, so the kernel contract is a contract and not one
//! compiler's habit.
//!
//! The engine hands a kernel one absolute byte offset for each declared column,
//! then `begin`, `end` and `dt`. Row `r` of a column sits at `ptr + r * 4`,
//! because every column here is i32. The kernel reads no header and walks no
//! descriptor.
//!
//! `dt` is i32. The engine passes a JavaScript number and the declared
//! parameter type decides the conversion, so an integer world takes an integer
//! step.
//!
//! `no_std` and no allocator, because every instance of one module shares one
//! linear memory and so shares one heap. A kernel allocates nothing.
//!
//! Build:
//!   rustc kernel.rs --target wasm32-unknown-unknown --edition 2021 \
//!     --crate-type cdylib -C opt-level=3 -C panic=abort \
//!     -C target-feature=+atomics,+bulk-memory,+mutable-globals \
//!     -C link-arg=--import-memory -C link-arg=--shared-memory \
//!     -C link-arg=--max-memory=<bytes> -C link-arg=--no-entry \
//!     -C link-arg=--export=__heap_base -C link-arg=--export=__stack_pointer \
//!     -o kernel_rust.wasm

#![no_std]
#![allow(clippy::missing_safety_doc)]

use core::panic::PanicInfo;

/// A kernel never panics, and a `no_std` build needs the handler anyway.
#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

/// The rounds the heavy body runs for each row.
const MIX_ROUNDS: u32 = 4;
/// The slot count of the scratch array and of the constant table.
const SLOTS: usize = 64;

const fn make_table() -> [i32; SLOTS] {
    let mut t = [0i32; SLOTS];
    let mut k = 0usize;
    while k < SLOTS {
        let kk = k as u32;
        t[k] = (kk.wrapping_mul(2654435761) ^ (kk << 3)) as i32;
        k += 1;
    }
    t
}

/// The constant table, so the module carries a data segment.
static TABLE: [i32; SLOTS] = make_table();

#[inline(always)]
unsafe fn load(addr: u32) -> i32 {
    (addr as *const i32).read_unaligned()
}

#[inline(always)]
unsafe fn store(addr: u32, v: i32) {
    (addr as *mut i32).write_unaligned(v)
}

#[no_mangle]
pub unsafe extern "C" fn integrate_i32(
    px: u32,
    py: u32,
    vx: u32,
    vy: u32,
    begin: u32,
    end: u32,
    dt: i32,
) {
    let mut i = begin;
    while i < end {
        let o = i * 4;
        store(px + o, load(px + o).wrapping_add(load(vx + o).wrapping_mul(dt)));
        store(py + o, load(py + o).wrapping_add(load(vy + o).wrapping_mul(dt)));
        i += 1;
    }
}

#[no_mangle]
pub unsafe extern "C" fn mix_i32(
    px: u32,
    py: u32,
    vx: u32,
    vy: u32,
    begin: u32,
    end: u32,
    dt: i32,
) {
    let mut i = begin;
    while i < end {
        let o = i * 4;
        let bx = load(vx + o);
        let by = load(vy + o);
        let mut h = load(px + o).wrapping_add(bx.wrapping_mul(dt));
        let mut r = 0u32;
        while r < MIX_ROUNDS {
            h = h.wrapping_mul(1103515245).wrapping_add(12345);
            h ^= ((h as u32) >> 15) as i32;
            // The branch is taken for about half the rows, so the body cannot
            // run one instruction stream for every row.
            if (h & 1023) > 512 {
                h = h.wrapping_mul(3).wrapping_add(by);
            } else {
                h ^= bx;
            }
            r += 1;
        }
        store(px + o, h);
        store(py + o, load(py + o).wrapping_add(h & 255));
        i += 1;
    }
}

/// A body that spills to the shadow stack, on purpose.
///
/// `scratch` is gathered from with an index the scratch itself decides, so no
/// compiler folds it into registers. It lands in linear memory below
/// `__stack_pointer`, which is the resource every instance of one module would
/// otherwise share.
#[no_mangle]
pub unsafe extern "C" fn stack_i32(
    px: u32,
    py: u32,
    vx: u32,
    vy: u32,
    begin: u32,
    end: u32,
    dt: i32,
) {
    let mut i = begin;
    while i < end {
        let o = i * 4;
        let by = load(vy + o);
        let mut h = load(px + o).wrapping_add(load(vx + o).wrapping_mul(dt));
        let mut scratch = [0i32; SLOTS];
        let mut k = 0usize;
        while k < SLOTS {
            h = h.wrapping_mul(1103515245).wrapping_add(12345);
            scratch[k] = h;
            k += 1;
        }
        let mut acc = 0i32;
        k = 0;
        while k < SLOTS {
            let idx = ((scratch[k] ^ by) & 63) as usize;
            acc = acc.wrapping_add(scratch[idx]);
            k += 1;
        }
        store(px + o, acc);
        store(py + o, load(py + o).wrapping_add(acc & 255));
        i += 1;
    }
}

/// A body that reads the module's own data segment.
#[no_mangle]
pub unsafe extern "C" fn table_i32(
    px: u32,
    py: u32,
    vx: u32,
    vy: u32,
    begin: u32,
    end: u32,
    dt: i32,
) {
    let mut i = begin;
    while i < end {
        let o = i * 4;
        let by = load(vy + o);
        let mut h = load(px + o).wrapping_add(load(vx + o).wrapping_mul(dt));
        let idx = ((h ^ by) & 63) as usize;
        h = h.wrapping_add(TABLE[idx]);
        store(px + o, h);
        store(py + o, load(py + o).wrapping_add(h & 255));
        i += 1;
    }
}
