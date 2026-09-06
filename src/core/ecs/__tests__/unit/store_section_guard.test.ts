/**
 * Store section guard: the banner boundaries, held by a test instead of a
 * comment.
 *
 * `store.ts` divides itself with `// ====` banners, and divides its field
 * declarations with `// --- X ---` sub-banners. Nothing checked that the
 * division meant anything. A method in one section could reach a field another
 * section owns, and the banner still read as a boundary.
 *
 * This test derives both from the file, with the TypeScript compiler API, the
 * way `ecs_passthrough_guard.test.ts` derives the pass-through band. It then
 * holds every cross-section field reach to `ALLOWED` below, one entry per
 * edge, each naming the fields it covers and why the edge exists. A new reach
 * fails here and names the section, the owner and the field.
 *
 * The list pins today's coupling. It is not a design. Read it as the bill for
 * a split: an entry is a seam a split has to build or a field a split has to
 * move.
 *
 * **Reads of `CORE` are exempt.** The entity index, the archetype graph, the
 * component metadata and the change tick are what every section is written
 * against. Requiring an entry for each would say only that the file has
 * shared core state, which is true of every archetype ECS. A *write* to `CORE`
 * is not exempt, because that is the reach a split has to reason about.
 *
 * The list is exact in both directions. An edge missing from `ALLOWED` fails,
 * and an `ALLOWED` entry no longer in the file fails too, so an extraction
 * that removes coupling has to delete its entry.
 *
 * Cold path. It parses one file at import.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const storePath = fileURLToPath(new URL("../../store.ts", import.meta.url));
const source = readFileSync(storePath, "utf8");
const lines = source.split("\n");
const sourceFile = ts.createSourceFile(storePath, source, ts.ScriptTarget.ESNext, true);

// --- Section and owner names, spelled once ------------------------------

const PRELUDE = "(prelude)";
const S_ARCH_GRAPH = "Archetype graph";
const S_LIFECYCLE = "Entity lifecycle";
const S_SPAWN = "Template and direct spawn";
const S_TOGGLE = "Entity enable and disable";
const S_DESTROY = "Deferred destruction";
const S_STRUCTURAL = "Deferred structural changes";
const S_OBSERVERS = "Component observers";
const S_REGISTRATION = "Component registration";
const S_SPARSE = "Sparse storage class (out-of-identity components)";
const S_SNAPSHOT = "World snapshot and resume, mount onto a live world";
const S_RELATIONS = "Relations, (relation, target) pairs on the sparse store";
const S_IMMEDIATE = "Immediate component operations (for setup and spawning)";
const S_DIRECT = "Direct data access (used by SystemContext)";
const S_QUERY = "Query support";
const S_EVENTS = "Event channels, delegations to the event registry";
const S_RESOURCES =
	"Resource storage, delegations to `ResourceRegistry` (resource_registry.ts)";

/** Every `// ====` banner, in file order, with the synthetic prelude first.
 * A rename or a removal fails here first, which is the intended reading
 * order: the section list is the claim, the edge list is the detail. */
const EXPECTED_SECTIONS = [
	PRELUDE,
	S_ARCH_GRAPH,
	S_LIFECYCLE,
	S_SPAWN,
	S_TOGGLE,
	S_DESTROY,
	S_STRUCTURAL,
	S_OBSERVERS,
	S_REGISTRATION,
	S_SPARSE,
	S_SNAPSHOT,
	S_RELATIONS,
	S_IMMEDIATE,
	S_DIRECT,
	S_QUERY,
	S_EVENTS,
	S_RESOURCES
];

/** Sub-banners that name state the whole file is written against. Their
 * fields fold into one owner, `CORE`, so an edge into them says something. */
const CORE_SUBS = new Set([
	"Entity ID management",
	"Component metadata",
	"Archetype management",
	"World tick, change tick and trace"
]);
const CORE = "CORE";

// Owners that are sub-banners rather than sections.
const O_SPARSE = "Sparse storage class (out-of-identity components)";
const O_RELATIONS = "Relations (sparse (relation, target) pairs)";
const O_EVENTS = "Event channels";
const O_DEFERRED = "Deferred operation buffers";
const O_SNAPSHOT_SVC = "Snapshot and resume service";
const O_OBSERVERS = "Component observers";
const O_ROW_GRAIN = "The row grain: the row tick plane and the dirty list";
const O_SAB = "SAB-backed ECS columns";

