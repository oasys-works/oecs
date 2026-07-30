/**
 * The definitions of the cases for the comparison. `IMPLS` at the end of this file
 * is the authority on which libraries take part.
 *
 * There is one factory for each library, and each factory returns
 * `{ [caseName]: {fn, iters, setup?, check?} }`. Each implementation obeys one
 * rule: USE THE METHOD THAT THE LIBRARY ITSELF RECOMMENDS. Therefore each library
 * gets the fastest path for access in its own documentation. The cases do not use
 * one common form, because a common form gives an advantage to the library that it
 * fits. If a library keeps no component data itself (piecs), the tool measures the
 * typed arrays that the library requires from the caller.
 *
 * That rule has a second half, and the two halves can disagree. A METHOD that the
 * documentation recommends is not always a CALL to the library. miniplex holds an
 * entity as a plain object, and thus a user tests for a component with a property
 * read. But miniplex also has `Bucket.has(entity)`, and wolf-ecs is reported as
 * absent for the same case because it has no equivalent. The rule is applied the
 * same way in both places: where the library HAS a membership call, the case uses
 * that call. Refer to the note above the miniplex `has` case.
 *
 * The set of cases includes a case only if all the libraries can do the same work.
 * Therefore the set does NOT include relations, observers, change detection or
 * snapshots. Most of the libraries have none of these functions. A comparison
 * of features must include them, but a benchmark cannot.
 *
 * N and the numbers of repetitions are equal to the values in `bench/suite.mjs`.
 * Therefore you can compare the column for oecs directly with the values that the
 * suite reports. `read_by_id` reads the ids in the sequence of their creation, and
 * `bench/suite.mjs` does the same. Do not change one without the other.
 */
export const N = 10_000;
const DT = 0.016;
const FRAG_BITS = 6; // 2^6 = 64 archetype variants
const FRAG_ARCH = 1 << FRAG_BITS;
const FRAG_PER = Math.floor(N / FRAG_ARCH);

/** The accumulator of the last timed loop. Each `fn` that only READS writes its sum
 * here, so that the engine cannot remove the loop as dead code.
 *
 * `read_by_id` and `has` also use it as their CHECKSUM (`check: () => sink`). That
 * is correct, because `child.mjs` makes one process for one library and one case:
 * no other case can write `sink` in that process, and `check` runs after the last
 * sample. Both cases must give exactly `20 * N`. Each library seeds `x = 1` for
 * every one of the N entities, and each library holds the component on all of them.
 * Therefore the sum of `20 * N` reads of `1`, and the count of `20 * N` results of
 * `true`, are the same number for every library. A read outside an array gives
 * `undefined`, and thus NaN, and the comparison in `vs.mjs` then fails loudly. */
export let sink = 0;

/**
 * Prevents the error that made the first value for bitECS incorrect. If a library
 * uses the ENTITY ID as the index of its component storage, the arrays must have the
 * size of the highest id, and not the size of the number of entities. A store to an
 * index outside a typed array does not throw an error, and it does not write the
 * value. It removes the value, and it also makes the engine deoptimize the loop.
 * The result looks like a slow library.
 */
function assertIdsFit(ids, cap, where) {
	let max = -1;
	for (let i = 0; i < ids.length; i++) if (ids[i] > max) max = ids[i];
	if (max >= cap) {
		throw new Error(`${where}: max entity id ${max} does not fit storage of ${cap}`);
	}
}

