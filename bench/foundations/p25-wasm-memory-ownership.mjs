/**
 * P25 ownership. Who owns the low addresses of the memory?
 *
 * A linker puts a shadow stack, a data segment and a heap base at low
 * addresses. The store now starts at a base the caller chooses, and a
 * wasm-backed world defaults that base to one page. This probe measures the
 * overlap at each base, then tries the two ways out: the module moves, or the
 * store moves.
 *
 * The module here never reads the store. Every byte of the store that changes
 * is therefore a collision.
 *
 * Every reader takes the store base and adds it. The base is
 * `ecs.memoryPlan.storeBase`, and `buildWorld` returns it as `headerOff`.
 */

import { loadOecs, table } from "./harness.mjs";
import { buildZig, zigAvailable } from "./wasm/build_zig.mjs";
import {
	MAX_PAGES,
	MAX_BYTES,
	buildWorld,
	readHeader,
	readDescriptors,
	describeAddress,
	changedRanges
} from "./wasm/world.mjs";

const { ECS } = await loadOecs();
const PAGE = 65536;

if (zigAvailable() === null) {
	console.log("zig is absent. This probe needs a real toolchain, so it is a skip and not a pass.");
	process.exit(0);
}

function snapshot(buffer, base, capacity) {
	return new Uint8Array(new Uint8Array(buffer, base, capacity));
}

function instantiate(bytes, memory) {
	return new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
}

function moduleMemoryLimits(bytes) {
	// Read the declared limits of the memory the module imports or defines,
	// because the host has to satisfy them before any of this works.
	let p = 8;
	const uleb = () => {
		let r = 0,
			s = 0,
			b;
		do {
			b = bytes[p++];
			r |= (b & 0x7f) << s;
			s += 7;
		} while (b & 0x80);
		return r >>> 0;
	};
	const out = { imported: null, defined: null };
	while (p < bytes.length) {
		const id = bytes[p++];
		const size = uleb();
		const end = p + size;
		if (id === 2) {
			const n = uleb();
			for (let i = 0; i < n; i++) {
				const ml = uleb();
				p += ml;
				const nl = uleb();
				p += nl;
				const kind = bytes[p++];
				if (kind === 2) {
					const flags = bytes[p++];
					const min = uleb();
					const max = flags & 1 ? uleb() : null;
					out.imported = { flags, min, max };
				} else if (kind === 0) uleb();
				else if (kind === 1) {
					p++;
					const f = bytes[p++];
					uleb();
					if (f & 1) uleb();
				} else if (kind === 3) {
					p += 2;
				}
			}
		}
		if (id === 5) {
			const n = uleb();
			for (let i = 0; i < n; i++) {
				const flags = bytes[p++];
				const min = uleb();
				const max = flags & 1 ? uleb() : null;
				out.defined = { flags, min, max };
			}
		}
		p = end;
	}
	return out;
}

// ── 1. where a linker puts the things the module owns ────────────────────────
const builds = [
	{ name: "default", flags: [] },
	{ name: "--global-base=8 MiB", flags: ["--global-base=8388608"] },
	{ name: "--global-base=32 MiB", flags: ["--global-base=33554432"] }
];
const built = [];
for (const b of builds) {
	const bytes = buildZig("squatter.zig", `squatter-${b.name.replace(/[^a-z0-9]/gi, "_")}.wasm`, {
		maxMemoryBytes: 1024 * PAGE,
		flags: [...b.flags, "--export=__heap_base", "--export=__data_end"]
	});
	if (bytes === null || bytes.error) {
		console.log(`build ${b.name} failed: ${bytes && bytes.error}`);
		continue;
	}
	const mem = new WebAssembly.Memory({ initial: 800, maximum: 1024, shared: true });
	const ex = instantiate(bytes, mem);
	built.push({
		name: b.name,
		bytes,
		limits: moduleMemoryLimits(bytes),
		dataAddr: ex.data_addr(),
		dataLen: ex.data_len(),
		stackAddr: ex.stack_addr(),
		dataEnd: ex.__data_end.value,
		heapBase: ex.__heap_base.value
	});
}

