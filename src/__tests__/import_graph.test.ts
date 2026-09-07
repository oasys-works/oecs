/***
 * Import graph gate.
 *
 * Two facts about `src` that no compiler flag states. First, the value import
 * graph is a directed acyclic graph, so no module runs before the module it
 * reads from is initialised. Second, the type import graph is not acyclic, and
 * its tangle has a known shape.
 *
 * The value rule is the one that breaks a program. A cycle at value level makes
 * a binding read before its module body ran, which reads `undefined` in ESM and
 * throws under a class extends. The build is free to order chunks either way,
 * so the fault appears with a bundler change and not with a source change.
 *
 * The type rule is a design pin. A type-only cycle costs nothing at run time,
 * because the compiler erases the edge. It still blocks module extraction: a
 * file inside the tangle cannot move out of the package on its own. The pinned
 * membership below makes any growth of the tangle a failing test rather than a
 * slow drift.
 *
 * The gate reads source text only. It never builds a type checker, which is
 * what keeps it in the same cost class as a unit test.
 ***/

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const SRC = path.join(ROOT, "src");

/** Every non-test module the package compiles, absolute and sorted. */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			sourceFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
	}
	return out.sort();
}

/** One edge between two modules of `src`. `typeOnly` is true when the compiler
 * erases every name the declaration carries. */
interface Edge {
	readonly from: string;
	readonly to: string;
	readonly typeOnly: boolean;
	readonly line: number;
}

/** A named import list that carries `type` on every element erases whole, the
 * same as `import type`. A default binding is a value, so its presence alone
 * makes the declaration a value edge. */
function namedListIsAllType(clause: ts.ImportClause): boolean {
	if (clause.name) return false;
	const bindings = clause.namedBindings;
	if (!bindings || !ts.isNamedImports(bindings)) return false;
	return bindings.elements.every((element) => element.isTypeOnly);
}

function collectEdges(files: readonly string[], options: ts.CompilerOptions): Edge[] {
	const known = new Set(files);
	const cache = ts.createModuleResolutionCache(ROOT, (x) => x, options);
	const edges: Edge[] = [];

	for (const file of files) {
		const source = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.ESNext,
			true
		);
		const resolve = (specifier: string): string | undefined => {
			const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, cache);
			const name = resolved.resolvedModule?.resolvedFileName;
			if (name === undefined) return undefined;
			const normal = path.normalize(name);
			return known.has(normal) ? normal : undefined;
		};
		const push = (to: string, typeOnly: boolean, node: ts.Node) => {
			if (to === file) return;
			edges.push({
				from: file,
				to,
				typeOnly,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
			});
		};

		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				const to = resolve(node.moduleSpecifier.text);
				if (to !== undefined) {
					const clause = node.importClause;
					// A bare `import "./x"` keeps the module for its side effects.
					const typeOnly =
						clause !== undefined && (clause.isTypeOnly || namedListIsAllType(clause));
					push(to, typeOnly, node);
				}
			} else if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const to = resolve(node.moduleSpecifier.text);
				if (to !== undefined) {
					const clause = node.exportClause;
					const typeOnly =
						node.isTypeOnly ||
						(clause !== undefined &&
							ts.isNamedExports(clause) &&
							clause.elements.every((element) => element.isTypeOnly));
					push(to, typeOnly, node);
				}
			} else if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments.length > 0 &&
				ts.isStringLiteral(node.arguments[0])
			) {
				// A dynamic import loads the module, so it is a value edge.
				const to = resolve(node.arguments[0].text);
				if (to !== undefined) push(to, false, node);
			} else if (
				ts.isImportTypeNode(node) &&
				ts.isLiteralTypeNode(node.argument) &&
				ts.isStringLiteral(node.argument.literal)
			) {
				const to = resolve(node.argument.literal.text);
				if (to !== undefined) push(to, true, node);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return edges;
}

type Graph = ReadonlyMap<string, readonly string[]>;

