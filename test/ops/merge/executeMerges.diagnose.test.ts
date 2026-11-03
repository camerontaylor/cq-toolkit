// Split from test/ops/merge/executeMerges.test.ts (F3): diagnoseMergeFailure
// (UC §3 row 45).
import { describe, expect, test } from 'vitest';
import { diagnoseMergeFailure } from '../../../src/ops/merge/diagnoseMergeFailure.js';
import type { ExecutionReport } from '../../../src/ops/merge/executeMerges.js';

// ---------------------------------------------------------------------------
// diagnoseMergeFailure (UC §3 row 45)
// ---------------------------------------------------------------------------

describe('diagnoseMergeFailure', () => {
  const mixed: ExecutionReport = {
    merged: [1, 4],
    retargeted: [3],
    stale: [{ pr: 9, detail: 'head moved between plan and run (plan saw aa, live is bb)' }],
    failed: [{ pr: 2, error: 'gh pr merge 2 --merge failed (exit 1): protected branch' }],
    blocked: [{ pr: 7, reason: 'blocked_by_ancestor' }],
  };

  test('each not-merged bucket maps to its plain-language cause, pr-number sorted', () => {
    const diagnosis = diagnoseMergeFailure(mixed);
    expect(diagnosis.causes).toEqual([
      { pr: 2, cause: 'merge_rejected' },
      { pr: 7, cause: 'blocked_by_ancestor' },
      { pr: 9, cause: 'state_drift' },
    ]);
    expect(diagnosis.needsHuman).toEqual([2, 7, 9]);
  });

  test('the summary line carries every count', () => {
    expect(diagnoseMergeFailure(mixed).summary).toBe(
      'merge run: 2 merged, 1 retargeted, 3 need a human ' +
        '(state_drift: 1, merge_rejected: 1, blocked_by_ancestor: 1)',
    );
  });

  test('a clean report diagnoses nothing to do', () => {
    const diagnosis = diagnoseMergeFailure({
      merged: [1],
      retargeted: [],
      stale: [],
      failed: [],
      blocked: [],
    });
    expect(diagnosis.causes).toEqual([]);
    expect(diagnosis.needsHuman).toEqual([]);
    expect(diagnosis.summary).toBe(
      'merge run: 1 merged, 0 retargeted, 0 need a human ' +
        '(state_drift: 0, merge_rejected: 0, blocked_by_ancestor: 0)',
    );
  });

  test('pure: same report → deep-equal diagnosis', () => {
    expect(diagnoseMergeFailure(mixed)).toEqual(diagnoseMergeFailure(mixed));
  });
});