// ── oecs ────────────────────────────────────────────────────────────────────
export function oecsCases(lib) {
	const { ECS } = lib;
	// These values are equal to the values in suite.mjs. A column with the full size
	// moves the new allocation of the store into the setup, which the tool does not
	// measure. Therefore the timed part measures the operation, and not the allocator.
	const PRESIZED = { memory: { columnCapacity: Math.round(N * 1.2) } };
	const PRESIZED_BULK = { memory: { columnCapacity: N * 6 } };
	const cases = {};

	{
		const ecs = new ECS(PRESIZED);
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
		ecs.spawnMany(ecs.template(Pos({ x: 0, y: 0 }), Vel({ vx: 1, vy: 1 })), N);
		const q = ecs.query(Pos, Vel);
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					q.eachChunk((cols, count) => {
						const { x, y } = cols.mut(Pos);
						const { vx, vy } = cols.read(Vel);
						for (let i = 0; i < count; i++) {
							x[i] += vx[i] * DT;
							y[i] += vy[i] * DT;
						}
					});
				}
			},
			check: () => {
				let s = 0;
				q.eachChunk((cols, count) => {
					const { x } = cols.read(Pos);
					for (let i = 0; i < count; i++) s += x[i];
				});
				return s;
			},
		};
	}

	{
		const ecs = new ECS(PRESIZED);
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const tags = [];
		for (let i = 0; i < FRAG_BITS; i++) tags.push(ecs.registerTag());
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			const items = [Pos({ x: 0, y: 0 })];
			for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) items.push(tags[b]);
			ecs.spawnMany(ecs.template(...items), FRAG_PER);
		}
		const q = ecs.query(Pos);
		// The case uses `x += 2` against columns with the initial value zero, and it
		// does not use `x += y`. Each library here makes the initial value zero. But
		// the libraries do NOT all give a method to set a column at the spawn: the
		// `Entity.make` function of harmony with a tag in the type does not do it.
		// Therefore a constant increment is the only form that gives a checksum that
		// you can compare across all the libraries. This case measures the dispatch
		// for each archetype across 64 archetypes. The removal of the second read of
		// a column makes no change to that measurement.
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					q.eachChunk((cols, count) => {
						const { x } = cols.mut(Pos);
						for (let i = 0; i < count; i++) x[i] += 2;
					});
				}
			},
			check: () => {
				let s = 0;
				q.eachChunk((cols, count) => {
					const { x } = cols.read(Pos);
					for (let i = 0; i < count; i++) s += x[i];
				});
				return s;
			},
		};
	}

	{
		const ecs = new ECS(PRESIZED);
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		// The cursor is outside the loop. A cursor is the accessor that oecs
		// recommends for access to many entities by id, and it is the equivalent of
		// the `const { x } = Pos` that bitECS puts outside its own loop.
		//
		// This case used `getField` before. `getField` is the incorrect path for this
		// shape, because it finds the NAME of the field at each call.
		// `probe-fieldname.mjs` gives 6.5 ns to 7.9 ns for that operation alone. A
		// cursor finds the offset of the column one time. Therefore a read of a field
		// is one index operation. `probe-refcursor.mjs` gives 13.42 ns for a cursor,
		// and 20.35 ns for `getField`.
		//
		// The case uses `cursorRead`, and not `cursor`, because the case only reads. A
		// mutable cursor sets the change tick at each `at()` call. No other library in
		// this table records a change during a read. Therefore the read-only cursor is
		// the equal comparison.
		const pos = ecs.cursorRead(Pos);
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) {
						pos.at(ids[i]);
						s += pos.x;
					}
				sink = s;
			},
			check: () => sink,
		};
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += ecs.hasComponent(ids[i], Pos) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const ecs = new ECS(PRESIZED_BULK);
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
			return { ecs, t: ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0, vy: 0 })) };
		},
		fn: (s) => {
			for (let i = 0; i < 3 * N; i++) s.ecs.spawn(s.t);
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const ecs = new ECS(PRESIZED);
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
			return { ecs, ids };
		},
		fn: (s) => {
			for (let i = 0; i < s.ids.length; i++) s.ecs.despawn(s.ids[i]);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const ecs = new ECS(PRESIZED);
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const Tag = ecs.registerTag();
			const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
			// Make the [Pos, Tag] archetype outside the timed part.
			ecs.addComponent(ids[0], Tag);
			ecs.removeComponent(ids[0], Tag);
			return { ecs, ids, Tag };
		},
		fn: (s) => {
			const { ecs, ids, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Tag);
				for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Tag);
			}
		},
	};

	return cases;
}

