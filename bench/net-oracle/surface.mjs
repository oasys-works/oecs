/**
 * The probes for the API surface. Each one is small, and each one has an exact
 * expected value.
 *
 * `driver.mjs` holds the layers that run against the CONTINUOUS simulation. Those
 * layers give the deepest checks, because the reference net gives an expected value
 * at each tick. But some parts of the API cannot go into a net that must keep its
 * meaning:
 *
 *   - a CYCLE in a relation. The net must have no cycle in its ports, and a walk over
 *     a cycle must not run without an end. Therefore the guard needs its own world.
 *   - a MISTAKE. A read of a resource that is absent, or a restore of a snapshot from
 *     a world with a different shape, must give a named error. A run that made the
 *     mistake could not continue.
 *   - a REPLAY. `replayCommandLog` needs a second, fresh world. It then compares the
 *     hash of the state at each tick with the hash of the first run.
 *   - the BATCH paths, such as `batchAddComponent`, which take an archetype and not
 *     an entity. The net changes one agent at a time.
 *   - the COMBINATORS for a run condition, where the model must know the exact set of
 *     ticks. The simulation gates one system on one resource, and that is all that a
 *     tick-accurate model can hold there.
 *
 * Each probe below has a model, and it is not a check that the call does not throw.
 * A probe that only asked "did this throw" would pass against an ECS that gave the
 * wrong answer, and that is the failure mode of this whole tool.
 *
 * Use this tool only for local work, as you use the other tools in `bench/`. It is
 * not a part of the package.
 */
import { Divergence } from "./driver.mjs";

/** Report a failure through the same channel that the driver uses. */
function bad(what, msg) {
	throw new Divergence(`surface/${what}: ${msg}`);
}

/**
 * The count of the assertions that the probes made in this process.
 *
 * Each probe gives back its OWN delta of this counter. `PROBES` holds a floor for
 * each probe. Therefore the number that a probe reports is the number of the
 * comparisons that it made.
 *
 * A number in the text of the file cannot show this. A probe that makes no
 * comparison still reports a number that is more than zero. Then the floor passes,
 * and it shows nothing.
 */
let CHECKS = 0;

/** Count one assertion that this file makes directly, and not with a helper. */
function counted() {
	CHECKS++;
}

function eq(what, name, got, want) {
	CHECKS++;
	if (got !== want) bad(what, `${name} is ${got}, want ${want}`);
}

function eqList(what, name, got, want) {
	CHECKS++;
	const g = [...got];
	const w = [...want];
	if (g.length !== w.length || g.some((v, i) => v !== w[i])) {
		bad(what, `${name} is [${g}], want [${w}]`);
	}
}

/** Run `fn`, and require it to throw an `ECSError` of the given category.
 *
 * An `ECSError` carries its code in `category`, and `isEcsError` is the narrow test
 * for it. Both come from the public entry, so a probe that reads them keeps the error
 * surface itself under test. */
function throwsWith(lib, what, name, category, fn) {
	counted();
	let err = null;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	if (err === null) bad(what, `${name} did not throw, and ${category} was the expected error`);
	if (!lib.isEcsError(err)) {
		bad(what, `${name} threw ${err.name}, which is not an ECSError: ${err.message}`);
	}
	if (err.category !== category) bad(what, `${name} threw ${err.category}, want ${category}`);
}

// ── 1. the guards on a traversal ────────────────────────────────────────────
/**
 * A cycle in a relation chain, and truncation by `maxDepth`.
 *
 * The net has no cycle in its ports, and `driver.mjs` cannot make one: a cycle would
 * break each other layer. But a walk over a cycle must not run without an end, and it
 * must report the cycle in a development build. This probe makes the cycle and pins
 * both behaviours. Refer to `cyclicWalk`.
 *
 * It also pins the meaning of `maxDepth`. `maxDepth` counts EDGES, so `maxDepth = 1`
 * gives two levels. The record chain in `world.mjs` checks the same rule over a chain
 * that is hundreds of levels deep; this probe checks the small values, where an error
 * of one is easy to see.
 */
export function traversalGuards(lib) {
	const what = "traversal";
	const at = CHECKS;
	const { ECS, HIERARCHY_UNBOUNDED } = lib;
	const ecs = new ECS({ deterministic: true });
	const N = ecs.registerComponent({ d: "i32" }, { name: "N" });
	const P = ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" });
	// A chain of five: 0 <- 1 <- 2 <- 3 <- 4, with 0 as the root.
	const chain = [];
	for (let i = 0; i < 5; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, N, { d: i });
		chain.push(e);
	}
	for (let i = 1; i < 5; i++) ecs.relations.add(chain[i], P, chain[i - 1]);

	const walk = (md) => {
		const out = [];
		const q = ecs.query(N);
		(md === undefined ? q.hierarchy(P) : q.hierarchy(P, md)).forEachEntity((e) => out.push(e));
		return out;
	};
	// A walk gives a parent before its children, so the order is the chain itself.
	eqList(what, "hierarchy with no limit", walk(), chain);
	eqList(what, "hierarchy with HIERARCHY_UNBOUNDED", walk(HIERARCHY_UNBOUNDED), chain);
	// `maxDepth` counts EDGES. Therefore a limit of 1 gives the root and one level.
	eqList(what, "hierarchy with maxDepth 0", walk(0), [chain[0]]);
	eqList(what, "hierarchy with maxDepth 1", walk(1), chain.slice(0, 2));
	eqList(what, "hierarchy with maxDepth 3", walk(3), chain.slice(0, 4));
	// The eager helpers over the same chain. `ancestorsOf` starts at the entity.
	eqList(what, "ancestorsOf over four edges", ecs.relations.ancestorsOf(chain[4], P), [
		chain[4],
		chain[3],
		chain[2],
		chain[1],
		chain[0],
	]);
	eq(what, "rootOf over four edges", ecs.relations.rootOf(chain[4], P), chain[0]);
	eqList(what, "cascadeOf from the root", ecs.relations.cascadeOf(chain[0], P), chain);

	// ── the cycle ───────────────────────────────────────────────────────────
	// Close the chain: the root now points at the tail.
	//
	// `relation_service.ts` promises TWO behaviours here, one for each build, and
	// this probe pins both:
	//
	//   - a development build must give a loud `RELATION_CYCLE`;
	//   - a production build must take a SAFE EARLY-OUT, and it must NEVER HANG. The
	//     guard for the cycle is `if (DEV)`-gated, and the visited set is not.
	//
	// The promise that matters most in production is the one about the hang, and the
	// only proof of it is that the call returns. Therefore the next line running IS
	// the assertion. `cyclicWalk` below accepts either behaviour, and it requires the
	// result of the production arm to name no entity two times — a walk that repeated
	// an entity would be going around the cycle.
	ecs.relations.add(chain[0], P, chain[4]);
	cyclicWalk(lib, what, "ancestorsOf over a cycle", () =>
		ecs.relations.ancestorsOf(chain[4], P)
	);
	cyclicWalk(lib, what, "rootOf over a cycle", () => [ecs.relations.rootOf(chain[4], P)]);
	cyclicWalk(lib, what, "hierarchy over a cycle", () => walk());
	ecs.dispose();
	return CHECKS - at;
}

/**
 * Run a walk over a chain that holds a cycle, and accept either documented result.
 *
 * A development build must throw `RELATION_CYCLE`. A production build must return,
 * and its result must name no entity two times. Neither build may run without an end,
 * and the return of this function is the proof of that.
 */
function cyclicWalk(lib, what, name, fn) {
	counted();
	let out = null;
	try {
		out = fn();
	} catch (e) {
		if (!lib.isEcsError(e) || e.category !== lib.ECS_ERROR.RELATION_CYCLE) {
			bad(what, `${name} threw ${e.category ?? e.name}, want RELATION_CYCLE: ${e.message}`);
		}
		return; // the development arm
	}
	// The production arm. The walk stopped, so it did not hang. It must also have
	// stopped rather than gone around: no entity may appear two times.
	const seen = new Set();
	for (const e of out) {
		if (seen.has(e)) {
			bad(what, `${name} returned ${e} two times — the walk went around the cycle`);
		}
		seen.add(e);
	}
}

// ── 2. the built-in relations ───────────────────────────────────────────────
/**
 * `registerChildOf` and `registerIsA`.
 *
 * Both are thin: each one is a call of `relations.register` with a chosen cardinality
 * and cleanup policy. Therefore the value of a check is in the DEFAULT of each one,
 * because a caller depends on it and a change to it is silent.
 *
 *   - `ChildOf` defaults to `"delete"`. The death of a parent must destroy the
 *     complete subtree.
 *   - `IsA` defaults to `"clear"`. The death of an exemplar must leave its instances
 *     alive, and it must drop the link.
 */