// --- Parse: sections, sub-banners, fields, members -----------------------

const BANNER_BAR = /^\s*\/\/ ={10,}\s*$/;
const SUB_BANNER = /^\s*\/\/ --- (.+?) ---\s*$/;

/** A `// ====` banner is a bar, a one-line name, and a bar. */
function readSections(): { name: string; line: number }[] {
	const found: { name: string; line: number }[] = [{ name: PRELUDE, line: 1 }];
	for (let i = 0; i < lines.length; i++) {
		if (BANNER_BAR.test(lines[i]) && lines[i + 2] !== undefined && BANNER_BAR.test(lines[i + 2])) {
			found.push({ name: lines[i + 1].replace(/^\s*\/\/\s*/, "").trim(), line: i + 1 });
			i += 2;
		}
	}
	return found;
}

const storeClass = ((): ts.ClassDeclaration => {
	let found: ts.ClassDeclaration | undefined;
	sourceFile.forEachChild((node) => {
		if (ts.isClassDeclaration(node) && node.name?.text === "Store") found = node;
	});
	if (found === undefined) throw new Error("class Store not found in store.ts");
	return found;
})();

const lineOf = (node: ts.Node): number =>
	sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const classStartLine = lineOf(storeClass);
const sections = readSections();
// Sub-banners before the class body label an interface, not a field.
const subBanners = lines
	.map((text, i) => ({ text, line: i + 1 }))
	.filter((l) => l.line >= classStartLine)
	.map((l) => ({ match: SUB_BANNER.exec(l.text), line: l.line }))
	.filter((l): l is { match: RegExpExecArray; line: number } => l.match !== null)
	.map((l) => ({ name: l.match[1], line: l.line }));

function sectionAt(line: number): string {
	let current = sections[0].name;
	for (const s of sections) if (s.line <= line) current = s.name;
	return current;
}

function subBannerAt(line: number): string | null {
	let current: string | null = null;
	for (const s of subBanners) if (s.line <= line) current = s.name;
	return current;
}

/** Field name to owner. A field declared inside a section belongs to it. A
 * field in the declaration block belongs to its sub-banner, or to `CORE`. */
const fieldOwner = new Map<string, string>();
type Member = { name: string; section: string; node: ts.Node };
const members: Member[] = [];

for (const m of storeClass.members) {
	const line = lineOf(m);
	const section = sectionAt(line);
	if (ts.isPropertyDeclaration(m)) {
		const sub = subBannerAt(line);
		const owner =
			section !== PRELUDE ? section : sub !== null && CORE_SUBS.has(sub) ? CORE : (sub ?? "");
		fieldOwner.set(m.name.getText(sourceFile), owner);
		continue;
	}
	if (
		ts.isMethodDeclaration(m) ||
		ts.isGetAccessorDeclaration(m) ||
		ts.isSetAccessorDeclaration(m) ||
		ts.isConstructorDeclaration(m)
	) {
		const name = ts.isConstructorDeclaration(m) ? "constructor" : m.name.getText(sourceFile);
		members.push({ name, section, node: m });
		// A parameter property declares a field too.
		if (ts.isConstructorDeclaration(m)) {
			for (const p of m.parameters) {
				if ((p.modifiers ?? []).length > 0) {
					const sub = subBannerAt(line);
					fieldOwner.set(
						p.name.getText(sourceFile),
						sub !== null && CORE_SUBS.has(sub) ? CORE : (sub ?? "")
					);
				}
			}
		}
	}
}

// --- Parse: which member reaches which field, and how --------------------

type Edge = { from: string; to: string; fields: Set<string>; writes: Set<string> };
const edges = new Map<string, Edge>();
const edgeKey = (from: string, to: string): string => `${from} -> ${to}`;

/** Every `expr` that an assignment or an increment writes through. */
function writeTargets(node: ts.Node): Set<ts.Node> {
	const targets = new Set<ts.Node>();
	const walk = (n: ts.Node): void => {
		if (ts.isBinaryExpression(n)) {
			const kind = n.operatorToken.kind;
			if (
				kind === ts.SyntaxKind.EqualsToken ||
				(kind >= ts.SyntaxKind.FirstCompoundAssignment &&
					kind <= ts.SyntaxKind.LastCompoundAssignment)
			) {
				targets.add(n.left);
			}
		}
		if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
			if (
				n.operator === ts.SyntaxKind.PlusPlusToken ||
				n.operator === ts.SyntaxKind.MinusMinusToken
			) {
				targets.add(n.operand);
			}
		}
		n.forEachChild(walk);
	};
	walk(node);
	return targets;
}

