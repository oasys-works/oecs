/**
 * The change feed, shared by more than one consumer.
 *
 * The store records what changed and hands it out. The observer registry is
 * one consumer. These tests hold the seam to the three rules that let a second
 * consumer join. The observation flags merge by OR across consumers. Each
 * drain runs once per run and every later consumer of that run gets the same
 * result. The structural hooks and the settle hooks are lists, and each list
 * runs in install order.
 *
 * They also cover the checks `ECS.create` runs over a plugin list: a missing
 * dependency, one name twice, and a facade member that would overwrite
 * something the world already carries.
 */

import { describe, expect, it, vi } from "vitest";
import { Store } from "../../store";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../phase";
import { ECSError, ECS_ERROR } from "../../utils/error";
import { openAccess } from "../test_helpers";
import type { Plugin, PluginHost } from "../../plugin";
import type { ObservationFlags } from "../../store";
import type { EntityID } from "../../entity";
import type { SystemContext } from "../../system_context";

const NOTHING: ObservationFlags = {
	add: false,
	remove: false,
	disable: false,
	enable: false,
	set: false
};

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

describe("the observation flags merge across consumers", () => {
	it("keeps a flag one consumer asked for while another drops its own", () => {
		const store = new Store();
		const Pos = store.registerComponent({ x: "f64" });
		const cid = Pos.id as number;
		const adds: EntityID[] = [];
		store.addStructuralHook((ev) => {
			for (let i = 0; i < ev.addLen; i++) adds.push(ev.addEid[i] as EntityID);
		});

		// A wants the adds. B wants the row grain. Neither wants what the other
		// asked for, so an ask that overwrites loses one of them.
		store.configureObservation("a", cid, { ...NOTHING, add: true });
		store.configureObservation("b", cid, { ...NOTHING, set: true });

		const first = store.createEntity();
		store.addComponentDeferred(first, Pos, { x: 1 });
		store.flushStructural();
		expect(adds).toEqual([first]);

		store.noteSetEntity(Pos, first);
		expect(store.drainSet(cid, store.advanceChangeTick()).listed).toEqual([first]);

		// A leaves. Its ask goes to all-false, which is the same as absent.
		store.configureObservation("a", cid, NOTHING);
		adds.length = 0;
		const second = store.createEntity();
		store.addComponentDeferred(second, Pos, { x: 1 });
		store.flushStructural();
		expect(adds).toEqual([]);

		// B never asked for the adds and never gave up the row grain.
		store.noteSetEntity(Pos, second);
		expect(store.drainSet(cid, store.advanceChangeTick()).listed).toEqual([second]);
	});
});

describe("a drain runs once per run", () => {
	it("gives the second dense consumer of one run the rows the first one got", () => {
		const store = new Store();
		const Pos = store.registerComponent({ x: "f64" });
		const cid = Pos.id as number;
		store.configureObservation("a", cid, { ...NOTHING, set: true });
		const e = store.createEntity();
		store.addComponent(e, Pos, { x: 0 });
		store.noteSetEntity(Pos, e);

		const run = store.advanceChangeTick();
		const first = store.drainSet(cid, run);
		expect(first.listed).toEqual([e]);
		const second = store.drainSet(cid, run);
		expect(second).toBe(first);
		expect(second.listed).toEqual([e]);

		// A later run starts fresh: the records of the run above are spent.
		expect(store.drainSet(cid, store.advanceChangeTick()).listed).toEqual([]);
	});

	it("gives the second sparse consumer of one run the members the first one got", () => {
		const store = new Store();
		const Cool = store.registerSparseComponent({ v: "f64" });
		const sid = Cool as unknown as number;
		store.configureSparseObservation("a", sid, true);
		const e = store.createEntity();
		store.addSparse(e, Cool, { v: 0 });
		store.setSparseField(e, Cool, "v", 1);

		const run = store.advanceChangeTick();
		const first = store.drainSparseSet(sid, run);
		expect(first).toEqual([e]);
		const second = store.drainSparseSet(sid, run);
		expect(second).toBe(first);
		expect(second).toEqual([e]);

		expect(store.drainSparseSet(sid, store.advanceChangeTick())).toEqual([]);
	});
});