export function builtinRelations(lib) {
	const what = "builtins";
	const at = CHECKS;
	const { ECS, registerChildOf, registerIsA } = lib;
	const ecs = new ECS({ deterministic: true });
	const T = ecs.registerComponent({ v: "i32" }, { name: "T" });
	const ChildOf = registerChildOf(ecs);
	const IsA = registerIsA(ecs);
	const e = [];
	for (let i = 0; i < 7; i++) {
		const x = ecs.spawn();
		ecs.addComponent(x, T, { v: i });
		e.push(x);
	}
	// A tree: 0 is the root, 1 and 2 are its children, 3 and 4 are children of 1.
	ecs.relations.add(e[1], ChildOf, e[0]);
	ecs.relations.add(e[2], ChildOf, e[0]);
	ecs.relations.add(e[3], ChildOf, e[1]);
	ecs.relations.add(e[4], ChildOf, e[1]);
	eqList(what, "the children of the root", ecs.relations.sourcesOf(e[0], ChildOf), [e[1], e[2]]);
	eqList(what, "ancestorsOf a leaf", ecs.relations.ancestorsOf(e[3], ChildOf), [e[3], e[1], e[0]]);
	eq(what, "rootOf a leaf", ecs.relations.rootOf(e[3], ChildOf), e[0]);
	// `cascadeOf` promises breadth-first order, parents before children.
	eqList(what, "cascadeOf the root", ecs.relations.cascadeOf(e[0], ChildOf), [
		e[0],
		e[1],
		e[2],
		e[3],
		e[4],
	]);
	// The default of `ChildOf` is `"delete"`. Therefore the subtree dies with the root.
	ecs.despawn(e[0]);
	for (const x of [e[0], e[1], e[2], e[3], e[4]]) {
		counted();
		if (ecs.isAlive(x)) bad(what, `entity ${x} is alive, and the ChildOf cascade must destroy it`);
	}
	counted();
	if (!ecs.isAlive(e[5]) || !ecs.isAlive(e[6])) {
		bad(what, `the ChildOf cascade destroyed an entity that is not in the tree`);
	}

	// The default of `IsA` is `"clear"`. Therefore an instance outlives its exemplar.
	ecs.relations.add(e[5], IsA, e[6]);
	eq(what, "the exemplar of an instance", ecs.relations.targetOf(e[5], IsA), e[6]);
	ecs.despawn(e[6]);
	counted();
	if (!ecs.isAlive(e[5])) bad(what, `the IsA default must not destroy an instance`);
	eq(what, "the exemplar after its death", ecs.relations.targetOf(e[5], IsA), undefined);
	ecs.dispose();
	return CHECKS - at;
}

// ── 3. the wildcard read ────────────────────────────────────────────────────
/**
 * The `(*, T)` query — "which entities point at this target, through any relation".
 *
 * `forEachRelatedTo` is that query, and a system that uses it must list
 * `ANY_RELATION` in `relationReads`. This probe runs it inside a system, so the
 * access check of the development build is watching, and it compares the result with
 * the same question asked one relation at a time.
 */
export function wildcardRead(lib) {
	const what = "wildcard";
	const at = CHECKS;
	const { ECS, SCHEDULE, ANY_RELATION } = lib;
	const ecs = new ECS({ deterministic: true });
	const T = ecs.registerComponent({ v: "i32" }, { name: "T" });
	const R1 = ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" });
	const R2 = ecs.relations.register({ multi: true, onDeleteTarget: "clear" });
	const e = [];
	for (let i = 0; i < 6; i++) {
		const x = ecs.spawn();
		ecs.addComponent(x, T, { v: i });
		e.push(x);
	}
	ecs.relations.add(e[1], R1, e[0]);
	ecs.relations.add(e[2], R2, e[0]);
	ecs.relations.add(e[3], R2, e[0]);
	ecs.relations.add(e[4], R2, e[5]);

	const q = ecs.query(T);
	let got = null;
	const reader = ecs.registerSystem({
		name: "wildcard-reader",
		reads: [T],
		writes: [],
		// The authorisation for a `(*, T)` walk. It does NOT authorise a read of one
		// named relation; the documentation says so, and `sourcesOf` below is a host
		// call outside a system, so it needs no declaration.
		relationReads: [ANY_RELATION],
		fn: () => {
			const out = [];
			q.forEachRelatedTo(e[0], (x) => out.push(x));
			out.sort((a, b) => a - b);
			got = out;
		},
	});
	ecs.addSystems(SCHEDULE.UPDATE, reader);
	ecs.startup();
	ecs.update(1);
	// The same answer, from the reads of one relation at a time.
	const want = [
		...ecs.relations.sourcesOf(e[0], R1),
		...ecs.relations.sourcesOf(e[0], R2),
	].sort((a, b) => a - b);
	eqList(what, "forEachRelatedTo against the per-relation reads", got, want);
	// `sourcesOfAny` answers the same question, and it names the relation as well.
	const anyPairs = ecs.relations.sourcesOfAny(e[0]);
	eqList(
		what,
		"sourcesOfAny against the per-relation reads",
		anyPairs.map(([, s]) => s).sort((a, b) => a - b),
		want
	);
	// `pairsOf` gives the complete relation.
	eqList(
		what,
		"pairsOf(R2)",
		ecs.relations.pairsOf(R2).map(([s, t]) => `${s}>${t}`),
		[`${e[2]}>${e[0]}`, `${e[3]}>${e[0]}`, `${e[4]}>${e[5]}`]
	);
	eq(what, "the count of the registered relations", ecs.relations.count, 2);
	ecs.dispose();
	return CHECKS - at;
}

// ── 4. the templates and the batch paths ────────────────────────────────────
/**
 * `template`, `spawn`, `spawnBundle`, `spawnMany` with overrides,
 * `batchAddComponent` and `batchRemoveComponent`, against a `Map` model.
 *
 * `batchAddComponent` takes an ARCHETYPE and not an entity. The net changes one agent
 * at a time, so it cannot reach that path. The batch path writes one column at a
 * time, with a `fill`, so an error in it gives the wrong value for each row of the
 * archetype and not for one row.
 */
