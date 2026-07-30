/**
 * Does random structural operations, and compares the result with an independent
 * model in JavaScript.
 *
 * The row plane (`Archetype._bufs`) changed how the ECS puts a row in place, how it
 * exchanges two rows, and how it removes a row. Therefore "the unit tests pass" is
 * not sufficient. This tool does long sequences of random operations: spawn,
 * despawn, add, remove, disable, enable, operations in a batch, and moves in bulk.
 * After each step, it compares the component values and the query membership of
 * each live entity with a model that uses a `Map` of objects.
 *
 *   node bench/fuzz.mjs [seed] [steps]
 *   node bench/fuzz.mjs --prod [seed] [steps]   # the build that the package ships
 *
 * THE DEFAULT BUILD IS A DEVELOPMENT BUILD, and the released package is not. A
 * development build keeps the internal assertions, and thus it gives more mechanisms
 * a chance to find a fault. But the shipped path is the production path, so `--prod`
 * runs the same seeds against `__DEV__ = false`. `bench/README.md` records which
 * tool uses which build.
 */
import path from "node:path";
import url from "node:url";
import { buildLib } from "./build.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PROD = args.includes("--prod");
const positional = args.filter((a) => !a.startsWith("--"));
const outfile = path.join(here, PROD ? ".out/oecs.fuzz.prod.mjs" : ".out/oecs.fuzz.mjs");
// A development build keeps the internal assertions active; `--prod` drops them.
await buildLib(outfile, { dev: !PROD });
const { ECS } = await import(url.pathToFileURL(outfile).href);

const seed0 = Number(positional[0] ?? 1);
const STEPS = Number(positional[1] ?? 4000);

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}

