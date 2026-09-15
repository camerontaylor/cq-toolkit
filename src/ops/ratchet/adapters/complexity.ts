// complexity adapter — lane H slice 2.
//
// Two accepted shapes for the same metric: a pre-averaged summary
// ({averageComplexity: n}, passed through verbatim) or an array of
// per-entity records ({Complexity: n}) whose arithmetic mean becomes the
// value, rounded half-up to 2 decimals so identical records always produce
// identical baseline bytes. Empty arrays, records without a numeric
// Complexity, negative values → null: non-passing evidence (I5), never a
// fabricated pass.
import type { MetricAdapter, MetricReading } from '../registry.js';

// Math.round sends exact halves toward +Infinity; inputs are validated
// non-negative before this runs, so this IS half-up — and deterministic.
function roundHalfUp2(x: number): number {
  return Math.round(x * 100) / 100;
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
        if (typeof cx !== 'number' || !Number.isFinite(cx)) return null;
        sum += cx;
      }
      const value = roundHalfUp2(sum / raw.length);
      if (!Number.isFinite(value) || value < 0) return null;
      return { value, unit: 'avg-cx' };
    }
    if (typeof raw === 'object' && raw !== null) {
      const avg = (raw as Record<string, unknown>)['averageComplexity'];
      if (typeof avg !== 'number' || !Number.isFinite(avg) || avg < 0) return null;
      return { value: avg, unit: 'avg-cx' };
    }
    return null;
  },
};