console.log("## where the linker puts the module, addresses in the shared memory");
table(built, [
	{ label: "build", get: (r) => r.name },
	{ label: "data segment", get: (r) => `${r.dataAddr} .. ${r.dataAddr + r.dataLen}` },
	{ label: "one stack local", get: (r) => r.stackAddr },
	{ label: "__data_end", get: (r) => r.dataEnd },
	{ label: "__heap_base", get: (r) => r.heapBase },
	{
		label: "declared memory min pages",
		get: (r) => (r.limits.imported ? r.limits.imported.min : "-")
	}
]);

// ── 2. what the module writes into a live store ──────────────────────────────
console.log("\n## a default-linked module against a live store, which bytes change");
const defBuild = built.find((b) => b.name === "default");
// Two bases. The default of one page keeps the header off address 0 and clears
// nothing else. The second sits above every address the module claims.
const clearedBase = Math.ceil(defBuild.heapBase / PAGE) * PAGE;
const baseCases = [
	{ label: "default store base", storeBase: undefined },
	{ label: `store base above __heap_base, ${clearedBase}`, storeBase: clearedBase }
];
for (const baseCase of baseCases) {
	for (const population of [4096, 200000]) {
		console.log(`\n  ${baseCase.label}, world of about ${(population * 7) / 4} entities`);
		const rows = [];
		const def = defBuild;
		const w = buildWorld(ECS, {
			kind: "i32",
			n: population,
			deterministic: true,
			seed: population < 100000,
			storeBase: baseCase.storeBase
		});
		const buf = w.ecs.wasmMemory.buffer;
		const base = w.headerOff;
		const cap = readHeader(buf, base).capacity;
		const hashBefore = w.ecs.snapshots.stateHash() >>> 0;

		let before = snapshot(buf, base, cap);
		const ex = instantiate(def.bytes, w.ecs.wasmMemory);
		rows.push({ act: "instantiate", diff: changedRanges(before, new Uint8Array(buf, base, cap)) });

		before = snapshot(buf, base, cap);
		ex.touch_global(7);
		rows.push({ act: "touch_global", diff: changedRanges(before, new Uint8Array(buf, base, cap)) });

		before = snapshot(buf, base, cap);
		ex.touch_stack(3);
		rows.push({ act: "touch_stack", diff: changedRanges(before, new Uint8Array(buf, base, cap)) });

		// `changedRanges` counts from the start of the snapshot, which is the base.
		// Add it back, so the span and the region name are addresses.
		table(rows, [
			{ label: "module action", get: (r) => r.act },
			{ label: "store byte runs changed", get: (r) => r.diff.count },
			{
				label: "span",
				get: (r) => (r.diff.span ? `${base + r.diff.span[0]} .. ${base + r.diff.span[1]}` : "none")
			},
			{
				label: "region",
				get: (r) => (r.diff.span ? describeAddress(buf, base + r.diff.span[0], base) : "-")
			}
		]);

		const header = readHeader(buf, base);
		const hashAfter = w.ecs.snapshots.stateHash() >>> 0;
		let alive = 0;
		let readable = 0;
		for (const id of w.ids) {
			if (w.ecs.isAlive(id)) alive++;
			try {
				w.ecs.getField(id, w.Pos, "x");
				readable++;
			} catch {
				// A corrupt entity index makes the read throw or answer for the
				// wrong row. Both count as a loss here.
			}
		}
		let updateError = "none";
		try {
			w.ecs.update(1);
		} catch (e) {
			updateError = `${e.name}: ${e.message}`.slice(0, 90);
		}
		table(
			[
				{
					what: "magic still correct",
					value: header.magic === 827148627 ? "yes" : `NO, ${header.magic}`
				},
				{
					what: "capacity still correct",
					value: header.capacity === cap ? "yes" : `NO, ${header.capacity}`
				},
				{ what: "stateHash before the module ran", value: hashBefore },
				{ what: "stateHash after the module ran", value: hashAfter },
				{ what: "entities still alive", value: `${alive} of ${w.ids.length}` },
				{ what: "entities whose field still reads", value: `${readable} of ${w.ids.length}` },
				{ what: "ecs.update after the module ran", value: updateError }
			],
			[
				{ label: "check", get: (r) => r.what },
				{ label: "result", get: (r) => r.value }
			]
		);
		w.ecs.dispose?.();
	}
}