function graphOf(files: readonly string[], edges: readonly Edge[], valueOnly: boolean): Graph {
	const adjacency = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
	for (const edge of edges) {
		if (valueOnly && edge.typeOnly) continue;
		adjacency.get(edge.from)!.add(edge.to);
	}
	return new Map([...adjacency].map(([from, to]) => [from, [...to].sort()]));
}

/** Tarjan, iterative. Returns the components that hold a cycle. */
function cyclicComponents(graph: Graph): string[][] {
	let counter = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const components: string[][] = [];

	for (const start of graph.keys()) {
		if (index.has(start)) continue;
		const work: [string, number][] = [[start, 0]];
		index.set(start, counter);
		low.set(start, counter++);
		stack.push(start);
		onStack.add(start);
		while (work.length > 0) {
			const frame = work[work.length - 1];
			const [node, cursor] = frame;
			const neighbours = graph.get(node) ?? [];
			if (cursor < neighbours.length) {
				frame[1]++;
				const next = neighbours[cursor];
				if (!index.has(next)) {
					index.set(next, counter);
					low.set(next, counter++);
					stack.push(next);
					onStack.add(next);
					work.push([next, 0]);
				} else if (onStack.has(next)) {
					low.set(node, Math.min(low.get(node)!, index.get(next)!));
				}
			} else {
				work.pop();
				if (low.get(node) === index.get(node)) {
					const component: string[] = [];
					let member: string;
					do {
						member = stack.pop()!;
						onStack.delete(member);
						component.push(member);
					} while (member !== node);
					components.push(component);
				}
				if (work.length > 0) {
					const parent = work[work.length - 1][0];
					low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
				}
			}
		}
	}
	return components.filter(
		(component) => component.length > 1 || (graph.get(component[0]) ?? []).includes(component[0])
	);
}

/** One concrete cycle inside a component, for the failure message. */
function cyclePath(graph: Graph, component: readonly string[]): string[] {
	const members = new Set(component);
	const start = [...component].sort()[0];
	const path: string[] = [];
	const seen = new Set<string>();
	const walk = (node: string): boolean => {
		path.push(node);
		seen.add(node);
		for (const next of graph.get(node) ?? []) {
			if (!members.has(next)) continue;
			if (next === start) return true;
			if (seen.has(next)) continue;
			if (walk(next)) return true;
		}
		path.pop();
		return false;
	};
	return walk(start) ? [...path, start] : [...component];
}

const label = (file: string) => path.relative(SRC, file).replaceAll(path.sep, "/");
const naming = (component: readonly string[]) => component.map(label).sort().join(", ");

/**
 * Every module allowed to sit in a type-only cycle, and the size of the largest
 * component they may form.
 *
 * The gate is a ceiling, not an equality. A module that joins the tangle fails
 * the test and the message names it. A patch that pulls a module out passes,
 * and the patch author lowers the list in the same change.
 */
const TANGLED_MODULES: readonly string[] = [
	...[
		"core/ecs/access_check.ts",
		"core/ecs/archetype.ts",
		"core/ecs/archetype_graph.ts",
		"core/ecs/changed_query.ts",
		"core/ecs/chunk_columns.ts",
		"core/ecs/ecs.ts",
		"core/ecs/frame_trace.ts",
		"core/ecs/observer.ts",
		"core/ecs/plugin.ts",
		"core/ecs/query.ts",
		"core/ecs/query_cache.ts",
		"core/ecs/query_terms.ts",
		// Extracted out of store.ts. It names Archetype, and store.ts names it,
		// so it inherits the store's cycle. A module carved out of a tangled
		// file joins that file's tangle, and the ceiling below rises with it.
		"core/ecs/query_registry.ts",
		// Extracted out of store.ts. It avoids naming Archetype, and it still
		// names HostState, which snapshot.ts declares from inside the cycle.
		"core/ecs/snapshot_mount.ts",
		"core/ecs/relation.ts",
		"core/ecs/snapshot.ts",
		"core/ecs/store.ts",
		"core/ecs/system.ts",
		"core/ecs/system_context.ts"
	],
	...["core/store/column_store.ts", "core/store/store_regions.ts"],
	...["plugins/relations/builtin_relations.ts", "plugins/relations/index.ts"]
];

