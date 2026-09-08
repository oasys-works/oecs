/**
 * Build a Zig source in this directory to a freestanding wasm module, and
 * return the bytes. A missing compiler is a skip and never a pass, so the
 * caller gets `null` and must print the skip.
 *
 * `--max-memory` must be at least the maximum of the memory the host hands
 * over, or instantiation rejects the module.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = `${HERE}build/`;
const ZIG = "/opt/homebrew/bin/zig";

export function zigAvailable() {
	if (existsSync(ZIG)) return ZIG;
	const which = spawnSync("zig", ["version"], { encoding: "utf8" });
	return which.error ? null : "zig";
}

/**
 * @param source   file name in this directory, for example `abi.zig`
 * @param out      output file name under `build/`
 * @param maxMemoryBytes  the maximum of the host memory, in bytes
 * @param flags    extra linker flags, for example `--global-base=...`
 */
export function buildZig(
	source,
	out,
	{
		maxMemoryBytes,
		flags = [],
		sharedMemory = true,
		importMemory = true,
		optimize = "ReleaseSmall",
		reuse = false
	} = {}
) {
	const bin = `${OUT}${out}`;
	// A runtime without write permission still needs the module. When the
	// caller says the binary is already current, read it and do not compile.
	if (reuse && existsSync(bin) && statSync(bin).mtimeMs >= statSync(`${HERE}${source}`).mtimeMs) {
		return readFileSync(bin);
	}
	const zig = zigAvailable();
	if (zig === null) return null;
	mkdirSync(OUT, { recursive: true });
	const args = [
		"build-exe",
		`${HERE}${source}`,
		"-target",
		"wasm32-freestanding",
		"-mcpu=generic+atomics+bulk_memory",
		"-fno-entry",
		"-O",
		optimize,
		"-rdynamic",
		// Without `--import-memory` the linker defines a memory inside the
		// module. The module then loads from its own linear memory and never
		// touches the store, and every read below its initial size succeeds
		// with the wrong bytes. That failure is silent, so the probe asserts
		// the import instead of assuming it.
		...(importMemory ? ["--import-memory"] : []),
		...(sharedMemory ? ["--shared-memory", `--max-memory=${maxMemoryBytes}`] : []),
		...flags,
		`-femit-bin=${bin}`
	];
	const run = spawnSync(zig, args, { encoding: "utf8", cwd: OUT });
	if (run.status !== 0) {
		return {
			error: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(0, 12).join("\n")
		};
	}
	return readFileSync(bin);
}
