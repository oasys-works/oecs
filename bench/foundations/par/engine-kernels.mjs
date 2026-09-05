/**
 * The two kernels the engine probe runs, in the argument order a `parallel`
 * system declares.
 *
 * The engine hands a `js` kernel one typed array for each declared column, in
 * `parallel.columns` order, then `begin`, `end` and `dt`. That is why these
 * take positional columns and not the view array the hand-rolled probe passes.
 * The bodies are the ones in `kernels.mjs`, so the two probes measure the same
 * arithmetic.
 *
 * The sequential `fn` in the probe imports this file too. A difference between
 * the pooled run and the sequential run can then only come from the split, and
 * never from two copies of a body.
 *
 * Every row is independent of every other row. A kernel that read a
 * neighbouring row would answer differently under a split, and the byte compare
 * would not catch it.
 */

/** Integrate position by velocity. Three loads, three fused updates, no branch.
 * Memory bound, and the cheapest per-row body a real system has. */
export function integrate(px, py, pz, vx, vy, vz, begin, end, dt) {
	for (let i = begin; i < end; i++) {
		px[i] += vx[i] * dt;
		py[i] += vy[i] * dt;
		pz[i] += vz[i] * dt;
	}
}

/** A damped spring toward a target, with a branch on the distance. Several
 * dozen flops for each row, a square root, and a path that is taken for some
 * rows and not others. Compute bound, and the case a split should win. */
export function spring(px, py, pz, vx, vy, vz, tx, ty, tz, begin, end, dt) {
	const stiffness = 12.0;
	const damping = 0.85;
	const maxSpeed = 40.0;
	for (let i = begin; i < end; i++) {
		const dx = tx[i] - px[i];
		const dy = ty[i] - py[i];
		const dz = tz[i] - pz[i];
		const d2 = dx * dx + dy * dy + dz * dz;
		let ax;
		let ay;
		let az;
		// The branch is the point. A row far from its target pulls along the unit
		// vector; a row already close falls back to a linear pull, which avoids
		// the reciprocal square root at the origin.
		if (d2 > 1e-6) {
			const inv = 1.0 / Math.sqrt(d2);
			const k = stiffness * Math.sqrt(d2);
			ax = dx * inv * k;
			ay = dy * inv * k;
			az = dz * inv * k;
		} else {
			ax = dx * stiffness;
			ay = dy * stiffness;
			az = dz * stiffness;
		}
		let nvx = (vx[i] + ax * dt) * damping;
		let nvy = (vy[i] + ay * dt) * damping;
		let nvz = (vz[i] + az * dt) * damping;
		const s2 = nvx * nvx + nvy * nvy + nvz * nvz;
		if (s2 > maxSpeed * maxSpeed) {
			const scale = maxSpeed / Math.sqrt(s2);
			nvx *= scale;
			nvy *= scale;
			nvz *= scale;
		}
		vx[i] = nvx;
		vy[i] = nvy;
		vz[i] = nvz;
		px[i] += nvx * dt;
		py[i] += nvy * dt;
		pz[i] += nvz * dt;
	}
}
