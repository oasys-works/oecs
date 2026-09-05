/***
 * What a parallel system carries, and what a registration refuses.
 *
 * A parallel system is a normal system that also names a kernel a worker can
 * load. Everything a worker cannot reach is refused here, at registration,
 * instead of failing inside a pass: sparse stores, relations, resources, the
 * command buffer, events, observers and the row-to-entity table are all
 * main-thread objects, and no worker touches one.
 *
 * The plan this builds is the only per-frame state the dispatch reads. It hangs
 * off the frozen descriptor, so the dispatch resolves it with one property load
 * rather than a hash of an object identity.
 ***/

import { COMPONENT_MASK_WORDS } from "../../core/store/vendored_abi/abi";
import type { ComponentDef } from "../../core/ecs/component";
import type { Query } from "../../core/ecs/query";
import type { ParallelConfig, SystemConfig } from "../../core/ecs/system";
import { ECS_ERROR, ECSError } from "../../core/ecs/utils/error";

/**
 * The total matched row count below which a parallel system runs `fn` on the
 * main thread.
 *
 * Measured, and deliberately conservative. A probe sweeps a memory-bound body
 * and a compute-bound one, each as a `js` kernel and as a `wasm` kernel, over
 * the shared backing and the wasm backing, on more than one engine family. This
 * value sits above every crossover it found. So a world that never tunes it
 * never pays a pooled frame that the sequential frame would have won.
 *
 * One number cannot serve two costs, and this one serves the memory-bound case.
 * A compute-bound body crosses far earlier, and this value costs it most of its
 * gain. Give such a system its own `minRows`.
 *
 * The crossover also rises with the worker count, because the barrier grows
 * while the work for each worker shrinks. The plan cannot scale by that count,
 * because the pool attaches after the plan is built.
 *
 * `parallel.minRows` from the caller always wins, and zero is a value.
 */
export const DEFAULT_PARALLEL_MIN_ROWS = 200_000;

/** What one dispatch reads. Mutable, because the pool fills `slot` and `ready`
 * when the workers report the kernel loaded. */
export interface ParallelPlan {
	/** The kernel's slot in the pool, or -1 before the pool takes it. */
	slot: number;
	/** Whether every worker holds the kernel. False until then, and the system
	 * runs `fn` in the meantime. */
	ready: boolean;
	readonly exportName: string;
	/** The query whose archetypes the kernel runs over. */
	readonly query: Query<any>;
	readonly include: Uint32Array;
	readonly exclude: Uint32Array | null;
	/** `(component_id, field_id)` pairs, flat, in the kernel's argument order. */
	readonly specs: Int32Array;
	readonly minRows: number;
	/** The components whose changed tick the join stamps. */
	readonly writes: readonly ComponentDef<any>[];
	readonly kernel: ParallelConfig["kernel"];
}

/**
 * Refuse a `wasm` kernel module the pool cannot serve.
 *
 * A worker instantiates the module with one import, the world's memory as
 * `env.memory`. Every other import fails inside the worker, where the fault
 * names a worker and not the system, so the check runs here instead.
 *
 * A module that imports no memory is the quiet case. It addresses its own
 * linear memory, writes rows nothing reads, and reports success.
 *
 * The parameter count is not checked here. The JS API reports no signature for
 * a module export, so the worker checks the arity once it holds the function.
 *
 * Dev guard, at registration.
 */
function assertKernelModule(who: string, module: WebAssembly.Module, exportName: string): void {
	const imports = WebAssembly.Module.imports(module);
	let memory = false;
	for (const entry of imports) {
		if (entry.module === "env" && entry.name === "memory" && entry.kind === "memory") {
			memory = true;
			continue;
		}
		throw new ECSError(
			ECS_ERROR.PARALLEL_KERNEL_MODULE,
			`${who} names a wasm kernel that imports '${entry.module}.${entry.name}' as a ${entry.kind}, and a worker supplies only 'env.memory'. Drop the import, or move what it does into the kernel.`
		);
	}
	if (!memory) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_KERNEL_MODULE,
			`${who} names a wasm kernel that imports no 'env.memory', so it addresses a linear memory of its own and never the store. Link the module with --import-memory.`
		);
	}
	const exported = WebAssembly.Module.exports(module).find((entry) => entry.name === exportName);
	if (exported === undefined) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_KERNEL_MODULE,
			`${who} names the wasm kernel export '${exportName}' and the module exports no such name. Name an export the module carries.`
		);
	}
	if (exported.kind !== "function") {
		throw new ECSError(
			ECS_ERROR.PARALLEL_KERNEL_MODULE,
			`${who} names the wasm kernel export '${exportName}', and the module exports it as a ${exported.kind}. A kernel must be a function.`
		);
	}
}

function maskWords(words: readonly number[]): Uint32Array {
	const out = new Uint32Array(COMPONENT_MASK_WORDS);
	for (let w = 0; w < COMPONENT_MASK_WORDS && w < words.length; w++) out[w] = words[w] >>> 0;
	return out;
}

/** The query's without-mask as the worker reads it, or `null` when the query
 * has no without term. A worker resolves the matched archetypes from the masks
 * alone, so an empty mask here would make it write rows the query excludes. */
function excludeWords(query: Query<any>): Uint32Array | null {
	const words = query.excludeWords;
	return words === null ? null : maskWords(words);
}