// ── bitECS 0.4 ──────────────────────────────────────────────────────────────
// Components are plain user-owned storage; SoA typed arrays are the documented
// fast shape. `query` returns a dense entity array, so the idiomatic hot loop is
// an indexed walk over it — there is no chunked column API to use instead.
export function bitecsCases(lib) {
	const {
		createWorld,
		addEntity,
		addComponent,
		addComponents,
		removeComponent,
		removeEntity,
		hasComponent,
		query,
	} = lib;
	const cases = {};

	{
		const world = createWorld();
		// SIZED FOR THE MAX ENTITY ID, NOT THE ENTITY COUNT. bitECS ids run 1..N, so
		// a `Float64Array(N)` puts index N out of bounds — and an OOB typed-array
		// store does not throw, it silently drops the write AND deoptimises the
		// enclosing loop. Getting this wrong reported bitECS 5× slower than it is.
		// This is exactly what the cross-library checksum below exists to catch.
		const CAP = N + 2;
		const Pos = { x: new Float64Array(CAP), y: new Float64Array(CAP) };
		const Vel = { vx: new Float64Array(CAP), vy: new Float64Array(CAP) };
		const ids = [];
		for (let i = 0; i < N; i++) {
			const e = addEntity(world);
			addComponent(world, e, Pos);
			addComponent(world, e, Vel);
			Vel.vx[e] = 1;
			Vel.vy[e] = 1;
			ids.push(e);
		}
		assertIdsFit(ids, CAP, "bitecs/iter2");
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					const ents = query(world, [Pos, Vel]);
					const { x, y } = Pos;
					const { vx, vy } = Vel;
					for (let i = 0; i < ents.length; i++) {
						const e = ents[i];
						x[e] += vx[e] * DT;
						y[e] += vy[e] * DT;
					}
				}
			},
			check: () => {
				let s = 0;
				const ents = query(world, [Pos, Vel]);
				for (let i = 0; i < ents.length; i++) s += Pos.x[ents[i]];
				return s;
			},
		};
	}

	{
		const world = createWorld();
		const CAP = N + 2;
		const Pos = { x: new Float64Array(CAP), y: new Float64Array(CAP) };
		const tags = [];
		for (let i = 0; i < FRAG_BITS; i++) tags.push({});
		const ids = [];
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			for (let k = 0; k < FRAG_PER; k++) {
				const e = addEntity(world);
				addComponent(world, e, Pos);
				for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) addComponent(world, e, tags[b]);
				ids.push(e);
			}
		}
		assertIdsFit(ids, CAP, "bitecs/iter_frag");
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					const ents = query(world, [Pos]);
					const { x } = Pos;
					for (let i = 0; i < ents.length; i++) x[ents[i]] += 2;
				}
			},
			check: () => {
				let s = 0;
				const ents = query(world, [Pos]);
				for (let i = 0; i < ents.length; i++) s += Pos.x[ents[i]];
				return s;
			},
		};
	}

	{
		const world = createWorld();
		const Pos = { x: new Float64Array(N + 1), y: new Float64Array(N + 1) };
		const ids = [];
		for (let i = 0; i < N; i++) {
			const e = addEntity(world);
			addComponent(world, e, Pos);
			Pos.x[e] = 1;
			ids.push(e);
		}
		assertIdsFit(ids, N + 1, "bitecs/read_by_id");
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				const { x } = Pos;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += x[ids[i]];
				sink = s;
			},
			check: () => sink,
		};
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += hasComponent(world, ids[i], Pos) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const world = createWorld();
			const Pos = { x: new Float64Array(3 * N + 1), y: new Float64Array(3 * N + 1) };
			const Vel = { vx: new Float64Array(3 * N + 1), vy: new Float64Array(3 * N + 1) };
			return { world, Pos, Vel };
		},
		// `addComponents` (plural) applies both in one call — bitECS's own bundle path,
		// and the fair counterpart to oecs spawning from a template. Two separate
		// `addComponent` calls would charge bitECS an extra archetype move that its API
		// does not require.
		fn: (s) => {
			const { world, Pos, Vel } = s;
			for (let i = 0; i < 3 * N; i++) {
				const e = addEntity(world);
				addComponents(world, e, Pos, Vel);
				Pos.x[e] = 1;
				Pos.y[e] = 2;
			}
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const world = createWorld();
			const Pos = { x: new Float64Array(N + 1), y: new Float64Array(N + 1) };
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = addEntity(world);
				addComponent(world, e, Pos);
				ids.push(e);
			}
			return { world, ids };
		},
		fn: (s) => {
			for (let i = 0; i < s.ids.length; i++) removeEntity(s.world, s.ids[i]);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const world = createWorld();
			const Pos = { x: new Float64Array(N + 1), y: new Float64Array(N + 1) };
			const Tag = {};
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = addEntity(world);
				addComponent(world, e, Pos);
				ids.push(e);
			}
			addComponent(world, ids[0], Tag);
			removeComponent(world, ids[0], Tag);
			return { world, ids, Tag };
		},
		fn: (s) => {
			const { world, ids, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) addComponent(world, ids[i], Tag);
				for (let i = 0; i < ids.length; i++) removeComponent(world, ids[i], Tag);
			}
		},
	};

	return cases;
}

// ── harmony-ecs ─────────────────────────────────────────────────────────────
// Namespaced API. `Schema.makeBinary` is the SoA (TypedArray) storage class and
// a query iterates `[entities, [columns…]]` per matched archetype — the closest
// analogue to oecs's `eachChunk`, and what the README's own example uses.
export function harmonyCases(lib) {
	const { World, Schema, Entity, Query, Format } = lib;
	const V2 = { x: Format.float64, y: Format.float64 };
	const cases = {};

	{
		const world = World.make(N * 8);
		const Pos = Schema.makeBinary(world, V2);
		const Vel = Schema.makeBinary(world, V2);
		const Kinetic = [Pos, Vel];
		for (let i = 0; i < N; i++) Entity.make(world, Kinetic, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
		const q = Query.make(world, Kinetic);
		// A harmony query is an array of `[entities, columns]` tuples, so both the
		// README's `for..of` and a plain indexed walk are valid. The indexed form is
		// used because it is the faster of the two available paths (the iterator
		// allocation costs ~3× — see `probe-query.mjs`), and every library here gets
		// its best documented path.
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					for (let a = 0; a < q.length; a++) {
						const [entities, [p, v]] = q[a];
						for (let i = 0; i < entities.length; i++) {
							p.x[i] += v.x[i] * DT;
							p.y[i] += v.y[i] * DT;
						}
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < q.length; a++) {
					const [entities, [p]] = q[a];
					for (let i = 0; i < entities.length; i++) s += p.x[i];
				}
				return s;
			},
		};
	}

	{
		const world = World.make(N * 8);
		const Pos = Schema.makeBinary(world, V2);
		const tags = [];
		for (let i = 0; i < FRAG_BITS; i++) tags.push(Schema.makeTag(world));
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			const type = [Pos];
			for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) type.push(tags[b]);
			type.sort((a, b) => a - b);
			for (let k = 0; k < FRAG_PER; k++) Entity.make(world, type);
		}
		const q = Query.make(world, [Pos]);
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					for (let a = 0; a < q.length; a++) {
						const [entities, [p]] = q[a];
						for (let i = 0; i < entities.length; i++) p.x[i] += 2;
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < q.length; a++) {
					const [entities, [p]] = q[a];
					for (let i = 0; i < entities.length; i++) s += p.x[i];
				}
				return s;
			},
		};
	}

	{
		const world = World.make(N * 8);
		const Pos = Schema.makeBinary(world, V2);
		const ids = [];
		for (let i = 0; i < N; i++) ids.push(Entity.make(world, [Pos], [{ x: 1, y: 1 }]));
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += Entity.get(world, ids[i], Pos).x;
				sink = s;
			},
			check: () => sink,
		};
		// `Entity.has` takes a TYPE (an array of schemas), not a single schema, and
		// re-normalises it on every call — an allocation and a sort per probe. That
		// is the library's own code on its own documented path, so it is measured
		// rather than worked around; the shape of the API is part of what is being
		// compared. The type array is hoisted so the loop is not also measuring a
		// literal allocation the caller could have avoided.
		const posType = [Pos];
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += Entity.has(world, ids[i], posType) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const world = World.make(N * 8);
			const Pos = Schema.makeBinary(world, V2);
			const Vel = Schema.makeBinary(world, V2);
			return { world, type: [Pos, Vel] };
		},
		fn: (s) => {
			for (let i = 0; i < 3 * N; i++) Entity.make(s.world, s.type);
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const world = World.make(N * 8);
			const Pos = Schema.makeBinary(world, V2);
			const ids = [];
			for (let i = 0; i < N; i++) ids.push(Entity.make(world, [Pos]));
			return { world, ids };
		},
		fn: (s) => {
			for (let i = 0; i < s.ids.length; i++) Entity.destroy(s.world, s.ids[i]);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const world = World.make(N * 8);
			const Pos = Schema.makeBinary(world, V2);
			const Tag = Schema.makeTag(world);
			const ids = [];
			for (let i = 0; i < N; i++) ids.push(Entity.make(world, [Pos]));
			Entity.set(world, ids[0], [Tag]);
			Entity.unset(world, ids[0], [Tag]);
			return { world, ids, Tag };
		},
		fn: (s) => {
			const { world, ids, Tag } = s;
			const t = [Tag];
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) Entity.set(world, ids[i], t);
				for (let i = 0; i < ids.length; i++) Entity.unset(world, ids[i], t);
			}
		},
	};

	return cases;
}

