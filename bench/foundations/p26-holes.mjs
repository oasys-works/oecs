/**
 * P26, how many bytes does the column store leave behind as holes?
 *
 * When an archetype overflows, the in-place grow path moves its columns to the
 * end of the buffer and abandons the old region. Nothing reuses that region, so a
 * world can hold up to about twice the bytes it needs, and the allocator cap is
 * reached that much sooner. This probe builds a few growth histories through the
 * public API and reads the layout back from the bytes.
 *
 * For each history and backing it prints:
 *
 *  - `span`, the header `capacity`, the store's used byte range. For the shared
 *    backing this is also the buffer byte length. The heap backing reserves the
 *    cap, so its buffer byte length is printed apart.
 *  - `extents`, the bytes the live column extents cover (`row_capacity * stride`
 *    summed over every column of every archetype, from the descriptors).
 *  - `live`, the bytes the live rows use (`row_count * stride`).
 *  - `holes`, the column data area minus the union of the live extents. The data
 *    area starts after the descriptor region and its 64 KiB headroom and ends at
 *    `span`. Alignment padding counts as a hole.
 *
 * The descriptor region start is read from the header. The data area start is
 * that plus the Store's 64 KiB descriptor headroom, which holds while no extend
 * outgrows the headroom. The probe asserts the descriptors still fit, because an
 * extend past the headroom reallocs the whole store and moves the data start.
 *
 * Usage: `pnpm build && node bench/foundations/p26-holes.mjs`.
 */
import { HEADER, ARCH, ARCH_HEADER_BYTES, COL, COL_BYTES } from "./par/view.mjs";

const PROBE_REGION = 0x50323648;
const DESCRIPTOR_HEADROOM = 64 * 1024;

const { ECS } = await import(new URL("../../dist/index.js", import.meta.url).href);

function makeWorld(backing) {
	const memory = backing === "shared" ? { backing: "shared" } : {};
	const ecs = new ECS({
		memory,
		regions: [{ id: PROBE_REGION, name: "p26-probe", bytes: 16, init: () => {} }]
	});
	const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
	const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
	const tags = [];
	for (let i = 0; i < 9; i++) tags.push(ecs.registerTag());
	// One template per tag mask, made on first use, so the archetype appears in
	// the store when the history first spawns into it.
	const templates = new Map();
	const templateFor = (mask) => {
		let t = templates.get(mask);
		if (t === undefined) {
			const items = [Pos({ x: 1, y: 2 }), Vel({ vx: 3, vy: 4 })];
			for (let b = 0; b < tags.length; b++) if (mask & (1 << b)) items.push(tags[b]);
			t = ecs.template(...items);
			templates.set(mask, t);
		}
		return t;
	};
	return { ecs, spawn: (mask, n) => ecs.spawnMany(templateFor(mask), n) };
}

