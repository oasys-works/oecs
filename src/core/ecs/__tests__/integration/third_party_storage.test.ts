/**
 * The storage seam and the access domain, driven from outside the package
 * through `fixtures/aos_plugin.ts`.
 *
 * | Path | Contract |
 * | --- | --- |
 * | purge | Each destroy path calls it once for each entity. A recycled index starts empty. |
 * | digest | No store keeps the old digest. A store moves it, even when empty. |
 * | snapshot | A restore reads the records back. A mismatch refuses before any state changes. |
 * | domain | The rules of a component term. Run conditions and observers take it too. |
 */

import { describe, expect, it } from "vitest";
import {
	ECS,
	ECSError,
	ECSRestoreError,
	ECS_ERROR,
	SCHEDULE,
	accessDomain,
	getEntityIndex,
	runIfAll,
	type EntityID,
	type Plugin,
	type PluginHost,
	type RunCondition,
	type StorageProvider
} from "../../../../index";
import { snapshots } from "../../../../plugins/snapshots";
import { relations, registerChildOf } from "../../../../plugins/relations";
import { observers } from "../../../../plugins/observers";
import { Store } from "../../store";
import { storeOnlyHost } from "../../plugin";
import { aos, AosStore } from "../fixtures/aos_plugin";

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected a throw");
}

function ecsError(fn: () => unknown): ECSError {
	const err = thrown(fn);
	expect(err).toBeInstanceOf(ECSError);
	return err as ECSError;
}

/** A plugin that registers one arbitrary provider, for the refusals. */
function raw(provider: StorageProvider, name = "raw"): Plugin<object> {
	return {
		name,
		install(host: PluginHost): object {
			host.registerStorage(provider);
			return {};
		}
	};
}

function world() {
	return ECS.create({ deterministic: true, plugins: [snapshots(), relations(), aos()] });
}

describe("a plugin store, registered through the host", () => {
	it("drops a record on the deferred destroy, and a recycled index starts empty", () => {
		const w = world();
		const kin = w.aos.define("kin", ["type", "seq"]);
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const a = w.spawnBundle(Tag);
		const b = w.spawnBundle(Tag);
		kin.add(a, { type: 1, seq: 10 });
		kin.add(b, { type: 2, seq: 20 });
		const doomed: EntityID[] = [a];
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "reaper",
				reads: [],
				writes: [],
				despawns: [Tag],
				fn(ctx) {
					for (const e of doomed.splice(0)) ctx.commands.despawn(e);
				}
			})
		);
		w.startup();
		w.update(1 / 60);

		expect(w.isAlive(a)).toBe(false);
		expect(kin.has(a)).toBe(false);
		expect(kin.size).toBe(1);
		expect(kin.members()).toEqual([b]);
		expect(kin.purged).toBe(1);

		// The free list is LIFO, so the next spawn takes the index `a` held.
		const c = w.spawnBundle(Tag);
		expect(getEntityIndex(c)).toBe(getEntityIndex(a));
		expect(kin.has(c)).toBe(false);
		expect(kin.size).toBe(1);
	});

	it("drops a record on the immediate despawn", () => {
		const w = world();
		const kin = w.aos.define("kin", ["x"]);
		const e = w.spawn();
		const keep = w.spawn();
		kin.add(e, { x: 3 });
		kin.add(keep, { x: 4 });
		w.despawn(e);
		expect(kin.has(e)).toBe(false);
		expect(kin.members()).toEqual([keep]);
		expect(kin.get(keep, "x")).toBe(4);
		expect(kin.purged).toBe(1);
	});

	it("drops the record of every entity a delete cascade takes, on both paths", () => {
		for (const path of ["immediate", "deferred"] as const) {
			const w = world();
			const kin = w.aos.define("kin", ["depth"]);
			const ChildOf = registerChildOf(w);
			// A chain root -> a -> b -> c, and one bystander.
			const chain: EntityID[] = [w.spawn()];
			for (let i = 1; i < 4; i++) {
				const e = w.spawn();
				w.relations.add(e, ChildOf, chain[i - 1]);
				chain.push(e);
			}
			const bystander = w.spawn();
			for (let i = 0; i < chain.length; i++) kin.add(chain[i], { depth: i });
			kin.add(bystander, { depth: 99 });

			if (path === "immediate") {
				w.despawn(chain[0]);
			} else {
				w.addSystems(
					SCHEDULE.UPDATE,
					w.registerSystem({
						name: "cut",
						reads: [],
						writes: [],
						despawns: [],
						exclusive: true,
						fn(ctx) {
							ctx.commands.despawn(chain[0]);
						}
					})
				);
				w.startup();
				w.update(1 / 60);
			}

			for (const e of chain) expect(w.isAlive(e)).toBe(false);
			expect(kin.members()).toEqual([bystander]);
			// Once for each destroyed entity, and never for the bystander.
			expect(kin.purged).toBe(chain.length);
		}
	});

	it("purges every store that purges, on both paths, not the first alone", () => {
		const w = world();
		const one = w.aos.define("one", ["x"]);
		const two = w.aos.define("two", ["x"]);
		const three = w.aos.define("three", ["x"]);
		const stores = [one, two, three];
		const [a, b] = [w.spawn(), w.spawn()];
		for (const st of stores) {
			st.add(a, { x: 1 });
			st.add(b, { x: 2 });
		}
		w.despawn(a);
		expect(stores.map((st) => st.has(a))).toEqual([false, false, false]);
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "reap",
				reads: [],
				writes: [],
				exclusive: true,
				fn(ctx) {
					ctx.commands.despawn(b);
				}
			})
		);
		w.startup();
		w.update(1 / 60);
		expect(stores.map((st) => st.size)).toEqual([0, 0, 0]);
		expect(stores.map((st) => st.purged)).toEqual([2, 2, 2]);
	});

	it("purges a store on a bare store too, through the store-only host", () => {
		const store = new Store();
		const kin = new AosStore("kin", ["x"]);
		storeOnlyHost(store).registerStorage(kin);
		const e = store.createEntity();
		kin.add(e, { x: 1 });
		store.destroyEntity(e);
		expect(kin.has(e)).toBe(false);
		expect(kin.purged).toBe(1);
	});

	it("never calls a store that supplies no purge", () => {
		const w = ECS.create({ plugins: [raw({ name: "inert" })] });
		const e = w.spawn();
		w.despawn(e);
		expect(w.isAlive(e)).toBe(false);
	});
});

