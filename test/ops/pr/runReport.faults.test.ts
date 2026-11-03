// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

// ---------------------------------------------------------------------------
// I9 — per-package faults collect, never fail the op
// ---------------------------------------------------------------------------

describe('effects faults land on their row (I9)', () => {
  test('a SNAPSHOT fault → unknown row with the fault as reason; the other package still reports ready', async () => {
    // ONE consolidated read (final jNTyS): the snapshot resolves fully or
    // faults fully — a faulted snapshot is an unknown row, never half-stale
    // evidence, and the sibling package still reports.
    const fake = fakeGh({
      checks: new Map([[12, { state: 'pass' }]]),
      reviews: new Map([
        [11, { state: 'none' }],
        [12, { state: 'none' }],
      ]),
      readinessFaults: new Map([[11, 'gh pr view exited 4']]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.rows[0]).toMatchObject({
      name: 'core',
      number: 11,
      readiness: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      reason: 'readiness: gh pr view exited 4',
    });
    expect(report.rows[1]).toMatchObject({ name: 'util', readiness: 'ready' });
    expect(report.counts).toEqual({ ready: 1, blocked: 0, unknown: 1 });
  });
});
