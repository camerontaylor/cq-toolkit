// complexity adapter — lane H slice 2.
//
// Two accepted shapes for the same metric: a pre-averaged summary
// ({averageComplexity: n}) or an array of per-entity records
// ({Complexity: n}) whose arithmetic mean becomes the value. Both paths
// share ONE half-up-to-2-decimals rounding core so identical inputs always
// produce identical baseline bytes; the core guards the half decision with
// a relative epsilon, because the binary doubles for exact decimal halves
// round the wrong way under naive float scaling (1.005 arrives as
// 100.49999999999999 — via the direct multiply AND via the accumulated sum
// feeding the array ratio). Empty arrays, records without a finite
// non-negative Complexity, negative or overflow values → null: non-passing
// evidence (I5), never a fabricated pass.
import type { MetricAdapter, MetricReading } from '../metricRegistry.js';

/**
 * Half-up rounding of a positive scaled ratio with a fixed ABSOLUTE
 * tolerance: representation noise of the ×100 scale is ≤ 1e-9 for the
 * magnitudes where a decimal half is expressible, so 1e-9 rescues every
 * true half (1.005 arrives as 100.49999999999999) while
 * genuinely-below-half values stay down. A RELATIVE guard would flip them
 * at large magnitudes (1000000.004999999 rounded UP under the old
 * y*(1+8·EPSILON) guard); beyond ~1e6 the rounding is best-effort and
 * genuinely-below-half values round down.
 */
function halfUp(y: number): number {
  return Math.floor(y + 0.5 + 1e-9);
}

/** halfUp over an integer-domain ratio (numerator already *100-scaled), result back on the 2-decimal scale by /100. */
function roundRatioHalfUp2(num: number, den: number): number {
  return halfUp(num / den);
}

function roundHalfUp2(x: number): number {
  return roundRatioHalfUp2(x * 100, 1) / 100;
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