export function templatesAndBatch(lib) {
	const what = "templates";
	const at = CHECKS;
	const { ECS, bundle } = lib;
	const ecs = new ECS({ deterministic: true });
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ dx: "i32" }, { name: "Vel" });
	const Mark = ecs.registerComponent({}, { name: "Mark" });
	const Extra = ecs.registerComponent({ n: "i32" }, { name: "Extra" });

	// The model: entity -> { x, y, dx, mark, n }.
	const model = new Map();

	const tpl = ecs.template(bundle(Pos, { x: 1, y: 2 }), bundle(Vel, { dx: 3 }));
	// One entity from the template, with no override.
	const a = ecs.spawn(tpl);
	model.set(a, { x: 1, y: 2, dx: 3, mark: false, n: null });
	// One entity from the template, with an override for one field. The map of the
	// overrides is FLAT: it takes a field name, and not a component name.
	const b = ecs.spawn(tpl, { x: 10 });
	model.set(b, { x: 10, y: 2, dx: 3, mark: false, n: null });
	// A bulk spawn with one shared override. The write is one `fill` for each column,
	// so a bug gives the same wrong value to each row.
	const many = ecs.spawnMany(tpl, 5, { dx: 9 });
	for (const e of many) model.set(e, { x: 1, y: 2, dx: 9, mark: false, n: null });
	// `spawnBundle` is the authoring form with no template.
	const c = ecs.spawnBundle(bundle(Pos, { x: 7, y: 8 }), bundle(Vel, { dx: 6 }), Mark);
	model.set(c, { x: 7, y: 8, dx: 6, mark: true, n: null });

	const check = (stage) => {
		for (const [e, m] of model) {
			eq(what, `${stage}: ${e}.Pos.x`, ecs.getField(e, Pos, "x"), m.x);
			eq(what, `${stage}: ${e}.Pos.y`, ecs.getField(e, Pos, "y"), m.y);
			eq(what, `${stage}: ${e}.Vel.dx`, ecs.getField(e, Vel, "dx"), m.dx);
			eq(what, `${stage}: ${e} has Mark`, ecs.hasComponent(e, Mark), m.mark);
			eq(what, `${stage}: ${e} has Extra`, ecs.hasComponent(e, Extra), m.n !== null);
			if (m.n !== null) eq(what, `${stage}: ${e}.Extra.n`, ecs.getField(e, Extra, "n"), m.n);
		}
	};
	check("after the spawns");

	// ── the batch paths ─────────────────────────────────────────────────────
	// Find the archetype of the bulk-spawned rows, and add a component to the whole
	// archetype at one time. Each row of it must get the same value.
	let target = null;
	ecs.query(Pos, Vel).forEach((arch) => {
		if (arch.hasComponent(Mark.id)) return;
		if (target === null) target = arch.id;
	});
	counted();
	if (target === null) bad(what, `no archetype of {Pos, Vel} with no Mark was found`);
	// Collect the members BEFORE the add: the add moves every row to a new archetype.
	const members = [];
	ecs.query(Pos, Vel).forEach((arch) => {
		if (arch.id !== target) return;
		const ids = arch.entityIds;
		for (let i = 0; i < arch.entityCount; i++) members.push(ids[i]);
	});
	ecs.batchAddComponent(target, Extra, { n: 42 });
	for (const e of members) model.get(e).n = 42;
	check("after batchAddComponent");

	// And back again. `batchRemoveComponent` takes the archetype that the add made.
	let withExtra = null;
	ecs.query(Pos, Vel, Extra).forEach((arch) => {
		if (withExtra === null) withExtra = arch.id;
	});
	counted();
	if (withExtra === null) bad(what, `batchAddComponent made no archetype that holds Extra`);
	ecs.batchRemoveComponent(withExtra, Extra);
	for (const e of members) model.get(e).n = null;
	check("after batchRemoveComponent");

	// `getEntityIndex` and `entityIdAtRow` are the two helpers for an id. The model
	// above holds each id, so both have an exact expected value here.
	const { getEntityIndex } = lib;
	for (const e of model.keys()) {
		counted();
		if (getEntityIndex(e) < 0) bad(what, `getEntityIndex(${e}) is negative`);
	}
	// `entityIdAtRow` reads the id OUT of a row of an archetype. Therefore the two
	// helpers must agree for each row of each archetype that the model holds. The row
	// must give the same id again.
	ecs.query(Pos, Vel).forEach((arch) => {
		const ids = arch.entityIds;
		for (let row = 0; row < arch.entityCount; row++) {
			eq(what, `entityIdAtRow(${arch.id}, ${row})`, ecs.entityIdAtRow(arch.id, row), ids[row]);
		}
	});
	ecs.dispose();
	return CHECKS - at;
}

// ── 5. the complete vocabulary of the write seam ────────────────────────────
/**
 * The host commands that the simulation does not use: `spawn` and `despawn`, plus
 * `spawnEntry`, the `onSpawned` callback, `push`, `pending`, `clear`, and
 * `uninstallHostCommandSeam`.
 *
 * The quarantine in `world.mjs` uses `disable`, `enable`, `add_component`,
 * `remove_component` and `set_field`. Therefore this probe covers the two that are
 * left, and it covers the shape of the queue.
 */
export function hostSeamVocabulary(lib) {
	const what = "host-seam";
	const at = CHECKS;
	const {
		ECS,
		installHostCommandSeam,
		uninstallHostCommandSeam,
		spawnEntry,
	} = lib;
	const ecs = new ECS({ deterministic: true });
	const queue = installHostCommandSeam(ecs);
	const Pos = ecs.registerComponent({ x: "i32" }, { name: "Pos" });
	const Tag = ecs.registerComponent({}, { name: "Tag" });
	ecs.startup();

	// A `spawn` command, with the typed entry builder and the callback that learns the
	// new id. The id exists only after the deferred create, so the callback is the
	// only way for the host to learn it.
	let born = null;
	queue.spawn([spawnEntry(Pos, { x: 5 }), spawnEntry(Tag, {})], (id) => {
		born = id;
	});
	eq(what, "the pending count after one spawn", queue.pending, 1);
	ecs.update(1);
	eq(what, "the pending count after the drain", queue.pending, 0);
	counted();
	if (born === null) bad(what, `onSpawned did not run`);
	counted();
	if (!ecs.isAlive(born)) bad(what, `the spawned entity ${born} is not alive`);
	eq(what, "the field of the spawned entity", ecs.getField(born, Pos, "x"), 5);
	eq(what, "the tag of the spawned entity", ecs.hasComponent(born, Tag), true);

	// `push` takes a command that is already built. That is the path a codec for the
	// SAB ring, or a replay of a log, uses.
	queue.push({ kind: "set_field", eid: born, def: Pos, field: "x", value: 11 });
	ecs.update(1);
	eq(what, "the field after a pushed set_field", ecs.getField(born, Pos, "x"), 11);

	// `clear` drops the buffer with no apply.
	queue.push({ kind: "set_field", eid: born, def: Pos, field: "x", value: 99 });
	eq(what, "the count that clear dropped", queue.clear(), 1);
	ecs.update(1);
	eq(what, "the field after a cleared command", ecs.getField(born, Pos, "x"), 11);

	// A `despawn` command.
	queue.despawn(born);
	ecs.update(1);
	eq(what, "the entity after a despawn command", ecs.isAlive(born), false);

	// `uninstallHostCommandSeam` removes the apply system. Therefore a command that
	// comes after it is never applied.
	const second = ecs.spawn();
	ecs.addComponent(second, Pos, { x: 1 });
	eq(what, "uninstall reports that it found the seam", uninstallHostCommandSeam(ecs, queue), true);
	eq(what, "a second uninstall reports nothing", uninstallHostCommandSeam(ecs, queue), false);
	queue.setField(second, Pos, "x", 77);
	ecs.update(1);
	eq(what, "the field after the seam is gone", ecs.getField(second, Pos, "x"), 1);
	ecs.dispose();
	return CHECKS - at;
}

// ── 6. the replay of a command log ──────────────────────────────────────────
/**
 * Record a session, write it as JSON, read it back, and replay it into a FRESH world.
 * The hash of the state after each tick must be equal, tick for tick.
 *
 * This is a metamorphic oracle, and it needs no reference implementation: two runs of
 * the same command stream over the same world must give the same state. It also
 * covers `serializeCommandLog` and `deserializeCommandLog`, because the replay reads
 * the log that came back from JSON, and not the log in memory.
 */
export function commandReplay(lib) {
	const what = "replay";
	const at = CHECKS;
	const {
		ECS,
		SCHEDULE,
		installHostCommandSeam,
		HostCommandRecorder,
		serializeCommandLog,
		deserializeCommandLog,
		replayCommandLog,
		spawnEntry,
	} = lib;

	// One builder, used two times. The replay needs a world with the same shape: the
	// same components, registered in the same order, and the same systems.
	const build = (recorder) => {
		const ecs = new ECS({ deterministic: true });
		const queue = installHostCommandSeam(
			ecs,
			recorder === null ? undefined : { recorder }
		);
		const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
		const Vel = ecs.registerComponent({ dx: "i32" }, { name: "Vel" });
		const Tag = ecs.registerComponent({}, { name: "Tag" });
		const q = ecs.query(Pos, Vel);
		// A system that integrates, so the state depends on the count of the ticks and
		// not on the commands alone.
		const move = ecs.registerSystem({
			name: "move",
			reads: [Vel],
			writes: [Pos],
			fn: () => {
				q.eachChunk((cols, count) => {
					const { x } = cols.mut(Pos);
					const { dx } = cols.read(Vel);
					for (let i = 0; i < count; i++) x[i] += dx[i];
				});
			},
		});
		ecs.addSystems(SCHEDULE.UPDATE, move);
		return { ecs, queue, Pos, Vel, Tag };
	};

	const recorder = new HostCommandRecorder(7);
	const first = build(recorder);
	// Seed-time commands drain at PRE_STARTUP, so they go in before `startup()`.
	const seeded = [];
	first.queue.spawn([spawnEntry(first.Pos, { x: 0, y: 0 }), spawnEntry(first.Vel, { dx: 2 })], (id) =>
		seeded.push(id)
	);
	first.ecs.startup();
	counted();
	if (seeded.length !== 1) bad(what, `the seed-time spawn did not apply at PRE_STARTUP`);

	// A short session with a command of every kind that the queue offers.
	const hashes = [];
	const spawnedPerTick = [];
	for (let t = 0; t < 8; t++) {
		if (t % 2 === 0) {
			first.queue.spawn(
				[spawnEntry(first.Pos, { x: t, y: t }), spawnEntry(first.Vel, { dx: 1 })],
				(id) => spawnedPerTick.push(id)
			);
		}
		if (t === 3) first.queue.add(seeded[0], first.Tag, {});
		if (t === 5) first.queue.remove(seeded[0], first.Tag);
		if (t === 6) first.queue.disable(seeded[0]);
		if (t === 7) first.queue.enable(seeded[0]);
		first.queue.setField(seeded[0], first.Pos, "y", t);
		if (t === 4 && spawnedPerTick.length > 0) first.queue.despawn(spawnedPerTick[0]);
		first.ecs.update(0.25);
		hashes.push(first.ecs.snapshots.stateHash());
	}
	const log = recorder.snapshotLog();
	eq(what, "the count of the recorded ticks", log.ticks.length, 8);
	counted();
	if (log.startup.length !== 1) {
		bad(what, `the startup bucket holds ${log.startup.length} commands, want 1`);
	}
	eq(what, "the seed that the log carries", log.seed, 7);
	first.ecs.dispose();

	// ── the round trip through JSON, and the replay ─────────────────────────
	const revived = deserializeCommandLog(serializeCommandLog(log));
	const second = build(null);
	const result = replayCommandLog(second.ecs, second.queue, revived);
	eq(what, "the count of the replayed ticks", result.ticks, 8);
	eq(what, "the count of the seed-time commands", result.startupCommands, 1);
	eqList(what, "the hash of the state after each tick", result.stateHashes, hashes);
	second.ecs.dispose();
	return CHECKS - at;
}

