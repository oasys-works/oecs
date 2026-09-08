/** A world with the snapshot plugin installed. The tools here drive capture
 * and restore, so they take it. A consumer installs only the plugins it
 * names, and carries no code for the rest. */
function snapshotWorld(lib, options) {
	return lib.ECS.create({
		...options,
		plugins: [lib.snapshots(), lib.events(), lib.relations(), lib.observers()]
	});
}

/**
 * Cross-runtime conformance probe.
 *
 * Runs the shipped artifact (`dist/index.js`) on whichever engine invokes it,
 * exercises the core paths, and prints one line: `<engine> <stateHash> <checks>`.
 *
 * CI runs this on node, deno and bun, then compares the lines. A difference in
 * the hash is a cross-engine divergence in the layout, the iteration order, or
 * the arithmetic, the class of fault that round 3 of the substrate study found
 * by adding a second engine, and that a single-engine test suite cannot see.
 *
 * Deterministic worlds reject `f32` or `f64` columns, so every column here is
 * `i32`. That is the same constraint a determinism-mode consumer works under.
 *
 * Usage:
 *   node  scripts/conformance.mjs
 *   deno  run --allow-read scripts/conformance.mjs
 *   bun   scripts/conformance.mjs
 */

const DIST = new URL("../../dist/index.js", import.meta.url);
const PLUGIN = (name) => new URL(`../../dist/plugins/${name}.js`, import.meta.url).href;
const { ECS, SCHEDULE } = await import(DIST.href);
// Each plugin ships as its own entry, so a consumer that installs none of
// them carries none of their code. The probe installs all four, and thus it
// imports all four.
const lib = {
	ECS,
	snapshots: (await import(PLUGIN("snapshots"))).snapshots,
	events: (await import(PLUGIN("events"))).events,
	relations: (await import(PLUGIN("relations"))).relations,
	observers: (await import(PLUGIN("observers"))).observers
};

function engineName() {
	if (typeof Deno !== "undefined") return `deno-${Deno.version.deno}`;
	if (typeof Bun !== "undefined") return `bun-${Bun.version}`;
	if (typeof process !== "undefined" && process.versions?.node)
		return `node-${process.versions.node}`;
	return "unknown";
}

const failures = [];
function check(name, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures.push(`${name}: expected ${expected}, got ${actual}`);
	return ok;
}

// --- world -----------------------------------------------------------------
const ecs = snapshotWorld(lib, { deterministic: true });

const Pos = ecs.registerComponent({ x: "i32", y: "i32" });
const Vel = ecs.registerComponent({ vx: "i32", vy: "i32" });
const Tag = ecs.registerComponent({});

const movers = ecs.query(Pos, Vel);

const move = ecs.registerSystem({
	reads: [Vel],
	writes: [Pos],
	fn: () => {
		movers.forEachChunk((cols, count) => {
			const { x, y } = cols.mut(Pos);
			const { vx, vy } = cols.read(Vel);
			for (let i = 0; i < count; i++) {
				x[i] += vx[i];
				y[i] += vy[i];
			}
		});
	}
});

ecs.addSystems(SCHEDULE.UPDATE, move);
ecs.startup();

// --- populate: deterministic, seeded, no Math.random ------------------------
const N = 2000;
let seed = 0x9e3779b9 >>> 0;
const rand = () => {
	// xorshift32, the same generator the substrate study used for its shuffle,
	// chosen here because it is exactly reproducible across engines.
	seed ^= seed << 13;
	seed >>>= 0;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	seed >>>= 0;
	return seed;
};

const entities = [];
for (let i = 0; i < N; i++) {
	const e = ecs.spawn();
	ecs.addComponent(e, Pos, { x: rand() % 1000, y: rand() % 1000 });
	if (i % 2 === 0) ecs.addComponent(e, Vel, { vx: (rand() % 7) - 3, vy: (rand() % 7) - 3 });
	if (i % 5 === 0) ecs.addComponent(e, Tag);
	entities.push(e);
}

check("query count after spawn", movers.entityCount, N / 2);

// --- run frames -------------------------------------------------------------
for (let f = 0; f < 20; f++) ecs.update(1);

// --- structural churn: add and remove drives archetype transitions --------------
for (let i = 0; i < N; i += 3) {
	const e = entities[i];
	if (ecs.hasComponent(e, Tag)) ecs.removeComponent(e, Tag);
	else ecs.addComponent(e, Tag);
}
for (let i = 0; i < N; i += 7) ecs.despawn(entities[i]);

for (let f = 0; f < 10; f++) ecs.update(1);

// --- liveness and generational handles ----------------------------------------
check("despawned entity is dead", ecs.isAlive(entities[0]), false);
check("live entity is alive", ecs.isAlive(entities[1]), true);

// --- snapshot round-trip ----------------------------------------------------
const hashBefore = ecs.snapshots.stateHash();
const snap = ecs.snapshots.capture();
for (let f = 0; f < 5; f++) ecs.update(1);
const hashDrifted = ecs.snapshots.stateHash();
check("update changes the hash", hashDrifted !== hashBefore, true);
ecs.snapshots.restore(snap);
check("restore reproduces the hash", ecs.snapshots.stateHash(), hashBefore);

// --- report -----------------------------------------------------------------
const hash = ecs.snapshots.stateHash();
const line = `${engineName()} hash=${hash >>> 0} entities=${ecs.entityCount} failures=${failures.length}`;
console.log(line);
for (const f of failures) console.error(`  FAIL ${f}`);

if (failures.length > 0) {
	if (typeof process !== "undefined") process.exitCode = 1;
	else if (typeof Deno !== "undefined") Deno.exit(1);
}
