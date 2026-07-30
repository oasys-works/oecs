/**
 * The suite of benchmark cases for oecs. Use it only for local work.
 *
 * The suite runs against a bundle with the semantics of the released package
 * (__DEV__ = false). Therefore the values show the hot path of the released
 * package, and not the build with the development guards.
 *
 *   node bench/run.mjs                 # all the cases
 *   node bench/run.mjs iter            # select the cases by a part of the name
 */
import { bench } from "./harness.mjs";

const N = 10_000;

// You cannot measure a world if the TIMED part makes an archetype larger. The
// store makes a new allocation during the timed part, and the cost of that
// allocation has two very different values, because it depends on the condition of
// the heap. A null comparison uses equal code on both sides, and it showed
// differences of as much as 48% for those cases. `columnCapacity` gives each
// column the size of the complete population before the measurement. Therefore the
// store becomes larger during `setup`, which the tool does not measure, and the
// timed loop measures the operation, and not the allocator.
const PRESIZED = { memory: { columnCapacity: Math.round(N * 1.2) } };
// `spawnMany` adds 5×N rows for each sample. Therefore it needs more capacity. Do
// not give that capacity to each case, because the allocator then uses more time,
// and the garbage collector adds more noise.
const PRESIZED_BULK = { memory: { columnCapacity: N * 6 } };

