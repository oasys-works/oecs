/**
 * Runs one scenario for the CPU profiler of Node. Use `readprof.mjs` to read the
 * `.cpuprofile` file that the profiler writes.
 *
 *   node --cpu-prof --cpu-prof-dir=bench/.out/prof bench/profile.mjs <scenario>
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { buildLib } from "./build.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.join(here, ".out");
fs.mkdirSync(outDir, { recursive: true });

const outfile = path.join(outDir, `oecs.prof.mjs`);
await buildLib(outfile, { dev: false });
const { ECS, SCHEDULE } = await import(
	url.pathToFileURL(outfile).href + `?t=${process.hrtime.bigint()}`
);

const N = 10_000;
const scenario = process.argv[2] ?? "addComponent";

const scenarios = {
	addComponent() {
		for (let rep = 0; rep < 200; rep++) {
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
			const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
			for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Vel, { vx: 1, vy: 2 });
		}
	},
	addRemove() {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Tag = ecs.registerTag();
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		for (let r = 0; r < 200; r++) {
			for (let i = 0; i < ids.length; i++) ecs.addComponent(ids[i], Tag);
			for (let i = 0; i < ids.length; i++) ecs.removeComponent(ids[i], Tag);
		}
	},
	getField() {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
		let s = 0;
		for (let r = 0; r < 2000; r++) for (let i = 0; i < N; i++) s += ecs.getField(ids[i], Pos, "x");
		globalThis.__sink = s;
	},
	queryResolve() {
		const ecs = new ECS();
		const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
		const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
		ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 }), Vel({ vx: 1, vy: 1 })), 1000);
		let q;
		for (let i = 0; i < 20_000_000; i++) q = ecs.query(Pos, Vel);
		globalThis.__sink = q;
	},
	update() {
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
		for (let f = 0; f < 500_000; f++) ecs.update(0.016);
	},
	updateNoop() {
		const ecs = new ECS();
		const noop = () => {};
		for (let i = 0; i < 20; i++) ecs.addSystems(SCHEDULE.UPDATE, ecs.registerSystem({ fn: noop }));
		ecs.startup();
		for (let f = 0; f < 2_000_000; f++) ecs.update(0.016);
	},
	commands() {
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
				},
			})
		);
		ecs.startup();
		for (let f = 0; f < 3000; f++) {
			mode = 0;
			ecs.update(0.016);
			mode = 1;
			ecs.update(0.016);
		}
	},
	despawn() {
		for (let rep = 0; rep < 400; rep++) {
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const ids = ecs.spawnMany(ecs.template(Pos({ x: 1, y: 1 })), N);
			for (let i = 0; i < ids.length; i++) ecs.despawn(ids[i]);
		}
	},
	spawnEmpty() {
		for (let rep = 0; rep < 400; rep++) {
			const ecs = new ECS();
			for (let i = 0; i < N; i++) ecs.spawn();
		}
	},
	spawnTemplate() {
		for (let rep = 0; rep < 400; rep++) {
			const ecs = new ECS();
			const Pos = ecs.registerComponent({ x: "f64", y: "f64" });
			const Vel = ecs.registerComponent({ vx: "f64", vy: "f64" });
			const t = ecs.template(Pos({ x: 1, y: 2 }), Vel({ vx: 0, vy: 0 }));
			for (let i = 0; i < N; i++) ecs.spawn(t);
		}
	},
};

if (!scenarios[scenario]) {
	console.error(`unknown scenario: ${scenario}\navailable: ${Object.keys(scenarios).join(", ")}`);
	process.exit(1);
}
const t0 = process.hrtime.bigint();
scenarios[scenario]();
console.log(`${scenario}: ${Number(process.hrtime.bigint() - t0) / 1e6} ms`);
