/**
 * Writes an HTML page with the results of ONE comparison from the past. The page
 * needs no other file. The values are constants in this file, and this program
 * calculates the dimensions of each bar from them. To make a page for a new
 * comparison, you must put the new values into this file.
 *
 * THIS FILE IS A RECORD, AND IT IS NOT A TOOL. Every number below belongs to the
 * run that its footer names: the working tree against HEAD 6f47ff8, over the 26
 * cases that `suite.mjs` held at that time. `suite.mjs` has 33 cases now, and the
 * seven that this page does not show are the `access/` rows for `getField_2fields`,
 * `refRead`, and the cursor, and `struct/archetype_rampup`. The noise floor below
 * also belongs to that run and to those 26 cases. Do not quote it as the floor of
 * the machine today: run `node bench/ab/ref.mjs --null` for that.
 *
 *   node bench/report.mjs > /path/to/report.html
 */

// name, head ns, working ns, median Δ%, IQR lo, IQR hi, verdict
const SECTIONS = [
	{
		id: "dispatch",
		title: "Frame dispatch",
		lede: "Fixed per-frame cost: what a tick charges before any of your system bodies run. This was the single largest win — two thirds of the phase loop was a Map lookup keyed on the system object.",
		rows: [
			["sched/update_20noop", 504.1, 279.3, -45.3, -46, -43, "faster"],
			["sched/update_20systems", 2058.1, 1737.8, -15.6, -16, -15, "faster"],
		],
	},
	{
		id: "structural",
		title: "Structural churn",
		lede: "Spawn, despawn, and archetype transitions — the classic ECS bottleneck. Rows are now placed straight into cached typed-array views instead of through a per-column push/pop API.",
		rows: [
			["struct/add_remove_cycle", 55.8, 42.3, -24.4, -25, -23, "faster"],
			["struct/add_remove_valued", 64.6, 51.7, -20.0, -23, -19, "faster"],
			["struct/despawn", 28.4, 22.0, -19.9, -28, -17, "faster"],
			["struct/spawn_template", 34.2, 27.8, -19.4, -21, -18, "faster"],
			["cmd/spawn_despawn_1000", 50.5, 42.0, -14.3, -18, -13, "faster"],
			["struct/addComponent_valued", 110.4, 97.5, -11.8, -15, -6, "faster"],
			["struct/spawn_empty", 8.0, 8.1, 0.6, -1, 3, "flat"],
			["struct/spawnMany", 11.7, 12.2, 1.9, -5, 190, "noisy"],
		],
	},
	{
		id: "query",
		title: "Query resolution",
		lede: "Looking a cached query up by its component set. The cache hit was allocating a BitSet and its backing array on every call, for nothing.",
		rows: [
			["query/resolve_cached", 55.6, 47.4, -14.6, -15, -14, "faster"],
			["query/compose_without", 7.6, 7.7, 0.7, -2, 1, "flat"],
			["query/count", 4.0, 4.0, -0.4, -2, 2, "flat"],
		],
	},
	{
		id: "iteration",
		title: "Iteration",
		lede: "Untouched by design. It was already at parity with a hand-written loop over raw typed arrays — that reference row is measured here as a control, and both it and the ECS path moved by less than a quarter of a percent.",
		rows: [
			["iter/eachChunk_2comp", 1.3, 1.3, -0.2, -1, 0, "flat"],
			["iter/raw_typedarray_baseline", 1.3, 1.3, 0.0, 0, 2, "control"],
			["iter/forEach_getColumnRead", 1.0, 1.0, 0.0, -2, 2, "flat"],
			["iter/forEachEntity", 2.8, 2.8, 0.1, -2, 1, "flat"],
			["iter/frag_64arch", 0.8, 0.8, -0.3, -9, 3, "noisy"],
		],
	},
	{
		id: "access",
		title: "Random access, relations, sparse storage",
		lede: "Also untouched. Listed because a change to row placement could easily have disturbed any of these, and the point of measuring them is to show it did not.",
		rows: [
			["access/getField", 21.4, 21.4, -0.6, -2, 0, "flat"],
			["access/setField", 18.4, 18.4, -0.3, -1, 0, "flat"],
			["access/hasComponent", 8.7, 8.7, -0.5, -2, 1, "flat"],
			["access/isAlive", 3.5, 3.5, 0.0, 0, 1, "flat"],
			["rel/targetOf", 14.1, 14.1, -1.0, -1, 1, "flat"],
			["rel/sourcesOf", 113.9, 113.7, 0.1, -3, 2, "flat"],
			["sparse/hasSparse", 13.0, 13.0, -0.5, -4, 0, "flat"],
			["sparse/getSparseField", 17.9, 17.7, -1.4, -3, 0, "flat"],
		],
	},
];

