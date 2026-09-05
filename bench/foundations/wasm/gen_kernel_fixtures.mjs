/**
 * Write the checked-in kernel modules the unit suite runs on the pool.
 *
 * The suite must not build a module. A compiler is not a dependency of the
 * tests, and a module emitted at test time proves only that the emitter and the
 * test agree. The binaries are checked in, so the tests compare the engine
 * against bytes that were fixed before the change under test, and they run on a
 * machine with no toolchain at all.
 *
 * Four toolchains carry the same four bodies. The sources sit in this
 * directory, beside this file, and each one's header repeats its build line.
 *
 *   kernel_emitted.wasm   kernel_module.mjs, emitted byte by byte, no toolchain
 *   kernel_zig.wasm       kernel.zig
 *   kernel_rust.wasm      kernel.rs
 *   kernel_c.wasm         kernel.c, through `zig cc`
 *   kernel_as.wasm        kernel_as.ts, AssemblyScript, two bodies of the four
 *
 * AssemblyScript carries two bodies. It has no shadow stack a host can move and
 * its constants live on a runtime heap, and every instance over one memory
 * shares a heap. Its header says so.
 *
 * Regenerate after a change to any source, to the emitter, or to the kernel
 * contract:
 *
 *   node bench/foundations/wasm/gen_kernel_fixtures.mjs
 *
 * A missing toolchain is a skip and never a pass. The script reports which
 * files it wrote and which it left alone, and it exits non-zero when a
 * toolchain it found refused to build.
 *
 * The exact build lines:
 *
 *   zig build-exe kernel.zig -target wasm32-freestanding \
 *     -mcpu=generic+atomics+bulk_memory -fno-entry -O ReleaseFast -rdynamic \
 *     --import-memory --shared-memory --max-memory=33554432 \
 *     --export=__heap_base --export=__stack_pointer
 *
 *   rustc kernel.rs --target wasm32-unknown-unknown --edition 2021 \
 *     --crate-type cdylib -C opt-level=3 -C panic=abort \
 *     -C target-feature=+atomics,+bulk-memory,+mutable-globals \
 *     -C link-arg=--import-memory -C link-arg=--shared-memory \
 *     -C link-arg=--max-memory=33554432 -C link-arg=--no-entry \
 *     -C link-arg=--export=__heap_base -C link-arg=--export=__stack_pointer \
 *     -o kernel_rust.wasm
 *
 *   zig cc -target wasm32-freestanding -O3 -nostdlib \
 *     -matomics -mbulk-memory -mmutable-globals \
 *     -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
 *     -Wl,--max-memory=33554432 \
 *     -Wl,--export=integrate_i32 -Wl,--export=mix_i32 \
 *     -Wl,--export=stack_i32 -Wl,--export=table_i32 \
 *     -Wl,--export=__heap_base -Wl,--export=__stack_pointer \
 *     -o kernel_c.wasm kernel.c
 *
 *   npx --yes --package=assemblyscript asc kernel_as.ts \
 *     --outFile kernel_as.wasm --optimize --runtime stub \
 *     --importMemory --sharedMemory --initialMemory 1 --maximumMemory 512 \
 *     --noAssert --enable threads,bulk-memory,mutable-globals
 *
 * Every module declares the same memory maximum, so one world serves them all.
 * A world that declares a larger maximum fails to instantiate them.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitKernelModule, emitRefusedModules } from "./kernel_module.mjs";
import { buildZig, zigAvailable } from "./build_zig.mjs";
import { integrateI32, mixI32, stackI32, tableI32 } from "./engine-kernels.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BUILD = `${HERE}build/`;
const OUT = fileURLToPath(new URL("../../../src/core/ecs/__tests__/fixtures/", import.meta.url));

/** Every module declares this maximum, and a world that runs one must declare
 * the same. Keep it in step with `KERNEL_MAX_PAGES` in the fixture module. */
export const MAX_PAGES = 512;
const MAX_BYTES = MAX_PAGES * 65_536;

function zigModule() {
	const bytes = buildZig("kernel.zig", "kernel_zig.wasm", {
		maxMemoryBytes: MAX_BYTES,
		flags: ["--export=__heap_base", "--export=__stack_pointer"],
		optimize: "ReleaseFast"
	});
	if (bytes === null) return { skip: "zig is not on this machine" };
	if (bytes.error) return { error: bytes.error };
	return { bytes };
}

