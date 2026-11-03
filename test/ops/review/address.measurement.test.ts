// Split provenance: the ADR-0008 T35 round-1 baseline tests written in
// feat/measurement-m2-review against test/ops/review/address.test.ts moved
// here when main split that file by subject; they form one subject — the
// initialOpenBlocking population the review-address report captures — so
// they stay together rather than scattering across the mechanism splits.
import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { reviewPlannedUnitsOf } from '../../../src/ops/fix/measurement.js';
import { finding, fixture, reportOf } from './address.helpers.js';
import { world } from './address-pr.helpers.js';

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
  test('a PR item stopped at the fix wall still joins the round-1 baseline', async () => {
    // The second dispatch item is stopped by the fix wall BEFORE its
    // admission, so the dispatch capture never sees it. Round 1 must merge
    // the full open-thread population anyway: the denominator is 2, not 1.
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    const w = await world(true, {
      wallMs: 8000,
      concurrency: 1,
      // T1's fix lands first; the moved clock then leaves only the final
      // re-review reserve (a quarter of the 8s wall), so T2 stops at the wall.
      afterFix: (id) => {
        if (id === 'T1') skewMs = 6100;
      },
    });
    try {
      const result = await w.run();
      const report = reportOf(result);
      expect(result.status).toBe('needs-human');
      expect(report.reasons.join(' ')).toContain('preserve final re-review wall');
      // Exactly one item was admitted and fixed…
      expect(report.fixes.map((fix) => fix.finding.id)).toEqual(['T1']);
      // …while the round-1 population holds both open threads.
      expect(report.initialOpenBlocking).toEqual(['T1', 'T2']);
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toEqual(['T1', 'T2']);
    } finally {
      clock.mockRestore();
      await w.cleanup();
    }
  });
  test('a PR admission refusal still saves the full round-1 population', async () => {
    // T1 is admitted and fixed, then T2's admission refuses. The dispatch
    // capture alone would save ['T1'] and a consumer would read 1/2; the
    // pre-dispatch seed has already recorded every open thread the run was
    // about to work, so the saved denominator stays the whole round.
    const w = await world(true, { refuseAdmissionAt: 2, concurrency: 1 });
    try {
      const result = await w.run();
      const report = reportOf(result);
      expect(result.status).toBe('needs-human');
      expect(report.reasons.join(' ')).toContain('admission refused');
      // Only T1 was dispatched and admitted…
      expect(report.fixes.map((fix) => fix.finding.id)).toEqual(['T1']);
      // …yet the saved baseline is the FULL population, not the dispatched ids.
      expect(report.initialOpenBlocking).toEqual(['T1', 'T2']);
      expect(reviewPlannedUnitsOf(report)).toEqual(['T1', 'T2']);
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toEqual(['T1', 'T2']);
    } finally {
      await w.cleanup();
    }
  });
});