describe("the digest folds a plugin store", () => {
	function populate(w: Pick<ECS, "registerComponent" | "spawnBundle">): EntityID[] {
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const out: EntityID[] = [];
		for (let i = 0; i < 6; i++) out.push(w.spawnBundle(Tag({ v: i })));
		return out;
	}

	it("leaves the digest of a world with no store as it was, and a store moves it even empty", () => {
		const bare = ECS.create({ deterministic: true, plugins: [snapshots()] });
		const w = world();
		populate(bare);
		populate(w);
		expect(w.snapshots.stateHash()).toBe(bare.snapshots.stateHash());
		w.aos.define("kin", ["x"]);
		expect(w.snapshots.stateHash()).not.toBe(bare.snapshots.stateHash());
	});

	it("folds nothing for a store that supplies no hash", () => {
		const bare = ECS.create({ deterministic: true, plugins: [snapshots()] });
		const w = ECS.create({
			deterministic: true,
			plugins: [snapshots(), raw({ name: "inert", purge: () => {} })]
		});
		populate(bare);
		populate(w);
		expect(w.snapshots.stateHash()).toBe(bare.snapshots.stateHash());
	});

	it("moves with every record, and returns when the record returns", () => {
		const w = world();
		const es = populate(w);
		const kin = w.aos.define("kin", ["x", "y"]);
		kin.add(es[0], { x: 1, y: 2 });
		const h0 = w.snapshots.stateHash();
		kin.set(es[0], "y", 3);
		const h1 = w.snapshots.stateHash();
		expect(h1).not.toBe(h0);
		kin.set(es[0], "y", 2);
		expect(w.snapshots.stateHash()).toBe(h0);
		kin.add(es[1], { x: 0, y: 0 });
		expect(w.snapshots.stateHash()).not.toBe(h0);
		kin.remove(es[1]);
		expect(w.snapshots.stateHash()).toBe(h0);
	});

	it("gives one digest for equal contents reached in another order", () => {
		const a = world();
		const b = world();
		const ea = populate(a);
		const eb = populate(b);
		const ka = a.aos.define("kin", ["x"]);
		const kb = b.aos.define("kin", ["x"]);
		for (let i = 0; i < 6; i++) ka.add(ea[i], { x: i * 7 });
		for (let i = 5; i >= 0; i--) kb.add(eb[i], { x: i * 7 });
		kb.add(eb[2], { x: 0 });
		kb.set(eb[2], "x", 14);
		expect(a.snapshots.stateHash()).toBe(b.snapshots.stateHash());
	});

	it("moves the digest for a store whose hash folds no word", () => {
		const bare = ECS.create({ deterministic: true, plugins: [snapshots()] });
		const w = ECS.create({
			deterministic: true,
			plugins: [snapshots(), raw({ name: "silent", hash: () => {} })]
		});
		expect(w.snapshots.stateHash()).not.toBe(bare.snapshots.stateHash());
	});

	it("keeps one word apart from the store that folded it", () => {
		// Two stores fold the same one word between them. Only the position of
		// each store tells the two worlds apart.
		const both = (first: number[], second: number[]) =>
			ECS.create({
				deterministic: true,
				plugins: [
					snapshots(),
					raw({ name: "a", hash: (fold) => first.forEach(fold) }, "pa"),
					raw({ name: "b", hash: (fold) => second.forEach(fold) }, "pb")
				]
			});
		expect(both([5], []).snapshots.stateHash()).not.toBe(both([], [5]).snapshots.stateHash());
	});

	it("folds each store under its own position, so two stores do not alias", () => {
		const a = world();
		const b = world();
		const ea = populate(a);
		const eb = populate(b);
		const a1 = a.aos.define("one", ["x"]);
		a.aos.define("two", ["x"]);
		b.aos.define("one", ["x"]);
		const b2 = b.aos.define("two", ["x"]);
		a1.add(ea[0], { x: 5 });
		b2.add(eb[0], { x: 5 });
		expect(a.snapshots.stateHash()).not.toBe(b.snapshots.stateHash());
	});
});

