import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
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
import { config, finding, fixture, reportOf } from './address.helpers.js';
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
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
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
  test('a blocking finding restored by source validation joins the round-1 baseline', async () => {
    // Q17b: with a coderabbit reviewer configured, hasRequiredSources runs
    // deferred-context resolution BEFORE dispatch, and that resolution mutates
    // the record — here a cached 'fixed' row with no ledger witness is
    // reopened to open. The baseline capture must see the post-restoration
    // population: the run dispatches and fixes the reopened row, so a
    // pre-restoration capture would understate the denominator it reports.
    const f = await fixture([
      finding('a'),
      { ...finding('b'), status: 'fixed' as const, reason: 'cached disposition' },
    ]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      await f.repo.write('.gitignore', '/.cq/\n');
      f.repo.commitAll('ignore engine state');
      const sources = [
        { kind: 'agent' as const, status: 'terminal' as const },
        { kind: 'coderabbit' as const, status: 'terminal' as const },
      ];
      const fixedIds: string[] = [];
      let fixedHead = '';
      const result = await makeReviewAddress({
        ...realDeps,
        config: {
          ...config,
          review: {
            ...config.review,
            reviewers: ['agent', 'coderabbit'],
            addressConcurrency: 1,
          },
        },
        resolveDeferredVendorContext: async () => undefined,
        initialRecord: { ...f.record(), sources },
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (target) => {
            fixedIds.push(target.id);
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
          value: { ...f.record(), head: fixedHead, sources, findings: [] },
        }),
      })({ ...f.input, rounds: 1 });
      const report = reportOf(result);
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      // The cached-fixed row was restored to open before dispatch…
      expect(fixedIds).toEqual(['a', 'b']);
      // …so the round-1 baseline holds both blockers the run worked, not just
      // the row that was open in the raw record.
      expect(report.initialOpenBlocking).toEqual(['a', 'b']);
      expect(reviewPlannedUnitsOf(report)).toEqual(['a', 'b']);
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toEqual(['a', 'b']);
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
  test('a non-blocking PR population seeds no round-1 baseline', async () => {
    // Every PR thread is severity 'major', so with critical-only blocking the
    // planned population contains no blockers. The pre-dispatch seed must apply
    // the same severity filter as admission and the post-fetch merge; it may
    // not record the raw plan ids.
    const w = await world(false, { blockingSeverities: ['critical'] });
    try {
      const result = await w.run();
      const report = reportOf(result);
      // The thread was planned and fixed anyway (dispatch does not filter on
      // severity), so a non-empty baseline here would be the raw plan ids.
      expect(report.fixes.map((fix) => fix.finding.id)).toEqual(['T1']);
      expect(report.initialOpenBlocking).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });
  test('an all-skipped plan with a truncated post-dispatch fetch persists no round-1 baseline', async () => {
    // The pre-merge empty-plan trap: every unresolved foreign thread is
    // skipped (the responder's own settled loop reply has the last word —
    // loop-replied-this-head), so the plan is empty and onItemsPlanned([])
    // fires. The post-dispatch fetch is then truncated, exiting needs-human
    // BEFORE the post-fetch merge. An empty seed would persist
    // initialOpenBlocking: [] — a PRESENT-empty list a measurement consumer
    // reads as known-zero while the blocking thread still exists — so the
    // field must stay ABSENT (unknown). Only the post-fetch merge and the
    // local-path capture may write a genuinely known-empty population.
    const w = await world(false, { settledLoopReplies: true, truncatePrStateFrom: 2 });
    try {
      const result = await w.run();
      const report = reportOf(result);
      expect(result.status).toBe('needs-human');
      expect(report.reasons.join(' ')).toContain('PR review source truncated');
      // The empty-plan premise itself: nothing was planned or dispatched.
      expect(report.fixes).toEqual([]);
      expect(report.initialOpenBlocking).toBeUndefined();
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toBeUndefined();
      expect('initialOpenBlocking' in persisted).toBe(false);
    } finally {
      await w.cleanup();
    }
  });
  test('a blocking agent re-review finding dispatched in round 1 joins the baseline', async () => {
    // The round-1 PR agent re-review can return a NEW blocker (the
    // open-finding fixture's agent-follow-up) that the PR path dispatches in
    // the SAME round. The population merge before the re-review saw only the
    // forge-thread population, so without a capture at the agent dispatch the
    // run works a unit the round-1 baseline never counts — reviewPlannedUnitsOf
    // understates the denominator and fixes-per-run reads inflated.
    const w = await world(false, { reviewOutcome: 'open-finding' });
    try {
      const result = await w.run();
      const report = reportOf(result);
      expect(result.status).toBe('needs-human');
      // The agent finding really was dispatched as round-1 work…
      expect(w.prompts.some((p) => p.includes('agent-follow-up'))).toBe(true);
      // …so the round-1 baseline holds the thread AND the agent finding.
      expect(report.initialOpenBlocking).toEqual(['T1', 'agent-follow-up']);
      expect(reviewPlannedUnitsOf(report)).toEqual(['T1', 'agent-follow-up']);
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        initialOpenBlocking?: string[];
      };
      expect(persisted.initialOpenBlocking).toEqual(['T1', 'agent-follow-up']);
    } finally {
      await w.cleanup();
    }
  });
});