// ── 3. the data segment of a shared-memory module has a guard in the memory ──
console.log("\n## does the module initialise its own data segment?");
{
	const shared = built.find((b) => b.name === "default");
	const trial = (fill) => {
		const mem = new WebAssembly.Memory({ initial: 800, maximum: 1024, shared: true });
		if (fill !== null) new Uint8Array(mem.buffer).fill(fill);
		const ex = instantiate(shared.bytes, mem);
		return {
			prefill: fill === null ? "untouched memory" : `every byte 0x${fill.toString(16)}`,
			word: `0x${new DataView(mem.buffer).getUint32(ex.data_addr(), true).toString(16)}`
		};
	};
	const rows = [trial(null), trial(0x00), trial(0x11), trial(0x01)];
	table(rows, [
		{ label: "state of the memory before instantiation", get: (r) => r.prefill },
		{ label: "first word of the data segment after", get: (r) => r.word }
	]);
	console.log("  the source sets that word to 0xa5a5a5a5");

	// Find the byte that decides it. The linker guards the one-time
	// initialisation of a shared memory with a word in that same memory.
	const wrote = (lo, hi) => {
		const mem = new WebAssembly.Memory({ initial: 800, maximum: 1024, shared: true });
		const u8 = new Uint8Array(mem.buffer);
		u8.fill(0x11);
		u8.fill(0, lo, hi);
		const ex = instantiate(shared.bytes, mem);
		return new DataView(mem.buffer).getUint32(ex.data_addr(), true) === 0xa5a5a5a5;
	};
	let lo = 0;
	let hi = 800 * PAGE;
	if (wrote(lo, hi)) {
		while (hi - lo > 4) {
			const mid = lo + (((hi - lo) >> 1) & ~3);
			if (wrote(lo, mid)) hi = mid;
			else lo = mid;
		}
		const def = built.find((b) => b.name === "default");
		table(
			[
				{ what: "address of the guard word", value: lo },
				{ what: "end of the data segment", value: def.dataAddr + def.dataLen },
				{ what: "__data_end", value: def.dataEnd }
			],
			[
				{ label: "fact", get: (r) => r.what },
				{ label: "address", get: (r) => r.value }
			]
		);
	}
}

// ── 4. the module moves: --global-base above the store ───────────────────────
console.log("\n## the module moves its base above the store");
{
	const rows = [];
	// The engine-constructed memory declares its own maximum, and the module's
	// data must fit under it.
	const gb32 = built.find((b) => b.name === "--global-base=32 MiB");
	try {
		const ecs = ECS.create({ memory: { backing: { wasm: { maximumPages: MAX_PAGES } } } });
		instantiate(gb32.bytes, ecs.wasmMemory);
		rows.push({
			case: `engine memory, max ${MAX_PAGES} pages, module base 32 MiB`,
			result: "instantiated"
		});
		ecs.dispose?.();
	} catch (e) {
		rows.push({
			case: `engine memory, max ${MAX_PAGES} pages, module base 32 MiB`,
			result: `${e.name}: ${e.message}`.slice(0, 96)
		});
	}

	// A caller-supplied memory can be born large enough to hold both, but the
	// store then declares no ceiling at all.
	const gb8 = built.find((b) => b.name === "--global-base=8 MiB");
	const memory = new WebAssembly.Memory({ initial: 200, maximum: 1024, shared: true });
	const ecs = ECS.create({ memory: { backing: { wasm: { memory } } } });
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	const T = ecs.template(Pos({ x: 1, y: 1, z: 1 }), Vel({ vx: 1, vy: 1, vz: 1 }));
	ecs.spawnMany(T, 1000);
	ecs.publishRowCounts();
	const ex = instantiate(gb8.bytes, memory);
	const storeBase = ecs.memoryPlan.storeBase;
	const capacity = readHeader(memory.buffer, storeBase).capacity;
	const inStore = (addr) => addr >= storeBase && addr < storeBase + capacity;
	rows.push({
		case: "caller memory 200 pages, module base 8 MiB",
		result: `store [${storeBase}, ${storeBase + capacity}), module base ${ex.data_addr()}, base inside the store ${inStore(ex.data_addr())}`
	});

	// The store appends a new column region at its tail, so any free address
	// under the cap is a place the store may write next.
	const probeFrom = storeBase + capacity;
	const probeBytes = Math.min(512 * 1024, memory.buffer.byteLength - probeFrom);
	const stamp = new Uint8Array(memory.buffer, probeFrom, probeBytes);
	stamp.fill(0xcd);
	const kept = new Uint8Array(stamp);
	const Extra = ecs.registerComponent({ a: "f32", b: "f32", c: "f32", d: "f32" });
	const T2 = ecs.template(Pos({ x: 2, y: 2, z: 2 }), Extra({ a: 1, b: 1, c: 1, d: 1 }));
	ecs.spawnMany(T2, 2000);
	ecs.publishRowCounts();
	const after = new Uint8Array(memory.buffer, probeFrom, probeBytes);
	let overwritten = 0;
	for (let i = 0; i < probeBytes; i++) if (after[i] !== kept[i]) overwritten++;
	rows.push({
		case: `${probeBytes} marker bytes written from the old capacity, then a new archetype appears`,
		result: `capacity ${readHeader(memory.buffer, storeBase).capacity}, marker bytes overwritten ${overwritten}`
	});
	table(rows, [
		{ label: "case", get: (r) => r.case },
		{ label: "result", get: (r) => r.result }
	]);
	ecs.dispose?.();
}