/** @param {typeof import('../src/index.ts')} lib */
export function makeSuite(lib, filter = "") {
	const { ECS, SCHEDULE } = lib;
	const cases = [];
	const add = (name, fn, opts) => {
		if (name.includes(filter)) cases.push({ name, fn, opts });
	};

	// ────────────────────────────────────────────────────────────────────────
	// 1. SoA iteration — the core promise. eachChunk over N entities.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
		const t = ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 1 }));
		ecs.spawnMany(t, N);
		const q = ecs.query(Pos, Vel);
		add(
			"iter/eachChunk_2comp",
			() => {
				for (let r = 0; r < 100; r++) {
					q.eachChunk((cols, count) => {
						const { x, y } = cols.mut(Pos);
						const { vx, vy } = cols.read(Vel);
						for (let i = 0; i < count; i++) {
							x[i] += vx[i] * 0.016;
							y[i] += vy[i] * 0.016;
						}
					});
				}
			},
			{ iters: 100 * N }
		);

		// Baseline: what the raw typed arrays cost with zero ECS overhead.
		const rawX = new Float64Array(N);
		const rawY = new Float64Array(N);
		const rawVX = new Float64Array(N).fill(1);
		const rawVY = new Float64Array(N).fill(1);
		add(
			"iter/raw_typedarray_baseline",
			() => {
				for (let r = 0; r < 100; r++) {
					for (let i = 0; i < N; i++) {
						rawX[i] += rawVX[i] * 0.016;
						rawY[i] += rawVY[i] * 0.016;
					}
				}
			},
			{ iters: 100 * N }
		);

		add(
			"iter/forEach_getColumnRead",
			() => {
				for (let r = 0; r < 100; r++) {
					q.forEach((arch) => {
						const x = arch.getColumnRead(Pos, "x");
						const y = arch.getColumnRead(Pos, "y");
						const n = arch.entityCount;
						let s = 0;
						for (let i = 0; i < n; i++) s += x[i] + y[i];
						sink = s;
					});
				}
			},
			{ iters: 100 * N }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 2. Fragmented iteration — 64 archetypes, same total entity count.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const tags = [];
		for (let i = 0; i < 6; i++) tags.push(ecs.registerTag());
		// 64 archetype variants from a 6-bit tag mask
		const per = Math.floor(N / 64);
		for (let mask = 0; mask < 64; mask++) {
			const items = [Pos({ x: 1, y: 2 })];
			for (let b = 0; b < 6; b++) if (mask & (1 << b)) items.push(tags[b]);
			const t = ecs.template(...items);
			ecs.spawnMany(t, per);
		}
		const q = ecs.query(Pos);
		add(
			"iter/frag_64arch",
			() => {
				for (let r = 0; r < 300; r++) {
					q.eachChunk((cols, count) => {
						const { x, y } = cols.mut(Pos);
						for (let i = 0; i < count; i++) x[i] += y[i];
					});
				}
			},
			{ iters: 300 * per * 64 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 3. forEachEntity — the entity-id walk.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		const q = ecs.query(Pos);
		add(
			"iter/forEachEntity",
			() => {
				for (let r = 0; r < 20; r++) {
					let s = 0;
					q.forEachEntity((e) => {
						s += e;
					});
					sink = s;
				}
			},
			{ iters: 20 * N }
		);
		add("query/count", () => {
			for (let r = 0; r < 100_000; r++) sink = q.entityCount;
		}, { iters: 100_000 });
	}

	// ────────────────────────────────────────────────────────────────────────
	// 4. Random access — getField / setField / hasComponent.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		add(
			"access/getField",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], Pos, "x");
				sink = s;
			},
			{ iters: 20 * N }
		);
		// Two fields through `getField`. NOT simply twice the row above: the entity
		// resolution is repeated, but the second call hits a warm cache line, so the
		// real figure lands below double. The docs table quotes this row rather than
		// doubling, which is why it exists.
		add(
			"access/getField_2fields",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++)
						s += ecs.getField(ids[i], Pos, "x") + ecs.getField(ids[i], Pos, "y");
				sink = s;
			},
			{ iters: 20 * N }
		);
		add(
			"access/setField",
			() => {
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) ecs.setField(ids[i], Pos, "x", i);
			},
			{ iters: 20 * N }
		);
		add(
			"access/hasComponent",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += ecs.hasComponent(ids[i], Pos) ? 1 : 0;
				sink = s;
			},
			{ iters: 20 * N }
		);
		add(
			"access/isAlive",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.isAlive(ids[i]) ? 1 : 0;
				sink = s;
			},
			{ iters: 20 * N }
		);
		// The cursor rows sit beside `getField` deliberately: they are the same work
		// through the accessor built for a by-id SWEEP, so a regression that moved
		// one path and not the other is visible as the pair drifting apart. The
		// cursor is hoisted out of the timed region because that is the whole point
		// of it — timing `ecs.cursorRead(...)` inside the loop would measure the
		// allocation a cursor exists to remove.
		// `refRead` sits between the two: it resolves once per entity like a cursor,
		// but allocates an accessor per entity like `getField` does not. Both arities
		// are here because that allocation amortises over fields — the 1-field row is
		// close to `getField`, the 2-field row is not.
		add(
			"access/refRead_1field",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += ecs.refRead(Pos, ids[i]).x;
				sink = s;
			},
			{ iters: 20 * N }
		);
		add(
			"access/refRead_2fields",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) {
						const p = ecs.refRead(Pos, ids[i]);
						s += p.x + p.y;
					}
				sink = s;
			},
			{ iters: 20 * N }
		);
		const posRead = ecs.cursorRead(Pos);
		const posMut = ecs.cursor(Pos);
		add(
			"access/cursor_read_1field",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) {
						posRead.at(ids[i]);
						s += posRead.x;
					}
				sink = s;
			},
			{ iters: 20 * N }
		);
		// Two fields per repoint. `at()` is the resolution, and it is paid once for
		// both — so this row against the one above prices a single field access,
		// which is what tells a reader when a cursor beats `getField` per call.
		add(
			"access/cursor_read_2fields",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) {
						posRead.at(ids[i]);
						s += posRead.x + posRead.y;
					}
				sink = s;
			},
			{ iters: 20 * N }
		);
		// The mutable variant, whose `at()` also stamps the component change tick.
		// Held apart from the read-only row so that stamp has a price of its own.
		add(
			"access/cursor_write",
			() => {
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) {
						posMut.at(ids[i]);
						posMut.x = i;
					}
			},
			{ iters: 20 * N }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 5. Structural churn — spawn / despawn / add / remove.
	// ────────────────────────────────────────────────────────────────────────
	add(
		"struct/spawn_empty",
		(s) => {
			for (let i = 0; i < N; i++) s.ecs.spawn();
		},
		{
			iters: N,
			setup: () => ({ ecs: new ECS() }),
		}
	);

	add(
		"struct/spawn_template",
		(s) => {
			for (let i = 0; i < 3 * N; i++) s.ecs.spawn(s.t);
		},
		{
			iters: 3 * N,
			setup: () => {
				const ecs = new ECS(PRESIZED_BULK);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
				return { ecs, t: ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0, vy: 0 })) };
			},
		}
	);

	add(
		"struct/spawnMany",
		(s) => {
			for (let r = 0; r < 5; r++) s.ecs.spawnMany(s.t, N);
		},
		{
			iters: 5 * N,
			setup: () => {
				const ecs = new ECS(PRESIZED_BULK);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
				return { ecs, t: ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0, vy: 0 })) };
			},
		}
	);

	add(
		"struct/despawn",
		(s) => {
			for (let i = 0; i < s.ids.length; i++) s.ecs.despawn(s.ids[i]);
		},
		{
			iters: N,
			setup: () => {
				const ecs = new ECS(PRESIZED);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
				return { ecs, ids };
			},
		}
	);

	add(
		"struct/add_remove_cycle",
		(s) => {
			const { ecs, ids, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Tag);
				for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Tag);
			}
		},
		{
			iters: 10 * N,
			setup: () => {
				// PRESIZED, and not a bare `new ECS()`. Planting the archetype below
				// makes it, but at the DEFAULT column capacity, which is far below N.
				// The timed loop then moved all N rows into it and paid four column
				// grows inside the measurement — the exact cost this setup exists to
				// keep out. A counter on `growColumnStore` found it; the null run did
				// not, because four grows across 10·N operations stay below the noise.
				const ecs = new ECS(PRESIZED);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Tag = ecs.registerTag();
				const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
				// Plant the [Pos, Tag] archetype (and its store columns) here —
				// minting one inside the timed loop drags an `extendColumnStore`
				// realloc into the measurement, which is bimodal on heap state.
				ecs.addComponent(ids[0], Tag);
				ecs.removeComponent(ids[0], Tag);
				return { ecs, ids, Tag };
			},
		}
	);

	// Steady state (no archetype growth after the first cycle): the pure
	// 2-col → 4-col row-move cost.
	add(
		"struct/add_remove_valued",
		(s) => {
			const { ecs, ids, Vel } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Vel, { vx: 1, vy: 2 });
				for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Vel);
			}
		},
		{
			iters: 10 * N,
			setup: () => {
				const ecs = new ECS();
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
				const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
				// warm the target archetype to full capacity so the timed loop
				// never triggers a store realloc
				for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Vel, { vx: 1, vy: 2 });
				for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Vel);
				return { ecs, ids, Vel };
			},
		}
	);

	add(
		"struct/addComponent_valued",
		(s) => {
			const { ecs, ids, Vel } = s;
			for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Vel, { vx: 1, vy: 2 });
		},
		{
			iters: 3 * N,
			setup: () => {
				const ecs = new ECS(PRESIZED_BULK);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
				const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), 3 * N);
				// Plant the [Pos, Vel] archetype + columns outside the timed loop.
				ecs.addComponent(ids[0], Vel, { vx: 1, vy: 2 });
				ecs.removeComponent(ids[0], Vel);
				return { ecs, ids, Vel };
			},
		}
	);

	// Archetype registration ramp-up — the O(N²) extend cascade, where creating a
	// new archetype re-publishes column views to every existing one. `refreshViews`
	// is tuned to be allocation-free there, and the row plane adds work to it, so
	// it needs its own case.
	add(
		"struct/archetype_rampup",
		(s) => {
			const { ecs, Pos, tags } = s;
			// 2^8 distinct component sets, each materialised by one spawn
			for (let mask = 1; mask < 256; mask++) {
				const items = [Pos({ x: 1, y: 2 })];
				for (let b = 0; b < 8; b++) if (mask & (1 << b)) items.push(tags[b]);
				ecs.spawn(ecs.template(...items));
			}
		},
		{
			iters: 255,
			setup: () => {
				const ecs = new ECS();
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const tags = [];
				for (let i = 0; i < 8; i++) tags.push(ecs.registerComponent({ v: "f64" }));
				return { ecs, Pos, tags };
			},
		}
	);

	// ────────────────────────────────────────────────────────────────────────
	// 6. Schedule dispatch — per-frame fixed cost.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), 100);
		const q = ecs.query(Pos);
		for (let i = 0; i < 20; i++) {
			ecs.addSystems(
				SCHEDULE.UPDATE,
				ecs.registerSystem({
					writes: [Pos],
					fn: () => {
						q.eachChunk((cols, count) => {
							const { x } = cols.mut(Pos);
							for (let j = 0; j < count; j++) x[j] += 1;
						});
					},
				})
			);
		}
		ecs.startup();
		add(
			"sched/update_20systems",
			() => {
				for (let f = 0; f < 5_000; f++) ecs.update(0.016);
			},
			{ iters: 5_000 }
		);
	}

	{
		const ecs = new ECS();
		const noop = () => {};
		for (let i = 0; i < 20; i++)
			ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({ fn: noop }));
		ecs.startup();
		add(
			"sched/update_20noop",
			() => {
				for (let f = 0; f < 20_000; f++) ecs.update(0.016);
			},
			{ iters: 20_000 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 7. Deferred commands from inside a system.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		let mode = 0;
		const spawned = [];
		ecs.addSystems(
			SCHEDULE.UPDATE,
			ecs.registerSystem({
				writes: [Pos],
				fn: (ctx) => {
					if (mode === 0) {
						for (let i = 0; i < 1000; i++)
							spawned.push(ctx.commands.spawn(Pos({ x: 1, y: 1 })));
					} else {
						for (let i = 0; i < spawned.length; i++) ctx.commands.despawn(spawned[i]);
						spawned.length = 0;
					}
				},
			})
		);
		ecs.startup();
		add(
			"cmd/spawn_despawn_1000",
			() => {
				for (let f = 0; f < 600; f++) {
					mode = 0;
					ecs.update(0.016);
					mode = 1;
					ecs.update(0.016);
				}
			},
			{ iters: 600 * 2000 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 8. Relations.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const ChildOf = ecs.relations.register({ mode: "exclusive" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		for (let i = 1; i < N; i++) ecs.relations.add(ids[i], ChildOf, ids[i >> 1]);
		add(
			"rel/targetOf",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 1; i < N; i++) s += ecs.relations.targetOf(ids[i], ChildOf) ?? 0;
				sink = s;
			},
			{ iters: 20 * N }
		);
		add(
			"rel/sourcesOf",
			() => {
				let s = 0;
				for (let r = 0; r < 5; r++)
					for (let i = 0; i < 2000; i++) s += ecs.relations.sourcesOf(ids[i], ChildOf).length;
				sink = s;
			},
			{ iters: 5 * 2000 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 9. Sparse components.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Spark = ecs.registerSparseComponent({ v: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		for (let i = 0; i < N; i += 2) ecs.addSparse(ids[i], Spark, { v: 1 });
		add(
			"sparse/hasSparse",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += ecs.hasSparse(ids[i], Spark) ? 1 : 0;
				sink = s;
			},
			{ iters: 20 * N }
		);
		add(
			"sparse/getSparseField",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i += 2) s += ecs.getSparseField(ids[i], Spark, "v");
				sink = s;
			},
			{ iters: 20 * (N / 2) }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 10. Query resolution / composition (cache-hit cost).
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
		const Tag = ecs.registerTag();
		ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 }), Vel({ vx: 1, vy: 1 })), 1000);
		add(
			"query/resolve_cached",
			() => {
				for (let i = 0; i < 200_000; i++) sink = ecs.query(Pos, Vel);
			},
			{ iters: 200_000 }
		);
		const base = ecs.query(Pos, Vel);
		add(
			"query/compose_without",
			() => {
				for (let i = 0; i < 200_000; i++) sink = base.without(Tag);
			},
			{ iters: 200_000 }
		);
	}

	return cases;
}

export let sink;

export function runSuite(lib, filter) {
	const cases = makeSuite(lib, filter ?? "");
	const results = [];
	for (const c of cases) results.push(bench(c.name, c.fn, c.opts));
	return results;
}
