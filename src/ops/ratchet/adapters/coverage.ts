// coverage adapter — lane H slice 2.
//
// Reads the istanbul-style coverage-summary.json shape: `total.lines.pct`
// is THE ratcheted value (higher is better, unit pct);
// branches/functions/statements pct ride along in `detail` when present and
// numeric. Anything missing or non-numeric, and any value pct outside
// [0, 100], yields null — non-passing evidence (I5), never a fabricated pass.
import type { MetricAdapter, MetricReading } from '../registry.js';

function pctOf(node: unknown): number | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const pct = (node as Record<string, unknown>)['pct'];
  return typeof pct === 'number' ? pct : undefined;
}

export const coverage: MetricAdapter = {
  id: 'coverage',
  direction: 'higher-is-better',
  extract(raw: unknown): MetricReading | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const total = (raw as Record<string, unknown>)['total'];
    if (typeof total !== 'object' || total === null) return null;
    const record = total as Record<string, unknown>;
    const pct = pctOf(record.lines);
    if (pct === undefined || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    const detail: Record<string, unknown> = {};
    for (const key of ['branches', 'functions', 'statements'] as const) {
      const value = pctOf(record[key]);
      // Detail rides along only when it is a believable pct, same [0,100]
      // bound as the primary value; junk detail is dropped, not fatal.
      if (value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100) {
        detail[key] = value;
      }
    }
    return Object.keys(detail).length === 0
      ? { value: pct, unit: 'pct' }
      : { value: pct, unit: 'pct', detail };
  },
};