function runOne(seed) {
	const rand = rng(seed);
	const pick = (n) => (rand() * n) | 0;

	// A deterministic world gives `snapshots.stateHash()`, `capture()` and
	// `restore()`. Therefore each round also writes the store and reads it again.
	// This is the only path that still reads the logical length of a column, in
	// `restoreHostRows` and in the check for a decrease in `refreshView`. The row
	// plane stopped keeping that length correct continuously.
	const ecs = new ECS({ deterministic: true });
	const A = ecs.registerComponent({ a0: "i32", a1: "i32" });
	const B = ecs.registerComponent({ b0: "i32" });
	const C = ecs.registerComponent({ c0: "i32", c1: "i32", c2: "i32" });
	const T = ecs.registerTag();
	const defs = [
		{ def: A, fields: ["a0", "a1"] },
		{ def: B, fields: ["b0"] },
		{ def: C, fields: ["c0", "c1", "c2"] },
		{ def: T, fields: [] },
	];

	// model: entity -> { comps: Map<defIndex, {field: value}>, disabled: bool }
	const model = new Map();
	const live = [];
	let counter = 0;

	const qA = ecs.query(A);
	const qAB = ecs.query(A, B);
	const qC = ecs.query(C);

	const valuesFor = (d) => {
		const v = {};
		for (const f of d.fields) v[f] = ++counter;
		return v;
	};

	for (let step = 0; step < STEPS; step++) {
		const op = pick(9);
		if (op === 0 || live.length === 0) {
			// spawn, sometimes with a template
			let e;
			if (rand() < 0.5) {
				e = ecs.spawn();
				model.set(e, { comps: new Map(), disabled: false });
			} else {
				const d = defs[pick(3)];
				const v = valuesFor(d);
				const t = ecs.template(d.def(v));
				e = ecs.spawn(t);
				model.set(e, { comps: new Map([[d, { ...v }]]), disabled: false });
			}
			live.push(e);
		} else if (op === 1) {
			const i = pick(live.length);
			const e = live[i];
			ecs.despawn(e);
			model.delete(e);
			live[i] = live[live.length - 1];
			live.pop();
		} else if (op === 2) {
			const e = live[pick(live.length)];
			const d = defs[pick(defs.length)];
			const m = model.get(e);
			if (d.fields.length === 0) {
				ecs.addComponent(e, d.def);
				m.comps.set(d, {});
			} else {
				const v = valuesFor(d);
				ecs.addComponent(e, d.def, v);
				m.comps.set(d, { ...v });
			}
		} else if (op === 3) {
			const e = live[pick(live.length)];
			const d = defs[pick(defs.length)];
			ecs.removeComponent(e, d.def);
			model.get(e).comps.delete(d);
		} else if (op === 4) {
			const e = live[pick(live.length)];
			const m = model.get(e);
			if (m.comps.size > 0 && !m.disabled) {
				ecs.disable(e);
				m.disabled = true;
			}
		} else if (op === 5) {
			const e = live[pick(live.length)];
			const m = model.get(e);
			if (m.disabled) {
				ecs.enable(e);
				m.disabled = false;
			}
		} else if (op === 6) {
			// setField on a held component
			const e = live[pick(live.length)];
			const m = model.get(e);
			const held = [...m.comps.keys()].filter((d) => d.fields.length > 0);
			if (held.length > 0) {
				const d = held[pick(held.length)];
				const f = d.fields[pick(d.fields.length)];
				const v = ++counter;
				ecs.setField(e, d.def, f, v);
				m.comps.get(d)[f] = v;
			}
		} else if (op === 7) {
			// addComponents / removeComponents (multi)
			const e = live[pick(live.length)];
			const m = model.get(e);
			const d1 = defs[pick(defs.length)];
			const d2 = defs[pick(defs.length)];
			if (d1 !== d2) {
				if (rand() < 0.5) {
					const v1 = valuesFor(d1);
					const v2 = valuesFor(d2);
					ecs.addComponents(e, d1.def(v1), d2.def(v2));
					m.comps.set(d1, { ...v1 });
					m.comps.set(d2, { ...v2 });
				} else {
					ecs.removeComponents(e, d1.def, d2.def);
					m.comps.delete(d1);
					m.comps.delete(d2);
				}
			}
		} else {
			// spawnMany
			const d = defs[pick(3)];
			const v = valuesFor(d);
			const t = ecs.template(d.def(v));
			const n = 1 + pick(5);
			const ids = ecs.spawnMany(t, n);
			for (const e of ids) {
				model.set(e, { comps: new Map([[d, { ...v }]]), disabled: false });
				live.push(e);
			}
		}

		// A component-less entity occupies no archetype row, so it cannot carry
		// the enabled/disabled partition — dropping the last component silently
		// clears `disabled`, and re-adding one does NOT restore it. Mirror that.
		for (const m of model.values()) if (m.comps.size === 0) m.disabled = false;

		if (step % 25 !== 0 && step !== STEPS - 1) continue;

		// ── the ECS must hold NO MORE entities than the model ──────────────
		// Everything below walks the MODEL and asserts `model ⊆ ecs`, and the query
		// checks reject an entity that a query yields and the model does not want.
		// Together those cover a leaked entity that still carries `A`, `B` or `C`. They
		// do NOT cover a leaked entity that carries only `T` or no component at all:
		// such an entity is in no query and in no walk of the model, so a despawn that
		// silently kept it alive was invisible. One count closes that hole, because
		// `entityCount` counts a live entity with no component.
		if (ecs.entityCount !== model.size) {
			fail(seed, step, `ecs holds ${ecs.entityCount} live entities, model holds ${model.size}`);
		}

		// ── verify every live entity ───────────────────────────────────────
		for (const [e, m] of model) {
			if (!ecs.isAlive(e)) fail(seed, step, `entity ${e} should be alive`);
			if (ecs.isDisabled(e) !== m.disabled)
				fail(seed, step, `entity ${e} disabled=${ecs.isDisabled(e)} want ${m.disabled}`);
			for (const d of defs) {
				const want = m.comps.get(d);
				if (ecs.hasComponent(e, d.def) !== (want !== undefined))
					fail(seed, step, `entity ${e} has(${d.fields}) mismatch`);
				if (want === undefined) continue;
				for (const f of d.fields) {
					const got = ecs.getField(e, d.def, f);
					if (got !== want[f])
						fail(seed, step, `entity ${e} ${f}=${got} want ${want[f]}`);
				}
			}
		}

		// ── verify query membership + counts ───────────────────────────────
		const checks = [
			[qA, (m) => m.comps.has(defs[0])],
			[qAB, (m) => m.comps.has(defs[0]) && m.comps.has(defs[1])],
			[qC, (m) => m.comps.has(defs[2])],
		];
		for (const [q, pred] of checks) {
			let want = 0;
			for (const m of model.values()) if (pred(m) && !m.disabled) want++;
			if (q.entityCount !== want) fail(seed, step, `query count ${q.entityCount} want ${want}`);
			const seen = new Set();
			q.forEachEntity((e) => seen.add(e));
			if (seen.size !== want) fail(seed, step, `forEachEntity ${seen.size} want ${want}`);
			for (const e of seen) {
				const m = model.get(e);
				if (!m || !pred(m) || m.disabled) fail(seed, step, `query yielded wrong entity ${e}`);
			}
		}

		// ── snapshot round-trip: capture → restore → same hash, same data ──
		if (step % 250 === 0) {
			const h0 = ecs.snapshots.stateHash();
			const bytes = ecs.snapshots.capture();
			// Scribble over the live world between capture and restore, so a
			// restore that silently no-ops cannot pass this check.
			let scribbled = false;
			for (const [e, m] of model) {
				for (const [d, want] of m.comps) {
					if (d.fields.length === 0) continue;
					ecs.setField(e, d.def, d.fields[0], want[d.fields[0]] + 12345);
					scribbled = true;
					break;
				}
				if (scribbled) break;
			}
			if (scribbled && ecs.snapshots.stateHash() === h0)
				fail(seed, step, `stateHash blind to a field write — oracle is vacuous`);
			ecs.snapshots.restore(bytes);
			const h1 = ecs.snapshots.stateHash();
			if (h0 !== h1) fail(seed, step, `stateHash ${h0} → ${h1} across capture/restore`);
			for (const [e, m] of model) {
				for (const [d, want] of m.comps) {
					for (const f of d.fields) {
						const got = ecs.getField(e, d.def, f);
						if (got !== want[f])
							fail(seed, step, `post-restore entity ${e} ${f}=${got} want ${want[f]}`);
					}
				}
			}
		}
	}
	return live.length;
}

function fail(seed, step, msg) {
	console.error(`FAIL seed=${seed} step=${step}: ${msg}`);
	process.exit(1);
}

let total = 0;
for (let s = seed0; s < seed0 + 40; s++) total += runOne(s);
console.log(`ok — 40 seeds × ${STEPS} steps, ${total} entities left live`);