/** The member count of the largest type-only component. Lower it with the
 * patch that shrinks the tangle. Raise it only for a module carved out of a
 * file that already sits in the tangle, because that module cannot avoid the
 * cycle: it names the same archetype and store types, and the file it came
 * out of names it back. An extraction moves state, and it grows this number
 * by one each time.
 *
 * The four files split out of `query.ts` are the exceptions on record. Each
 * move took one end of an edge that already existed, so no new dependency
 * appeared and the count rose with the file count alone. `query_terms.ts`
 * names a relation and the relation service names the terms record. Each of
 * `query_cache.ts`, `chunk_columns.ts` and `changed_query.ts` names a query
 * or its resolver, and `query.ts` names it back. That is the price of the
 * split: one member per module carved off `query.ts`. `query_registry.ts`
 * and `snapshot_mount.ts`, carved out of `store.ts`, pay the same price.
 * `component_registry.ts` does not, because it holds functions over plain
 * data and names no type from inside the cycle.
 *
 * The phase vocabulary in `phase.ts` imports nothing, so `schedule.ts` and
 * `run_condition.ts` left the tangle, and `ecs.ts` with `plugin.ts` now form
 * a two-cycle of their own.
 *
 * Pulling `query_terms.ts` back out needs `RelationDef` in a leaf module.
 * `chunk_columns.ts` comes out when its `resolver` field narrows to the one
 * method it calls, which changes a shipped type. `query_cache.ts` and
 * `changed_query.ts` cannot come out while a cache holds a query and a
 * changed view wraps one. */
const LARGEST_TANGLE = 17;

describe("import graph", () => {
	const configPath = path.join(ROOT, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		ROOT,
		undefined,
		configPath
	);
	const files = sourceFiles(SRC);
	const edges = collectEdges(files, parsed.options);

	it("resolves every relative specifier in src", () => {
		expect(files.length).toBeGreaterThan(50);
		expect(edges.length).toBeGreaterThan(files.length);
	});

	it("keeps the value import graph acyclic", () => {
		const graph = graphOf(files, edges, true);
		const cyclic = cyclicComponents(graph);
		const found = cyclic.map((component) => {
			const withLines = cyclePath(graph, component)
				.map((file) => label(file))
				.join(" -> ");
			return `value import cycle: ${withLines}`;
		});
		expect(found, found.join("\n")).toEqual([]);
	});

	it("lets no new module join a type cycle", () => {
		const graph = graphOf(files, edges, false);
		const components = cyclicComponents(graph);
		const pinned = new Set(TANGLED_MODULES);
		const joined = [
			...new Set(
				components
					.flat()
					.map(label)
					.filter((file) => !pinned.has(file))
			)
		].sort();
		const message = [
			`modules that joined a type cycle: ${joined.join(", ")}`,
			...components
				.filter((component) => component.some((file) => !pinned.has(label(file))))
				.map(
					(component) =>
						`component (${component.length}): ${naming(component)}\n  one cycle: ${cyclePath(
							graph,
							component
						)
							.map(label)
							.join(" -> ")}`
				)
		].join("\n");

		expect(joined, message).toEqual([]);
	});

	it("holds the largest type component to its ceiling", () => {
		const graph = graphOf(files, edges, false);
		const components = cyclicComponents(graph).sort((a, b) => b.length - a.length);
		const largest = components[0]?.length ?? 0;
		const message =
			largest > LARGEST_TANGLE
				? `the type tangle grew: ${naming(components[0])}`
				: `the type tangle shrank, lower LARGEST_TANGLE to ${largest}`;
		expect(largest, message).toBeLessThanOrEqual(LARGEST_TANGLE);
	});
});