// ── 7. the run conditions and the system sets ───────────────────────────────
/**
 * Each combinator for a run condition, against an exact model of the ticks.
 *
 * `driver.mjs` gates one system on `runIfResourceEq`, because the driver controls the
 * value of that resource and can therefore predict the ticks. The others need the
 * count of the ticks of the ECS itself, so they get a world of their own here, where
 * the model is a simple loop.
 *
 * A false condition must also leave no other mark: the documentation says that a tick
 * that the gate skipped is not different from a tick where the system is absent.
 */
export function runConditions(lib) {
	const what = "conditions";
	const at = CHECKS;
	const {
		ECS,
		SCHEDULE,
		resourceKey,
		runEveryNTicks,
		runIfResourceEq,
		runIfAnyMatch,
		not,
		allOf,
		anyOf,
		systemSet,
	} = lib;
	const ecs = new ECS({ deterministic: true });
	const Mark = ecs.registerComponent({ v: "i32" }, { name: "Mark" });
	const Mode = resourceKey("mode");
	ecs.resources.register(Mode, 0);

	const runs = { every2: 0, every3off1: 0, modeIs1: 0, notMode1: 0, both: 0, either: 0, anyMark: 0, setA: 0, setB: 0 };
	const counter = (key) => () => {
		runs[key]++;
	};
	const mk = (name, key) =>
		ecs.registerSystem({ name, reads: [], writes: [], fn: counter(key) });

	// The driver of the value of the resource. It runs first, so a gate in a later
	// phase sees the value of this tick.
	let mode = 0;
	const setMode = ecs.registerSystem({
		name: "set-mode",
		reads: [],
		writes: [],
		resourceWrites: [Mode],
		fn: (ctx) => ctx.setResource(Mode, mode),
	});
	ecs.addSystems(SCHEDULE.PRE_UPDATE, setMode);

	const qMark = ecs.query(Mark);
	const setBoth = systemSet("both-of-them");
	ecs.addSystems(
		SCHEDULE.UPDATE,
		{ system: mk("every2", "every2"), runIf: runEveryNTicks(2) },
		{ system: mk("every3off1", "every3off1"), runIf: runEveryNTicks(3, 1) },
		{ system: mk("modeIs1", "modeIs1"), runIf: runIfResourceEq(Mode, 1) },
		{ system: mk("notMode1", "notMode1"), runIf: not(runIfResourceEq(Mode, 1)) },
		{ system: mk("both", "both"), runIf: allOf(runEveryNTicks(2), runIfResourceEq(Mode, 1)) },
		{ system: mk("either", "either"), runIf: anyOf(runEveryNTicks(2), runIfResourceEq(Mode, 1)) },
		{ system: mk("anyMark", "anyMark"), runIf: runIfAnyMatch(qMark) },
		// Two members of one set. `configureSet` gives the set one condition, and each
		// member inherits it.
		{ system: mk("setA", "setA"), set: setBoth },
		{ system: mk("setB", "setB"), set: setBoth }
	);
	ecs.configureSet(setBoth, { runIf: runIfResourceEq(Mode, 2) });
	ecs.startup();

	// The model. `runEveryNTicks` reads `ctx.ecsTick`. The tick of the ECS during the
	// N-th call of `update` is N-1, so the index of this loop IS that tick. A read of
	// `_getCurrentTick()` before the call gives the tick of the PREVIOUS update, which
	// is one step early.
	const want = { every2: 0, every3off1: 0, modeIs1: 0, notMode1: 0, both: 0, either: 0, anyMark: 0, setA: 0, setB: 0 };
	for (let i = 0; i < 12; i++) {
		mode = i % 3;
		// A `Mark` entity exists from tick 4 on, so `runIfAnyMatch` must be false before
		// that and true after it.
		if (i === 4) {
			const e = ecs.spawn();
			ecs.addComponent(e, Mark, { v: 1 });
		}
		const tick = i;
		const e2 = tick % 2 === 0;
		const e3 = (tick - 1) % 3 === 0;
		const m1 = mode === 1;
		const m2 = mode === 2;
		const hasMark = i >= 4;
		if (e2) want.every2++;
		if (e3) want.every3off1++;
		if (m1) want.modeIs1++;
		if (!m1) want.notMode1++;
		if (e2 && m1) want.both++;
		if (e2 || m1) want.either++;
		if (hasMark) want.anyMark++;
		if (m2) {
			want.setA++;
			want.setB++;
		}
		ecs.update(1);
	}
	for (const key of Object.keys(want)) {
		eq(what, `the runs of the system gated by ${key}`, runs[key], want[key]);
	}
	ecs.dispose();
	return CHECKS - at;
}

// ── 8. the lifecycle of a resource, and the edges of an event ───────────────
/**
 * A resource goes present, absent, present again. An event channel gives no row when
 * nobody emitted.
 *
 * Both are lifecycle rules that the continuous simulation cannot break, because it
 * registers each resource one time and emits on each tick. The rule that a read of an
 * absent resource must give a NAMED error is what a caller depends on.
 */
export function resourceAndEventEdges(lib) {
	const what = "resources";
	const at = CHECKS;
	const { ECS, SCHEDULE, resourceKey, eventKey, signalKey, ECS_ERROR } = lib;
	const ecs = new ECS({ deterministic: true });
	const Cfg = resourceKey("cfg");
	eq(what, "has() before the register", ecs.resources.has(Cfg), false);
	throwsWith(lib, what, "get() before the register", ECS_ERROR.RESOURCE_NOT_REGISTERED, () =>
		ecs.resources.get(Cfg)
	);
	ecs.resources.register(Cfg, { n: 1 });
	eq(what, "has() after the register", ecs.resources.has(Cfg), true);
	eq(what, "the value after the register", ecs.resources.get(Cfg).n, 1);
	throwsWith(lib, what, "a second register", ECS_ERROR.RESOURCE_ALREADY_REGISTERED, () =>
		ecs.resources.register(Cfg, { n: 2 })
	);
	ecs.resources.set(Cfg, { n: 3 });
	eq(what, "the value after set()", ecs.resources.get(Cfg).n, 3);
	ecs.resources.remove(Cfg);
	eq(what, "has() after remove()", ecs.resources.has(Cfg), false);
	// The key is free again. This is the present, absent, present axis.
	ecs.resources.register(Cfg, { n: 4 });
	eq(what, "the value after the second register", ecs.resources.get(Cfg).n, 4);

	// ── the events ──────────────────────────────────────────────────────────
	const Hit = eventKey("hit");
	const Ping = signalKey("ping");
	ecs.events.register(Hit, ["a", "b"]);
	ecs.events.registerSignal(Ping);
	let emit = 0;
	const seen = [];
	const signals = [];
	const em = ecs.registerSystem({
		name: "em",
		reads: [],
		writes: [],
		fn: (ctx) => {
			for (let i = 0; i < emit; i++) ctx.emit(Hit, { a: i, b: i * 2 });
			if (emit > 0) ctx.emit(Ping);
		},
	});
	const rd = ecs.registerSystem({
		name: "rd",
		reads: [],
		writes: [],
		fn: (ctx) => {
			const r = ctx.read(Hit);
			const rows = [];
			for (let i = 0; i < r.length; i++) rows.push(`${r.a[i]}:${r.b[i]}`);
			seen.push(rows.join(","));
			signals.push(ctx.read(Ping).length);
		},
	});
	ecs.addSystems(SCHEDULE.UPDATE, em);
	ecs.addSystems(SCHEDULE.POST_UPDATE, rd);
	ecs.startup();
	for (const n of [0, 2, 0, 3, 1, 0]) {
		emit = n;
		ecs.update(1);
	}
	// A channel clears itself at the end of each update. Therefore a tick with no emit
	// must read nothing, and a tick that emits must read that tick alone.
	eqList(what, "the rows of the event channel per tick", seen, ["", "0:0,1:2", "", "0:0,1:2,2:4", "0:0", ""]);
	eqList(what, "the count of the signal per tick", signals, [0, 1, 0, 1, 1, 0]);
	ecs.dispose();
	return CHECKS - at;
}

