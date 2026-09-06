/***
 * The boundary between the core rollup graph and the plugin rollup graph.
 *
 * The build runs two passes (see `vite.config.ts` for why). Two passes mean two
 * module graphs. A module the plugin pass reaches is compiled into the
 * plugin bundles as a second copy. For a pure function that is a few
 * duplicated bytes. For anything that carries identity or state it is a defect.
 * A copied class fails `instanceof` against the class the package root exports.
 * A copied singleton or registry holds none of what the core put in it.
 *
 * So every module both graphs reach is classified here, once, in one of two
 * lists. `SINGLE` names a module the plugin pass must not compile. The pass
 * marks it external and resolves it to a relative import of the core artifact.
 * Both graphs then share the one instance. `DUPLICABLE` names a module whose
 * second copy changes nothing observable, with the reason beside it.
 *
 * A module in neither list fails the build. That is the point. The failure is
 * a prompt to classify the module, not a bug report from a consumer.
 *
 * Cold path. Both vite plugins run at build time only.
 ***/

import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** What the core pass records for the plugin pass to check against. */
interface CoreManifest {
	/** `production` or `development`. A plugin bundle must bind to the core
	 * artifact of its own variant, never to the other one. */
	readonly variant: string;
	/** Every `src`-relative module the core pass compiled. */
	readonly modules: readonly string[];
	/** Export names per core entry, so the plugin pass can check that every
	 * binding it resolves to an entry is actually there. */
	readonly exports: Readonly<Record<string, readonly string[]>>;
}

/** The core entries a plugin bundle may bind to. */
type CoreEntry = "index" | "internal";

/** Modules the plugin pass must not compile, and the entry that serves
 * each one. The entry has to export every binding the plugin graph reaches.
 * That is why `src/internal.ts` carries the plugin-fault and debug-name
 * lists. */
const SINGLE: Readonly<Record<string, CoreEntry>> = {
	// `ECSError`, `ECSRestoreError` and the `ECS_ERROR` categories. A consumer
	// catches these by class, and `isEcsError` is an `instanceof` behind a name.
	"core/ecs/utils/error.ts": "index",
	// The two plugin faults, apart from the classes. The classes resolve to
	// the root, and these resolve to the tooling entry.
	"core/ecs/utils/plugin_error.ts": "internal",
	// `StoreRestoreError` and `SparseRestoreError`, both caught by class and
	// both exported from the package root.
	"core/restore_errors.ts": "index",
	// The component name registry. `registerComponent` writes it in the core,
	// and an observer message reads it from the plugin.
	"core/ecs/debug_names.ts": "internal",
	// The access-span singleton. An observer callback runs inside the span the
	// world opened, so it has to read the span the world wrote.
	"core/ecs/access_check.ts": "internal",
	// The dispatch-trace singleton. A host-side emit records into the trace the
	// world started.
	"core/ecs/dispatch_trace.ts": "internal"
};

/** Modules both graphs reach whose second copy changes nothing a caller can
 * observe. Each reason states what would have to be true for the copy to
 * matter, and why it is not. */
const DUPLICABLE: Readonly<Record<string, string>> = {
	"core/ecs/entity.ts": "packed-id codec, pure functions over numbers",
	"core/ecs/event.ts":
		"event keys and schema types, and two symbol factories a caller calls for itself",
	"core/ecs/facades.ts":
		"delegates to the store and holds no state, and its error, access-check and trace imports are single",
	"core/ecs/relation.ts":
		"relation handle types and the seam interfaces, plus three primitive constants two copies agree on",
	"core/ecs/snapshot.ts": "the frame version and the host-state shapes, constants and types",
	"core/ecs/utils/arrays.ts": "bucket push and the entity-id radix, pure functions over numbers",
	"core/ecs/sparse_store.ts":
		"sparse stores, built by the core and mutated through methods, and its error class is single",
	"core/ecs/system.ts": "system ids and the empty access record, which is spread and never compared",
	"core/ecs/utils/constants.ts": "numeric limits",
	"core/store/allocator.ts":
		"allocator factories, and a plugin uses the allocator the store hands it, so the copy builds none",
	"core/store/column_store.ts": "column views, plain records the store discriminates structurally",
	"core/store/descriptor.ts": "layout descriptor codec, pure functions over a DataView",
	"core/store/entity_index.ts": "entity index codec, pure functions over a DataView",
	"core/store/header.ts": "store header offsets and reader, pure",
	"core/store/snapshot.ts": "dense snapshot codec, and its error class is single",
	"core/store/state_hash.ts": "FNV-1a steps, pure",
	"core/store/vendored_abi/abi.ts": "ABI constants",
	"dev_flag.ts": "one boolean, and each variant compiles it to the same literal",
	"type_primitives/assertions.ts":
		"identity casts, because every caller the plugin graph reaches throws an ECSError instead of an assertion"
};

/** The specifier rollup emits for an externalised module, rewritten to a real
 * relative path once the output format is known. */
const TOKEN: Readonly<Record<CoreEntry, string>> = {
	index: "oecs:core-entry-index",
	internal: "oecs:core-entry-internal"
};

