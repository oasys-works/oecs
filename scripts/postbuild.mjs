/**
 * Post-build declaration fixups (POLISH_AUDIT M19).
 *
 * 1. Rewrite relative import/export specifiers in every emitted `.d.ts` to
 *    explicit `./x.js` / `./x/index.js` form — node16/nodenext ESM resolution
 *    requires extensions, and vite-plugin-dts emits extensionless specifiers
 *    (attw InternalResolutionError otherwise).
 * 2. Duplicate each fixed `.d.ts` as a `.d.cts` sibling (specifiers rewritten
 *    to `.cjs`) so the `require` condition's `types` no longer points CJS TS
 *    consumers at ESM-flavored declarations — the attw "masquerading" failure.
 */
import fs from "node:fs";
import path from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;

const dtsFiles = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else if (entry.name.endsWith(".d.ts")) dtsFiles.push(p);
	}
})(dist);

/** Append an explicit extension to one relative specifier, checking what the
 * bare path actually names in the declaration tree. */
function fixSpecifier(fromDir, spec, ext) {
	if (fs.existsSync(path.join(fromDir, spec + ".d.ts"))) return spec + ext;
	if (fs.existsSync(path.join(fromDir, spec, "index.d.ts"))) return spec + "/index" + ext;
	return spec; // already extensioned or external — leave untouched
}

// `from "./x"`, `import "./x"`, `import("./x")` — every syntactic position a
// relative specifier can appear in a declaration file.
const SPEC_RE = /((?:from\s+|import\s+|import\s*\(\s*)["'])(\.[^"']*)(["'])/g;

let count = 0;
for (const file of dtsFiles) {
	const dir = path.dirname(file);
	const src = fs.readFileSync(file, "utf8");
	const esm = src.replace(SPEC_RE, (_, pre, spec, post) => pre + fixSpecifier(dir, spec, ".js") + post);
	const cjs = src.replace(SPEC_RE, (_, pre, spec, post) => pre + fixSpecifier(dir, spec, ".cjs") + post);
	fs.writeFileSync(file, esm);
	fs.writeFileSync(file.slice(0, -5) + ".d.cts", cjs);
	count++;
}
console.log(`postbuild: ${count} declaration files fixed (+ .d.cts siblings)`);