// ── 9. the guard on a sparse restore ────────────────────────────────────────
/**
 * A restore of a sparse snapshot into a world with a different shape must give a
 * NAMED error, and it must not write a part of the state.
 *
 * The simulation restores into the world that made the bytes, so it can never reach
 * this path. A consumer that loads a save from an older build can.
 */
export function sparseRestoreGuard(lib) {
	const what = "sparse-restore";
	const at = CHECKS;
	const { ECS, SparseRestoreError } = lib;
	const a = new ECS({ deterministic: true });
	const A1 = a.registerSparseComponent({ k: "i32" }, { name: "S1" });
	const ea = a.spawn();
	a.addSparse(ea, A1, { k: 5 });
	const bytes = a.snapshots.captureSparse();
	// The same shape restores.
	a.setSparseField(ea, A1, "k", 9);
	a.snapshots.restoreSparse(bytes);
	eq(what, "the field after a restore into the same world", a.getSparseField(ea, A1, "k"), 5);

	// A world with a DIFFERENT sparse shape must refuse the bytes.
	const b = new ECS({ deterministic: true });
	b.registerSparseComponent({ k: "i32", extra: "i32" }, { name: "S1" });
	b.registerSparseComponent({ z: "u8" }, { name: "S2" });
	let err = null;
	try {
		b.snapshots.restoreSparse(bytes);
	} catch (e) {
		err = e;
	}
	counted();
	if (err === null) bad(what, `a restore into a world with a different sparse shape did not throw`);
	counted();
	if (!(err instanceof SparseRestoreError)) {
		bad(what, `the restore threw ${err.name}, want SparseRestoreError: ${err.message}`);
	}
	a.dispose();
	b.dispose();
	return CHECKS - at;
}

// ── 10. the frame trace ─────────────────────────────────────────────────────
/**
 * `FrameTraceRecorder` against what the harness did.
 *
 * The trace is a development seam, and it records the systems, the commands and the
 * calls of the observers of one frame. The harness knows exactly which of those it
 * asked for. Therefore the count of each kind is a model, and this is not a check
 * that the recorder produced some output.
 */
