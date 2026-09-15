// typecheck-count adapter — the first ratchet metric source.
//
// Accepts either a summary object ({count: n}, possibly nested) or raw
// compiler text counted by ANCHORED tsc diagnostic-header lines. Three
// shapes tsc actually emits: classic `path(line,col): error TSxxxx: msg`
// (paths may contain spaces, and even '(' — the path part matches
// non-greedily up to the real location), pretty `path:line:col - error
// TSxxxx: msg`, and location-free heads `error TSxxxx: msg` (e.g. TS18003,
// no inputs found). ANSI escape sequences (tsc --pretty colors) are
// stripped before matching. An unanchored /error TS\d+:/ would also count
// displayed SOURCE lines that merely quote the literal text
// (const message = "error TS1234:"). Counts must be non-negative INTEGERS
// (an error count is cardinal; 0.5 errors is unusable evidence).
// Text evidence cannot distinguish a clean build from output that is not a
// compiler log at all, so text with zero diagnostic headers yields null —
// non-passing evidence (I5), never a fabricated 0 pass. Callers that KNOW
// the count supply the object form, where a structured 0 is a real zero.
// Cyclic source data is bounded by a visited-set: a cycle yields
// "no count here", never unbounded recursion.
import type { MetricAdapter, MetricReading } from '../registry.js';

// ANSI escape sequences: CSI forms (colors/cursor — what `tsc --pretty`
// emits) and OSC strings. Stripped before matching; matching the ESC byte
// is the point, so no-control-regex is intentionally disabled here.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCES = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// A line counts iff it opens like a real tsc diagnostic header — one of the
// three shapes tsc actually emits (see the file header). Anchored at ^ so
// quoted diagnostic text anywhere later in a line never counts; the classic
// path part is non-greedy `.+?` so a path containing '(' itself ('weird(1)
// .ts') still terminates at the real (line,col) location.
const TSC_ERROR_LINE =
  /^(?:error TS\d+:|.+?\(\d+,\d+\):\s*error TS\d+:|.+?:\d+:\d+\s+-\s+error TS\d+:)/;

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
      // ANSI-stripped FIRST: `tsc --pretty` wraps path/line/col/'error' in
      // escapes, and those bytes would break every anchored header match.
      const plain = raw.replace(ANSI_SEQUENCES, '');
      const count = plain.split('\n').filter((line) => TSC_ERROR_LINE.test(line)).length;
      if (count === 0) return null;
      return { value: count, unit: 'errors' };
    }
    return null;
  },
};