/** The declarations a worker cannot serve, each with the field that names it. */
const REFUSED: readonly (readonly [keyof SystemConfig, string])[] = [
	["spawns", "a worker makes no structural change"],
	["despawns", "a worker makes no structural change"],
	["transitions", "a worker makes no structural change"],
	["resourceReads", "a resource is a main-thread value"],
	["resourceWrites", "a resource is a main-thread value"],
	["sparseReads", "a sparse store is a main-thread object"],
	["sparseWrites", "a sparse store is a main-thread object"],
	["relationReads", "a relation store is a main-thread object"],
	["relationWrites", "a relation store is a main-thread object"]
];

/**
 * Refuse a parallel config a worker cannot serve. Dev guard, and it runs at
 * registration so the fault names the config instead of a frame.
 *
 * `query` is the resolved first query, because the dense-only rule is a
 * property of the query and not of the declaration list.
 */
export function assertParallelConfig(config: SystemConfig, query: Query<any>): void {
	const parallel = config.parallel as ParallelConfig;
	const who = config.name !== undefined ? `system '${config.name}'` : "a parallel system";

	for (const [field, why] of REFUSED) {
		const value = config[field] as readonly unknown[] | undefined;
		if (value !== undefined && value.length > 0) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_ACCESS,
				`${who} declares '${field}' beside 'parallel', and ${why}. Drop the declaration, or run the system sequentially.`
			);
		}
	}
	if (config.exclusive === true) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares 'exclusive' beside 'parallel', and an exclusive system reaches state no worker can see. Drop 'exclusive', or run the system sequentially.`
		);
	}
	if (config.backendHandle !== undefined) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares 'backendHandle' beside 'parallel', and one system body cannot run in two places. Keep one of them.`
		);
	}
	if (config.fn === undefined) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares 'parallel' with no 'fn'. The sequential body runs below the row threshold, and on a world with no pool, so it is required.`
		);
	}

	const terms = query.terms;
	if (
		terms.sparseIncludes.length > 0 ||
		terms.sparseExcludes.length > 0 ||
		terms.relationIncludes.length > 0 ||
		terms.relationExcludes.length > 0 ||
		terms.hierarchyTerm !== null ||
		terms.includesDisabled
	) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} runs over a query that carries a sparse, relation, hierarchy or disabled term, and a worker resolves a query from the archetype masks alone. Give it a query of with-only or with-and-without terms.`
		);
	}

	const declared = new Set<number>();
	for (const def of config.reads) declared.add(def.id as number);
	for (const def of config.writes) declared.add(def.id as number);
	const queried = new Set<number>();
	for (const def of query.defs) queried.add(def.id as number);
	const named = new Set<number>();
	for (const [def] of parallel.columns) {
		named.add(def.id as number);
		if (!declared.has(def.id as number)) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_ACCESS,
				`${who} names component id ${def.id as number} in 'parallel.columns' but not in 'reads' or 'writes'. Add it to the access declaration.`
			);
		}
		if (!queried.has(def.id as number)) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_ACCESS,
				`${who} names component id ${def.id as number} in 'parallel.columns' but the query does not require it, so a matched archetype may hold no column for it. Add it to the query.`
			);
		}
	}
	for (const def of config.writes) {
		if (!named.has(def.id as number)) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_ACCESS,
				`${who} declares a write of component id ${def.id as number} that 'parallel.columns' does not name. The join stamps every declared write, and it needs the component's columns. Add a field of it to 'parallel.columns', or drop the write.`
			);
		}
	}
	for (const def of query.defs) {
		if (!declared.has(def.id as number)) {
			throw new ECSError(
				ECS_ERROR.PARALLEL_ACCESS,
				`${who} queries component id ${def.id as number} that is not in 'reads' or 'writes'. Add it to the access declaration.`
			);
		}
	}

	const minRows = parallel.minRows;
	if (minRows !== undefined && (!Number.isInteger(minRows) || minRows < 0)) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares parallel.minRows must be an integer >= 0, got ${String(minRows)}`
		);
	}
	const kernel = parallel.kernel;
	if (typeof kernel.export !== "string" || kernel.export.length === 0) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares parallel.kernel.export must be a non-empty export name, got ${String(kernel.export)}`
		);
	}
	if (kernel.wasm === undefined && kernel.js === undefined) {
		throw new ECSError(
			ECS_ERROR.PARALLEL_ACCESS,
			`${who} declares a parallel.kernel with neither 'wasm' nor 'js'. Give a compiled WebAssembly.Module, or an absolute module URL a worker can import.`
		);
	}
	if (kernel.wasm !== undefined) assertKernelModule(who, kernel.wasm, kernel.export);
}

/**
 * Resolve one parallel config into the plan the dispatch reads. Runs in every
 * build, because the masks and the column specs are not diagnostics.
 *
 * `fieldId` maps a field name to the id the descriptor carries, which is the
 * world's own mapping.
 */
export function createParallelPlan(
	parallel: ParallelConfig,
	query: Query<any>,
	writes: readonly ComponentDef<any>[],
	fieldId: (def: ComponentDef<any>, field: string) => number
): ParallelPlan {
	const specs = new Int32Array(parallel.columns.length * 2);
	for (let i = 0; i < parallel.columns.length; i++) {
		const [def, field] = parallel.columns[i];
		specs[i * 2] = def.id as number;
		specs[i * 2 + 1] = fieldId(def, field);
	}
	return {
		slot: -1,
		ready: false,
		exportName: parallel.kernel.export,
		query,
		include: maskWords(query.include.words),
		exclude: excludeWords(query),
		specs,
		minRows: parallel.minRows ?? DEFAULT_PARALLEL_MIN_ROWS,
		writes,
		kernel: parallel.kernel
	};
}