export function frameTrace(lib) {
	const what = "trace";
	const at = CHECKS;
	const { ECS, SCHEDULE, FrameTraceRecorder } = lib;
	const ecs = new ECS({ deterministic: true });
	const Pos = ecs.registerComponent({ x: "i32" }, { name: "Pos" });
	const Tag = ecs.registerComponent({}, { name: "Tag" });
	let adds = 0;
	ecs.observe(Tag, { name: "tag-watch", access: {}, onAdd: () => adds++ });
	const seeds = [];
	for (let i = 0; i < 3; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: i });
		seeds.push(e);
	}
	const sys = ecs.registerSystem({
		name: "tagger",
		reads: [],
		writes: [],
		transitions: [{ whenHas: [Pos], add: [Tag], remove: [] }],
		fn: (ctx) => {
			for (const e of seeds) ctx.commands.add(e, Tag);
		},
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.startup();

	const rec = new FrameTraceRecorder();
	ecs.setTrace(rec);
	ecs.update(1);
	ecs.setTrace(null);
	const frames = rec.frames();
	// `setTrace` is `if (DEV)`-gated end to end, so a PRODUCTION build never installs
	// the sink and the recorder stays empty. That is the documented behaviour, and it
	// is the whole point of a development-only seam: the released package must pay
	// nothing for it. Therefore this probe has two arms, and the count of the frames
	// selects between them.
	//
	// The assertion about the callbacks of the observer holds in BOTH builds, because
	// an observer is not a development seam.
	eq(what, "the calls of the onAdd observer", adds, 3);
	if (frames.length === 0) {
		// The production arm. Nothing else to read; the recorder is correctly inert.
		ecs.dispose();
		return CHECKS - at;
	}
	// One call of `update`, therefore one frame.
	eq(what, "the count of the recorded frames", frames.length, 1);
	const kinds = new Map();
	for (const ev of frames[0].events) kinds.set(ev.kind, (kinds.get(ev.kind) ?? 0) + 1);
	// The harness queued exactly three `add` commands, and the observer therefore fired
	// exactly three times. Both numbers are a model, and the trace must give them.
	eq(what, "the add commands that the trace recorded", kinds.get("command_queued") ?? 0, 3);
	eq(what, "the observer calls that the trace recorded", kinds.get("observer_fired") ?? 0, 3);
	// The trace must name the system, and it must pair each start with an end.
	eq(
		what,
		"the starts and the ends of the systems",
		kinds.get("system_start") ?? 0,
		kinds.get("system_end") ?? 0
	);
	// Every event of one kind must carry the entity that the harness named.
	const seenEntities = new Set();
	for (const ev of frames[0].events) {
		if (ev.kind === "command_queued") seenEntities.add(ev.entity);
	}
	eqList(what, "the entities of the recorded commands", [...seenEntities].sort((a, b) => a - b), [...seeds].sort((a, b) => a - b));
	// `reset()` frees the recorder for a second run.
	rec.reset();
	eq(what, "the frames after reset()", rec.frames().length, 0);
	ecs.dispose();
	return CHECKS - at;
}

// ── 11. the explicit removal of a relation ──────────────────────────────────
/**
 * `relations.remove(src, R, tgt?)`, against a model.
 *
 * The simulation never calls it. A port of the net is an exclusive relation, and a
 * rewrite REPLACES its target with an `add`. Each other unlink in the harness comes
 * from `onDeleteTarget` when a target dies. Therefore the explicit unlink had no
 * cover. The rule for a MULTI relation had no cover also: if the caller gives no
 * `tgt`, the call must remove each target of that source.
 *
 * Four behaviours get an exact expected value:
 *   - an exclusive unlink removes the forward link AND the reverse key;
 *   - a multi unlink of ONE target keeps the other targets, and it keeps their
 *     reverse keys;
 *   - a multi unlink with NO target argument removes each target of that source. It
 *     must not change a different source that names the same target;
 *   - a removal that names no live pair makes no change, and it does not throw.
 */
export function relationRemoval(lib) {
	const what = "relation-remove";
	const at = CHECKS;
	const { ECS } = lib;
	const ecs = new ECS({ deterministic: true });
	const T = ecs.registerComponent({ v: "i32" }, { name: "T" });
	const Ex = ecs.relations.register({ exclusive: true, onDeleteTarget: "clear" });
	const Mu = ecs.relations.register({ multi: true, onDeleteTarget: "clear" });
	const e = [];
	for (let i = 0; i < 6; i++) {
		const x = ecs.spawn();
		ecs.addComponent(x, T, { v: i });
		e.push(x);
	}
	const asc = (xs) => [...xs].sort((a, b) => a - b);

	// ── the exclusive unlink ────────────────────────────────────────────────
	ecs.relations.add(e[1], Ex, e[0]);
	eq(what, "has() after the add", ecs.relations.has(e[1], Ex), true);
	eq(what, "targetOf() after the add", ecs.relations.targetOf(e[1], Ex), e[0]);
	eqList(what, "sourcesOf() after the add", ecs.relations.sourcesOf(e[0], Ex), [e[1]]);
	ecs.relations.remove(e[1], Ex, e[0]);
	eq(what, "has() after the remove", ecs.relations.has(e[1], Ex), false);
	eq(what, "targetOf() after the remove", ecs.relations.targetOf(e[1], Ex), undefined);
	// The reverse key must go with the forward link. A leak here is exactly the
	// `relation-reverse-leak` mutant, on the path that no other probe reaches.
	eqList(what, "sourcesOf() after the remove", ecs.relations.sourcesOf(e[0], Ex), []);
	eqList(what, "pairsOf() after the remove", ecs.relations.pairsOf(Ex), []);
	// A second remove names no live pair. It must be a no-op, and it must not throw.
	ecs.relations.remove(e[1], Ex, e[0]);
	eq(what, "has() after a second remove", ecs.relations.has(e[1], Ex), false);

	// ── the multi unlink of ONE target ──────────────────────────────────────
	ecs.relations.add(e[2], Mu, e[0]);
	ecs.relations.add(e[2], Mu, e[3]);
	ecs.relations.add(e[2], Mu, e[4]);
	eqList(what, "targetsOf() after three adds", ecs.relations.targetsOf(e[2], Mu), asc([e[0], e[3], e[4]]));
	ecs.relations.remove(e[2], Mu, e[3]);
	eqList(what, "targetsOf() after one remove", ecs.relations.targetsOf(e[2], Mu), asc([e[0], e[4]]));
	eqList(what, "the reverse key of the removed target", ecs.relations.sourcesOf(e[3], Mu), []);
	eqList(what, "the reverse key of a target that stayed", ecs.relations.sourcesOf(e[0], Mu), [e[2]]);
	eq(what, "has() while targets remain", ecs.relations.has(e[2], Mu), true);

	// ── the multi unlink with NO target: every target of that source ────────
	// A second source names `e[0]` as well, so "each target of THIS source" must
	// leave that other source alone.
	ecs.relations.add(e[5], Mu, e[0]);
	ecs.relations.remove(e[2], Mu);
	eqList(what, "targetsOf() after the remove of every target", ecs.relations.targetsOf(e[2], Mu), []);
	eq(what, "has() after the remove of every target", ecs.relations.has(e[2], Mu), false);
	eqList(what, "the other source survives", ecs.relations.sourcesOf(e[0], Mu), [e[5]]);
	eqList(what, "the reverse key of the other target is gone", ecs.relations.sourcesOf(e[4], Mu), []);
	eqList(
		what,
		"pairsOf() holds the surviving pair alone",
		ecs.relations.pairsOf(Mu).map(([s, t]) => `${s}>${t}`),
		[`${e[5]}>${e[0]}`]
	);
	ecs.dispose();
	return CHECKS - at;
}

// ── 12. the cursors and the single-entity refs ──────────────────────────────
/**
 * `ecs.cursor`, `ecs.cursorRead`, `ctx.ref`, `ctx.refRead` and `tryGetField`.
 *
 * The simulation writes each column through `eachChunk`, `setField` or
 * `updateField`. Therefore it never reaches this family of calls. `mutants.mjs`
 * found that gap: the first version of the `changed-tick-not-set-by-mut` mutant
 * removed the line for the change tick from `ctx.ref`. Its pattern matched, and the
 * mutant ESCAPED, because no case ran that code.
 *
 * The promises in the documentation are exact:
 *   - a cursor `at()` finds the entity again. A field write through the cursor goes
 *     into the column, and `getField` then reads the same value;
 *   - the MUTABLE cursor and `ctx.ref` set the tick for the change. Therefore
 *     `changed()` reports the archetype after a write through them, and it becomes
 *     quiet after that;
 *   - `tryGetField` gives `undefined` for a component that the entity does not hold.
 *     `getField` throws, or it reads a value with no meaning.
 */
export function cursorsAndRefs(lib) {
	const what = "cursors";
	const at = CHECKS;
	const { ECS, SCHEDULE } = lib;
	const ecs = new ECS({ deterministic: true });
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Other = ecs.registerComponent({ z: "i32" }, { name: "Other" });
	const ents = [];
	for (let i = 0; i < 5; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: i, y: i * 2 });
		ents.push(e);
	}

	// ── the host cursor: one object, many entities ──────────────────────────
	const cur = ecs.cursor(Pos);
	for (let i = 0; i < ents.length; i++) {
		cur.at(ents[i]);
		eq(what, `the cursor reads x of entity ${i}`, cur.x, i);
		cur.x = i + 100;
	}
	for (let i = 0; i < ents.length; i++) {
		eq(what, `getField sees the cursor write ${i}`, ecs.getField(ents[i], Pos, "x"), i + 100);
	}
	// `at()` gives the cursor back, so a single-expression read is one expression.
	eq(what, "at() returns the cursor", ecs.cursorRead(Pos).at(ents[2]).x, 102);
	const rcur = ecs.cursorRead(Pos);
	for (let i = 0; i < ents.length; i++) {
		eq(what, `the read-only cursor reads y of ${i}`, rcur.at(ents[i]).y, i * 2);
	}

	// ── `tryGetField`: the total sibling of `getField` ──────────────────────
	eq(what, "tryGetField on a component the entity holds", ecs.tryGetField(ents[0], Pos, "x"), 100);
	eq(what, "tryGetField on a component the entity lacks", ecs.tryGetField(ents[0], Other, "z"), undefined);

	// ── `ctx.ref` inside a system, and the change tick that it stamps ───────
	const qChanged = ecs.query(Pos).changed(Pos);
	let write = true;
	let changedArchetypes = 0;
	const writer = ecs.registerSystem({
		name: "ref-writer",
		reads: [],
		writes: [Pos],
		fn: (ctx) => {
			if (!write) return;
			// The mutable ref stamps the change tick. `refRead` does not, and the two
			// must agree about the VALUE.
			const w = ctx.ref(Pos, ents[0]);
			const r = ctx.refRead(Pos, ents[1]);
			w.y = r.y + 7;
		},
	});
	const reader = ecs.registerSystem({
		name: "changed-reader",
		reads: [Pos],
		writes: [],
		fn: () => {
			changedArchetypes = 0;
			qChanged.forEach(() => changedArchetypes++);
		},
	});
	ecs.addSystems(SCHEDULE.UPDATE, writer);
	ecs.addSystems(SCHEDULE.POST_UPDATE, reader);
	ecs.startup();

	// QUIET FIRST. This order IS the assertion. `addComponent` above set the tick for
	// the change of the archetype. The reader did not run one time, so its baseline is
	// the start of the run. Therefore the FIRST tick reports each archetype, and the
	// result does not depend on `ctx.ref`. A check on that tick passes against an ECS
	// that never sets the tick, and the `changed-tick-not-set-by-ref` mutant shows it.
	// Therefore the probe uses three ticks to make the baseline current, and it
	// requires a quiet layer, BEFORE it reads the result of one write through
	// `ctx.ref`.
	write = false;
	ecs.update(1);
	ecs.update(1);
	ecs.update(1);
	eq(what, "changed(Pos) before any write through a ref", changedArchetypes, 0);

	write = true;
	ecs.update(1);
	// entity 1 holds y = 2, so the write is 9. The value is the check that `refRead`
	// read the right row, and `ref` wrote the right one.
	eq(what, "the value that a write through ctx.ref left", ecs.getField(ents[0], Pos, "y"), 9);
	eq(what, "changed(Pos) after a write through ctx.ref", changedArchetypes, 1);
	// Two ticks with no write. A write stays visible to a system whose previous run
	// was at that tick, so the SECOND quiet tick is the one that must report nothing.
	write = false;
	ecs.update(1);
	ecs.update(1);
	eq(what, "changed(Pos) on a tick with no write through a ref", changedArchetypes, 0);
	eq(what, "the value after the quiet ticks", ecs.getField(ents[0], Pos, "y"), 9);
	ecs.dispose();
	return CHECKS - at;
}

// ── 13. the immediate toggle from the host ──────────────────────────────────
/**
 * `ecs.disable` and `ecs.enable`, called from the HOST and not through the seam.
 *
 * `world.mjs` sends each toggle through `HostCommandQueue`. The documentation gives
 * the reason: an observer fires for a DEFERRED toggle only, and an immediate call
 * from the host fires nothing. The complete quarantine layer of the oracle depends
 * on that sentence, and no test read it.
 *
 * This probe holds both halves. The immediate call must move the row: `isDisabled`
 * changes, a default query loses the row, and `includeDisabled()` keeps it. The
 * immediate call must also call NO observer. The deferred path in the same world
 * must then call one. Therefore this file measures the difference, and it does not
 * assume it.
 */
