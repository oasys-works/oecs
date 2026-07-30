/**
 * A small harness for measurements. It does a warmup, and it then measures the
 * time of each sample. It reports the best value and the median value of the
 * samples. The best value has the least noise, because noise only adds time.
 */

export function bench(name, fn, { iters = 1, warmup = 3, samples = 9, setup } = {}) {
	// warmup
	for (let i = 0; i < warmup; i++) {
		const state = setup ? setup() : undefined;
		fn(state);
	}
	const times = [];
	for (let s = 0; s < samples; s++) {
		const state = setup ? setup() : undefined;
		const t0 = process.hrtime.bigint();
		fn(state);
		const t1 = process.hrtime.bigint();
		times.push(Number(t1 - t0) / 1e6);
	}
	times.sort((a, b) => a - b);
	const best = times[0];
	const median = times[(times.length / 2) | 0];
	return {
		name,
		bestMs: best,
		medianMs: median,
		opsPerSec: iters / (best / 1000),
		nsPerOp: (best * 1e6) / iters,
	};
}

export function report(results) {
	const w = Math.max(...results.map((r) => r.name.length));
	for (const r of results) {
		console.log(
			`${r.name.padEnd(w)}  ${r.bestMs.toFixed(3).padStart(9)} ms  ` +
				`${fmt(r.opsPerSec).padStart(12)} ops/s  ${r.nsPerOp.toFixed(1).padStart(10)} ns/op`
		);
	}
}

function fmt(n) {
	if (n > 1e9) return (n / 1e9).toFixed(2) + "B";
	if (n > 1e6) return (n / 1e6).toFixed(2) + "M";
	if (n > 1e3) return (n / 1e3).toFixed(2) + "K";
	return n.toFixed(1);
}

export function json(results, file) {
	return JSON.stringify(
		Object.fromEntries(results.map((r) => [r.name, { ns: r.nsPerOp, ms: r.bestMs }])),
		null,
		2
	);
}