// ── wolf-ecs ────────────────────────────────────────────────────────────────
// `defineComponent` returns the SoA storage directly, and `Query.forEach` walks
// entity ids. Storage is indexed by entity id, so the hot loop is an id-indexed
// walk — same shape as bitECS.
export function wolfCases(lib) {
	const { ECS, types, all } = lib;
	const cases = {};
	const MAX = N * 8;

	{
		const ecs = new ECS(MAX);
		const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
		const Vel = ecs.defineComponent({ vx: types.f64, vy: types.f64 });
		for (let i = 0; i < N; i++) {
			const e = ecs.createEntity();
			ecs.addComponent(e, Pos, false);
			ecs.addComponent(e, Vel, false);
			Vel.vx[e] = 1;
			Vel.vy[e] = 1;
		}
		const q = ecs.createQuery(all(Pos, Vel));
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				const { x, y } = Pos;
				const { vx, vy } = Vel;
				for (let r = 0; r < 100; r++) {
					for (let a = 0; a < q.archetypes.length; a++) {
						const ents = q.archetypes[a].entities;
						for (let i = 0; i < ents.length; i++) {
							const e = ents[i];
							x[e] += vx[e] * DT;
							y[e] += vy[e] * DT;
						}
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < q.archetypes.length; a++) {
					const ents = q.archetypes[a].entities;
					for (let i = 0; i < ents.length; i++) s += Pos.x[ents[i]];
				}
				return s;
			},
		};
	}

	{
		const ecs = new ECS(MAX);
		const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
		const tags = [];
		for (let i = 0; i < FRAG_BITS; i++) tags.push(ecs.defineComponent());
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			for (let k = 0; k < FRAG_PER; k++) {
				const e = ecs.createEntity();
				ecs.addComponent(e, Pos, false);
				for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) ecs.addComponent(e, tags[b], false);
			}
		}
		const q = ecs.createQuery(all(Pos));
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				const { x } = Pos;
				for (let r = 0; r < 300; r++) {
					for (let a = 0; a < q.archetypes.length; a++) {
						const ents = q.archetypes[a].entities;
						for (let i = 0; i < ents.length; i++) x[ents[i]] += 2;
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < q.archetypes.length; a++) {
					const ents = q.archetypes[a].entities;
					for (let i = 0; i < ents.length; i++) s += Pos.x[ents[i]];
				}
				return s;
			},
		};
	}

	{
		const ecs = new ECS(MAX);
		const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
		const ids = [];
		for (let i = 0; i < N; i++) {
			const e = ecs.createEntity();
			ecs.addComponent(e, Pos, false);
			Pos.x[e] = 1;
			ids.push(e);
		}
		assertIdsFit(ids, Pos.x.length, "wolf/read_by_id");
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				const { x } = Pos;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += x[ids[i]];
				sink = s;
			},
			check: () => sink,
		};
		// wolf-ecs exposes no public per-entity membership test; the archetype
		// mask check its own query path uses is protected. Reported as absent
		// rather than emulated with a hand-rolled probe that would not be the
		// library's own code.
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const ecs = new ECS(MAX);
			const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
			const Vel = ecs.defineComponent({ vx: types.f64, vy: types.f64 });
			return { ecs, Pos, Vel };
		},
		fn: (s) => {
			const { ecs, Pos, Vel } = s;
			for (let i = 0; i < 3 * N; i++) {
				const e = ecs.createEntity();
				ecs.addComponent(e, Pos, false);
				ecs.addComponent(e, Vel, false);
				Pos.x[e] = 1;
				Pos.y[e] = 2;
			}
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const ecs = new ECS(MAX);
			const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = ecs.createEntity();
				ecs.addComponent(e, Pos, false);
				ids.push(e);
			}
			return { ecs, ids };
		},
		fn: (s) => {
			for (let i = 0; i < s.ids.length; i++) s.ecs.destroyEntity(s.ids[i], false);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const ecs = new ECS(MAX);
			const Pos = ecs.defineComponent({ x: types.f64, y: types.f64 });
			const Tag = ecs.defineComponent();
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = ecs.createEntity();
				ecs.addComponent(e, Pos, false);
				ids.push(e);
			}
			ecs.addComponent(ids[0], Tag, false);
			ecs.removeComponent(ids[0], Tag, false);
			return { ecs, ids, Tag };
		},
		fn: (s) => {
			const { ecs, ids, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Tag, false);
				for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Tag, false);
			}
		},
	};

	return cases;
}

