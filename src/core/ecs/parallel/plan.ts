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

import { COMPONENT_MASK_WORDS } from "../../store/vendored_abi/abi";
import type { ComponentDef } from "../component";
import type { Query } from "../query";
import type { ParallelConfig, SystemConfig } from "../system";
import { ECS_ERROR, ECSError } from "../utils/error";

/**
 * The total matched row count below which a parallel system runs `fn` on the
 * main thread.
 *
 * A placeholder, and the caller must tune it. The probes show the crossover is
 * a property of the machine and of the kernel, never a constant: a heavy kernel
 * crosses far earlier than a memory-bound one, and one worker is always a loss.
 * The value here is high enough that a world which never tunes it keeps the
 * sequential path.
 */
export const DEFAULT_PARALLEL_MIN_ROWS = 100_000;

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