function rustModule() {
	const out = `${BUILD}kernel_rust.wasm`;
	const run = spawnSync(
		"rustc",
		[
			`${HERE}kernel.rs`,
			"--target", "wasm32-unknown-unknown",
			"--edition", "2021",
			"--crate-type", "cdylib",
			"-C", "opt-level=3",
			"-C", "panic=abort",
			"-C", "target-feature=+atomics,+bulk-memory,+mutable-globals",
			"-C", "link-arg=--import-memory",
			"-C", "link-arg=--shared-memory",
			"-C", `link-arg=--max-memory=${MAX_BYTES}`,
			"-C", "link-arg=--no-entry",
			"-C", "link-arg=--export=__heap_base",
			"-C", "link-arg=--export=__stack_pointer",
			"-o", out
		],
		{ encoding: "utf8" }
	);
	if (run.error !== undefined) return { skip: "rustc is not on this machine" };
	if (run.status !== 0) return { error: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
	return { bytes: readFileSync(out) };
}

function cModule() {
	const zig = zigAvailable();
	if (zig === null) return { skip: "zig cc is not on this machine, and apple clang has no wasm32 target" };
	const out = `${BUILD}kernel_c.wasm`;
	const run = spawnSync(
		zig,
		[
			"cc",
			"-target", "wasm32-freestanding",
			"-O3",
			"-nostdlib",
			"-matomics",
			"-mbulk-memory",
			"-mmutable-globals",
			"-Wl,--no-entry",
			"-Wl,--import-memory",
			"-Wl,--shared-memory",
			`-Wl,--max-memory=${MAX_BYTES}`,
			"-Wl,--export=integrate_i32",
			"-Wl,--export=mix_i32",
			"-Wl,--export=stack_i32",
			"-Wl,--export=table_i32",
			"-Wl,--export=__heap_base",
			"-Wl,--export=__stack_pointer",
			"-o", out,
			`${HERE}kernel.c`
		],
		{ encoding: "utf8" }
	);
	if (run.error !== undefined) return { skip: "zig cc would not start" };
	if (run.status !== 0) return { error: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
	return { bytes: readFileSync(out) };
}

function assemblyScriptModule() {
	const out = `${BUILD}kernel_as.wasm`;
	const run = spawnSync(
		"npx",
		[
			"--yes", "--package=assemblyscript", "asc",
			`${HERE}kernel_as.ts`,
			"--outFile", out,
			"--optimize",
			"--runtime", "stub",
			"--importMemory",
			"--sharedMemory",
			"--initialMemory", "1",
			"--maximumMemory", String(MAX_PAGES),
			"--noAssert",
			"--enable", "threads,bulk-memory,mutable-globals"
		],
		{ encoding: "utf8" }
	);
	if (run.error !== undefined) return { skip: "npx would not start, so AssemblyScript is unreachable" };
	if (run.status !== 0) return { error: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
	return { bytes: readFileSync(out), bodies: ["integrate_i32", "mix_i32"] };
}

const BODIES = [
	["integrate_i32", integrateI32],
	["mix_i32", mixI32],
	["stack_i32", stackI32],
	["table_i32", tableI32]
];
const ROWS = 512;
const DT = 3;
const COLUMN_BASE = 4 * 1024 * 1024;

/**
 * Run every body of one module against its JavaScript twin, on one thread.
 *
 * A fixture that disagrees here would fail the suite in a way that names the
 * pool, and the fault would be in the source. So the check runs at build time,
 * where it names the toolchain.
 */
function agrees(bytes, bodies) {
	const memory = new WebAssembly.Memory({ initial: 256, maximum: MAX_PAGES, shared: true });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
	const i32 = new Int32Array(memory.buffer);
	const columns = [0, 1, 2, 3].map((c) => COLUMN_BASE + c * ROWS * 4);
	const seed = () => {
		for (let r = 0; r < ROWS; r++) {
			i32[columns[0] / 4 + r] = (r % 1000) - 500;
			i32[columns[1] / 4 + r] = r % 977;
			i32[columns[2] / 4 + r] = (r % 13) - 6;
			i32[columns[3] / 4 + r] = (r % 17) - 8;
		}
	};
	const snapshot = () => [...new Int32Array(memory.buffer, COLUMN_BASE, ROWS * 4)];
	for (const [name, twin] of BODIES) {
		if (bodies !== undefined && !bodies.includes(name)) continue;
		seed();
		const views = columns.map((c) => new Int32Array(memory.buffer, c, ROWS));
		twin(views[0], views[1], views[2], views[3], 0, ROWS, DT);
		const expected = snapshot();
		seed();
		instance.exports[name](columns[0], columns[1], columns[2], columns[3], 0, ROWS, DT);
		const got = snapshot();
		for (let i = 0; i < expected.length; i++) {
			if (expected[i] !== got[i]) return `${name} disagrees with its JavaScript twin`;
		}
	}
	return null;
}

mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

const jobs = [
	["kernel_emitted.wasm", () => ({ bytes: emitKernelModule({ minPages: 1, maxPages: MAX_PAGES }) })],
	["kernel_zig.wasm", zigModule],
	["kernel_rust.wasm", rustModule],
	["kernel_c.wasm", cModule],
	["kernel_as.wasm", assemblyScriptModule]
];

// The refused set carries a fault on purpose, so no body of it is compared.
const refused = emitRefusedModules({ minPages: 1, maxPages: MAX_PAGES });
for (const [file, bytes] of [
	["kernel_bad_import.wasm", refused.badImport],
	["kernel_no_memory.wasm", refused.noMemory],
	["kernel_bad_arity.wasm", refused.badArity],
	["kernel_frozen_stack.wasm", refused.frozenStack],
	["kernel_no_heap_base.wasm", refused.noHeapBase]
]) {
	writeFileSync(`${OUT}${file}`, bytes);
	console.log(`wrote ${file}, ${bytes.length} bytes`);
}

let failed = false;
for (const [name, build] of jobs) {
	const result = build();
	if (result.skip !== undefined) {
		console.log(`skip  ${name}: ${result.skip}, the checked-in file is unchanged`);
		continue;
	}
	if (result.error !== undefined) {
		console.log(`FAIL  ${name}: ${result.error.split("\n").slice(0, 8).join("\n")}`);
		failed = true;
		continue;
	}
	const wrong = agrees(result.bytes, result.bodies);
	if (wrong !== null) {
		console.log(`FAIL  ${name}: ${wrong}`);
		failed = true;
		continue;
	}
	writeFileSync(`${OUT}${name}`, result.bytes);
	console.log(`wrote ${name}, ${result.bytes.length} bytes`);
}
if (failed) process.exit(1);
