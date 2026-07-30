/** Reads a .cpuprofile file, and shows the functions with the highest self time. */
import fs from "node:fs";

const file = process.argv[2];
const prof = JSON.parse(fs.readFileSync(file, "utf8"));
const byId = new Map();
for (const n of prof.nodes) byId.set(n.id, n);

const self = new Map();
const counts = new Map();
for (const id of prof.samples) counts.set(id, (counts.get(id) ?? 0) + 1);

let total = 0;
for (const [id, c] of counts) {
	const n = byId.get(id);
	if (!n) continue;
	const f = n.callFrame;
	const name = `${f.functionName || "(anon)"} ${short(f.url)}:${f.lineNumber + 1}`;
	self.set(name, (self.get(name) ?? 0) + c);
	total += c;
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [name, c] of rows) {
	console.log(`${((c / total) * 100).toFixed(2).padStart(6)}%  ${String(c).padStart(7)}  ${name}`);
}

function short(u) {
	if (!u) return "";
	return u.split("/").pop();
}
