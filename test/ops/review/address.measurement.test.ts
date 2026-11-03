// Split provenance: the ADR-0008 T35 round-1 baseline tests written in
// feat/measurement-m2-review against test/ops/review/address.test.ts moved
// here when main split that file by subject; they form one subject — the
// initialOpenBlocking population the review-address report captures — so
// they stay together rather than scattering across the mechanism splits.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { reviewPlannedUnitsOf } from '../../../src/ops/fix/measurement.js';
import { finding, fixture, reportOf } from './address.helpers.js';

describe('review.address round-1 baseline', () => {
  test('the initial open-blocker population survives the fix that resolves it', async () => {
    const f = await fixture([finding('a')]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      await f.repo.write('.gitignore', '/.cq/\n');
      f.repo.commitAll('ignore engine state');
      let fixedHead = '';
      const result = await makeReviewAddress({
        ...realDeps,
        initialRecord: f.record(),
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (target) => {
            await f.repo.write(`src/${target.id}.ts`, 'export const fixed = 1;\n');
            fixedHead = f.repo.commitAll(`fix ${target.id}`);
            return {
              finding: { ...target, status: 'fixed' as const, reason: 'fixed' },
              reason: 'fixed',
              observedHead: fixedHead,
              commit: fixedHead,
              validation: [],
            };
          },
        }),
        review: async () => ({
          status: 'ok' as const,
          value: { ...f.record(), head: fixedHead, findings: [] },
        }),
      })({ ...f.input, rounds: 1 });
      const report = reportOf(result);
      expect(result.status, report.reasons.join(' | ')).toBe('ok');
      // The successful re-review replaced the record and emptied the
      // recomputed population…
      expect(report.findings).toEqual([]);
      expect(report.openBlocking).toEqual([]);
      // …while the population captured before the fix is unchanged, and it is
      // what a T23 measurement consumer must use as the denominator.
      expect(report.initialOpenBlocking).toEqual(['a']);
      expect(reviewPlannedUnitsOf(report)).toEqual(['a']);
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toEqual(['a']);
    } finally {
      await f.cleanup();
    }
  });
});