// ── piecs ───────────────────────────────────────────────────────────────────
// piecs stores NO component data: `createComponentId()` mints a bit, and the
// caller owns the arrays. So the storage measured here is host Float64Arrays
// indexed by entity id, which is what the library's own README prescribes.
// Queries are expressed as systems and iterated per archetype.
export function piecsCases(lib) {
	const { World, buildQuery, createArchetypeSystem } = lib;
	const cases = {};

	{
		const x = new Float64Array(N + 1);
		const y = new Float64Array(N + 1);
		const vx = new Float64Array(N + 1).fill(1);
		const vy = new Float64Array(N + 1).fill(1);
		let archetypes = [];
		const world = new World();
		{
			const Pos = world.createComponentId();
			const Vel = world.createComponentId();
			world.registerSystem(
				createArchetypeSystem(
					(arch) => {
						archetypes = arch;
					},
					buildQuery((b) => b.every(Pos, Vel))
				)
			);
			world.initialize();
			for (let i = 0; i < N; i++) {
				const e = world.createEntity();
				world.addComponent(e, Pos);
				world.addComponent(e, Vel);
			}
		}
		world.update(); // resolve the archetype list once, outside the timed region
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					for (let a = 0; a < archetypes.length; a++) {
						const ents = archetypes[a].entities;
						for (let i = 0; i < ents.length; i++) {
							const e = ents[i];
							x[e] += vx[e] * DT;
							y[e] += vy[e] * DT;
						}
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < archetypes.length; a++) {
					const ents = archetypes[a].entities;
					for (let i = 0; i < ents.length; i++) s += x[ents[i]];
				}
				return s;
			},
		};
	}

	{
		const x = new Float64Array(N + 1);
		let archetypes = [];
		const world = new World();
		{
			const Pos = world.createComponentId();
			const tags = [];
			for (let i = 0; i < FRAG_BITS; i++) tags.push(world.createComponentId());
			world.registerSystem(
				createArchetypeSystem(
					(arch) => {
						archetypes = arch;
					},
					buildQuery((b) => b.every(Pos))
				)
			);
			world.initialize();
			for (let mask = 0; mask < FRAG_ARCH; mask++) {
				for (let k = 0; k < FRAG_PER; k++) {
					const e = world.createEntity();
					world.addComponent(e, Pos);
					for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) world.addComponent(e, tags[b]);
				}
			}
		}
		world.update();
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					for (let a = 0; a < archetypes.length; a++) {
						const ents = archetypes[a].entities;
						for (let i = 0; i < ents.length; i++) x[ents[i]] += 2;
					}
				}
			},
			check: () => {
				let s = 0;
				for (let a = 0; a < archetypes.length; a++) {
					const ents = archetypes[a].entities;
					for (let i = 0; i < ents.length; i++) s += x[ents[i]];
				}
				return s;
			},
		};
	}

	{
		const x = new Float64Array(N + 1).fill(1);
		const world = new World();
		const Pos = world.createComponentId();
		const ids = [];
		world.initialize();
		for (let i = 0; i < N; i++) {
			const e = world.createEntity();
			world.addComponent(e, Pos);
			ids.push(e);
		}
		world.update();
		assertIdsFit(ids, x.length, "piecs/read_by_id");
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += x[ids[i]];
				sink = s;
			},
			check: () => sink,
		};
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++)
					for (let i = 0; i < N; i++) s += world.hasComponent(ids[i], Pos) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	// `prefabricate` is piecs's own template API — an archetype handed to
	// `createEntity` so the entity lands in its final archetype directly, exactly
	// what `ecs.spawn(template)` does for oecs. Two `addComponent` calls instead
	// would charge piecs archetype moves its API lets the caller skip.
	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const world = new World();
			const Pos = world.createComponentId();
			const Vel = world.createComponentId();
			const prefab = world.prefabricate([Pos, Vel]);
			world.initialize();
			return { world, prefab };
		},
		fn: (s) => {
			const { world, prefab } = s;
			for (let i = 0; i < 3 * N; i++) world.createEntity(prefab);
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const world = new World();
			const Pos = world.createComponentId();
			world.initialize();
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = world.createEntity();
				world.addComponent(e, Pos);
				ids.push(e);
			}
			return { world, ids };
		},
		fn: (s) => {
			for (let i = 0; i < s.ids.length; i++) s.world.deleteEntity(s.ids[i]);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const world = new World();
			const Pos = world.createComponentId();
			const Tag = world.createComponentId();
			world.initialize();
			const ids = [];
			for (let i = 0; i < N; i++) {
				const e = world.createEntity();
				world.addComponent(e, Pos);
				ids.push(e);
			}
			world.addComponent(ids[0], Tag);
			world.removeComponent(ids[0], Tag);
			return { world, ids, Tag };
		},
		fn: (s) => {
			const { world, ids, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < ids.length; i++) world.addComponent(ids[i], Tag);
				for (let i = 0; i < ids.length; i++) world.removeComponent(ids[i], Tag);
			}
		},
	};

	return cases;
}

