/**
 * A plugin written outside this package, from the exported seam alone.
 *
 * Every plugin in `src/plugins` is first-party, so each one may reach a module
 * a consumer cannot. This file writes its plugin in the test body, from
 * `Plugin`, `PluginHost` and the change feed, and installs it through
 * `ECS.create` beside a first-party plugin. What it proves is that the seam is
 * whole: the facade lands on the world, the change feed answers a consumer it
 * has never heard of, and the settle hook runs at the tail of `update()`.
 *
 * A second plugin here installs a system dispatch route, which is the hook
 * point the workers plugin uses. It is named for what it hooks, so a third
 * party claims a system body through the same seam and the core names no
 * plugin.
 *
 * It also holds `ECS.create` to its three refusals. A duplicate name, a
 * missing `requires` and a facade key that would overwrite a world member each
 * throw, and the message names the plugin.
 *
 * The facade key here is `audit`, which no first-party plugin claims, so the
 * surface check has to accept it.
 */

import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { ECSError, ECS_ERROR } from "../../utils/error";
import type { ComponentDef } from "../../component";
import type { EntityID } from "../../entity";
import type { ChangeFeed, Plugin, PluginHost, RouteControl } from "../../plugin";
import type { SystemConfig } from "../../system";
import { SCHEDULE } from "../../phase";
import { relations } from "../../../../plugins/relations";
import { observers } from "../../../../plugins/observers";

/** The surface the third-party plugin contributes. */
interface AuditPlugin {
	readonly audit: Audit;
}

/** Counts what the change feed reported for one component, and when.
 *
 * A consumer of the feed names itself, asks for the grain it wants, and drains
 * on its own settle hook. Nothing else crosses. */
class Audit {
	/** Entity ids the feed reported, newest run last. */
	public readonly seen: EntityID[] = [];
	/** One entry per settle, holding the change tick of that point. */
	public readonly runs: number[] = [];

	constructor(
		private readonly _changes: ChangeFeed,
		/** The component this plugin registered for itself. */
		public readonly def: ComponentDef<{ note: "i32" }>
	) {}

	public drain(run: number): void {
		this.runs.push(run);
		const result = this._changes.drainSet(this.def.id, run);
		for (const id of result.scanned) this.seen.push(id);
		for (const id of result.listed) this.seen.push(id);
	}
}

/** The plugin a consumer writes.
 *
 * It registers its own component through the bare world, asks the feed for
 * that component's row grain, and drains on the settle hook. Those three are
 * the whole seam a plugin outside the package gets. */
function audit(name = "audit"): Plugin<AuditPlugin> {
	return {
		name,
		// It reads a relation target in its own dispatch, so relations comes
		// first in the list or construction fails.
		requires: ["relations"],
		install(host: PluginHost): AuditPlugin {
			const def = host.world.registerComponent({ note: "i32" }, { name: `${name}.Note` });
			const service = new Audit(host.changes, def);
			// The row grain, keyed by this plugin's name. The store merges every
			// consumer's ask, so this never takes a flag from another.
			host.changes.configureObservation(name, def.id, {
				add: false,
				remove: false,
				disable: false,
				enable: false,
				set: true
			});
			host.onSettle((run) => service.drain(run));
			return { audit: service };
		}
	};
}

/** The surface the route plugin contributes. */
interface DetourPlugin {
	readonly detour: Detour;
}

/** A system dispatch route written outside this package.
 *
 * It claims every system whose name starts with `detour.`, and runs a counter
 * in place of that system's own body. The plan it builds is opaque to the
 * core, which is the property this proves: the descriptor carries a plugin's
 * value and the schedule never looks inside it. */
class Detour {
	public ran = 0;
	public disposed = 0;
	public control: RouteControl | null = null;

	/** The registration seam. `undefined` leaves the system on its own `fn`. */
	public plan(config: SystemConfig): object | undefined {
		const name = config.name;
		if (name === undefined || !name.startsWith("detour.")) return undefined;
		return { label: name };
	}

	/** The dispatch seam. True means this route ran the body. */
	public run(plan: object): boolean {
		expect(plan).toHaveProperty("label");
		this.ran++;
		return true;
	}
}

/** A plugin that installs a route, the hook the workers plugin uses. */
function detour(): Plugin<DetourPlugin> {
	return {
		name: "detour",
		install(host: PluginHost): DetourPlugin {
			const service = new Detour();
			service.control = host.installRoute(service);
			host.onDispose(() => {
				service.disposed++;
			});
			return { detour: service };
		}
	};
}

/** Run `fn` and return the `ECSError` it threw. */
function thrown(fn: () => unknown): ECSError {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(ECSError);
		return e as ECSError;
	}
	expect.unreachable("expected a fault, got a value");
	throw new Error("unreachable");
}

