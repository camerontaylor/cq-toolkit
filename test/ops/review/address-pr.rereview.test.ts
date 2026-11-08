import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its closure, re-review-outcome and prior-finding
// disposition tests. The shared phase-one orchestration world lives in
// address-pr.helpers.ts.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test('opt-in closure uncertainty refuses PR-thread resolution', async () => {
    const w = await world(false, { verifyClosure: true });
    try {
      const result = await w.run();
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.closureVerifications?.[0]?.verification.verdict).toBe('uncertain');
      expect(report.findings).toMatchObject([{ id: 'T1', status: 'open' }]);
      expect(report.openBlocking).toMatchObject([{ id: 'T1', status: 'open' }]);
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
      expect(w.resolved.has('T1')).toBe(false);
      expect(w.actions).not.toContain('resolve:T1');
      expect(w.reviewerCalls()).toBe(0);
    } finally {
      await w.cleanup();
    }
  });

  test.each(['failed', 'wrong-head', 'open-finding'] as const)(
    'verified PR work is retained but fresh %s re-review cannot announce clean',
    async (reviewOutcome) => {
      const w = await world(false, { reviewOutcome });
      try {
        const result = await w.run();
        expect(result.status).toBe('needs-human');
        const report = result.status === 'ok' ? result.value : result.report!;
        expect(report.fixesPerRun).toBe(1);
        expect(report.rounds).toHaveLength(1);
        expect(report.rounds[0]?.runs.length).toBeGreaterThan(0);
        expect(w.actions).toContain('push');
        expect(w.actions).not.toContain('rerequest');
        expect(report.reasons.join(' ')).toMatch(/PR re-review|round cap/);
        if (reviewOutcome === 'open-finding') {
          expect(report.rounds).toHaveLength(1);
          expect(report.rounds[0]?.runs).toHaveLength(2);
          expect(report.rounds[0]?.record.sources.map((source) => source.kind).sort()).toEqual([
            'agent',
            'pr-threads',
          ]);
          expect(w.prompts.some((p) => p.includes('agent-follow-up'))).toBe(true);
          expect(report.openBlocking.some((f) => f.id === 'agent-follow-up')).toBe(true);
        }
        expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
      } finally {
        await w.cleanup();
      }
    },
  );

  test('PR re-review carries the thread findings with their recorded dispositions', async () => {
    const w = await world();
    try {
      const result = await w.run();
      await expectOpaqueIncomplete(result, join(w.root, 'git'));
      expect(w.reviewInputs).toHaveLength(1);
      expect(w.reviewInputs[0]?.priorFindings).toEqual([
        expect.objectContaining({ id: 'T1', source: 'pr-threads', status: 'fixed' }),
      ]);
      // The whole-branch comparison and pinned base are unchanged by the addition.
      expect(w.reviewInputs[0]?.base).toMatch(/^[a-f0-9]{40}$/);
      expect(w.reviewInputs[0]?.target).toBe('main');
      expect(w.reviewInputs[0]?.reviewers).toEqual(['agent']);
    } finally {
      await w.cleanup();
    }
  });
});
