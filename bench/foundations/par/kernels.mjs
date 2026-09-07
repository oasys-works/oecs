/**
 * The two kernels the split probe runs, written once so the sequential path and
 * the worker path execute the same source.
 *
 * Both take the nine bound column views in a fixed order and a half-open row
 * range. Every row is independent of every other row, which is the property a
 * row-range split depends on. A kernel that read a neighbouring row would give
 * a different answer under a split, and this probe would not catch it.
 *
 * View order: px, py, pz, vx, vy, vz, tx, ty, tz.
 */

export const KERNEL_A = 0;
export const KERNEL_B = 1;

/** Integrate position by velocity. Three loads, three fused updates, no branch.
 * Memory bound, and the cheapest per-row body a real system has. */
export function kernelA(views, begin, end, dt) {
	const px = views[0];
	const py = views[1];
	const pz = views[2];
	const vx = views[3];
	const vy = views[4];
	const vz = views[5];
	for (let i = begin; i < end; i++) {
		px[i] += vx[i] * dt;
		py[i] += vy[i] * dt;
		pz[i] += vz[i] * dt;
	}
}

/** A damped spring toward a target, with a branch on the distance. Several
 * dozen flops for each row, a square root, and a path that is taken for some
 * rows and not others. Compute bound, and the case a split should win. */
export function kernelB(views, begin, end, dt) {
	const px = views[0];
	const py = views[1];
	const pz = views[2];
	const vx = views[3];
	const vy = views[4];
	const vz = views[5];
	const tx = views[6];
	const ty = views[7];
	const tz = views[8];
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
		// The branch is the point. A row far from its target pulls along the
		// unit vector. A row already close falls back to a linear pull, which
		// avoids the reciprocal square root at the origin.
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

export function runKernel(job, views, begin, end, dt) {
	if (job === KERNEL_A) kernelA(views, begin, end, dt);
	else kernelB(views, begin, end, dt);
}

/**
 * The row range one worker owns, over the concatenation of every bound
 * archetype in descriptor order.
 *
 * Every worker computes this from the same inputs, so no plan travels over the
 * wire and no worker can disagree with another about who owns a row. Returns an
 * array of `{ boundIndex, begin, end }`.
 */
export function partition(rowCounts, workerIndex, workerCount) {
	let total = 0;
	for (let i = 0; i < rowCounts.length; i++) total += rowCounts[i];
	const from = Math.floor((total * workerIndex) / workerCount);
	const to = Math.floor((total * (workerIndex + 1)) / workerCount);
	const out = [];
	let base = 0;
	for (let i = 0; i < rowCounts.length; i++) {
		const n = rowCounts[i];
		const lo = Math.max(from, base) - base;
		const hi = Math.min(to, base + n) - base;
		if (hi > lo) out.push({ boundIndex: i, begin: lo, end: hi });
		base += n;
	}
	return out;
}