for (const member of members) {
	const targets = writeTargets(member.node);
	const walk = (n: ts.Node): void => {
		if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
			const field = n.name.text;
			const owner = fieldOwner.get(field);
			if (owner !== undefined && owner !== member.section) {
				const key = edgeKey(member.section, owner);
				let edge = edges.get(key);
				if (edge === undefined) {
					edge = { from: member.section, to: owner, fields: new Set(), writes: new Set() };
					edges.set(key, edge);
				}
				edge.fields.add(field);
				if (targets.has(n)) edge.writes.add(field);
			}
		}
		n.forEachChild(walk);
	};
	walk(member.node);
}

// --- The allowlist -------------------------------------------------------

type Allowed = {
	/** The section that reaches. */
	from: string;
	/** The owner it reaches into. */
	to: string;
	/** Every field of `to` that `from` names. Exact. */
	fields: string[];
	/** Why the edge exists, and what a split would have to do about it. */
	reason: string;
};

const ALLOWED: Allowed[] = [
	// ---- The prelude. It declares every field, so it reaches everything.
	{
		from: PRELUDE,
		to: O_SAB,
		fields: [
			"_bindingsRegionBytes",
			"_bufferAllocator",
			"_capContext",
			"_columnStore",
			"_deterministic",
			"_entityIndexCapacity",
			"_onBufferResized",
			"_regions",
			"_storeBase"
		],
		reason:
			"The constructor builds the backing, and stateHash and publishRowCounts read it. The backing is built before any section exists, so this edge cannot move."
	},
	{
		from: PRELUDE,
		to: CORE,
		fields: [
			"_archGraph",
			"_componentMetas",
			"_emptyArchetypeId",
			"_entityAllocator",
			"_entityArchetypes",
			"_entityRows",
			"changeTick",
			"tick"
		],
		reason:
			"Construction assigns the core state, and _refreshEntityIndexViews replants the entity index views after a backing resize. Writes, so not exempt."
	},
	{
		from: PRELUDE,
		to: O_RELATIONS,
		fields: ["_relations"],
		reason:
			"relationHost, installRelations and the relations accessor are the relation plugin's install seam. A split moves them with the seam."
	},
	{
		from: PRELUDE,
		to: O_EVENTS,
		fields: ["_events"],
		reason: "The event plugin's install seam, same shape as the relation one."
	},
	{
		from: PRELUDE,
		to: O_SNAPSHOT_SVC,
		fields: ["_snapshots"],
		reason: "The snapshot plugin's install seam, same shape as the relation one."
	},
	{
		from: PRELUDE,
		to: O_DEFERRED,
		fields: ["_deferred"],
		reason: "The constructor builds the deferred buffer with its closure host."
	},
	{
		from: PRELUDE,
		to: O_OBSERVERS,
		fields: [
			"_obsEvents",
			"_structuralHooks",
			"_structuralObserverCount",
			"_toggleObserverCount"
		],
		reason:
			"addStructuralHook takes a hook, and stateHash skips the observer state. A split gives the observer section an install method and keeps the counters behind it."
	},
	{
		from: PRELUDE,
		to: O_ROW_GRAIN,
		fields: ["_initialCapacity", "_rowCountsDirty", "queryDirtyEpoch"],
		reason:
			"publishRowCounts clears the row-count dirty flag, and the constructor seeds the capacity. _initialCapacity sits under the row-grain banner and belongs to the archetype layout, which the banner does not say."
	},
	{
		from: PRELUDE,
		to: O_SPARSE,
		fields: ["_sparseStores"],
		reason: "snapshotHost hands the sparse stores to the snapshot plugin, and stateHash folds them in."
	},
	{
		from: PRELUDE,
		to: S_RESOURCES,
		fields: ["_resources"],
		reason: "The resources accessor, one line over the extracted ResourceRegistry."
	},

	// ---- Archetype graph.
	{
		from: S_ARCH_GRAPH,
		to: O_SAB,
		fields: ["_bufferAllocator", "_columnStore", "_growHandler"],
		reason:
			"_extendStore and _materializeArchetype are the graph's storage-lifecycle host seams. ArchetypeGraph deliberately never touches the column store, so the seam stays on this side."
	},
	{
		from: S_ARCH_GRAPH,
		to: O_ROW_GRAIN,
		fields: ["_dirtyTrackedCids", "anyDirtyTracked"],
		reason:
			"_materializeArchetype seeds a new archetype's row tick plane when any component asked for the row grain. Archetype creation and change detection meet here."
	},

	// ---- Template and direct spawn.
	{
		from: S_SPAWN,
		to: O_ROW_GRAIN,
		fields: ["_rowCountsDirty", "queryDirtyEpoch"],
		reason:
			"A spawn or a destroy invalidates the cached row counts and bumps the query epoch. Every structural section writes these two, so they are the split's shared invalidation seam."
	},
	{
		from: S_SPAWN,
		to: O_RELATIONS,
		fields: ["_relations"],
		reason: "_destroyOne purges the destroyed entity's relations before the row goes."
	},
	{
		from: S_SPAWN,
		to: O_SPARSE,
		fields: ["_sparseStores"],
		reason: "_destroyOne purges the destroyed entity's sparse members before the row goes."
	},

	// ---- Entity enable and disable.
	{
		from: S_TOGGLE,
		to: O_ROW_GRAIN,
		fields: ["_rowCountsDirty", "queryDirtyEpoch"],
		reason: "A toggle moves the enabled partition boundary, so the cached row counts go stale."
	},

	// ---- Deferred destruction.
	{
		from: S_DESTROY,
		to: O_DEFERRED,
		fields: ["_deferred"],
		reason:
			"The queue lives in DeferredCommandBuffer and the appliers stay here, which is the collaborator's stated split."
	},
	{
		from: S_DESTROY,
		to: O_OBSERVERS,
		fields: [
			"_collectDestroyEid",
			"_collectDestroyRemoveBit",
			"_collectDisableBit",
			"_collectEnableBit",
			"_collectToggleEid",
			"_structuralObserverCount",
			"_toggleObserverCount",
			"_toggleInitial"
		],
		reason:
			"The widest edge in the file. The destroy and toggle flushes collect observer events into observer-owned scratch. A split has to move the scratch with the flush, or give the observer section a collector the flush calls."
	},
	{
		from: S_DESTROY,
		to: O_ROW_GRAIN,
		fields: ["_rowCountsDirty", "queryDirtyEpoch"],
		reason: "Same invalidation seam as the spawn section."
	},
	{
		from: S_DESTROY,
		to: O_RELATIONS,
		fields: ["_relations"],
		reason: "The destroy flush purges relations for every destroyed entity."
	},
	{
		from: S_DESTROY,
		to: O_SPARSE,
		fields: ["_sparseStores"],
		reason: "The destroy flush purges sparse members for every destroyed entity."
	},

	// ---- Deferred structural changes.
	{
		from: S_STRUCTURAL,
		to: O_DEFERRED,
		fields: ["_deferred"],
		reason: "Same split as the destroy flush: queue in the collaborator, applier here."
	},
	{
		from: S_STRUCTURAL,
		to: O_OBSERVERS,
		fields: ["_obsEvents", "_structuralObserverCount"],
		reason: "The add and remove flushes collect observer events into observer-owned scratch."
	},
	{
		from: S_STRUCTURAL,
		to: S_TOGGLE,
		fields: ["_flushEpoch", "_flushTouched"],
		reason:
			"The only edge into the toggle section. The add and remove flushes mark which entities one flush round touched, and the toggle section settles the marks. The two are one mechanism under two banners."
	},

	// ---- Component observers.
	{
		from: S_OBSERVERS,
		to: O_ROW_GRAIN,
		fields: ["_dirtyLists", "_dirtyTrackedCids", "_drainResults", "anyDirtyTracked"],
		reason:
			"The row grain is the observer section's own storage under a different banner. A split merges the two, it does not build a seam between them."
	},
	{
		from: S_OBSERVERS,
		to: O_SPARSE,
		fields: ["_sparseDrains", "_sparseStores"],
		reason:
			"The sparse entity grain: drainSparseSet and noteSetEntity read the sparse stores the change they report belongs to."
	},

	// ---- Component registration.
	{
		from: S_REGISTRATION,
		to: CORE,
		fields: ["_componentCount", "_componentMetas"],
		reason:
			"registerComponent appends the component metadata every other section reads. Writes, so not exempt. A split makes this section the sole writer and the rest readers."
	},

	// ---- Sparse storage, snapshot, relations, immediate ops, direct access.
	{
		from: S_SNAPSHOT,
		to: O_SAB,
		fields: ["_columnStore"],
		reason:
			"_mountRestoredDense swaps the live backing on a restore. Store-owned on purpose, because the snapshot service never writes a Store field."
	},
	{
		from: S_RELATIONS,
		to: O_SPARSE,
		fields: ["_sparseStores"],
		reason: "A relation is a sparse (relation, target) pair, so the traversals read the sparse store that backs it."
	},
	{
		from: S_IMMEDIATE,
		to: O_ROW_GRAIN,
		fields: ["_scratchTargetMask"],
		reason:
			"A reused mask for the add and remove transition, declared under the row-grain banner but not row-grain state. Move the declaration before a split, not after."
	},
	{
		from: S_DIRECT,
		to: O_ROW_GRAIN,
		fields: ["anyDirtyTracked"],
		reason:
			"cursorBinder branches once on whether anything asked for the row grain, which decides whether a cursor write records a row."
	}
];