describe("the hook lists", () => {
	it("hands one round's structural events to every hook, in install order", () => {
		const store = new Store();
		const Pos = store.registerComponent({ x: "f64" });
		const cid = Pos.id as number;
		const seen: string[] = [];
		store.addStructuralHook((ev) => seen.push(`first:${ev.addEid[0]}:${ev.addLen}`));
		store.addStructuralHook((ev) => seen.push(`second:${ev.addEid[0]}:${ev.addLen}`));
		store.configureObservation("a", cid, { ...NOTHING, add: true });

		const e = store.createEntity();
		store.addComponentDeferred(e, Pos, { x: 1 });
		store.flushStructural();

		expect(seen).toEqual([`first:${e}:1`, `second:${e}:1`]);
	});

	it("runs every settle hook once per update, in install order, with one run tick", () => {
		const log: [string, number][] = [];
		const settleCap = (name: string): Plugin<object> => ({
			name,
			install(host: PluginHost): object {
				host.onSettle((run) => log.push([name, run]));
				return {};
			}
		});
		const world = ECS.create({ plugins: [settleCap("first"), settleCap("second")] });
		world.update(0);

		expect(log.map((e) => e[0])).toEqual(["first", "second"]);
		expect(log[0][1]).toBe(log[1][1]);
		expect(log).toHaveLength(2);

		// A world of its own keeps its own list, and an empty list fires nothing.
		const spy = vi.fn();
		const spied = ECS.create({
			plugins: [
				{
					name: "spy",
					install(host: PluginHost): object {
						host.onSettle(spy);
						return {};
					}
				} as Plugin<object>
			]
		});
		ECS.create({}).update(0);
		expect(spy).not.toHaveBeenCalled();
		spied.update(0);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("ECS.create checks the plugin list", () => {
	const alpha: Plugin<object> = { name: "alpha", install: () => ({}) };

	it("names a dependency the list never installed", () => {
		const beta: Plugin<object> = {
			name: "beta",
			requires: ["alpha"],
			install: () => ({})
		};
		const err = thrown(() => ECS.create({ plugins: [beta] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_NOT_INSTALLED);
		expect(err.message).toContain("beta plugin");
		expect(err.message).toContain("@oasys/oecs/alpha");
		// The dependency ahead of it in the list satisfies the ask.
		expect(() => ECS.create({ plugins: [alpha, beta] })).not.toThrow();
		// Behind it, it does not: the list is walked in order.
		expect(() => ECS.create({ plugins: [beta, alpha] })).toThrow(ECSError);
	});

	it("names a plugin the list installs twice", () => {
		const err = thrown(() => ECS.create({ plugins: [alpha, alpha] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_ALREADY_INSTALLED);
		expect(err.message).toContain("alpha");
	});

	it("names a facade member that would overwrite a world member", () => {
		const clash: Plugin<object> = {
			name: "gamma",
			install: () => ({ update: (): void => {} })
		};
		const err = thrown(() => ECS.create({ plugins: [clash] }));
		expect(err.category).toBe(ECS_ERROR.PLUGIN_SURFACE_COLLISION);
		expect(err.message).toContain("gamma");
		expect(err.message).toContain("update");
		// A reserved slot exists to be filled, so filling one is allowed.
		expect(() =>
			ECS.create({
				plugins: [{ name: "delta", install: () => ({ observe: (): void => {} }) } as Plugin<object>]
			})
		).not.toThrow();
	});
});

describe("the host a plugin installs through", () => {
	it("hands over the world, and settles after every system of the frame", () => {
		const order: string[] = [];
		let handed: unknown = null;
		const probe: Plugin<object> = {
			name: "probe",
			install(host: PluginHost): object {
				handed = host.world;
				host.world.addSystems(
					SCHEDULE.POST_UPDATE,
					host.world.registerSystem({
						...openAccess([]),
						fn(_ctx: SystemContext): void {
							order.push("system");
						}
					})
				);
				host.onSettle(() => order.push("settle"));
				return {};
			}
		};
		const world = ECS.create({ plugins: [probe] });
		expect(handed).toBe(world);

		world.startup();
		world.update(0);
		expect(order).toEqual(["system", "settle"]);
	});
});