function manifestPath(): string {
	const p = process.env.OECS_CORE_MANIFEST;
	if (p === undefined || p === "") {
		throw new Error(
			"OECS_CORE_MANIFEST is not set. Build through scripts/build.mjs, which points it at a temporary file"
		);
	}
	return p;
}

/** `src`-relative posix path, or `undefined` for a module outside `src`. */
function srcRelative(srcDir: string, id: string): string | undefined {
	const rel = path.relative(srcDir, id);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return rel.split(path.sep).join("/");
}

/** Record the core graph for the plugin pass. Runs in the core pass only. */
export function recordCoreGraph(srcDir: string, variant: string): Plugin {
	const modules = new Set<string>();
	const exported: Record<string, Set<string>> = {};
	return {
		name: "oecs:record-core-graph",
		generateBundle(_options, bundle) {
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				for (const id of Object.keys(chunk.modules)) {
					const rel = srcRelative(srcDir, id);
					if (rel !== undefined) modules.add(rel);
				}
				if (!chunk.isEntry) continue;
				const names = (exported[chunk.name] ??= new Set());
				for (const name of chunk.exports) names.add(name);
			}
		},
		closeBundle() {
			const manifest: CoreManifest = {
				variant,
				modules: [...modules].sort(),
				exports: Object.fromEntries(
					Object.entries(exported).map(([name, names]) => [name, [...names].sort()])
				)
			};
			fs.writeFileSync(manifestPath(), JSON.stringify(manifest));
		}
	};
}

/** Bind the plugin bundles to the core artifact, and fail the build on an
 * unclassified module or a binding the core entry does not export. Runs in the
 * plugin pass only. */
export function bindToCoreArtifact(srcDir: string, variant: string): Plugin {
	let manifest: CoreManifest;
	const suffix = variant === "development" ? ".development" : "";
	return {
		name: "oecs:bind-to-core-artifact",
		// Ahead of vite's own resolver, which would otherwise answer first and
		// never let `resolveId` below see the module.
		enforce: "pre",

		buildStart() {
			manifest = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as CoreManifest;
			// A development plugin bundle that bound to the production core
			// would give the program two worlds. One carries the guards and one
			// does not. Catch the stale record rather than ship that.
			if (manifest.variant !== variant) {
				throw new Error(
					`the core graph record is for the ${manifest.variant} variant and this pass is ${variant}. Run scripts/build.mjs, which writes the record once per variant`
				);
			}
		},

		// The output format decides `.js` against `.cjs`, and it is not known
		// while resolving. Chunks of this pass go beside the entries so one
		// relative path is right for every emitted file.
		outputOptions(options) {
			const ext = options.format === "cjs" ? "cjs" : "js";
			return { ...options, chunkFileNames: `plugins/[name]-[hash].${ext}` };
		},

		async resolveId(source, importer, options) {
			if (importer === undefined) return null;
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			if (resolved === null || resolved.external) return null;
			const rel = srcRelative(srcDir, resolved.id);
			if (rel === undefined) return null;
			const entry = SINGLE[rel];
			if (entry === undefined) return null;
			return { id: TOKEN[entry], external: true };
		},

		renderChunk(code, chunk, options) {
			const ext = options.format === "cjs" ? ".cjs" : ".js";
			const from = path.posix.dirname(chunk.fileName);
			let out = code;
			for (const [entry, token] of Object.entries(TOKEN)) {
				if (!out.includes(token)) continue;
				const rel = path.posix.relative(from, `${entry}${suffix}${ext}`);
				out = out.split(token).join(rel.startsWith(".") ? rel : `./${rel}`);
			}
			return out === code ? null : { code: out, map: null };
		},

		generateBundle(_options, bundle) {
			const copied: string[] = [];
			const missing: string[] = [];
			const core = new Set(manifest.modules);
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				for (const id of Object.keys(chunk.modules)) {
					const rel = srcRelative(srcDir, id);
					if (rel === undefined || !core.has(rel)) continue;
					if (rel in DUPLICABLE) continue;
					copied.push(`${rel} (in ${chunk.fileName})`);
				}
				// `importedBindings` still keys on the token, because
				// `renderChunk` edits the text and not the metadata rollup
				// collected.
				for (const [entry, token] of Object.entries(TOKEN)) {
					const bindings = chunk.importedBindings[token];
					if (bindings === undefined) continue;
					const available = new Set(manifest.exports[entry] ?? []);
					for (const name of bindings) {
						if (name !== "*" && !available.has(name)) {
							missing.push(`${name} (wanted by ${chunk.fileName} from ${entry})`);
						}
					}
				}
			}
			if (copied.length > 0) {
				throw new Error(
					"the plugin pass compiled a core module that scripts/core_boundary.ts does not classify: " +
						`${[...new Set(copied)].sort().join(", ")}. Add it to SINGLE if it carries identity or state, or to DUPLICABLE with the reason its copy is harmless`
				);
			}
			if (missing.length > 0) {
				throw new Error(
					"the plugin pass wants a binding the core entry does not export: " +
						`${[...new Set(missing)].sort().join(", ")}. Export it from that entry, or move the module out of SINGLE`
				);
			}
		}
	};
}