// --- Assertions ----------------------------------------------------------

/** An edge needs an entry unless it is a read-only reach of CORE. */
function needsEntry(edge: Edge): boolean {
	if (edge.to !== CORE) return true;
	return edge.writes.size > 0;
}

describe("store.ts section boundaries", () => {
	it("finds the banner sections the file declares", () => {
		expect(sections.map((s) => s.name)).toEqual(EXPECTED_SECTIONS);
	});

	it("gives every declared field an owner", () => {
		const orphans = [...fieldOwner.entries()].filter(([, owner]) => owner === "");
		expect(orphans.map(([name]) => name)).toEqual([]);
		expect(fieldOwner.size).toBeGreaterThan(0);
	});

	it("names every CORE sub-banner that the file still has", () => {
		const declared = new Set(subBanners.map((s) => s.name));
		for (const sub of CORE_SUBS) expect(declared).toContain(sub);
	});

	it("allows no cross-section field reach that ALLOWED does not name", () => {
		const listed = new Map(ALLOWED.map((a) => [edgeKey(a.from, a.to), a]));
		const unlisted: string[] = [];
		const widened: string[] = [];
		for (const edge of edges.values()) {
			if (!needsEntry(edge)) continue;
			const entry = listed.get(edgeKey(edge.from, edge.to));
			if (entry === undefined) {
				unlisted.push(`${edgeKey(edge.from, edge.to)} over ${[...edge.fields].sort().join(", ")}`);
				continue;
			}
			const allowedFields = new Set(entry.fields);
			for (const f of edge.fields) {
				if (!allowedFields.has(f)) widened.push(`${edgeKey(edge.from, edge.to)} now also reaches ${f}`);
			}
		}
		expect(unlisted).toEqual([]);
		expect(widened).toEqual([]);
	});

	it("keeps no ALLOWED entry the file no longer needs", () => {
		const live = new Map([...edges.values()].map((e) => [edgeKey(e.from, e.to), e]));
		const stale: string[] = [];
		const narrowed: string[] = [];
		for (const entry of ALLOWED) {
			const edge = live.get(edgeKey(entry.from, entry.to));
			if (edge === undefined || !needsEntry(edge)) {
				stale.push(edgeKey(entry.from, entry.to));
				continue;
			}
			for (const f of entry.fields) {
				if (!edge.fields.has(f)) narrowed.push(`${edgeKey(entry.from, entry.to)} no longer reaches ${f}`);
			}
		}
		expect(stale).toEqual([]);
		expect(narrowed).toEqual([]);
	});

	it("gives every ALLOWED entry a section, an owner and a reason", () => {
		const sectionNames = new Set(sections.map((s) => s.name));
		const ownerNames = new Set(fieldOwner.values());
		for (const entry of ALLOWED) {
			expect(sectionNames).toContain(entry.from);
			expect(ownerNames).toContain(entry.to);
			expect(entry.fields.length).toBeGreaterThan(0);
			expect(entry.reason.length).toBeGreaterThan(20);
		}
		const keys = ALLOWED.map((a) => edgeKey(a.from, a.to));
		expect(new Set(keys).size).toBe(keys.length);
	});
});