// ── bar geometry ───────────────────────────────────────────────────────────
// Axis is "% faster", so gains grow right from a zero line inset from the left;
// the two sub-2% regressions render as a short nub on the other side of it.
const ZERO = 7; // % of track width
const MAX = 48; // % faster at full width
const UNIT = (100 - ZERO - 2) / MAX;

const esc = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function bar(delta, lo, hi, kind) {
	const g = -delta; // % faster
	const wl = -hi; // IQR in "faster" terms
	const wh = -lo;
	const px = (v) => ZERO + v * UNIT;
	// A "not measurable" row has no verdict to express, so it gets a short hatched
	// stub anchored AT the zero line — never a bar whose length could be read as a
	// result. (Drawn from its signed value it would have straddled zero and looked
	// like a small gain.)
	const left = kind === "noisy" ? ZERO : g >= 0 ? ZERO : Math.max(0, px(g));
	const width = kind === "noisy" ? 0 : Math.max(Math.abs(g) * UNIT, g === 0 ? 0 : 0.35);
	const parts = [];
	parts.push(
		`<span class="fill ${kind}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>`
	);
	// IQR whisker — only where it spans something visible and the row claims a result
	if (kind === "faster" && Math.abs(wh - wl) > 0.2) {
		const a = Math.min(px(wl), px(wh));
		const b = Math.max(px(wl), px(wh));
		parts.push(
			`<span class="iqr" style="left:${a.toFixed(2)}%;width:${(b - a).toFixed(2)}%"></span>`
		);
	}
	parts.push(`<span class="zero" style="left:${ZERO}%"></span>`);
	return parts.join("");
}

function rowHTML([name, head, work, delta, lo, hi, kind]) {
	const g = -delta;
	const sign = g > 0 ? "+" : g < 0 ? "−" : "";
	const label =
		kind === "noisy"
			? "not measurable"
			: `${sign}${Math.abs(g).toFixed(1)}%`;
	const speedup = head / work;
	const tip =
		kind === "noisy"
			? `Rounds disagreed too widely to call — middle half spanned ${lo}%…${hi}%.`
			: `${head.toFixed(1)} ns → ${work.toFixed(1)} ns per op · ${speedup.toFixed(2)}× · middle half of rounds ${Math.abs(hi).toFixed(0)}…${Math.abs(lo).toFixed(0)}% faster`;
	return `        <tr class="row ${kind}" tabindex="0" data-tip="${esc(tip)}">
          <th scope="row" class="cname">${esc(name)}</th>
          <td class="ctrack"><span class="track">${bar(delta, lo, hi, kind)}</span></td>
          <td class="cdelta ${kind}">${esc(label)}</td>
          <td class="cns"><span class="was">${head.toFixed(1)}</span><span class="arrow">→</span><span class="now">${work.toFixed(1)}</span></td>
        </tr>`;
}

const sections = SECTIONS.map(
	(s) => `      <section class="area" id="${s.id}">
        <h2><span class="eyebrow">${esc(s.title)}</span></h2>
        <p class="lede">${esc(s.lede)}</p>
        <table class="bars">
          <caption class="sr-only">${esc(s.title)} — percent faster, working tree vs HEAD</caption>
          <thead class="sr-only"><tr><th>Benchmark</th><th>Percent faster</th><th>Delta</th><th>Nanoseconds per op, before and after</th></tr></thead>
          <tbody>
${s.rows.map(rowHTML).join("\n")}
          </tbody>
        </table>
      </section>`
).join("\n");