// ── 5. the engine moves in: a module that exports its own memory ─────────────
console.log("\n## the module owns the memory and the engine mounts on it");
{
	const bytes = buildZig("squatter.zig", "squatter-export.wasm", {
		maxMemoryBytes: 512 * PAGE,
		importMemory: false,
		flags: ["--export-memory", "--export=__heap_base", "--export=__data_end"]
	});
	if (bytes === null || bytes.error) {
		console.log(`  export-memory build failed: ${bytes && bytes.error}`);
	} else {
		const limits = moduleMemoryLimits(bytes);
		const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
		const memory = inst.exports.memory;
		const ex = inst.exports;
		const dv = new DataView(memory.buffer);
		const marker = 0xdeadbeef;
		dv.setUint32(ex.data_addr(), marker, true);
		const stackTop = ex.stack_addr();
		const rows = [
			{
				what: "module memory, defined pages",
				value: `min ${limits.defined.min}, max ${limits.defined.max}, flags ${limits.defined.flags}`
			}
		];
		let ecs = null;
		try {
			ecs = ECS.create({ memory: { backing: { wasm: { memory } } } });
			const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
			const T = ecs.template(Pos({ x: 1, y: 1, z: 1 }));
			ecs.spawnMany(T, 4096);
			ecs.publishRowCounts();
			const storeBase = ecs.memoryPlan.storeBase;
			const h = readHeader(memory.buffer, storeBase);
			const after = new DataView(memory.buffer);
			const inStore = (addr) => addr >= storeBase && addr < storeBase + h.capacity;
			rows.push({ what: "the engine mounted on the module memory", value: "yes" });
			rows.push({
				what: "store header at the base",
				value: `base ${storeBase}, magic ${h.magic}, capacity ${h.capacity}`
			});
			rows.push({
				what: "module data segment intact",
				value:
					after.getUint32(ex.data_addr(), true) === marker ? "yes" : "NO, the store overwrote it"
			});
			rows.push({
				what: "module data address against the store span",
				value: `${ex.data_addr()}, inside the store ${inStore(ex.data_addr())}`
			});
			rows.push({
				what: "a stack local of the module",
				value: `${stackTop}, inside the store ${inStore(stackTop)}`
			});
			const descs = readDescriptors(memory.buffer, storeBase);
			rows.push({ what: "archetypes a module can walk", value: descs.length });
		} catch (e) {
			rows.push({
				what: "the engine mounted on the module memory",
				value: `${e.name}: ${e.message}`.slice(0, 96)
			});
		}
		table(rows, [
			{ label: "check", get: (r) => r.what },
			{ label: "result", get: (r) => r.value }
		]);
		ecs?.dispose?.();
	}
}

// ── 6. what a store base would have to clear ─────────────────────────────────
console.log("\n## the lowest address a store base would have to clear");
table(built, [
	{ label: "build", get: (r) => r.name },
	{ label: "highest address the module claims", get: (r) => r.heapBase },
	{ label: "pages that address needs", get: (r) => Math.ceil(r.heapBase / PAGE) }
]);
{
	const w = buildWorld(ECS, { kind: "i32", n: 1, deterministic: true, seed: false });
	console.log(
		`  a store with maximumPages ${MAX_PAGES} and the default base occupies bytes ${w.headerOff} .. ${MAX_BYTES} at its cap`
	);
	w.ecs.dispose?.();
}
