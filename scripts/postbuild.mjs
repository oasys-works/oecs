/**
 * Post-build declaration fixups (POLISH_AUDIT M19).
 *
 * 1. Rewrite relative import and export specifiers in every emitted `.d.ts` to
 *    explicit `./x.js` / `./x/index.js` form, node16/nodenext ESM resolution
 *    requires extensions, and vite-plugin-dts emits extensionless specifiers
 *    (attw InternalResolutionError otherwise).
 * 2. Duplicate each fixed `.d.ts` as a `.d.cts` sibling (specifiers rewritten
 *    to `.cjs`) so the `require` condition's `types` no longer points CJS TS
 *    consumers at ESM-flavored declarations, the attw "masquerading" failure.
 * 3. Write one flat `dist/plugins/<name>.d.ts` per plugin. A plugin is a
 *    directory with an `index.ts`, so vite-plugin-dts mirrors it to
 *    `dist/plugins/<name>/index.d.ts`, while rollup emits the code flat. The
 *    re-export puts the declaration on the same path as the code, which is
 *    what the `exports` map names.
 */
import fs from "node:fs";
import path from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const pluginsSrc = new URL("../src/plugins/", import.meta.url).pathname;

// Before the walk, so each flat declaration gets its specifiers fixed and its
// `.d.cts` sibling like every other file.
let flat = 0;
for (const entry of fs.readdirSync(pluginsSrc, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const name = entry.name;
	if (!fs.existsSync(path.join(pluginsSrc, name, "index.ts"))) continue;
	const emitted = path.join(dist, "plugins", name, "index.d.ts");
	if (!fs.existsSync(emitted)) continue;
	fs.writeFileSync(path.join(dist, "plugins", `${name}.d.ts`), `export * from "./${name}/index";\n`);
	flat++;
}
console.log(`postbuild: ${flat} flat plugin declarations written`);

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
	// The worker entry's own chain names each file with its `.ts` extension, so
	// plain node can load the source in a worker. A declaration keeps that
	// spelling, and no `.ts` file ships, so it resolves to the emitted sibling
	// here like every other relative specifier.
	const base = spec.endsWith(".ts") ? spec.slice(0, -3) : spec;
	if (fs.existsSync(path.join(fromDir, base + ".d.ts"))) return base + ext;
	if (fs.existsSync(path.join(fromDir, base, "index.d.ts"))) return base + "/index" + ext;
	return spec; // already extensioned or external, leave untouched
}

// `from "./x"`, `import "./x"`, `import("./x")`, every syntactic position a
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