// ── koota ───────────────────────────────────────────────────────────────────
// Traits are SoA: `getStore`/`useStores` hand back per-field arrays indexed BY
// ENTITY ID, same storage shape as bitECS/wolf/piecs — so the hot loop is an
// id-indexed walk over the query's dense entity array. `useStores` is the
// documented fast path; `updateEach` is the ergonomic one and is not used here.
// Note the arrays are plain JS arrays, not TypedArrays — koota's own choice.
export function kootaCases(lib) {
	const { createWorld, trait, getStore } = lib;
	const cases = {};

	// A koota entity VALUE packs a world id in its high bits, while the SoA stores
	// are indexed by the bare entity id — so the store index is `entities[i].id()`,
	// exactly as the README's `useStores` example writes it. Indexing by the packed
	// value instead reads `undefined` (NaN into the checksum) and turns the store
	// array into a holey dictionary-mode array: it reported koota at 244 ms on
	// `iter_frag`, ~360× its real cost. Another one the checksum caught.
	{
		const Pos = trait({ x: 0, y: 0 });
		const Vel = trait({ vx: 1, vy: 1 });
		const world = createWorld();
		for (let i = 0; i < N; i++) world.spawn(Pos, Vel);
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					world.query(Pos, Vel).useStores(([p, v], ents) => {
						for (let i = 0; i < ents.length; i++) {
							const e = ents[i].id();
							p.x[e] += v.vx[e] * DT;
							p.y[e] += v.vy[e] * DT;
						}
					});
				}
			},
			check: () => {
				let s = 0;
				world.query(Pos, Vel).useStores(([p], ents) => {
					for (let i = 0; i < ents.length; i++) s += p.x[ents[i].id()];
				});
				return s;
			},
		};
	}

	{
		const Pos = trait({ x: 0, y: 0 });
		const tags = [];
		for (let i = 0; i < FRAG_BITS; i++) tags.push(trait({}));
		const world = createWorld();
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			const t = [Pos];
			for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) t.push(tags[b]);
			for (let k = 0; k < FRAG_PER; k++) world.spawn(...t);
		}
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					world.query(Pos).useStores(([p], ents) => {
						for (let i = 0; i < ents.length; i++) p.x[ents[i].id()] += 2;
					});
				}
			},
			check: () => {
				let s = 0;
				world.query(Pos).useStores(([p], ents) => {
					for (let i = 0; i < ents.length; i++) s += p.x[ents[i].id()];
				});
				return s;
			},
		};
	}

	{
		const Pos = trait({ x: 1, y: 1 });
		const world = createWorld();
		const es = [];
		for (let i = 0; i < N; i++) es.push(world.spawn(Pos));
		const px = getStore(world, Pos);
		// Bare ids resolved once at setup — the same thing the other id-indexed
		// libraries hold, so the timed loop is a store read and not an unpack.
		const idx = Array.from(world.query(Pos)).map((e) => e.id());
		assertIdsFit(idx, px.x.length, "koota/read_by_id");
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += px.x[idx[i]];
				sink = s;
			},
			check: () => sink,
		};
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += es[i].has(Pos) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => {
			const Pos = trait({ x: 1, y: 2 });
			const Vel = trait({ vx: 0, vy: 0 });
			return { world: createWorld(), Pos, Vel };
		},
		fn: (s) => {
			for (let i = 0; i < 3 * N; i++) s.world.spawn(s.Pos, s.Vel);
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const Pos = trait({ x: 1, y: 1 });
			const world = createWorld();
			const es = [];
			for (let i = 0; i < N; i++) es.push(world.spawn(Pos));
			return { es };
		},
		fn: (s) => {
			for (let i = 0; i < s.es.length; i++) s.es[i].destroy();
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const Pos = trait({ x: 1, y: 1 });
			const Tag = trait({});
			const world = createWorld();
			const es = [];
			for (let i = 0; i < N; i++) es.push(world.spawn(Pos));
			es[0].add(Tag);
			es[0].remove(Tag);
			return { es, Tag };
		},
		fn: (s) => {
			const { es, Tag } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < es.length; i++) es[i].add(Tag);
				for (let i = 0; i < es.length; i++) es[i].remove(Tag);
			}
		},
	};

	return cases;
}

