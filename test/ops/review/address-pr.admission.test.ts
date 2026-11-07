// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its admission and retention-refusal tests. The shared
// phase-one orchestration world lives in address-pr.helpers.ts.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test('PR admission refusal retains an existing prerequisite cause', async () => {
    const reason = 'baseline precondition failed: dependency metadata differs';
    const w = await world(false, { refuseAdmissionAt: 1, admissionPrecondition: reason });
    try {
      const result = await w.run();
      expect(result.status).toBe('needs-human');
      expect(result.status === 'needs-human' && result.reason).toContain(reason);
      expect(w.reviewerCalls()).toBe(0);
    } finally {
      await w.cleanup();
    }
  });

  test.each(['initial-refusal', 'sibling-refusal', 'snapshot-failure'] as const)(
    'settled PR run retention survives %s',
    async (mode) => {
      const w = await world(mode === 'sibling-refusal', {
        ...(mode === 'snapshot-failure'
          ? { postFixSnapshotFailure: true }
          : { refuseAdmissionAt: mode === 'initial-refusal' ? 1 : 2 }),
      });
      try {
        const result = await w.run();
        expect(result.status).toBe('needs-human');
        const report = result.status === 'ok' ? result.value : result.report!;
        expect(report.reasons.join(' ')).toMatch(
          mode === 'snapshot-failure' ? /scripted post-fix snapshot failure/ : /admission refused/,
        );
        expect(w.reviewerCalls()).toBe(0);
        if (mode === 'initial-refusal') {
          expect(w.prompts).toEqual([]);
          expect(report.rounds).toEqual([]);
        } else {
          expect(report.fixes.map((fix) => fix.finding.id)).toEqual(['T1']);
          expect(report.rounds).toHaveLength(1);
          expect(report.rounds[0]?.record.findings).toMatchObject([{ id: 'T1' }]);
          expect(report.rounds[0]?.runs).toHaveLength(1);
          const jobs = report.rounds[0]!.runs[0]!.jobs;
          expect(jobs).toHaveLength(mode === 'sibling-refusal' ? 2 : 1);
          expect(jobs[0]?.result.status).toBe('ok');
          if (mode === 'sibling-refusal') expect(jobs[1]?.result.status).toBe('failed');
        }
        const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
          version?: unknown;
        };
        // ADR-0005 decision 10: the persisted report envelope always declares v1.
        expect(persisted.version).toBe(1);
        expect(persisted).toEqual(report);
      } finally {
        await w.cleanup();
      }
    },
  );

  test('a budget stop before PR re-review retains the settled run and dispatched findings', async () => {
    const w = await world(false, { runBudget: 9 });
    try {
      const result = await w.run();
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(w.reviewerCalls()).toBe(0);
      expect(report.reasons.join(' ')).toMatch(/budget/);
      expect(report.rounds).toHaveLength(1);
      expect(report.rounds[0]?.runs).toHaveLength(1);
      expect(report.rounds[0]?.record.findings).toMatchObject([{ id: 'T1' }]);
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    } finally {
      await w.cleanup();
    }
  });
});