const allRows = SECTIONS.flatMap((s) => s.rows.map((r) => [s.title, ...r]));
const tableRows = allRows
	.map(
		([area, name, head, work, delta, lo, hi, kind]) =>
			`          <tr><td>${esc(area)}</td><td class="mono">${esc(name)}</td><td class="num">${head.toFixed(1)}</td><td class="num">${work.toFixed(1)}</td><td class="num">${delta > 0 ? "+" : ""}${delta.toFixed(1)}%</td><td class="num">${lo}…${hi}%</td><td>${kind === "flat" ? "no change" : kind === "control" ? "control" : kind === "noisy" ? "not measurable" : "faster"}</td></tr>`
	)
	.join("\n");

const html = `<title>oecs — what the optimisation pass bought</title>
<style>
  :root {
    color-scheme: light;
    --ground: #f6f7f7;
    --panel: #ffffff;
    --ink: #141a1b;
    --ink-2: #566365;
    --ink-3: #7d8b8d;
    --rule: #dfe5e5;
    --rule-2: #eceff0;
    --accent: #00887a;
    --accent-soft: #00887a1f;
    --iqr: #00887a70;
    --flat: #b9c4c4;
    --shadow: 0 1px 2px #0f191a0a, 0 8px 24px #0f191a0a;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --ground: #0f1416;
      --panel: #151c1e;
      --ink: #e4eaea;
      --ink-2: #93a2a4;
      --ink-3: #6d7d7f;
      --rule: #253032;
      --rule-2: #1c2426;
      --accent: #2fa394;
      --accent-soft: #2fa39426;
    --iqr: #2fa3947d;
      --iqr: #2fa3947d;
      --flat: #38474a;
      --shadow: 0 1px 2px #00000040, 0 8px 24px #0000002e;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --ground: #0f1416;
    --panel: #151c1e;
    --ink: #e4eaea;
    --ink-2: #93a2a4;
    --ink-3: #6d7d7f;
    --rule: #253032;
    --rule-2: #1c2426;
    --accent: #2fa394;
    --accent-soft: #2fa39426;
    --flat: #38474a;
    --shadow: 0 1px 2px #00000040, 0 8px 24px #0000002e;
  }

  body {
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
  }
  .wrap { max-width: 1000px; margin: 0 auto; padding: clamp(28px, 5vw, 72px) clamp(18px, 4vw, 40px) 96px; }
  .prose { max-width: 68ch; }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ── masthead ─────────────────────────────────────────────── */
  .kicker {
    font-family: var(--mono); font-size: 11.5px; letter-spacing: .13em;
    text-transform: uppercase; color: var(--ink-3); margin-bottom: 18px;
  }
  h1 {
    font-size: clamp(30px, 4.6vw, 46px); line-height: 1.1; letter-spacing: -.022em;
    font-weight: 620; text-wrap: balance; margin-bottom: 16px;
  }
  .standfirst { font-size: clamp(16px, 1.7vw, 18.5px); color: var(--ink-2); max-width: 62ch; }
  .meta {
    font-family: var(--mono); font-size: 11.5px; color: var(--ink-3);
    margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--rule);
    display: flex; flex-wrap: wrap; gap: 8px 22px;
  }
  .meta b { color: var(--ink-2); font-weight: 500; }

  /* ── stat tiles ───────────────────────────────────────────── */
  .tiles { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); margin: 40px 0 8px; }
  .tile {
    background: var(--panel); border: 1px solid var(--rule); border-radius: 10px;
    padding: 20px 20px 18px; box-shadow: var(--shadow);
  }
  .tile .t-label {
    font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--ink-3); margin-bottom: 12px;
  }
  .tile .t-num { font-size: 40px; line-height: 1; letter-spacing: -.03em; font-weight: 600; color: var(--accent); }
  .tile .t-num.plain { color: var(--ink); }
  .tile .t-unit { font-size: 17px; font-weight: 500; letter-spacing: -.01em; color: var(--ink-2); margin-left: 3px; }
  .tile .t-sub { font-family: var(--mono); font-size: 12px; color: var(--ink-2); margin-top: 11px; }

  /* ── sections ─────────────────────────────────────────────── */
  .area { margin-top: 54px; }
  .eyebrow {
    font-family: var(--mono); font-size: 12px; letter-spacing: .11em; text-transform: uppercase;
    color: var(--ink); font-weight: 600;
  }
  .area h2 { margin-bottom: 8px; }
  .lede { color: var(--ink-2); font-size: 15px; max-width: 70ch; margin-bottom: 22px; }

  /* ── bar rows ─────────────────────────────────────────────── */
  .bars { width: 100%; border-collapse: collapse; }
  .row { border-top: 1px solid var(--rule-2); }
  .row:first-child { border-top: 1px solid var(--rule); }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .row td, .row th { padding: 7px 0; vertical-align: middle; }
  .cname {
    font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); font-weight: 400;
    text-align: left; white-space: nowrap; padding-right: 16px; width: 1%;
  }
  .row.faster .cname { color: var(--ink); }
  .ctrack { width: 100%; }
  .track { position: relative; display: block; height: 15px; }
  .fill {
    position: absolute; top: 2px; height: 11px; background: var(--accent);
    border-radius: 0 3px 3px 0;
  }
  .fill.flat, .fill.control { background: var(--flat); border-radius: 2px; }
  .fill.noisy {
    background: repeating-linear-gradient(135deg, var(--flat) 0 3px, transparent 3px 6px);
    border-radius: 2px; min-width: 46px;
  }
  .iqr {
    position: absolute; top: 0; height: 15px;
    border-left: 2px solid var(--iqr); border-right: 2px solid var(--iqr);
  }
  .zero { position: absolute; top: -2px; height: 19px; width: 1px; background: var(--rule); }
  .cdelta {
    font-family: var(--mono); font-size: 13px; font-weight: 600; text-align: right;
    padding-left: 18px; white-space: nowrap; width: 1%; color: var(--accent);
  }
  .cdelta.flat, .cdelta.control { color: var(--ink-3); font-weight: 400; }
  .cdelta.noisy { color: var(--ink-3); font-weight: 400; font-size: 11.5px; font-style: italic; }
  .cns {
    font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); text-align: right;
    padding-left: 18px; white-space: nowrap; width: 1%;
  }
  .cns .arrow { margin: 0 5px; opacity: .55; }
  .row.faster .cns .now { color: var(--ink-2); }

  .legend {
    display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 18px;
    font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  }
  .legend span { display: inline-flex; align-items: center; gap: 7px; }
  .swatch { width: 22px; height: 8px; border-radius: 2px; display: inline-block; }
  .swatch.a { background: var(--accent); }
  .swatch.f { background: var(--flat); }
  .swatch.n { background: repeating-linear-gradient(135deg, var(--flat) 0 3px, transparent 3px 6px); }
  .swatch.i { border-left: 2px solid var(--iqr); border-right: 2px solid var(--iqr); height: 12px; }

  /* ── prose blocks ─────────────────────────────────────────── */
  .block { margin-top: 62px; padding-top: 34px; border-top: 1px solid var(--rule); }
  .block h2 { font-size: 22px; letter-spacing: -.015em; font-weight: 620; margin-bottom: 10px; }
  .block p { color: var(--ink-2); font-size: 15px; }
  .block p + p { margin-top: 12px; }

  .fixes { display: grid; gap: 12px; margin-top: 24px; }
  .fix {
    background: var(--panel); border: 1px solid var(--rule); border-radius: 10px;
    padding: 18px 20px; display: grid; gap: 6px;
  }
  .fix h3 { font-size: 15.5px; font-weight: 600; letter-spacing: -.01em; }
  .fix p { font-size: 14.5px; color: var(--ink-2); margin: 0; }
  .fix .tag {
    font-family: var(--mono); font-size: 11px; color: var(--accent);
    letter-spacing: .04em;
  }
  code {
    font-family: var(--mono); font-size: .9em; background: var(--accent-soft);
    padding: 1px 5px; border-radius: 4px; color: var(--ink);
  }

  .callout {
    margin-top: 24px; background: var(--panel); border: 1px solid var(--rule);
    border-radius: 10px; padding: 20px 22px;
  }
  .callout pre {
    font-family: var(--mono); font-size: 12px; line-height: 1.75; color: var(--ink-2);
    overflow-x: auto; margin: 0;
  }
  .callout .hl { color: var(--accent); font-weight: 600; }

  /* ── data table ───────────────────────────────────────────── */
  details { margin-top: 62px; padding-top: 34px; border-top: 1px solid var(--rule); }
  summary {
    font-family: var(--mono); font-size: 12px; letter-spacing: .09em; text-transform: uppercase;
    color: var(--ink-2); cursor: pointer; font-weight: 600;
  }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
  .scroll { overflow-x: auto; margin-top: 20px; }
  table.data { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 720px; }
  table.data th {
    text-align: left; font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--ink-3); font-weight: 500;
    padding: 8px 14px 8px 0; border-bottom: 1px solid var(--rule);
  }
  table.data td { padding: 6px 14px 6px 0; border-bottom: 1px solid var(--rule-2); color: var(--ink-2); }
  table.data td.mono { font-family: var(--mono); font-size: 12px; color: var(--ink); }
  table.data td.num { font-family: var(--mono); text-align: right; }

  footer {
    margin-top: 62px; padding-top: 22px; border-top: 1px solid var(--rule);
    font-family: var(--mono); font-size: 11.5px; color: var(--ink-3);
  }

  /* ── tooltip ──────────────────────────────────────────────── */
  #tip {
    position: fixed; z-index: 30; pointer-events: none; opacity: 0;
    transition: opacity .1s ease; background: var(--ink); color: var(--ground);
    font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
    padding: 8px 11px; border-radius: 7px; max-width: 340px; box-shadow: var(--shadow);
  }
  #tip.on { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { #tip { transition: none; } }

  @media (max-width: 640px) {
    .cns { display: none; }
    .cname { font-size: 11.5px; max-width: 148px; overflow: hidden; text-overflow: ellipsis; }
  }
</style>

<div class="wrap">
  <header>
    <div class="kicker">oecs · local performance investigation</div>
    <h1>Where the time went, and what it cost to prove it</h1>
    <p class="standfirst">
      Four changes to the engine's per-frame and structural paths. The hot iteration loop
      was already at parity with hand-written typed-array code, so it was left alone —
      everything gained here came from overhead around it.
    </p>
    <div class="meta">
      <span><b>26</b> benchmarks</span>
      <span><b>11</b> paired rounds, process-isolated</span>
      <span>node 24 · darwin arm64</span>
      <span>bundle of <code>src/</code>, <b>__DEV__=false</b> (the guards stay as branches)</span>
      <span>noise floor <b>±2.9%</b></span>
    </div>
  </header>

  <div class="tiles">
    <div class="tile">
      <div class="t-label">Frame dispatch overhead</div>
      <div class="t-num">1.80<span class="t-unit">× faster</span></div>
      <div class="t-sub">504 → 279 ns · 20 systems</div>
    </div>
    <div class="tile">
      <div class="t-label">Add / remove a component</div>
      <div class="t-num">1.32<span class="t-unit">× faster</span></div>
      <div class="t-sub">55.8 → 42.3 ns per op</div>
    </div>
    <div class="tile">
      <div class="t-label">Iteration over 10k entities</div>
      <div class="t-num plain">1.3<span class="t-unit">ns / entity</span></div>
      <div class="t-sub">unchanged · raw-array parity</div>
    </div>
  </div>

${sections}

  <div class="legend">
    <span><i class="swatch a"></i> measured gain</span>
    <span><i class="swatch i"></i> middle half of rounds</span>
    <span><i class="swatch f"></i> no change (within noise)</span>
    <span><i class="swatch n"></i> not measurable</span>
  </div>

  <div class="block prose">
    <h2>What changed</h2>
    <p>
      Four fixes, found by profiling rather than guessing. Each one names the benchmarks it moved.
    </p>
    <div class="fixes">
      <div class="fix">
        <div class="tag">sched/update_20noop · −45.3%</div>
        <h3>Last-run tick moved off a Map</h3>
        <p>
          The phase loop read and wrote <code>Map&lt;SystemDescriptor, number&gt;</code> twice per
          system per frame — hashing an object identity. Line-level profiling put
          <strong>63%</strong> of the whole loop in those two operations. System ids come from a dense
          per-world counter, so an id-indexed packed array replaces it.
        </p>
      </div>
      <div class="fix">
        <div class="tag">struct/* · −12% to −24%</div>
        <h3>Archetype row plane</h3>
        <p>
          Rows were placed through a column API — an accessor call, a capacity compare and a
          length load/store <em>per column per row</em>, around one typed-array move of actual work.
          But <code>Archetype.length</code> already is the row count for every column, so all of it was
          redundant. Columns are now indexed directly through cached views, with the row count
          published down only at the boundaries that read it.
        </p>
      </div>
      <div class="fix">
        <div class="tag">struct/addComponent_valued · −11.8%</div>
        <h3>One edge probe instead of four lookups</h3>
        <p>
          A component add re-checked the component mask, then re-read the same holey edge slot, then
          re-fetched the archetype, then read the edge again for its transition map. A single probe
          answers all of it: an add edge is only ever recorded on an archetype that lacks the
          component.
        </p>
      </div>
      <div class="fix">
        <div class="tag">query/resolve_cached · −14.6%</div>
        <h3>No allocation on a cache hit</h3>
        <p>
          <code>ecs.query(…)</code> allocated a BitSet and its backing array on every call — the
          resolver already copies its arguments three times internally, so the caller-side copy was
          pure garbage on the hit path.
        </p>
      </div>
    </div>
  </div>

  <div class="block prose">
    <h2>Why these numbers can be believed</h2>
    <p>
      The first version of this harness was worthless. Running both builds in one process made every
      measured call site megamorphic, and three benchmarks were quietly timing the memory allocator
      rather than the operation. A <strong>null run</strong> — identical code compiled on both sides,
      where every row must read zero — exposed it: swings from −17% to +40%, including a
      phantom 33% regression that does not exist.
    </p>
    <p>
      Each measurement now runs in its own child process, growth happens during setup rather than
      inside the timed region, and rows whose rounds disagree flag themselves rather than guess.
      The same null run today:
    </p>
    <div class="callout">
      <pre>$ node bench/ab/ref.mjs --null

<span class="hl">25 of 26 rows</span> read "~"  (23 of them within ±1%, worst 2.9%)
 1 row self-flags NOISY
 <span class="hl">0 faster, 0 slower</span>  — no false verdicts</pre>
    </div>
    <p>
      That worst non-noisy row — ±2.9% — is the noise floor the gains above have to clear, and every
      one of them clears it several times over. One row self-flagged in that null run; in the
      comparison itself, two rows refuse to produce a verdict, and they are shown as unmeasurable
      rather than dressed up as results.
    </p>
    <p>
      One caveat this page did not record at the time: a single summary figure understates how noisy
      an individual row can be. A row whose middle half is wide under identical code cannot support a
      small delta under changed code, however small the summary number is. The harness now prints the
      widest middle half alongside the largest delta, so a later run of this null does not need the
      reader to know that.
    </p>
    <p>
      Correctness was checked separately: the full suite (1613 tests) passes, and a randomized
      structural-op fuzzer — checking component values, query membership and snapshot round-trips
      against an independent model — passes across 280 seeds.
    </p>
  </div>

  <details>
    <summary>All 26 benchmarks — table view</summary>
    <div class="scroll">
      <table class="data">
        <thead>
          <tr><th>Area</th><th>Benchmark</th><th>Before (ns)</th><th>After (ns)</th><th>Median Δ</th><th>Middle half</th><th>Verdict</th></tr>
        </thead>
        <tbody>
${tableRows}
        </tbody>
      </table>
    </div>
  </details>

  <footer>
    Working tree vs HEAD 6f47ff8 · median of 11 paired rounds, each the best of 9 in-process samples ·
    lower is better · nothing committed
  </footer>
</div>

<div id="tip" role="status" aria-live="polite"></div>

<script>
  (function () {
    var tip = document.getElementById("tip");
    function show(el, x, y) {
      var t = el.getAttribute("data-tip");
      if (!t) return;
      tip.textContent = t;
      tip.classList.add("on");
      var r = tip.getBoundingClientRect();
      var left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
      var top = y - r.height - 12;
      if (top < 8) top = y + 18;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    function hide() { tip.classList.remove("on"); }
    document.querySelectorAll(".row").forEach(function (row) {
      row.addEventListener("mousemove", function (e) { show(row, e.clientX, e.clientY); });
      row.addEventListener("mouseleave", hide);
      row.addEventListener("focus", function () {
        var r = row.getBoundingClientRect();
        show(row, r.left + 40, r.top + r.height);
      });
      row.addEventListener("blur", hide);
    });
  })();
</script>
`;

process.stdout.write(html);