// ── miniplex ────────────────────────────────────────────────────────────────
// Object-based (AoS), by design: an entity IS a plain object and an archetype
// holds references to those objects. There are no columns to walk, so the hot
// loop dereferences one object per entity. That is not a handicap imposed by this
// harness — it is the library's storage model, and the reason it is in the table.
export function miniplexCases(lib) {
	const { World } = lib;
	const cases = {};

	{
		const world = new World();
		for (let i = 0; i < N; i++) world.add({ pos: { x: 0, y: 0 }, vel: { vx: 1, vy: 1 } });
		const q = world.with("pos", "vel");
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					const ents = q.entities;
					for (let i = 0; i < ents.length; i++) {
						const e = ents[i];
						e.pos.x += e.vel.vx * DT;
						e.pos.y += e.vel.vy * DT;
					}
				}
			},
			check: () => {
				let s = 0;
				for (const e of q.entities) s += e.pos.x;
				return s;
			},
		};
	}

	{
		const world = new World();
		// miniplex archetypes are keyed by component NAME presence, so 6 optional
		// tag keys give the same 64 combinations the other libraries get from tags.
		for (let mask = 0; mask < FRAG_ARCH; mask++) {
			for (let k = 0; k < FRAG_PER; k++) {
				const e = { pos: { x: 0, y: 0 } };
				for (let b = 0; b < FRAG_BITS; b++) if (mask & (1 << b)) e[`t${b}`] = true;
				world.add(e);
			}
		}
		const q = world.with("pos");
		cases.iter_frag = {
			iters: 300 * FRAG_PER * FRAG_ARCH,
			fn: () => {
				for (let r = 0; r < 300; r++) {
					const ents = q.entities;
					for (let i = 0; i < ents.length; i++) ents[i].pos.x += 2;
				}
			},
			check: () => {
				let s = 0;
				for (const e of q.entities) s += e.pos.x;
				return s;
			},
		};
	}

	{
		const world = new World();
		const es = [];
		for (let i = 0; i < N; i++) es.push(world.add({ pos: { x: 1, y: 1 } }));
		// The query is made in the setup, and not in the timed loop: miniplex caches a
		// query by its configuration, so a call inside the loop would measure that
		// cache. Every other library also gets its accessor before the loop.
		//
		// `connect()` is NECESSARY, and it is not an optimization. A miniplex query
		// connects to the world only when something reads its entities, and `has()`
		// does not do that read. Therefore a query that nothing iterated first reports
		// `has() === false` for every entity, and the loop then measures a search of an
		// EMPTY bucket. That condition is fast and it is meaningless. The cross-library
		// checksum found it: the sum was 0 where every other library gave 20·N.
		const q = world.with("pos").connect();
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += es[i].pos.x;
				sink = s;
			},
			check: () => sink,
		};
		// `Query.has(entity)` is miniplex's OWN membership call: `Query` extends
		// `Bucket`, and `Bucket.has` is documented as "returns true if the bucket
		// contains the given entity".
		//
		// This case read `es[i].pos !== undefined` before. That is hand-written user
		// code and not a call to miniplex, and it made miniplex the fastest library in
		// this row by a large factor. wolf-ecs is reported as ABSENT for this same case,
		// because it has no public membership call — so the two libraries were judged by
		// two different rules, and the rule at the top of this file says that a case
		// must not write a substitute. miniplex HAS the call, so the case uses it.
		//
		// The property read is not wrong for a miniplex user: an entity is a plain
		// object, and a property read is the natural idiom. But it prices the LAYOUT,
		// and this row prices a membership API. `README.md` records both, and it records
		// that the property read is much faster than the call.
		cases.has = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += q.has(es[i]) ? 1 : 0;
				sink = s;
			},
			check: () => sink,
		};
	}

	cases.spawn = {
		iters: 3 * N,
		setup: () => ({ world: new World() }),
		fn: (s) => {
			for (let i = 0; i < 3 * N; i++) s.world.add({ pos: { x: 1, y: 2 }, vel: { vx: 0, vy: 0 } });
		},
	};

	cases.despawn = {
		iters: N,
		setup: () => {
			const world = new World();
			const es = [];
			for (let i = 0; i < N; i++) es.push(world.add({ pos: { x: 1, y: 1 } }));
			return { world, es };
		},
		fn: (s) => {
			for (let i = 0; i < s.es.length; i++) s.world.remove(s.es[i]);
		},
	};

	cases.add_remove = {
		iters: 10 * N,
		setup: () => {
			const world = new World();
			const es = [];
			for (let i = 0; i < N; i++) es.push(world.add({ pos: { x: 1, y: 1 } }));
			// Plant the "tag" query outside the timed part. oecs, bitECS, harmony, wolf,
			// piecs and koota all put their target archetype in the setup, and miniplex
			// did not: the first `addComponent` inside the loop made the query and its
			// bucket. The cost is small against 10·N operations, but this file compares
			// libraries only where they do equal work.
			world.with("tag");
			return { world, es };
		},
		fn: (s) => {
			const { world, es } = s;
			for (let r = 0; r < 5; r++) {
				for (let i = 0; i < es.length; i++) world.addComponent(es[i], "tag", true);
				for (let i = 0; i < es.length; i++) world.removeComponent(es[i], "tag");
			}
		},
	};

	return cases;
}