/** A small seeded generator, so the churn history is the same every run. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const HISTORIES = {
	// (a) One archetype ramped from the default capacity to a million rows.
	"a-one-1M": (w) => {
		for (let n = 0; n < 1_000_000; n += 5000) w.spawn(0, 5000);
	},
	// (b) 64 archetypes ramped in round robin to 16K rows each.
	"b-64x16K": (w) => {
		for (let round = 0; round < 32; round++) for (let m = 0; m < 64; m++) w.spawn(m, 512);
	},
	// (c) 512 archetypes, sizes falling as 1/rank from 64K rows, ramped in round
	// robin so the grows interleave.
	"c-512-skew": (w) => {
		const target = [];
		for (let m = 0; m < 512; m++) target.push(Math.max(1, Math.floor(65536 / (m + 1))));
		const have = new Array(512).fill(0);
		for (let round = 0; round < 64; round++) {
			for (let m = 0; m < 512; m++) {
				const step = Math.ceil(target[m] / 64);
				const n = Math.min(step, target[m] - have[m]);
				if (n > 0) {
					w.spawn(m, n);
					have[m] += n;
				}
			}
		}
	},
	// (d) Churn: archetypes appear over time. Each step plants one new archetype,
	// then adds a random batch to a random live one, so extends interleave with
	// grows.
	"d-churn": (w) => {
		const r = rng(26);
		for (let k = 0; k < 256; k++) {
			w.spawn(k, 1 + Math.floor(r() * 64));
			for (let j = 0; j < 4; j++) {
				const m = Math.floor(r() * (k + 1));
				w.spawn(m, Math.floor(r() * r() * 4096));
			}
		}
	}
};

/** Read the layout back from the bytes and measure it. */
function measure(ecs) {
	ecs.publishRowCounts();
	const handle = ecs.regionHandle(PROBE_REGION);
	const buffer = handle.buffer;
	const base = handle.view.byteOffset;
	const dv = new DataView(buffer, base);
	const span = dv.getUint32(HEADER.capacity, true);
	const archetypeCount = dv.getUint32(HEADER.archetype_count, true);
	const regionOff = dv.getUint32(HEADER.layout_descriptor_off, true);
	let off = regionOff;
	const extents = [];
	let extentBytes = 0;
	let liveBytes = 0;
	for (let a = 0; a < archetypeCount; a++) {
		const rowCount = dv.getUint32(off + ARCH.row_count, true);
		const rowCapacity = dv.getUint32(off + ARCH.row_capacity, true);
		const columnCount = dv.getUint32(off + ARCH.column_count, true);
		for (let c = 0; c < columnCount; c++) {
			const co = off + ARCH_HEADER_BYTES + c * COL_BYTES;
			const byteOff = dv.getUint32(co + COL.byte_off, true);
			const stride = dv.getUint16(co + COL.stride, true);
			extents.push([byteOff, byteOff + stride * rowCapacity]);
			extentBytes += stride * rowCapacity;
			liveBytes += stride * rowCount;
		}
		off += ARCH_HEADER_BYTES + columnCount * COL_BYTES;
	}
	const usedDescriptor = off - regionOff;
	if (usedDescriptor > DESCRIPTOR_HEADROOM) {
		throw new Error(
			`descriptors use ${usedDescriptor} bytes, past the headroom: the data start moved`
		);
	}
	const dataStart = regionOff + DESCRIPTOR_HEADROOM;
	extents.sort((p, q) => p[0] - q[0]);
	let covered = 0;
	let cursor = dataStart;
	let largestHole = 0;
	for (const [s, e] of extents) {
		if (s < cursor) throw new Error(`overlapping extents at ${s}`);
		largestHole = Math.max(largestHole, s - cursor);
		covered += e - s;
		cursor = e;
	}
	largestHole = Math.max(largestHole, span - cursor);
	const area = span - dataStart;
	return {
		span,
		bufferBytes: buffer.byteLength,
		area,
		extentBytes,
		liveBytes,
		holes: area - covered,
		largestHole
	};
}

const mibs = (b) => (b / (1024 * 1024)).toFixed(2);

const rows = [];
for (const backing of ["heap", "shared"]) {
	for (const [name, run] of Object.entries(HISTORIES)) {
		const w = makeWorld(backing);
		run(w);
		const m = measure(w.ecs);
		rows.push({ name, backing, ...m });
	}
}

console.log(
	"| history | backing | span MiB | buffer MiB | column area MiB | extents MiB | live MiB | holes MiB | holes % of area | largest hole MiB |"
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
	console.log(
		`| ${r.name} | ${r.backing} | ${mibs(r.span)} | ${mibs(r.bufferBytes)} | ${mibs(r.area)} | ` +
			`${mibs(r.extentBytes)} | ${mibs(r.liveBytes)} | ${mibs(r.holes)} | ` +
			`${((100 * r.holes) / r.area).toFixed(1)} | ${mibs(r.largestHole)} |`
	);
}
