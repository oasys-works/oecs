/** Shows the self time of each line in one function. It uses positionTicks. */
import fs from "node:fs";

const [, , profFile, fnName, srcFile] = process.argv;
const prof = JSON.parse(fs.readFileSync(profFile, "utf8"));
const src = srcFile ? fs.readFileSync(srcFile, "utf8").split("\n") : null;

const hits = new Map();
let total = 0;
for (const n of prof.nodes) {
	if (n.callFrame.functionName !== fnName) continue;
	for (const pt of n.positionTicks ?? []) {
		hits.set(pt.line, (hits.get(pt.line) ?? 0) + pt.ticks);
		total += pt.ticks;
	}
}
if (total === 0) {
	console.log(`no positionTicks for ${fnName}`);
	process.exit(0);
}
console.log(`${fnName}: ${total} ticks`);
for (const [line, t] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
	const text = src ? (src[line - 1] ?? "").trim().slice(0, 100) : "";
	console.log(`${((t / total) * 100).toFixed(1).padStart(6)}%  ${String(t).padStart(6)}  L${line}  ${text}`);
}