export function immediateToggle(lib) {
	const what = "immediate-toggle";
	const at = CHECKS;
	const { ECS, installHostCommandSeam } = lib;
	const ecs = new ECS({ deterministic: true });
	const queue = installHostCommandSeam(ecs, { name: "toggle-apply" });
	const Pos = ecs.registerComponent({ x: "i32" }, { name: "Pos" });
	let disables = 0;
	let enables = 0;
	ecs.observe(Pos, {
		name: "toggle-watch",
		access: { reads: [], writes: [] },
		onDisable: () => disables++,
		onEnable: () => enables++,
	});
	const ents = [];
	for (let i = 0; i < 4; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: i });
		ents.push(e);
	}
	ecs.startup();
	const qEnabled = ecs.query(Pos);
	const qAll = ecs.query(Pos).includeDisabled();
	const enabled = () => {
		const out = [];
		qEnabled.forEachEntity((e) => out.push(e));
		return out.sort((a, b) => a - b);
	};
	const all = () => {
		const out = [];
		qAll.forEachEntity((e) => out.push(e));
		return out.sort((a, b) => a - b);
	};
	eqList(what, "a default query before any toggle", enabled(), ents);

	// ── the immediate half ──────────────────────────────────────────────────
	ecs.disable(ents[1]);
	eq(what, "isDisabled after an immediate disable", ecs.isDisabled(ents[1]), true);
	eqList(what, "a default query hides the row", enabled(), [ents[0], ents[2], ents[3]]);
	eqList(what, "includeDisabled() keeps the row", all(), ents);
	eq(what, "the onDisable calls that an immediate disable made", disables, 0);
	ecs.enable(ents[1]);
	eq(what, "isDisabled after an immediate enable", ecs.isDisabled(ents[1]), false);
	eqList(what, "a default query after the immediate enable", enabled(), ents);
	eq(what, "the onEnable calls that an immediate enable made", enables, 0);

	// ── the deferred half, for the contrast ─────────────────────────────────
	queue.disable(ents[2]);
	ecs.update(1);
	eq(what, "isDisabled after a deferred disable", ecs.isDisabled(ents[2]), true);
	eq(what, "the onDisable calls that the seam made", disables, 1);
	queue.enable(ents[2]);
	ecs.update(1);
	eq(what, "the onEnable calls that the seam made", enables, 1);
	eqList(what, "a default query after the deferred round trip", enabled(), ents);
	ecs.dispose();
	return CHECKS - at;
}

// ── 14. the guard on a restore of the whole world ───────────────────────────
/**
 * A restore that must fail gives a NAMED error, and it leaves the world unchanged.
 *
 * Layer 8 of the driver does a round trip that must SUCCEED, so it reads the good
 * path only. A consumer that loads a save from an older build, or a file that became
 * damaged, reaches this path instead. `restore` promises to fail CLOSED: it tests the
 * frame and the registration BEFORE it writes any live state.
 *
 * "It threw" is not the assertion here. After each refused call this probe reads
 * `stateHash` again, and the hash must not move. A restore that wrote a part of the
 * state and then threw would pass a check of the error alone.
 *
 * The probe also pins `ECS_SNAPSHOT_VERSION`. It reads the version word out of a
 * fresh capture and requires that word to be the exported constant. Therefore a
 * change to the frame format cannot pass this file while the constant stays the same.
 */
export function worldRestoreGuard(lib) {
	const what = "world-restore";
	const at = CHECKS;
	const { ECS, ECSRestoreError, StoreRestoreError, ECS_SNAPSHOT_VERSION } = lib;
	// The frame of a world snapshot: magic, version, and the length of each of the
	// three sections. Refer to `resume.ts`.
	const MAGIC_OFF = 0;
	const VERSION_OFF = 4;
	const FRAME_HEADER = 20;

	const ecs = new ECS({ deterministic: true });
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Mark = ecs.registerComponent({}, { name: "Mark" });
	const S = ecs.registerSparseComponent({ v: "i32" }, { name: "S" });
	const ents = [];
	for (let i = 0; i < 6; i++) {
		const e = ecs.spawn();
		ecs.addComponent(e, Pos, { x: i, y: i * 10 });
		if (i % 2 === 0) ecs.addComponent(e, Mark);
		ecs.addSparse(e, S, { v: i * 100 });
		ents.push(e);
	}
	ecs.startup();
	ecs.update(1);

	const bytes = ecs.snapshots.capture();
	const hash0 = ecs.snapshots.stateHash();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	eq(what, "the version word of a fresh capture", view.getUint32(VERSION_OFF, true), ECS_SNAPSHOT_VERSION);

	// The good path first. Without it every refusal below could pass while the bytes
	// themselves were bad, and the probe would show nothing.
	ecs.setField(ents[0], Pos, "x", 999);
	ecs.setSparseField(ents[0], S, "v", 999);
	ecs.snapshots.restore(bytes);
	eq(what, "a dense field after a good restore", ecs.getField(ents[0], Pos, "x"), 0);
	eq(what, "a sparse field after a good restore", ecs.getSparseField(ents[0], S, "v"), 0);
	eq(what, "the hash after a good restore", ecs.snapshots.stateHash(), hash0);

	/** Require a restore to refuse the bytes AND to change nothing. */
	const refuses = (name, make) => {
		const before = ecs.snapshots.stateHash();
		const beforeField = ecs.getField(ents[1], Pos, "x");
		let err = null;
		try {
			ecs.snapshots.restore(make());
		} catch (e) {
			err = e;
		}
		counted();
		if (err === null) bad(what, `${name}: the restore did not throw`);
		counted();
		if (!(err instanceof ECSRestoreError)) {
			bad(what, `${name}: the restore threw ${err.name}, want ECSRestoreError: ${err.message}`);
		}
		eq(what, `${name}: the hash after the refused restore`, ecs.snapshots.stateHash(), before);
		eq(what, `${name}: a live field after the refused restore`, ecs.getField(ents[1], Pos, "x"), beforeField);
	};

	/** A copy of the good bytes, which the caller then damages. */
	const copy = () => Uint8Array.from(bytes);

	refuses("a wrong version", () => {
		const b = copy();
		new DataView(b.buffer).setUint32(VERSION_OFF, ECS_SNAPSHOT_VERSION + 1, true);
		return b;
	});
	refuses("a wrong magic", () => {
		const b = copy();
		new DataView(b.buffer).setUint32(MAGIC_OFF, 0xdeadbeef, true);
		return b;
	});
	refuses("a buffer that is shorter than the frame header", () => bytes.slice(0, FRAME_HEADER - 1));
	refuses("a frame with one byte removed", () => bytes.slice(0, bytes.byteLength - 1));
	refuses("a frame with one byte added", () => {
		const b = new Uint8Array(bytes.byteLength + 1);
		b.set(bytes);
		return b;
	});
	// Damage inside the DENSE section, and not in the frame. The dense half has an
	// error class of its own, `StoreRestoreError`. The guard of the ECS reads the same
	// bytes, and it runs FIRST, because that is what keeps a refused restore
	// non-mutating. Therefore this entry gives one error class for each kind of
	// damage, and the assertion below pins that order.
	refuses("damage in the dense section", () => {
		const b = copy();
		new DataView(b.buffer).setUint32(FRAME_HEADER, 0, true);
		return b;
	});
	counted();
	if (StoreRestoreError === undefined) bad(what, `the entry does not export StoreRestoreError`);
	{
		let err = null;
		try {
			const b = copy();
			new DataView(b.buffer).setUint32(FRAME_HEADER, 0, true);
			ecs.snapshots.restore(b);
		} catch (e) {
			err = e;
		}
		counted();
		if (err instanceof StoreRestoreError) {
			bad(what, `damage in the dense section gave StoreRestoreError, want ECSRestoreError`);
		}
	}

	// A world with a DIFFERENT registration must refuse the bytes, and it must stay
	// usable. This is the case that a save from an older build gives.
	const other = new ECS({ deterministic: true });
	const OPos = other.registerComponent({ x: "i32", y: "i32", z: "i32" }, { name: "Pos" });
	const oe = other.spawn();
	other.addComponent(oe, OPos, { x: 1, y: 2, z: 3 });
	other.startup();
	other.update(1);
	const otherHash = other.snapshots.stateHash();
	let otherErr = null;
	try {
		other.snapshots.restore(bytes);
	} catch (e) {
		otherErr = e;
	}
	counted();
	if (otherErr === null) bad(what, `a restore into a world with a different registration did not throw`);
	counted();
	if (!(otherErr instanceof ECSRestoreError)) {
		bad(what, `the restore threw ${otherErr.name}, want ECSRestoreError: ${otherErr.message}`);
	}
	eq(what, "the hash of the other world after the refused restore", other.snapshots.stateHash(), otherHash);
	eq(what, "a field of the other world after the refused restore", other.getField(oe, OPos, "z"), 3);

	// The world must still TICK after the refusals. A world that fails closed but
	// cannot continue has kept its bytes and lost its purpose.
	ecs.update(1);
	eq(what, "a dense field after the world ticked again", ecs.getField(ents[0], Pos, "x"), 0);
	ecs.snapshots.restore(bytes);
	eq(what, "the hash after a good restore that follows the refusals", ecs.snapshots.stateHash(), hash0);
	ecs.dispose();
	other.dispose();
	return CHECKS - at;
}