describe("the world snapshot carries a plugin store", () => {
	function scene() {
		const w = world();
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		const kin = w.aos.define("kin", ["type", "seq"]);
		const es: EntityID[] = [];
		for (let i = 0; i < 5; i++) es.push(w.spawnBundle(Tag({ v: i })));
		for (let i = 0; i < 4; i++) kin.add(es[i], { type: i, seq: 100 + i });
		w.startup();
		return { w, kin, es, Tag };
	}

	it("brings every record back, and the digest with it", () => {
		const { w, kin, es } = scene();
		const hash = w.snapshots.stateHash();
		const before = kin.members().map((e) => [e, kin.get(e, "type"), kin.get(e, "seq")]);
		const bytes = w.snapshots.capture();

		kin.set(es[0], "seq", -1);
		kin.remove(es[1]);
		kin.add(es[4], { type: 9, seq: 9 });
		w.despawn(es[2]);
		expect(w.snapshots.stateHash()).not.toBe(hash);

		w.snapshots.restore(bytes);
		expect(w.snapshots.stateHash()).toBe(hash);
		expect(kin.members().map((e) => [e, kin.get(e, "type"), kin.get(e, "seq")])).toEqual(before);
		expect(w.isAlive(es[2])).toBe(true);
	});

	it("mounts into a second world that registered the same store", () => {
		const src = scene();
		const dst = scene();
		dst.kin.remove(dst.es[0]);
		dst.kin.set(dst.es[1], "seq", 0);
		dst.w.snapshots.restore(src.w.snapshots.capture());
		expect(dst.w.snapshots.stateHash()).toBe(src.w.snapshots.stateHash());
		expect(dst.kin.members()).toEqual(src.kin.members());
	});

	it("restores the store after the world, so the store reads the restored entities", () => {
		const w = ECS.create({ deterministic: true, plugins: [snapshots()] });
		const e = w.spawn();
		const seen: boolean[] = [];
		const probe: StorageProvider = {
			name: "probe",
			capture: () => new Uint8Array([1]),
			restore: () => {
				seen.push(w.isAlive(e));
			}
		};
		storeOnlyHost((w as unknown as { _store: Store })._store).registerStorage(probe);
		const bytes = w.snapshots.capture();
		w.despawn(e);
		expect(w.isAlive(e)).toBe(false);
		w.snapshots.restore(bytes);
		expect(seen).toEqual([true]);
	});

	it("refuses a restore into a world whose store supplies no capture", () => {
		const data = new Map<EntityID, string>();
		const w = ECS.create({
			deterministic: true,
			plugins: [snapshots(), raw({ name: "keep", purge: (e) => void data.delete(e) })]
		});
		const bytes = w.snapshots.capture();
		const e = w.spawn();
		data.set(e, "e");
		const hash = w.snapshots.stateHash();
		const err = thrown(() => w.snapshots.restore(bytes));
		expect(err).toBeInstanceOf(ECSRestoreError);
		expect((err as Error).message).toContain("'keep'");
		expect((err as Error).message).toContain("capture");
		expect(w.isAlive(e)).toBe(true);
		expect(w.snapshots.stateHash()).toBe(hash);
	});

	it("refuses a mismatched store before it touches the world", () => {
		const cases: [string, (w: ReturnType<typeof world>) => void][] = [
			["another name", (w) => w.aos.define("other", ["type", "seq"])],
			["a second store", (w) => w.aos.define("extra", ["x"])]
		];
		const src = scene();
		const bytes = src.w.snapshots.capture();
		for (const [label, change] of cases) {
			const w = world();
			const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
			if (label === "another name") {
				change(w);
			} else {
				w.aos.define("kin", ["type", "seq"]);
				change(w);
			}
			const e = w.spawnBundle(Tag({ v: 42 }));
			w.startup();
			const hash = w.snapshots.stateHash();
			const err = thrown(() => w.snapshots.restore(bytes));
			expect(err, label).toBeInstanceOf(ECSRestoreError);
			expect((err as Error).message, label).toMatch(/storage mismatch/);
			expect(w.snapshots.stateHash(), label).toBe(hash);
			expect(w.getField(e, Tag, "v"), label).toBe(42);
		}
	});

	it("refuses stores registered in another order", () => {
		const a = world();
		a.aos.define("one", ["x"]);
		a.aos.define("two", ["x"]);
		a.startup();
		const b = world();
		b.aos.define("two", ["x"]);
		b.aos.define("one", ["x"]);
		b.startup();
		expect(() => b.snapshots.restore(a.snapshots.capture())).toThrow(/'one', 'two'/);
	});

	it("refuses a snapshot whose store the world never registered", () => {
		const src = scene();
		// The same archetype set as the source, so the dense guard passes and the
		// storage check is what refuses.
		const w = ECS.create({ deterministic: true, plugins: [snapshots(), relations()] });
		const Tag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		w.spawnBundle(Tag({ v: 0 }));
		w.startup();
		expect(() => w.snapshots.restore(src.w.snapshots.capture())).toThrow(
			/carries stores 'kin', and this world registered none/
		);
	});

	it("carries a store's own refusal as an ECSRestoreError, with the world untouched", () => {
		const { w, kin, es } = scene();
		const bytes = w.snapshots.capture();
		kin.set(es[0], "seq", 555);
		const hash = w.snapshots.stateHash();
		// Damage the stride word of the store's own section. The frame still
		// parses, so the store's `validate` is what refuses.
		const sections = bytes.slice();
		const view = new DataView(sections.buffer);
		const storageLen = view.getUint32(20, true);
		const storageAt = sections.length - storageLen;
		// [u32 count][u32 nameLen]["kin"][u32 dataLen] then the store's bytes.
		const dataAt = storageAt + 4 + 4 + 3 + 4;
		view.setInt32(dataAt, 7, true);
		const err = thrown(() => w.snapshots.restore(sections));
		expect(err).toBeInstanceOf(ECSRestoreError);
		expect((err as Error).message).toMatch(/storage 'kin' refused its section: .*7 fields/);
		expect(w.snapshots.stateHash()).toBe(hash);
		expect(kin.get(es[0], "seq")).toBe(555);
	});

	it("reads a legacy frame as one with no store, and refuses it where a store needs a section", () => {
		// A world with no store writes an empty storage section. Cut the sixth
		// header word and the section to get the frame the version 1 build wrote.
		const bare = ECS.create({ deterministic: true, plugins: [snapshots()] });
		const Tag = bare.registerComponent({ v: "i32" }, { name: "Tag" });
		bare.spawnBundle(Tag({ v: 3 }));
		bare.startup();
		const v2 = bare.snapshots.capture();
		const view = new DataView(v2.buffer);
		const storageLen = view.getUint32(20, true);
		const body = v2.subarray(24, v2.length - storageLen);
		const v1 = new Uint8Array(20 + body.length);
		v1.set(v2.subarray(0, 20));
		new DataView(v1.buffer).setUint32(4, 1, true);
		v1.set(body, 20);

		const hash = bare.snapshots.stateHash();
		bare.spawnBundle(Tag({ v: 4 }));
		bare.snapshots.restore(v1);
		expect(bare.snapshots.stateHash()).toBe(hash);

		const w = world();
		const WTag = w.registerComponent({ v: "i32" }, { name: "Tag" });
		w.spawnBundle(WTag({ v: 0 }));
		w.aos.define("kin", ["x"]);
		w.startup();
		expect(() => w.snapshots.restore(v1)).toThrow(
			/carries stores none, and this world registered 'kin'/
		);
	});
});

