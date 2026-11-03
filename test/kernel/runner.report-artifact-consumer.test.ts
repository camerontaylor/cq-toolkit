// runPlan report artifact consumer (#420): op report envelopes preserved
// through the journal and malformed extensions rejected. Moved verbatim from
// the pre-split test/kernel/runner.test.ts (split by subject for the 256 KiB
// review cap).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { OpResult, Plan } from '../../src/kernel/types.js';
import { entry, jobFinishes, jobInputSchema, viewWith } from './runner.helpers.js';
describe('runPlan report artifact consumer (#420)', () => {
  test('preserves reports on every status through the journal and rejects malformed extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-report-envelope-'));
    const valid = [
      { status: 'ok', value: 'clean', report: { open: [] } },
      { status: 'failed', error: 'failed gate', report: { open: ['a'] } },
      { status: 'needs-human', reason: 'round cap', report: { open: ['b'] } },
      { status: 'budget-exhausted', report: { tokens: 5 } },
      { status: 'indeterminate', detail: 'cancelled', report: { open: ['c'] } },
    ];
    const invalid = [
      { status: 'needs-human', reason: 'x', extra: 1, report: {} },
      { status: 'needs-human', reason: 'x', report: undefined },
      { status: 'failed', error: 'x', report: { x: undefined } },
      { status: 'failed', error: 'x', report: { x: NaN } },
      { status: 'failed', error: 'x', report: { x: () => 1 } },
      { status: 'failed', error: 'x', report: new Map() },
    ];
    try {
      const values = [...valid, ...invalid];
      const view = viewWith(
        entry(
          'fake',
          jobInputSchema,
          async (raw) => values[Number((raw as { jobId: string }).jobId)] as OpResult<unknown>,
        ),
      );
      const plan: Plan = {
        id: 'report-envelope',
        jobs: values.map((_, index) => ({
          id: `j${index}`,
          op: 'fake',
          input: { jobId: String(index) },
        })),
      };
      const report = await runPlan(
        plan,
        { concurrency: 2, stopOnError: false, journalDir: dir },
        view,
      );
      expect(report.jobs.slice(0, valid.length).map((row) => row.result)).toEqual(valid);
      expect(
        report.jobs
          .slice(valid.length)
          .every(
            (row) => row.result.status === 'failed' && row.result.error.includes('op contract'),
          ),
      ).toBe(true);
      const persisted = jobFinishes(await openRunLog(dir).read(report.runId));
      expect(persisted.slice(0, valid.length).map((row) => row.result)).toEqual(valid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
