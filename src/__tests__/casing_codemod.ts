/**
 * Casing codemod + guard helper (not shipped — lives under __tests__, so it is
 * excluded from the package build and from publish).
 *
 * oecs is camelCased on top of the engine re-derive (the engine source is
 * snake_case). The identifier rename ships, but doc-comments lag — they keep
 * naming methods/options in the old `snake_case` even though the code is
 * `camelCase`. `findStaleComments` finds those stale references; `applyComments`
 * rewrites them. The `casing_guard.test.ts` suite runs `findStaleComments` so a
 * future port can't silently reintroduce the drift.
 *
 * Safe by construction:
 *  - segments each file into code / string / comment, and rewrites ONLY comment
 *    text — strings (host-command kind discriminators, ActionOp unions, brand
 *    tags, `requirePositiveInt("max_bytes", …)` labels) and code are untouched;
 *  - replaces a snake token only when its camelCase form is a REAL code
 *    identifier and the snake form is NOT (so genuine snake symbols — ABI struct
 *    field names like `STORE_HEADER_OFFSETS.view_stamp` — and file names are
 *    left alone), with file-extension / path guards;
 *  - a small FORCE map covers tokens the gate keeps only because a test regex
 *    literal (e.g. `toThrow(/max_bytes/)`) pollutes the code-identifier set;
 *    each is verified (camel form is a declared symbol, snake form is not an ABI
 *    offset key).
 *
 * Error-message *strings* that name a renamed method (e.g. the old
 * `_assertDenseOnly("for_each")`) are NOT covered here — strings can be
 * load-bearing, so they are fixed by hand during a port. See the port log §5.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StaleRef {
	readonly file: string;
	readonly token: string;
	readonly camel: string;
}

// Tokens kept by the codeIdents gate only because a test regex literal polluted
// the code-identifier set. Verified: camel form is a real declared symbol, snake
// form is NOT an ABI offset key. Forced in COMMENTS only (strings stay untouched).
const FORCE: Readonly<Record<string, string>> = {
	max_bytes: "maxBytes",
	max_depth: "maxDepth",
	fixed_timestep: "fixedTimestep",
	max_fixed_steps: "maxFixedSteps",
	column_capacity: "columnCapacity",
	get_optional_column_read: "getOptionalColumnRead",
	add_systems: "addSystems",
	configure_set: "configureSet",
	resolve_ecs_memory: "resolveECSMemory" // ECS acronym — naive camel can't produce
};

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const SNAKE = /(?<![A-Za-z0-9_$])_*[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_$])/g;
const EXT = /^\.(ts|tsx|test|js|jsx|cjs|mjs|json|zig|md|css|html|map|d)\b/;

type SegKind = "code" | "string" | "line" | "block";
interface Seg {
	kind: SegKind;
	text: string;
}

/** Scan TS source into code / string / line-comment / block-comment segments. */
function segment(src: string): Seg[] {
	const segs: Seg[] = [];
	let i = 0;
	const n = src.length;
	let buf = "";
	let mode: SegKind = "code";
	let quote = "";
	const push = (kind: SegKind): void => {
		if (buf) segs.push({ kind, text: buf });
		buf = "";
	};
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (mode === "code") {
			if (c === "/" && c2 === "/") {
				push("code");
				mode = "line";
				buf += c + c2;
				i += 2;
				continue;
			}
			if (c === "/" && c2 === "*") {
				push("code");
				mode = "block";
				buf += c + c2;
				i += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				push("code");
				mode = "string";
				quote = c;
				buf += c;
				i++;
				continue;
			}
			buf += c;
			i++;
			continue;
		}
		if (mode === "string") {
			buf += c;
			if (c === "\\") {
				buf += c2 ?? "";
				i += 2;
				continue;
			}
			if (c === quote) push("string"), (mode = "code");
			i++;
			continue;
		}
		if (mode === "line") {
			if (c === "\n") {
				push("line");
				mode = "code";
				buf += c;
				i++;
				continue;
			}
			buf += c;
			i++;
			continue;
		}
		// block
		buf += c;
		if (c === "*" && c2 === "/") {
			buf += c2;
			i += 2;
			push("block");
			mode = "code";
			continue;
		}
		i++;
	}
	push(mode);
	return segs;
}

