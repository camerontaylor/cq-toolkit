// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the worker-result and fix-contract line builders.
import type { WorkerResult } from '../../src/driver/types.js';

/** A 'complete' WorkerResult whose structuredOutput is a single JSON line. */
export const completeWorker = (line: string, extra?: Partial<WorkerResult>): WorkerResult => ({
  structuredOutput: line,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
  model: 'test-model',
  ...extra,
});

/** The single-line JSON contract a compliant worker answers with. */
/**
 * One v2 fix contract line (THE FIX OUTCOME CONTRACT): a change is `fixed`;
 * no change is `unchanged_with_reason` citing `src/a.ts:3` unless `evidence`
 * says otherwise.
 */
export const fixLine = (
  changed: boolean,
  summary: string,
  commits: string[],
  evidence: Array<{ path: string; line: number }> = changed ? [] : [{ path: 'src/a.ts', line: 3 }],
): string =>
  JSON.stringify({
    disposition: changed ? 'fixed' : 'unchanged_with_reason',
    summary,
    commits,
    evidence,
  });

/** A v2 contract line with an explicit disposition (no commits). */
export const dispositionLine = (disposition: string, summary: string): string =>
  JSON.stringify({ disposition, summary, commits: [], evidence: [] });

/** The LEGACY v1 shape `{changed, summary, commits}`: free text, no disposition. */
export const legacyFixLine = (changed: boolean, summary: string, commits: string[]): string =>
  JSON.stringify({ changed, summary, commits });