// ── becsy ───────────────────────────────────────────────────────────────────
// The closest design cousin here: declared read/write access, systems-scoped
// component access, and an SoA store behind an entity-accessor API. That model is
// also why only three cases appear.
//
// `World.create` is ASYNC, and all component access must happen inside a system
// with declared access — there is no host-side read path. So each case is a becsy
// System, and the repetition loop lives INSIDE `execute()` so the measurement is
// iteration cost rather than 100 scheduler dispatches (matching what every other
// library's loop measures).
//
// ABSENT cases: `read_by_id`, `has`, `despawn`, `add_remove` all need stable
// per-entity handles across ticks, which becsy provides only via explicitly
// `hold()`-ed references with their own lifetime rules. Emulating that would
// measure the emulation, so those report `—`.
export async function becsyCases(lib) {
	const { System, Type, World, component, system } = lib;
	const cases = {};

	{
		class Pos {
			static schema = { x: Type.float64, y: Type.float64 };
		}
		class Vel {
			static schema = { vx: Type.float64, vy: Type.float64 };
		}
		component(Pos);
		component(Vel);
		let doneCheck = 0;
		// ONE system, not two. becsy infers system precedence from declared access, and
		// a separate seeder that writes what the mover also writes is a precedence
		// cycle it refuses to schedule. Seeding on the first tick from inside the mover
		// sidesteps that without reaching for explicit ordering.
		//
		// `World.create` does not expose its system instances, so the system captures
		// itself at construction — that handle is how the repetition count is set.
		let mv = null;
		class Move extends System {
			// becsy enforces declared access just as oecs does: creating a component
			// requires naming it writable first. `q.using(...).write` grants access
			// without producing a result set.
			granted = this.query((q) => q.using(Pos, Vel).write);
			ents = this.query((q) => q.current.with(Pos).write.and.with(Vel).read);
			reps = 0;
			seeded = false;
			constructor() {
				super();
				mv = this;
			}
			execute() {
				if (!this.seeded) {
					this.seeded = true;
					for (let i = 0; i < N; i++) this.createEntity(Pos, { x: 0, y: 0 }, Vel, { vx: 1, vy: 1 });
					return;
				}
				for (let r = 0; r < this.reps; r++) {
					for (const e of this.ents.current) {
						const p = e.write(Pos);
						const v = e.read(Vel);
						p.x += v.vx * DT;
						p.y += v.vy * DT;
					}
				}
				if (this.reps === 0) {
					let s = 0;
					for (const e of this.ents.current) s += e.read(Pos).x;
					doneCheck = s;
				}
			}
		}
		system(Move);
		const world = await World.create({ defs: [Pos, Vel, Move], maxEntities: N * 4 });
		// Tick 1 seeds; entities become query-visible on the next tick.
		mv.reps = 0;
		await world.execute();
		await world.execute();
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				mv.reps = 100;
				return world.execute();
			},
			check: async () => {
				mv.reps = 0;
				await world.execute();
				return doneCheck;
			},
		};
	}

	return cases;
}

// ── raw typed arrays: the ceiling, not a competitor ──────────────────────────
export function rawCases() {
	const cases = {};
	{
		const x = new Float64Array(N);
		const y = new Float64Array(N);
		const vx = new Float64Array(N).fill(1);
		const vy = new Float64Array(N).fill(1);
		cases.iter2 = {
			iters: 100 * N,
			fn: () => {
				for (let r = 0; r < 100; r++) {
					for (let i = 0; i < N; i++) {
						x[i] += vx[i] * DT;
						y[i] += vy[i] * DT;
					}
				}
			},
			check: () => {
				let s = 0;
				for (let i = 0; i < N; i++) s += x[i];
				return s;
			},
		};
	}
	{
		const x = new Float64Array(N);
		const COUNT = FRAG_PER * FRAG_ARCH;
		cases.iter_frag = {
			iters: 300 * COUNT,
			fn: () => {
				for (let r = 0; r < 300; r++) for (let i = 0; i < COUNT; i++) x[i] += 2;
			},
			check: () => {
				let s = 0;
				for (let i = 0; i < COUNT; i++) s += x[i];
				return s;
			},
		};
	}
	{
		const x = new Float64Array(N).fill(1);
		const ids = Array.from({ length: N }, (_, i) => i);
		cases.read_by_id = {
			iters: 20 * N,
			fn: () => {
				let s = 0;
				for (let r = 0; r < 20; r++) for (let i = 0; i < N; i++) s += x[ids[i]];
				sink = s;
			},
			check: () => sink,
		};
	}
	return cases;
}

export const IMPLS = {
	oecs: { kind: "bundle", make: oecsCases },
	bitecs: { kind: "npm", pkg: "bitecs", make: bitecsCases },
	koota: { kind: "npm", pkg: "koota", make: kootaCases },
	// No `exports` map, and the `main` field is UMD — the ESM build has to be named
	// explicitly or a bare import yields an empty namespace.
	becsy: { kind: "npm", pkg: "@lastolivegames/becsy/index.js", make: becsyCases },
	miniplex: { kind: "npm", pkg: "miniplex", make: miniplexCases },
	harmony: { kind: "npm", pkg: "harmony-ecs", make: harmonyCases },
	wolf: { kind: "npm", pkg: "wolf-ecs", make: wolfCases },
	piecs: { kind: "npm", pkg: "piecs", make: piecsCases },
	raw: { kind: "none", make: rawCases },
};

export const CASES = ["iter2", "iter_frag", "read_by_id", "has", "spawn", "despawn", "add_remove"];