function camelOf(s: string): string {
	const m = s.match(/^(_*)(.*)$/);
	if (m === null) return s;
	return m[1] + m[2].replace(/_([a-z0-9])/g, (_full, ch: string) => ch.toUpperCase());
}

// The codemod tooling documents snake_case tokens as examples (this file and the
// guard test), so it must not scan — or rewrite — itself.
const SELF_SKIP = new Set(["casing_codemod.ts", "casing_guard.test.ts"]);

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (name.endsWith(".ts") && !SELF_SKIP.has(name)) out.push(p);
	}
	return out;
}

function collectCodeIdents(files: readonly string[], segByFile: Map<string, Seg[]>): Set<string> {
	const idents = new Set<string>();
	for (const f of files) {
		const segs = segByFile.get(f);
		if (segs === undefined) continue;
		for (const s of segs) {
			if (s.kind !== "code") continue;
			for (const m of s.text.matchAll(IDENT)) idents.add(m[0]);
		}
	}
	return idents;
}

/** Decide the camelCase replacement for a snake token inside a comment, or null
 * to keep it (genuine snake symbol, file/path ref, or unknown prose). */
function resolve(tok: string, before: string, after: string, codeIdents: ReadonlySet<string>): string | null {
	if (EXT.test(after)) return null; // file ref, e.g. column_store.ts
	if (before.endsWith("/") || before.endsWith("@") || after.startsWith("/")) return null; // path ref
	const forced = FORCE[tok];
	if (forced !== undefined) return forced;
	if (codeIdents.has(tok)) return null; // genuine snake symbol (ABI field, …)
	const cc = camelOf(tok);
	if (cc !== tok && codeIdents.has(cc)) return cc; // stale comment ref
	return null; // prose / unknown
}

interface Loaded {
	readonly files: string[];
	readonly segByFile: Map<string, Seg[]>;
	readonly codeIdents: Set<string>;
}

function load(srcDir: string): Loaded {
	const files = walk(srcDir);
	const segByFile = new Map<string, Seg[]>();
	for (const f of files) segByFile.set(f, segment(readFileSync(f, "utf8")));
	return { files, segByFile, codeIdents: collectCodeIdents(files, segByFile) };
}

/** Stale snake_case API references remaining in comments under `srcDir`. */
export function findStaleComments(srcDir: string): StaleRef[] {
	const { files, segByFile, codeIdents } = load(srcDir);
	const out: StaleRef[] = [];
	for (const f of files) {
		const segs = segByFile.get(f);
		if (segs === undefined) continue;
		for (const s of segs) {
			if (s.kind !== "line" && s.kind !== "block") continue;
			for (const m of s.text.matchAll(SNAKE)) {
				const tok = m[0];
				const before = s.text.slice(0, m.index);
				const after = s.text.slice(m.index + tok.length);
				const cc = resolve(tok, before, after, codeIdents);
				if (cc !== null) out.push({ file: f, token: tok, camel: cc });
			}
		}
	}
	return out;
}

/** Rewrite stale snake_case comment refs to camelCase under `srcDir`. Returns the
 * number of files changed. Used during a port; the guard test only reads. */
export function applyComments(srcDir: string): number {
	const { files, segByFile, codeIdents } = load(srcDir);
	let changed = 0;
	for (const f of files) {
		const segs = segByFile.get(f);
		if (segs === undefined) continue;
		let dirty = false;
		for (const s of segs) {
			if (s.kind !== "line" && s.kind !== "block") continue;
			s.text = s.text.replace(SNAKE, (tok: string, offset: number, whole: string) => {
				const cc = resolve(tok, whole.slice(0, offset), whole.slice(offset + tok.length), codeIdents);
				if (cc !== null) dirty = true;
				return cc ?? tok;
			});
		}
		if (dirty) {
			writeFileSync(f, segs.map((s) => s.text).join(""));
			changed++;
		}
	}
	return changed;
}