describe("registerStorage refuses a malformed store", () => {
	it("refuses a store with no name", () => {
		const err = ecsError(() => ECS.create({ plugins: [raw({ name: "" })] }));
		expect(err.category).toBe(ECS_ERROR.INVALID_STORAGE_PROVIDER);
	});

	it("refuses capture without restore, and restore without capture", () => {
		const a = ecsError(() =>
			ECS.create({ plugins: [raw({ name: "half", capture: () => new Uint8Array(0) })] })
		);
		expect(a.category).toBe(ECS_ERROR.INVALID_STORAGE_PROVIDER);
		expect(a.message).toMatch(/'half' supplies capture alone/);
		const b = ecsError(() => ECS.create({ plugins: [raw({ name: "half", restore: () => {} })] }));
		expect(b.message).toMatch(/'half' supplies restore alone/);
	});

	it("refuses a second store of one name, and keeps the first", () => {
		const w = world();
		const first = w.aos.define("kin", ["x"]);
		const err = ecsError(() => w.aos.define("kin", ["y"]));
		expect(err.category).toBe(ECS_ERROR.INVALID_STORAGE_PROVIDER);
		expect(err.message).toMatch(/'kin'/);
		const e = w.spawn();
		first.add(e, { x: 1 });
		w.despawn(e);
		expect(first.purged).toBe(1);
	});
});

