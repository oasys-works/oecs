/**
 * P25 crossing. What does it cost to leave JavaScript for the frame?
 *
 * Every body here runs inside `ecs.update`, through the compute-backend seam,
 * so the measurement carries the real dispatch of the schedule and not a bare
 * function call. One archetype for each of eight tags, so "one call for the
 * frame" and "one call for each archetype" differ by eight crossings.
 *
 * One process for each variant. The world at a million entities holds tens of
 * megabytes, and a heap that large puts the collector inside the samples.
 */

import { loadOecs, time, table, variantArg, emit, RUNTIMES, runVariantOn } from "./harness.mjs";
import { emitAbiModule } from "./wasm/abi_module.mjs";
import { buildZig, zigAvailable } from "./wasm/build_zig.mjs";
import { readDescriptors } from "./wasm/world.mjs";

const PAGES = 2048;
const SIZES = [1000, 10000, 100000, 1000000];
const ARCHETYPES = 8;
const BODIES = [
	"ts",
	"hand one call",
	"zig one call",
	"zig call per archetype",
	"empty one call",
	"empty call per archetype"
];

function buildCrossingWorld(ECS, n) {
	const ecs = ECS.create({ memory: { backing: { wasm: { maximumPages: PAGES } } } });
	const Pos = ecs.registerComponent({ x: "f32", y: "f32", z: "f32" });
	const Vel = ecs.registerComponent({ vx: "f32", vy: "f32", vz: "f32" });
	// One tag for each archetype, so the descriptor region holds several
	// matching archetypes and the per-archetype call count is real.
	const tags = [];
	for (let i = 0; i < ARCHETYPES; i++) tags.push(ecs.registerComponent({ [`t${i}`]: "u32" }));
	const per = Math.max(1, Math.floor(n / ARCHETYPES));
	for (let i = 0; i < ARCHETYPES; i++) {
		const T = ecs.template(
			Pos({ x: 1, y: 1, z: 1 }),
			Vel({ vx: 1, vy: 1, vz: 1 }),
			tags[i]({ [`t${i}`]: i })
		);
		ecs.spawnMany(T, per);
	}
	ecs.publishRowCounts();
	return { ecs, Pos, Vel };
}

/** A backend that hands one system to a module. `perArchetype` decides whether
 * the frame costs one crossing or one for each archetype. */
class ModuleBackend {
	constructor(exports, entry, posId, velId, perArchetype) {
		this._ex = exports;
		this._entry = entry;
		this._posId = posId;
		this._velId = velId;
		this._perArchetype = perArchetype;
		this._headerOff = 0;
		this._descs = [];
		this._buffer = null;
	}
	setLayout(headerOff) {
		this._headerOff = headerOff;
		this._descs = [];
	}
	bind(buffer) {
		this._buffer = buffer;
	}
	_resolve() {
		// Re-walk lazily, because `setLayout` fires before the store publishes
		// the row counts of the frame.
		this._descs = readDescriptors(this._buffer, this._headerOff)
			.filter(
				(d) =>
					d.columns.some((c) => c.componentId === this._posId) &&
					d.columns.some((c) => c.componentId === this._velId)
			)
			.map((d) => d.descOff);
	}
	run() {
		if (!this._perArchetype) {
			this._ex[this._entry](this._headerOff, this._posId, this._velId, 0.5);
			return;
		}
		if (this._descs.length === 0) this._resolve();
		// A descriptor address is not a column base, so the per-archetype entry
		// takes both. The columns of that archetype start from the header offset.
		for (let i = 0; i < this._descs.length; i++) {
			this._ex[this._entry === "nop" ? "nop" : "step_at"](
				this._headerOff,
				this._descs[i],
				this._posId,
				this._velId,
				0.5
			);
		}
	}
}

const variant = variantArg();
if (variant !== null) {
	const [body, sizeText] = variant.split("@");
	const n = Number(sizeText);
	const { ECS, SCHEDULE } = await loadOecs();
	const { ecs, Pos, Vel } = buildCrossingWorld(ECS, n);
	const memory = ecs.wasmMemory;

	let system;
	if (body === "ts") {
		const movers = ecs.query(Pos, Vel);
		system = ecs.registerSystem({
			name: "move",
			reads: [Vel],
			writes: [Pos],
			queries: [[Pos, Vel]],
			fn: () => {
				movers.forEachColumns((cols, count) => {
					const { x, y, z } = cols.mut(Pos);
					const { vx, vy, vz } = cols.read(Vel);
					for (let i = 0; i < count; i++) {
						x[i] += vx[i] * 0.5;
						y[i] += vy[i] * 0.5;
						z[i] += vz[i] * 0.5;
					}
				});
			}
		});
	} else {
		const useZig = body.startsWith("zig");
		const bytes = useZig
			? buildZig("abi.zig", "abi.wasm", { maxMemoryBytes: PAGES * 65536, reuse: true })
			: emitAbiModule({ minPages: 1, maxPages: PAGES });
		if (bytes === null || bytes.error) {
			emit({ skip: "zig is absent" });
			process.exit(0);
		}
		const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
		const entry = body.startsWith("empty") ? "nop" : "step";
		const perArchetype = body.endsWith("call per archetype");
		const backend = new ModuleBackend(ex, entry, Pos.id, Vel.id, perArchetype);
		backend.bind(memory.buffer);
		ecs.attachBackend(backend);
		system = ecs.registerSystem({
			name: "move",
			reads: [Vel],
			writes: [Pos],
			queries: [[Pos, Vel]],
			backendHandle: 1,
			fn: () => {}
		});
	}

	ecs.addSystems(SCHEDULE.UPDATE, system);
	ecs.startup();
	const t = time(
		() => {
			ecs.update(0.5);
			return 1;
		},
		{ warmup: 8, samples: 25 }
	);
	emit({ median: t.median, p25: t.p25, p75: t.p75, min: t.min, max: t.max });
	process.exit(0);
}

// ── the parent: one process for each variant, on each runtime ────────────────
console.log(`## one frame of pos += vel * dt, through ecs.update, ${ARCHETYPES} archetypes`);
console.log(`   zig: ${zigAvailable() ?? "absent, so every zig row is a skip"}`);
// Compile once here. A child then reads the binary, which lets a runtime
// without write permission take part.
buildZig("abi.zig", "abi.wasm", { maxMemoryBytes: PAGES * 65536 });
for (const rt of RUNTIMES) {
	const rows = [];
	for (const n of SIZES) {
		const row = { n };
		for (const body of BODIES) {
			const r = runVariantOn(rt, import.meta.url, `${body}@${n}`);
			row[body] = r === null || r.skip ? null : r;
		}
		rows.push(row);
	}
	console.log(`\n### ${rt.cmd}, ${rt.engine}, median ms for one frame, p25 to p75 in brackets`);
	const cell = (r, body) => {
		const v = r[body];
		if (v === null) return "skip";
		return `${v.median.toFixed(3)} [${v.p25.toFixed(3)}, ${v.p75.toFixed(3)}]`;
	};
	table(rows, [
		{ label: "entities", get: (r) => r.n },
		...BODIES.map((b) => ({ label: b, get: (r) => cell(r, b) })),
		{
			label: "zig one call against ts",
			get: (r) =>
				r.ts && r["zig one call"]
					? `${(r.ts.median / r["zig one call"].median).toFixed(2)}x`
					: "skip"
		}
	]);
}
