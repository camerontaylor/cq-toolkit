// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

// ---------------------------------------------------------------------------
// Draft dominance (PR-165 r1#2, codex jLt4f): a draft can never be ready
// ---------------------------------------------------------------------------

describe('a draft PR is blocked regardless of checks and review', () => {
  test('draft + green checks + approval → blocked, reason naming the draft', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      drafts: new Map([[11, true]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pass',
      review: 'approved',
      reason: 'draft — not ready for review',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 1, unknown: 0 });
  });

  test('draft dominates UNRESOLVABLE evidence halves (pending checks, unreadable review)', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pending' }]]),
      reviews: new Map([[11, { state: 'unknown' }]]),
      drafts: new Map([[11, true]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pending',
      review: 'unknown',
      reason: 'draft — not ready for review',
    });
  });

  test('not-a-draft changes nothing: green evidence still reports ready', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      drafts: new Map([[11, false]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({ readiness: 'ready' });
  });
});
