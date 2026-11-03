// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,admission,vendorBoundary,lock,m5b3Correlation}.test.ts.
import { describe, expect, test } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { fixture, reportOf } from './address.helpers.js';

describe('blocked re-review marker (#509)', () => {
  const blockedTransient = (record: FindingsRecord) => ({
    status: 'needs-human' as const,
    reason: 'review.run: not every configured reviewer completed a terminal cycle',
    report: { ...record, blockedTransient: true as const },
  });
  /** One verified fix, then a blocked re-review (with one retry for transient blocks). */
  const run = async (
    spendOnRetry: number,
    firstBlock?: 'wall' | 'tokens' | 'remaining' | 'claimed-budget',
  ) => {
    const f = await fixture();
    const realNow = Date.now;
    let clock = realNow();
    try {
      if (firstBlock === 'wall') Date.now = () => clock;
      let account: ((result: WorkerResult) => void) | undefined;
      let reviews = 0;
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: (deps) => {
          account = deps.account;
          return {
            escalation: createEscalationState,
            fix: async (finding) => ({
              finding: { ...finding, status: 'fixed', reason: 'verified' },
              commit: 'a'.repeat(40),
              observedHead: f.record().head,
              reason: 'verified',
              validation: [],
            }),
          };
        },
        review: async () => {
          reviews += 1;
          if (firstBlock === 'wall') clock += 1001;
          if (firstBlock === 'tokens')
            account?.({
              stopReason: 'error',
              usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            });
          if (reviews === 2 && spendOnRetry > 0)
            account?.({
              stopReason: 'error',
              usage: { input: spendOnRetry, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            });
          return firstBlock
            ? {
                status: 'needs-human' as const,
                reason: 'review.run: not every configured reviewer completed a terminal cycle',
                report: {
                  ...f.record(),
                  ...(firstBlock !== 'remaining' ? { blockedBudget: true as const } : {}),
                },
              }
            : blockedTransient(f.record());
        },
      })({ ...f.input, maxTokens: 100, wallMs: firstBlock === 'wall' ? 1000 : 60000, rounds: 1 });
      return { result, reviews };
    } finally {
      Date.now = realNow;
      await f.cleanup();
    }
  };

  test.each(['wall', 'tokens'] as const)(
    '#532: a non-transient re-review block after exhausting %s carries budget',
    async (budget) => {
      const { result, reviews } = await run(0, budget);
      expect(reviews).toBe(1);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).fixes).toEqual([expect.objectContaining({ commit: 'a'.repeat(40) })]);
      expect(reportOf(result).stop).toBe('budget');
      expect(reportOf(result).verifiedHead).toBe('a'.repeat(40));
    },
  );

  test.each(['remaining', 'claimed-budget'] as const)(
    '#532: a %s block with leg budget remaining has no marker',
    async (mode) => {
      const { result, reviews } = await run(0, mode);
      expect(reviews).toBe(1);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).stop).toBeUndefined();
    },
  );

  test('still blocked after the retry with a verified fix: marked rereview-blocked', async () => {
    const { result, reviews } = await run(0);
    expect(reviews).toBe(2);
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).stop).toBe('rereview-blocked');
    // #490: no re-review replaced the dispatched rows, so the fixed finding's
    // row says fixed (S7 H/K/L reported every such row 'open').
    expect(
      reportOf(result).findings.map(({ id, status, reason }) => ({ id, status, reason })),
    ).toEqual([{ id: 'a', status: 'fixed', reason: 'verified' }]);
    // …and the draft-facing blockers agree with the rows: the fixed finding
    // is no longer listed as open blocking.
    expect(reportOf(result).openBlocking).toEqual([]);
  });

  test('a retry that exhausts the token budget carries budget, never rereview-blocked', async () => {
    const { result, reviews } = await run(100);
    expect(reviews).toBe(2);
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).stop).toBe('budget');
    expect(reportOf(result).stop).not.toBe('rereview-blocked');
  });
});

test.each(['identity', 'admission', 'scan', 'thrown'] as const)(
  '#532: %s refusal coinciding with the deadline stays unmarked',
  async (mode) => {
    const f = await fixture();
    const realNow = Date.now;
    let clock = realNow();
    try {
      Date.now = () => clock;
      const record = f.record();
      const result = await makeReviewAddress({
        ...f.deps,
        initialRecord:
          mode === 'admission'
            ? {
                ...record,
                get head() {
                  clock += 1001;
                  return 'b'.repeat(40);
                },
              }
            : record,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (item) => ({
            finding: { ...item, status: 'fixed', reason: 'verified' },
            commit: record.head,
            observedHead: record.head,
            reason: 'verified',
            validation: [],
          }),
        }),
        review: async () => {
          clock += 1001;
          if (mode === 'thrown') throw new Error('unexpected reviewer fault');
          if (mode === 'scan')
            return {
              status: 'needs-human',
              reason: 'review.run: denylist scan found protected content; refusing reviewer upload',
            };
          f.repo.git('commit', '--allow-empty', '-m', 'concurrent checkout');
          return { status: 'ok', value: record };
        },
      })({ ...f.input, wallMs: 1000 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).stop).toBeUndefined();
      expect(reportOf(result).reasons.join(' ')).toMatch(
        mode === 'identity'
          ? /identity changed/
          : mode === 'admission'
            ? /does not match/
            : mode === 'scan'
              ? /protected content/
              : /unexpected reviewer fault/,
      );
    } finally {
      Date.now = realNow;
      await f.cleanup();
    }
  },
);
