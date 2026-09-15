// typecheck-count adapter — the first ratchet metric source.
//
// Accepts either a summary object ({count: n}, possibly nested) or raw
// compiler text counted by /error TS\d+:/ lines. Counts must be non-negative
// INTEGERS (an error count is cardinal; 0.5 errors is unusable evidence).
// Text evidence cannot distinguish a clean build from output that is not a
// compiler log at all, so text with zero error lines yields null —
// non-passing evidence (I5), never a fabricated 0 pass. Callers that KNOW
// the count supply the object form, where a structured 0 is a real zero.
// Cyclic source data is bounded by a visited-set: a cycle yields
// "no count here", never unbounded recursion.
import type { MetricAdapter, MetricReading } from '../registry.js';

const TSC_ERROR_LINE = /error TS\d+:/;

/** Depth-first search for the first numeric `count` property; undefined when none (or on a cycle). */
function findNumericCount(node: unknown, seen: WeakSet<object>): number | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  if (seen.has(node)) return undefined; // cycle: this branch holds no new count
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (typeof record.count === 'number') return record.count;
  for (const child of Object.values(record)) {
    const found = findNumericCount(child, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const typecheckCount: MetricAdapter = {
  id: 'typecheck-count',
  direction: 'lower-is-better',
  extract(raw: unknown): MetricReading | null {
    if (typeof raw === 'object' && raw !== null) {
      const count = findNumericCount(raw, new WeakSet());
      if (count === undefined || !Number.isInteger(count) || count < 0) return null;
      return { value: count, unit: 'errors' };
    }
    if (typeof raw === 'string') {
      const count = raw.split('\n').filter((line) => TSC_ERROR_LINE.test(line)).length;
      if (count === 0) return null;
      return { value: count, unit: 'errors' };
    }
    return null;
  },
};
