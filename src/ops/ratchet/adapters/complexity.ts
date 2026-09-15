// complexity adapter — lane H slice 2.
//
// Two accepted shapes for the same metric: a pre-averaged summary
// ({averageComplexity: n}) or an array of per-entity records
// ({Complexity: n}) whose arithmetic mean becomes the value. Both paths
// round HALF-UP to 2 decimals so identical inputs always produce identical
// baseline bytes — in the integer domain (roundRatioHalfUp2), because the
// binary double for an exact decimal half (1.005 → 100.499999…, not 100.5)
// rounds the wrong way under naive float scaling. Empty arrays, records
// without a finite non-negative Complexity, negative values → null:
// non-passing evidence (I5), never a fabricated pass.
import type { MetricAdapter, MetricReading } from '../registry.js';

/** Half-up rounding of a non-negative integer-scaled ratio: (sum*100)/count. */
function halfUp(y: number): number {
  return Math.floor(y + 0.5);
}

function roundRatioHalfUp2(num: number, den: number): number {
  return halfUp(num / den);
}

function roundHalfUp2(x: number): number {
  // x*100 carries a few-ulp binary representation error (exact decimal 1.005
  // arrives as 100.49999999999999), so the half decision adds a RELATIVE
  // epsilon: far larger than the ulp-level noise of one multiply, far smaller
  // than the 0.5 half-step it guards — it can only rescue a true half, never
  // flip a non-half.
  return roundRatioHalfUp2(x * 100 + Math.abs(x * 100) * Number.EPSILON * 8, 1) / 100;
}

export const complexity: MetricAdapter = {
  id: 'complexity',
  direction: 'lower-is-better',
  extract(raw: unknown): MetricReading | null {
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      let sum = 0;
      for (const record of raw) {
        if (typeof record !== 'object' || record === null) return null;
        const cx = (record as Record<string, unknown>)['Complexity'];
        if (typeof cx !== 'number' || !Number.isFinite(cx) || cx < 0) return null;
        sum += cx;
      }
      const value = roundRatioHalfUp2(sum * 100, raw.length) / 100;
      if (!Number.isFinite(value)) return null;
      return { value, unit: 'avg-cx' };
    }
    if (typeof raw === 'object' && raw !== null) {
      const avg = (raw as Record<string, unknown>)['averageComplexity'];
      if (typeof avg !== 'number' || !Number.isFinite(avg) || avg < 0) return null;
      const value = roundHalfUp2(avg);
      // Finite input can still overflow the *100 scaling (1e307*100 =
      // Infinity); an infinite value would JSON.stringify to null and the
      // written file would fail its own parser, so it is no reading at all.
      if (!Number.isFinite(value)) return null;
      return { value, unit: 'avg-cx' };
    }
    return null;
  },
};