describe("a plugin written outside this package", () => {
	it("installs beside a first-party plugin and lands its facade on the world", () => {
		const world = ECS.create({ plugins: [relations(), audit()] });

		// The facade is on the world, and it is typed: reading `audit.seen`
		// compiles because `ECS.create` intersected `AuditPlugin` in.
		expect(world.audit).toBeInstanceOf(Audit);
		expect(world.audit.seen).toEqual([]);
		// It registered its own component through the bare world it was handed.
		expect(world.audit.def.id).toBe(0);
		// The first-party facade is there too, from the same call.
		expect(world.relations.count).toBe(0);
	});

	it("drains the row grain it asked for, at the settle hook it registered", () => {
		const world = ECS.create({ plugins: [relations(), audit()] });
		const Note = world.audit.def;
		const e = world.spawn();
		world.addComponent(e, Note, { note: 1 });
		world.flush();
		world.startup();
		world.update(1 / 60);
		const firstRuns = world.audit.runs.length;
		expect(firstRuns).toBe(1);

		// A write to the watched component is the grain's whole point. The next
		// settle reports the row, and no earlier one does.
		world.audit.seen.length = 0;
		world.setField(e, Note, "note", 7);
		world.update(1 / 60);
		expect(world.audit.runs.length).toBe(2);
		expect(world.audit.seen).toEqual([e]);

		// A settle with no write reports nothing, so the drain is a report of
		// change and not of membership.
		world.audit.seen.length = 0;
		world.update(1 / 60);
		expect(world.audit.runs.length).toBe(3);
		expect(world.audit.seen).toEqual([]);
		// Each settle runs at a later change tick than the one before it.
		expect(world.audit.runs[1]).toBeGreaterThan(world.audit.runs[0]);
		expect(world.audit.runs[2]).toBeGreaterThan(world.audit.runs[1]);
	});

	it("lets a plugin outside this package claim a system body", () => {
		const world = ECS.create({ plugins: [detour()] });
		const route = world.detour;
		let own = 0;
		let plain = 0;
		world.addSystems(
			SCHEDULE.UPDATE,
			world.registerSystem({
				name: "detour.claimed",
				reads: [],
				writes: [],
				fn: () => {
					own++;
				}
			}),
			world.registerSystem({
				name: "kept",
				reads: [],
				writes: [],
				fn: () => {
					plain++;
				}
			})
		);
		world.startup();

		// No route is attached yet, so every system runs its own body.
		world.update(1 / 60);
		expect(own).toBe(1);
		expect(plain).toBe(1);
		expect(route.ran).toBe(0);

		// Attaching the route replaces the claimed body and leaves the other.
		route.control!.route(route);
		world.update(1 / 60);
		expect(route.ran).toBe(1);
		expect(own).toBe(1);
		expect(plain).toBe(2);

		// Detaching puts the claimed system back on its own body.
		route.control!.route(null);
		world.update(1 / 60);
		expect(route.ran).toBe(1);
		expect(own).toBe(2);
		expect(plain).toBe(3);
	});

	it("runs a plugin's dispose hook when the world goes away", () => {
		const world = ECS.create({ plugins: [detour()] });
		const route = world.detour;
		expect(route.disposed).toBe(0);
		world.dispose();
		expect(route.disposed).toBe(1);
	});

	it("refuses a second system dispatch route", () => {
		const err = thrown(() => ECS.create({ plugins: [detour(), { ...detour(), name: "second" }] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("route");
	});

	it("refuses two plugins of one name", () => {
		const err = thrown(() => ECS.create({ plugins: [relations(), audit(), audit()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("audit");
	});

	it("refuses a plugin whose requires is not installed yet", () => {
		// The list is walked in order, so a dependency has to come first.
		const err = thrown(() => ECS.create({ plugins: [audit(), relations()] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_NOT_INSTALLED);
		expect(err.message).toContain("audit");
		expect(err.message).toContain("relations");
	});

	it("refuses a facade key that would overwrite a world member", () => {
		const collide: Plugin<{ spawn: () => void }> = {
			name: "collide",
			install(): { spawn: () => void } {
				return { spawn: () => undefined };
			}
		};
		const err = thrown(() => ECS.create({ plugins: [collide] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_SURFACE_COLLISION);
		expect(err.message).toContain("collide");
		expect(err.message).toContain("spawn");
	});

	it("lets a plugin fill a reserved slot, which is what the first-party ones do", () => {
		// `observe` is a reserved slot: a bare world declares it so it can name
		// the missing plugin, and the plugin that fills it is meant to replace
		// it. The collision check has to skip exactly those.
		const world = ECS.create({ plugins: [observers()] });
		expect(typeof world.observe).toBe("function");
	});
});