// ── 15. the immediate component writes of the host ──────────────────────────
/**
 * `addComponent`, `addComponents`, `removeComponent` and `removeComponents`, called
 * from the HOST and between the ticks.
 *
 * A structural observer runs for a DEFERRED operation only. Therefore the simulation
 * makes each structural change through `ctx.commands` or through the write seam. The
 * sets that the observers maintain are the oracle of layer 4.
 *
 * An immediate call from the host fires nothing. So the simulation cannot use one:
 * the derived sets would go out of step by design. This probe measures that
 * difference, and it does not assume it. It has the same shape as the probe for the
 * immediate toggle.
 *
 * The PLURAL forms make one archetype transition where the singular forms make
 * several. The result must be the same, so this probe does both and compares them.
 *
 * `fieldId` gives the index of a field inside the schema of its component. The order
 * of the declaration gives the expected value.
 */
export function immediateComponentWrites(lib) {
	const what = "immediate-components";
	const at = CHECKS;
	const { ECS, ECS_ERROR, bundle, SCHEDULE } = lib;
	const ecs = new ECS({ deterministic: true });
	const Pos = ecs.registerComponent({ x: "i32", y: "i32" }, { name: "Pos" });
	const Vel = ecs.registerComponent({ dx: "i32" }, { name: "Vel" });
	const Tag = ecs.registerComponent({}, { name: "Tag" });
	let adds = 0;
	let removes = 0;
	for (const def of [Pos, Vel, Tag]) {
		ecs.observe(def, {
			name: `watch-${def.id}`,
			access: { reads: [], writes: [] },
			onAdd: () => adds++,
			onRemove: () => removes++,
		});
	}
	const single = ecs.spawn();
	const plural = ecs.spawn();
	ecs.startup();
	// There is no public "which archetype holds this entity", so the probe reads the
	// archetype through a query. That is the same route the driver uses.
	const qPos = ecs.query(Pos);
	const archOf = (e) => {
		let id = -1;
		qPos.forEach((arch) => {
			const ids = arch.entityIds;
			for (let i = 0; i < arch.entityCount; i++) if (ids[i] === e) id = arch.id;
		});
		return id;
	};

	// ── the immediate half ──────────────────────────────────────────────────
	// One at a time.
	ecs.addComponent(single, Pos, { x: 1, y: 2 });
	ecs.addComponent(single, Vel, { dx: 3 });
	ecs.addComponent(single, Tag);
	// The same three in one call, through the varargs form. `bundle` pairs a
	// definition with its values, and a tag goes in as a bare definition.
	ecs.addComponents(plural, bundle(Pos, { x: 1, y: 2 }), bundle(Vel, { dx: 3 }), Tag);
	eq(what, "the onAdd calls that the immediate adds made", adds, 0);

	for (const [name, e] of [["one at a time", single], ["in one call", plural]]) {
		eq(what, `Pos.x after the adds ${name}`, ecs.getField(e, Pos, "x"), 1);
		eq(what, `Pos.y after the adds ${name}`, ecs.getField(e, Pos, "y"), 2);
		eq(what, `Vel.dx after the adds ${name}`, ecs.getField(e, Vel, "dx"), 3);
		eq(what, `Tag after the adds ${name}`, ecs.hasComponent(e, Tag), true);
	}
	// Both rows must now be in ONE archetype. The plural form makes one transition
	// and the singular form makes three, and the destination is the same.
	eq(what, "the two rows share an archetype", archOf(single), archOf(plural));
	counted();
	if (archOf(single) < 0) bad(what, `neither row is in an archetype that the query gives`);

	// Removal, by the same two routes.
	ecs.removeComponent(single, Vel);
	ecs.removeComponent(single, Tag);
	ecs.removeComponents(plural, Vel, Tag);
	eq(what, "the onRemove calls that the immediate removes made", removes, 0);
	for (const [name, e] of [["one at a time", single], ["in one call", plural]]) {
		eq(what, `Vel after the removes ${name}`, ecs.hasComponent(e, Vel), false);
		eq(what, `Tag after the removes ${name}`, ecs.hasComponent(e, Tag), false);
		// The row moved between archetypes. The column that stayed must carry its
		// values across that move.
		eq(what, `Pos.x survives the removes ${name}`, ecs.getField(e, Pos, "x"), 1);
		eq(what, `Pos.y survives the removes ${name}`, ecs.getField(e, Pos, "y"), 2);
	}
	eq(what, "the two rows share an archetype after the removes", archOf(single), archOf(plural));

	// ── the deferred half, for the contrast ─────────────────────────────────
	// The same two operations inside a system. These MUST call the observers. Without
	// this half, an ECS whose observers never fire would pass the counts above.
	let step = 0;
	const sys = ecs.registerSystem({
		name: "immediate-contrast",
		reads: [],
		writes: [],
		transitions: [{ whenHas: [Pos], add: [Vel], remove: [Vel] }],
		fn: (ctx) => {
			if (step === 0) ctx.commands.add(single, Vel, { dx: 7 });
			if (step === 1) ctx.commands.remove(single, Vel);
		},
	});
	ecs.addSystems(SCHEDULE.UPDATE, sys);
	ecs.update(1);
	eq(what, "the onAdd calls that the deferred add made", adds, 1);
	eq(what, "Vel.dx after the deferred add", ecs.getField(single, Vel, "dx"), 7);
	step = 1;
	ecs.update(1);
	eq(what, "the onRemove calls that the deferred remove made", removes, 1);
	eq(what, "Vel after the deferred remove", ecs.hasComponent(single, Vel), false);

	// ── fieldId ─────────────────────────────────────────────────────────────
	// The index of the field inside the schema of its component. The order of the
	// declaration gives it.
	eq(what, "fieldId of the first field", ecs.fieldId(Pos, "x"), 0);
	eq(what, "fieldId of the second field", ecs.fieldId(Pos, "y"), 1);
	eq(what, "fieldId of the only field of another component", ecs.fieldId(Vel, "dx"), 0);
	throwsWith(lib, what, "fieldId of a name that is absent", ECS_ERROR.FIELD_NOT_REGISTERED, () =>
		ecs.fieldId(Pos, "nope")
	);
	ecs.dispose();
	return CHECKS - at;
}

// ── the runner ──────────────────────────────────────────────────────────────
/**
 * Each probe: its name, its function, and a FLOOR on the count of the assertions
 * that it must make.
 *
 * The floor is the third column. It does more than report. A probe gives the delta
 * of the shared `CHECKS` counter, so the number is the count of the comparisons that
 * ran. A probe that returns early, or that loses an assertion in a change, then
 * gives a smaller number and the floor fails. Without the floor, the number is a
 * report only.
 *
 * Each floor is the count that a PRODUCTION build makes. `frameTrace` reads a sink
 * that a `DEV` guard controls, so that probe makes fewer comparisons in a production
 * build. A development build makes the same count or more.
 */
export const PROBES = [
	["traversal guards (cycle, maxDepth)", traversalGuards, 11],
	["built-in relations (ChildOf, IsA)", builtinRelations, 13],
	["the wildcard read (*, T)", wildcardRead, 4],
	["templates and the batch paths", templatesAndBatch, 145],
	["the vocabulary of the write seam", hostSeamVocabulary, 13],
	["the replay of a command log", commandReplay, 7],
	["the run conditions and the sets", runConditions, 9],
	["the lifecycle of a resource, and the events", resourceAndEventEdges, 10],
	["the guard on a sparse restore", sparseRestoreGuard, 3],
	["the frame trace", frameTrace, 1],
	["the explicit removal of a relation", relationRemoval, 18],
	["the cursors and the single-entity refs", cursorsAndRefs, 23],
	["the immediate toggle from the host", immediateToggle, 12],
	["the guard on a restore of the whole world", worldRestoreGuard, 36],
	["the immediate component writes of the host", immediateComponentWrites, 29],
];

/** Run each probe. It gives back the count of the probes and the count of the
 * assertions that they made. It also requires each probe to reach its floor. */
export function runSurface(lib, { quiet = false } = {}) {
	let checks = 0;
	for (const [name, fn, floor] of PROBES) {
		const n = fn(lib);
		if (n < floor) {
			bad("runner", `the probe "${name}" made ${n} assertions, and its floor is ${floor}`);
		}
		checks += n;
		if (!quiet) console.log(`  ${name.padEnd(44)} ${String(n).padStart(4)} checks`);
	}
	return { probes: PROBES.length, checks };
}
