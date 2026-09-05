/**
 * Runs the browser matrix in chromium, firefox and webkit, and prints one table
 * per browser.
 *
 * Playwright is not a dependency of this package, so this file imports it from
 * a directory you install yourself:
 *
 *     mkdir -p /tmp/oecs-browser-matrix && cd /tmp/oecs-browser-matrix
 *     npm init -y && npm i playwright
 *     npx playwright install chromium firefox webkit
 *
 * Name that directory with `OECS_PLAYWRIGHT_DIR`, or with `--playwright <dir>`.
 * The flag wins. Without either the driver names the missing directory and
 * exits.
 *
 *     OECS_PLAYWRIGHT_DIR=/tmp/oecs-browser-matrix \
 *       node bench/foundations/browser/drive.mjs
 *     node bench/foundations/browser/drive.mjs --playwright /tmp/oecs-browser-matrix \
 *       --browsers firefox,webkit
 *
 * Build `dist/` first. The page loads the built artifact, not the source, so a
 * stale `dist/` measures the wrong engine.
 *
 *     node scripts/build.mjs && node scripts/postbuild.mjs
 *
 * `--json <file>` writes every result, so a findings table can be written from
 * the run and not from the screen. `--headed` opens a window, for a failure you
 * want to watch.
 *
 * Safari proper is not here. `safaridriver` needs a privileged enable step, and
 * the webkit build Playwright ships is the closest thing this driver can start
 * without one.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { startServer } from "./server.mjs";

const CASES = [
	["main-refuses", "main-thread attachWorkers refuses"],
	["store-reader", "store_reader.wasm against a live store"],
	["worker-js", "worker host, shared backing, js kernel"],
	["worker-wasm", "worker host, wasm backing, wasm kernel"],
	["bad-url", "a wrong workerUrl is a fault, not a hang"],
	["grow", "a store grow between two runs of passes"]
];

const ENVIRONMENT = ["page-env", "worker-env"];

function flag(name) {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
}

function has(name) {
	return process.argv.includes(`--${name}`);
}

async function loadPlaywright() {
	const dir = flag("playwright") ?? process.env.OECS_PLAYWRIGHT_DIR;
	if (dir === undefined) {
		console.error(
			"drive.mjs: no playwright install named. Pass --playwright <dir>, or set OECS_PLAYWRIGHT_DIR. The file header says how to make one."
		);
		process.exit(2);
	}
	const require = createRequire(`${dir.replace(/\/$/, "")}/package.json`);
	try {
		// Playwright ships CommonJS, and node hands a CommonJS module back under
		// `default` when it cannot name the exports statically.
		const loaded = await import(pathToFileURL(require.resolve("playwright")).href);
		return loaded.chromium === undefined ? (loaded.default ?? loaded) : loaded;
	} catch (error) {
		console.error(`drive.mjs: playwright did not load from '${dir}': ${error.message}`);
		process.exit(2);
	}
}

/** Drive one browser through the page and give back what it reported. A launch
 * that fails is a result and not a crash, because one browser missing must not
 * hide the other two. */
async function runBrowser(playwright, name, origin, headed) {
	const type = playwright[name];
	if (type === undefined) return { name, error: `playwright exposes no browser named '${name}'` };
	let browser;
	try {
		browser = await type.launch({ headless: !headed });
	} catch (error) {
		return { name, error: `launch failed: ${error.message}` };
	}
	const version = browser.version();
	const console_ = [];
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		page.on("console", (message) => console_.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => console_.push(`pageerror: ${error.message}`));
		await page.goto(`${origin}/bench/foundations/browser/index.html`, { waitUntil: "load" });
		await page.waitForFunction("window.__oecsDone === true", null, { timeout: 300_000 });
		const results = await page.evaluate("window.__oecsResults");
		await browser.close();
		return { name, version, results, console: console_ };
	} catch (error) {
		let results = [];
		try {
			results = await browser.contexts()[0]?.pages()[0]?.evaluate("window.__oecsResults ?? []");
		} catch {
			// The page is gone, so whatever it held is gone with it.
		}
		await browser.close().catch(() => {});
		return { name, version, results, console: console_, error: error.message };
	}
}

function report(run) {
	console.log(`\n=== ${run.name}${run.version ? ` ${run.version}` : ""}`);
	if (run.error !== undefined) console.log(`    driver: ${run.error}`);
	const byId = new Map((run.results ?? []).map((r) => [r.id, r]));
	for (const id of ENVIRONMENT) {
		const result = byId.get(id);
		if (result !== undefined) console.log(`    ${id}: ${JSON.stringify(result.detail)}`);
	}
	for (const [id, label] of CASES) {
		const result = byId.get(id);
		if (result === undefined) {
			console.log(`    not run  ${id.padEnd(14)} ${label}`);
			continue;
		}
		console.log(
			`    ${(result.ok ? "pass" : "FAIL").padEnd(8)}${id.padEnd(14)} ${label}\n              ${JSON.stringify(result.detail)}`
		);
	}
	// A result the matrix does not name is still a result, so it is printed.
	for (const result of run.results ?? []) {
		const known = CASES.some(([id]) => id === result.id) || ENVIRONMENT.includes(result.id);
		if (!known) console.log(`    extra    ${result.id}  ${JSON.stringify(result.detail)}`);
	}
	if (run.console?.length > 0) {
		console.log("    page console:");
		for (const line of run.console) console.log(`      ${line}`);
	}
}

async function main() {
	const playwright = await loadPlaywright();
	const browsers = (flag("browsers") ?? "chromium,firefox,webkit").split(",").filter(Boolean);
	const { origin, close } = await startServer();
	console.log(`serving the repository on ${origin}`);
	const runs = [];
	for (const name of browsers) {
		runs.push(await runBrowser(playwright, name, origin, has("headed")));
		report(runs[runs.length - 1]);
	}
	await close();

	console.log("\n--- matrix");
	const header = ["case", ...runs.map((r) => r.name)];
	const rows = CASES.map(([id, label]) => {
		const cells = runs.map((run) => {
			const result = (run.results ?? []).find((r) => r.id === id);
			if (result === undefined) return "not run";
			return result.ok ? "pass" : "fail";
		});
		return [label, ...cells];
	});
	const widths = header.map((h, c) =>
		Math.max(h.length, ...rows.map((row) => String(row[c]).length))
	);
	const line = (cells) => cells.map((cell, c) => String(cell).padEnd(widths[c])).join("  ");
	console.log(line(header));
	console.log(line(widths.map((w) => "-".repeat(w))));
	for (const row of rows) console.log(line(row));
	console.log("");

	const json = flag("json");
	if (json !== undefined) {
		writeFileSync(json, `${JSON.stringify(runs, null, 2)}\n`);
		console.log(`wrote ${json}`);
	}

	const failed = runs.some(
		(run) => run.error !== undefined || (run.results ?? []).some((r) => !r.ok)
	);
	process.exit(failed ? 1 : 0);
}

await main();
