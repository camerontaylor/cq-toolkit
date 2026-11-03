// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import type { PrChecks, PrReviewState } from '../../../src/ops/pr/assemblePrs.js';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

// ---------------------------------------------------------------------------
// The three-valued matrix (R2 D9)
// ---------------------------------------------------------------------------

describe('the three-valued readiness matrix', () => {
  test.each([
    [{ state: 'fail' }, { state: 'approved' }, 'checks failing'],
    [{ state: 'pass' }, { state: 'changes-requested' }, 'changes requested'],
  ] as const)(
    'unknown merge state preserves an independently established block (%j, %j)',
    async (checks, review, reason) => {
      const fake = fakeGh({
        checks: new Map([[11, checks]]),
        reviews: new Map([[11, review]]),
        statuses: new Map([[11, 'unknown']]),
      });
      const report = await okReport(
        makeRunReport(fake.gh),
        inputOf({ packages: [{ name: 'core', number: 11 }] }),
      );
      expect(report.rows[0]).toMatchObject({
        readiness: 'blocked',
        checks: checks.state,
        review: review.state,
      });
      expect(report.rows[0]?.reason).toContain(reason);
    },
  );

  const MATRIX: Array<[PrChecks, PrReviewState, 'ready' | 'blocked' | 'unknown', string]> = [
    [{ state: 'pass' }, { state: 'approved' }, 'ready', 'green checks + approval'],
    [
      { state: 'pass' },
      { state: 'none' },
      'ready',
      'green checks + NO review policy (a null decision counts toward ready)',
    ],
    [
      { state: 'pass' },
      { state: 'required' },
      'unknown',
      'REVIEW_REQUIRED is not none — a demanded-but-absent review is never ready (r1#1)',
    ],
    [
      { state: 'pending' },
      { state: 'required' },
      'unknown',
      'required review, checks still running',
    ],
    [{ state: 'fail' }, { state: 'approved' }, 'blocked', 'failing checks beat approval'],
    [{ state: 'fail' }, { state: 'changes-requested' }, 'blocked', 'failing on both halves'],
    [
      { state: 'fail', failing: ['build'] },
      { state: 'none' },
      'blocked',
      'failing names the check',
    ],
    [
      { state: 'pending' },
      { state: 'changes-requested' },
      'blocked',
      'changes-requested beats pending',
    ],
    [{ state: 'none' }, { state: 'changes-requested' }, 'blocked', 'changes-requested beats none'],
    [{ state: 'pass' }, { state: 'unknown' }, 'unknown', 'an unreadable review is not approval'],
    [
      { state: 'pending' },
      { state: 'approved' },
      'unknown',
      'pending checks never pass by assumption',
    ],
    [{ state: 'pending' }, { state: 'none' }, 'unknown', 'pending checks, no review'],
    [{ state: 'none' }, { state: 'approved' }, 'unknown', 'no checks configured is not a pass'],
    [{ state: 'none' }, { state: 'none' }, 'unknown', 'neither half resolvable'],
  ];

  test.each(MATRIX)('%s × %s → %s (%s)', async (checks, review, expected) => {
    const fake = fakeGh({
      checks: new Map([[11, checks]]),
      reviews: new Map([[11, review]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.readiness).toBe(expected);
    // blocked/unknown rows always say why; ready rows stay silent.
    if (expected === 'ready') {
      expect(report.rows[0]?.reason).toBeUndefined();
    } else {
      expect(report.rows[0]?.reason).not.toBeUndefined();
    }
  });

  test('a blocked row by failing checks names the failed check; the row keeps the observed evidence', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'fail', failing: ['build', 'lint'] }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      checks: 'fail',
      review: 'approved',
      readiness: 'blocked',
      reason: 'checks failing (build, lint)',
    });
  });
});
