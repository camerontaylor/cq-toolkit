// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

describe('counts and shape', () => {
  test('counts include zeros across all three buckets', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail' }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.counts).toEqual({ ready: 1, blocked: 1, unknown: 0 });
    expect(report.runPrefix).toBe('cq/09-16a');
  });

  test('an empty fleet reports zero rows and zero counts (tracker optionally still updated)', async () => {
    const fake = fakeGh();
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [], tracker: { number: 7 } }),
    );
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ ready: 0, blocked: 0, unknown: 0 });
    expect(report.trackerUpdated).toBe(true);
    expect(fake.edits.get(7)).toContain('(no package PRs in this run)');
  });

  test('the report is plain JSON (round trip)', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail' }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
