// Managed reviews never retry a paid attempt implicitly. Queue workers own
// provider backoff; authors receive a refusal or a receipt and choose a repeat.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { managedBlocked, managedRefused, managedTerminal, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';
let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
describe('managed CodeRabbit retry ownership', () => {
  test.each(['rate_limit', 'auth', 'billing', 'cancelled'])(
    '%s never starts a local CLI or implicitly repeats',
    async (reason) => {
      const effects = repoEffects(repo);
      const submit = vi.fn(managedBlocked(reason));
      const sleep = vi.fn(async () => undefined);
      const result = await makeDevReview({
        effects,
        scanSecrets: stubScanner(),
        managedSubmit: submit,
        sleep,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result).toMatchObject({ reason: expect.stringContaining(reason) as unknown });
      expect(submit).toHaveBeenCalledOnce();
      expect(reviewerCalls(effects)).toHaveLength(0);
      expect(sleep).not.toHaveBeenCalled();
      expect(effects.openLedger('feature/x').load().records).toHaveLength(1);
    },
  );
  test('delivery uncertainty preserves retry classification without claiming a verdict', async () => {
    const effects = repoEffects(repo);
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      managedSubmit: managedRefused('delivery unknown', true),
    })({ repoRoot: repo.root });
    expect(result).toMatchObject({ status: 'needs-human', report: { transient: true } });
    expect(effects.openLedger('feature/x').load().records).toHaveLength(0);
  });
  test('a scan hit prevents queue admission', async () => {
    const effects = repoEffects(repo);
    const submit = vi.fn(managedTerminal([]));
    const result = await makeDevReview({
      effects,
      scanSecrets: async (components) =>
        components.map(({ component }) => ({ component, hits: [{ ruleId: 'deny', lines: [1] }] })),
      managedSubmit: submit,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(submit).not.toHaveBeenCalled();
    expect(reviewerCalls(effects)).toHaveLength(0);
  });
});
