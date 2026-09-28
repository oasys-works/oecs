/**
 * The suite of benchmark cases for oecs. Use it only for local work.
 *
 * `ab/` runs this suite against the artifacts of the package, and thus the values
 * of `ab/` show the code of the released package. `run.mjs` runs the same suite
 * against a bundle of `src/` from `build.mjs`, which keeps the development guards
 * as branches. Therefore do not compare a value from `run.mjs` with a value from
 * `ab/`. `bench/README.md` gives the full table.
 *
 *   node bench/run.mjs                 # all the cases
 *   node bench/run.mjs iter            # select the cases by a part of the name
 */
import { bench } from "./harness.mjs";

const N = 10_000;

// You cannot measure a world if the timed part makes an archetype larger. The
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
	// A world with every optional subsystem available, on either side of a
	// comparison. A build from before the plugin split carries them on the
	// world already, and has no `ECS.create`. Both sides must measure the same
	// work, so both get the same surface.
	const makeWorld = (options) => {
		if (typeof lib.ECS.create !== "function") return new lib.ECS(options);
		const plugins = [];
		for (const make of [lib.snapshots, lib.events, lib.relations, lib.observers]) {
			if (typeof make === "function") plugins.push(make());
		}
		return lib.ECS.create({ ...options, plugins });
	};
	const { ECS, SCHEDULE } = lib;
	// A build from before 0.7.0 names the iterators `forEach` and `forEachChunk`.
	// Give the new names the old functions. Both sides then make the same call.
	for (const cls of [lib.Query, lib.ChangedQuery]) {
		const proto = cls?.prototype;
		if (proto === undefined || typeof proto.forEachArchetype === "function") continue;
		proto.forEachArchetype = proto.forEach;
		proto.forEachColumns = proto.forEachChunk;
	}
	const cases = [];
	const add = (name, fn, opts) => {
		if (name.includes(filter)) cases.push({ name, fn, opts });
	};

	// ────────────────────────────────────────────────────────────────────────
	// 1. SoA iteration, the core promise. forEachColumns over N entities.
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
					q.forEachColumns((cols, count) => {
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
					q.forEachArchetype((arch) => {
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
	// 2. Fragmented iteration, 64 archetypes, same total entity count.
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
					q.forEachColumns((cols, count) => {
						const { x, y } = cols.mut(Pos);
						for (let i = 0; i < count; i++) x[i] += y[i];
					});
				}
			},
			{ iters: 300 * per * 64 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 3. forEachEntity, the entity-id walk.
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
		add(
			"query/count",
			() => {
				for (let r = 0; r < 100_000; r++) sink = q.entityCount;
			},
			{ iters: 100_000 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 4. Random access, getField and setField / hasComponent.
	// ────────────────────────────────────────────────────────────────────────
	{
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		add(
			"access/getField",
			() => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += ecs.getField(ids[i], Pos, "x");
				sink = s;
			},
			{ iters: 20 * N }
		);
		// Two fields through `getField`. This is not twice the row above, because the entity
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
		// 72 field names at one call site. A name lookup can win with one component
		// and lose here. See the `_fieldIndex` note in `archetype.ts`.
		{
			const ecs = new ECS(PRESIZED);
			const defs = [];
			const names = [];
			for (let c = 0; c < 24; c++) {
				const fields = [`c${c}_a`, `c${c}_b`, `c${c}_c`];
				defs.push(
					ecs.registerComponent({ [fields[0]]: "f64", [fields[1]]: "f64", [fields[2]]: "f64" })
				);
				names.push(fields);
			}
			const M = 1000;
			const many = ecs.spawnMany(ecs.template(...defs.map((d) => d({}))), M);
			add(
				"access/getField_manyNames",
				() => {
					let s = 0;
					for (let r = 0; r < 20; r++)
						for (let i = 0; i < M; i++) {
							const c = (i + r) % 24;
							s += ecs.getField(many[i], defs[c], names[c][(i + c) % 3]);
						}
					sink = s;
				},
				{ iters: 20 * M }
			);
		}
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
		// through the accessor built for a by-id sweep, so a regression that moved
		// one path and not the other is visible as the pair drifting apart. The
		// cursor is hoisted out of the timed region because that is the whole point
		// of it, timing `ecs.cursorRead(...)` inside the loop would measure the
		// allocation a cursor exists to remove.
		// `refRead` sits between the two: it resolves once per entity like a cursor,
		// but allocates an accessor per entity like `getField` does not. Both arities
		// are here because that allocation amortises over fields, the 1-field row is
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
		// both, so this row against the one above prices a single field access,
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
	// 5. Structural churn, spawn, despawn and add / remove.
	// ────────────────────────────────────────────────────────────────────────
	add(
		"struct/spawn_empty",
		(s) => {
			for (let i = 0; i < N; i++) s.ecs.spawn();
		},
		{
			iters: N,
			setup: () => ({ ecs: new ECS() })
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
			}
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
			}
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
			}
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
				// Presized, and not a bare `new ECS()`. Planting the archetype below
				// makes it, but at the default column capacity, which is far below N.
				// The timed loop then moved all N rows into it and paid four column
				// grows inside the measurement, the exact cost this setup exists to
				// keep out. A counter on `growColumnStore` found it. The null run did
				// not, because four grows across 10 × N operations stay below the noise.
				const ecs = new ECS(PRESIZED);
				const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
				const Tag = ecs.registerTag();
				const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
				// Plant the [Pos, Tag] archetype (and its store columns) here,
				// minting one inside the timed loop drags an `extendColumnStore`
				// realloc into the measurement, which is bimodal on heap state.
				ecs.addComponent(ids[0], Tag);
				ecs.removeComponent(ids[0], Tag);
				return { ecs, ids, Tag };
			}
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
			}
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
			}
		}
	);

	// Archetype registration ramp-up, the O(N²) extend cascade, where creating a
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
			}
		}
	);

	// ────────────────────────────────────────────────────────────────────────
	// 6. Schedule dispatch, per-frame fixed cost.
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
						q.forEachColumns((cols, count) => {
							const { x } = cols.mut(Pos);
							for (let j = 0; j < count; j++) x[j] += 1;
						});
					}
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
		for (let i = 0; i < 20; i++) ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({ fn: noop }));
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
						for (let i = 0; i < 1000; i++) spawned.push(ctx.commands.spawn(Pos({ x: 1, y: 1 })));
					} else {
						for (let i = 0; i < spawned.length; i++) ctx.commands.despawn(spawned[i]);
						spawned.length = 0;
					}
				}
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
	// Skipped entirely when the filter excludes it. Building the world anyway
	// put a second world shape (and, on a build with plugins, three extra
	// modules) into a process that was measuring something else, which made a
	// filtered comparison asymmetric between two builds.
	if ("rel/".includes(filter) || filter.startsWith("rel/")) {
		const ecs = makeWorld();
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
		// The sparse cursor is the read by id that the docs recommend: the columns
		// are indexed by entity, so `at` writes one field and a read is one load.
		// It sits beside `getSparseField` so the two paths are visible as a pair.
		// A build from before sparse cursors has no `sparseCursorRead`, so a
		// comparison with such a ref runs without this row.
		if (typeof ecs.sparseCursorRead === "function") {
			const spark = ecs.sparseCursorRead(Spark);
			add(
				"sparse/cursor_read",
				() => {
					let s = 0;
					for (let r = 0; r < 20; r++)
						for (let i = 0; i < N; i += 2) {
							spark.at(ids[i]);
							s += spark.v;
						}
					sink = s;
				},
				{ iters: 20 * (N / 2) }
			);
		}
		// The sparse query driver. `_2` is the `oecs-sparse` shape of `vs/`.
		{
			const q = ecs.query(Pos).andSparse(Spark);
			const spark = ecs.sparseCursorRead(Spark);
			add(
				"iter/sparse_forEachEntity_1",
				() => {
					let s = 0;
					for (let r = 0; r < 20; r++)
						q.forEachEntity((e) => {
							spark.at(e);
							s += spark.v;
						});
					sink = s;
				},
				{ iters: 20 * (N / 2) }
			);
			// A build from before `forEachIds` runs without the batch rows.
			if (typeof q.forEachIds === "function")
				add(
					"iter/sparse_batch_1",
					() => {
						let s = 0;
						for (let r = 0; r < 20; r++)
							q.forEachIds((ids, count) => {
								let t = 0;
								for (let i = 0; i < count; i++) {
									spark.at(ids[i]);
									t += spark.v;
								}
								s += t;
							});
						sink = s;
					},
					{ iters: 20 * (N / 2) }
				);
		}
		{
			const Vel = ecs.registerSparseComponent({ vx: "f64", vy: "f64" });
			for (let i = 0; i < N; i += 2) ecs.addSparse(ids[i], Vel, { vx: 1, vy: 1 });
			const q = ecs.query(Pos).andSparse(Spark, Vel);
			const spark = ecs.sparseCursor(Spark);
			const vel = ecs.sparseCursorRead(Vel);
			add(
				"iter/sparse_forEachEntity_2",
				() => {
					for (let r = 0; r < 20; r++)
						q.forEachEntity((e) => {
							spark.at(e);
							vel.at(e);
							spark.v += vel.vx * 0.016;
						});
				},
				{ iters: 20 * (N / 2) }
			);
			if (typeof q.forEachIds === "function")
				add(
					"iter/sparse_batch_2",
					() => {
						for (let r = 0; r < 20; r++)
							q.forEachIds((ids, count) => {
								for (let i = 0; i < count; i++) {
									const e = ids[i];
									spark.at(e);
									vel.at(e);
									spark.v += vel.vx * 0.016;
								}
							});
					},
					{ iters: 20 * (N / 2) }
				);
		}
		// Membership churn on a sparse tag: a bit flip and no archetype move.
		const SparkTag = ecs.registerSparseTag();
		add(
			"sparse/add_remove_tag",
			() => {
				for (let r = 0; r < 5; r++) {
					for (let i = 0; i < N; i++) ecs.addSparse(ids[i], SparkTag);
					for (let i = 0; i < N; i++) ecs.removeSparse(ids[i], SparkTag);
				}
			},
			{ iters: 10 * N }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 10. Query resolution and composition (cache-hit cost).
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
		// `without` became `not` inside 0.6.0. Pick the body once, before the
		// case runs, so a reference build older than the rename still runs this
		// case and each side keeps a direct call in the measured loop. A shared
		// body behind a resolved reference would add a frame to both sides.
		add(
			"query/compose_not",
			typeof base.not === "function"
				? () => {
						for (let i = 0; i < 200_000; i++) sink = base.not(Tag);
					}
				: () => {
						for (let i = 0; i < 200_000; i++) sink = base.without(Tag);
					},
			{ iters: 200_000 }
		);
	}

	// ────────────────────────────────────────────────────────────────────────
	// 11. The world digest, dense columns and a sparse store.
	// ────────────────────────────────────────────────────────────────────────
	// No plugin store, so the row shows the cost of the storage seam to a world
	// that does not use it. Skipped by the filter, for the reason section 8 gives.
	if ("digest/".includes(filter) || filter.startsWith("digest/")) {
		const ecs = makeWorld({ ...PRESIZED, deterministic: true });
		const Pos = ecs.registerComponent({ x: "i32", y: "i32" });
		const Mark = ecs.registerSparseComponent({ v: "i32" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 2 })), N);
		for (let i = 0; i < N; i += 4) ecs.addSparse(ids[i], Mark, { v: i });
		add(
			"digest/stateHash",
			() => {
				for (let r = 0; r < 10; r++) sink = ecs.snapshots.stateHash();
			},
			{ iters: 10 * N }
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