describe("an access domain holds a system to its declaration", () => {
	function setup() {
		const w = ECS.create({ plugins: [aos(), observers()] });
		const kin = w.aos.define("kin", ["x"]);
		const e = w.spawn();
		kin.add(e, { x: 1 });
		return { w, kin, e };
	}

	function run(w: ReturnType<typeof setup>["w"]): void {
		w.startup();
		w.update(1 / 60);
	}

	it("lets a declared reader read, and refuses the write it did not declare", () => {
		const { w, kin, e } = setup();
		let read = 0;
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "reader",
				reads: [],
				writes: [],
				domainReads: [kin.domain],
				fn() {
					read = kin.get(e, "x");
					kin.set(e, "x", 2);
				}
			})
		);
		const err = ecsError(() => run(w));
		expect(read).toBe(1);
		expect(err.category).toBe(ECS_ERROR.ACCESS_UNDECLARED);
		expect(err.message).toBe(
			"system 'reader' performed write on access domain 'kin' but did not declare it. Add the domain to 'domainWrites'"
		);
	});

	it("refuses a read a system never declared, and names the field that fixes it", () => {
		const { w, kin, e } = setup();
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "stranger",
				reads: [],
				writes: [],
				fn() {
					kin.get(e, "x");
				}
			})
		);
		expect(() => run(w)).toThrow(
			"system 'stranger' performed read on access domain 'kin' but did not declare it. Add the domain to 'domainReads or domainWrites'"
		);
	});

	it("lets a declared writer read too", () => {
		const { w, kin, e } = setup();
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "writer",
				reads: [],
				writes: [],
				domainWrites: [kin.domain],
				fn() {
					kin.set(e, "x", kin.get(e, "x") + 1);
				}
			})
		);
		run(w);
		expect(kin.get(e, "x")).toBe(2);
	});

	it("keys on identity, so a second domain of one name authorises nothing", () => {
		const { w, kin, e } = setup();
		const twin = accessDomain("kin");
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "twin",
				reads: [],
				writes: [],
				domainWrites: [twin],
				fn() {
					kin.get(e, "x");
				}
			})
		);
		expect(() => run(w)).toThrow(/performed read on access domain 'kin'/);
	});

	it("passes an exclusive system and a call outside every system", () => {
		const { w, kin, e } = setup();
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem({
				name: "god",
				reads: [],
				writes: [],
				exclusive: true,
				fn() {
					kin.set(e, "x", 7);
				}
			})
		);
		run(w);
		expect(kin.get(e, "x")).toBe(7);
		kin.set(e, "x", 8);
		expect(kin.get(e, "x")).toBe(8);
	});

	it("refuses a bare function system, which declares nothing", () => {
		const { w, kin, e } = setup();
		w.addSystems(
			SCHEDULE.UPDATE,
			w.registerSystem(() => {
				kin.get(e, "x");
			})
		);
		expect(() => run(w)).toThrow(/performed read on access domain 'kin'/);
	});

	it("holds a run condition to domainReads, and never lets it write", () => {
		const cases = [
			{ label: "declared", declare: true, write: false, fault: null },
			{ label: "undeclared", declare: false, write: false, fault: "read" },
			{ label: "writer", declare: true, write: true, fault: "write" }
		] as const;
		for (const c of cases) {
			const { w, kin, e } = setup();
			const gate: RunCondition = {
				name: "gate",
				...(c.declare ? { domainReads: [kin.domain] } : {}),
				evaluate: () => {
					if (c.write) kin.set(e, "x", 0);
					return kin.get(e, "x") === 1;
				}
			};
			let ran = 0;
			w.addSystems(SCHEDULE.UPDATE, {
				system: w.registerSystem({
					name: "gated",
					reads: [],
					writes: [],
					fn() {
						ran++;
					}
				}),
				runIf: gate
			});
			if (c.fault === null) {
				run(w);
				expect(ran, c.label).toBe(1);
			} else {
				expect(() => run(w), c.label).toThrow(
					new RegExp(`system 'gate' performed ${c.fault} on access domain 'kin'`)
				);
			}
		}
	});

	it("carries domainReads through a condition combinator", () => {
		const { w, kin, e } = setup();
		const reads: RunCondition = {
			name: "reads",
			domainReads: [kin.domain],
			evaluate: () => kin.get(e, "x") === 1
		};
		const always: RunCondition = { name: "always", evaluate: () => true };
		let ran = 0;
		w.addSystems(SCHEDULE.UPDATE, {
			system: w.registerSystem({
				name: "gated",
				reads: [],
				writes: [],
				fn() {
					ran++;
				}
			}),
			runIf: runIfAll(always, reads)
		});
		run(w);
		expect(ran).toBe(1);
	});

	it("holds an observer callback to its declared access", () => {
		for (const declared of [true, false]) {
			const { w, kin } = setup();
			const Hit = w.registerComponent({ n: "i32" }, { name: "Hit" });
			w.observe(Hit, {
				onAdd(eid) {
					kin.add(eid, { x: 5 });
				},
				access: declared ? { domainWrites: [kin.domain] } : {}
			});
			w.addSystems(
				SCHEDULE.UPDATE,
				w.registerSystem({
					name: "hitter",
					reads: [],
					writes: [],
					spawns: [[Hit]],
					fn(ctx) {
						ctx.commands.spawn(Hit({ n: 1 }));
					}
				})
			);
			if (declared) {
				run(w);
				expect(kin.size).toBe(2);
			} else {
				expect(() => run(w)).toThrow(/performed write on access domain 'kin'/);
			}
		}
	});
});
