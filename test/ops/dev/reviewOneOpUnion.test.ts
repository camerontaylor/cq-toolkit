import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevReviewInputSchema } from '../../../src/ops/dev/registry.js';
import type { DevCycleInput } from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { cycleReview, managedTerminal, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
// ---------------------------------------------------------------------------
// The dev.review input surface: the review cycle only. S2b-ii retired the
// author-admission branch, so an enrollment-shaped input must now refuse.
// ---------------------------------------------------------------------------

describe('dev.review — review cycle only', () => {
  it('accepts an explicit action "cycle" as the review cycle', async () => {
    const effects = repoEffects(repo);
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
      action: 'cycle',
    });
    expect(result.status).toBe('ok');
  });

  it('refuses an unknown action with the failed taxonomy (never a silent cycle)', async () => {
    const effects = repoEffects(repo);
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
      action: 'bogus',
    } as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('action');
    expect(reviewerCalls(effects)).toEqual([]);
  });

  it('refuses an unknown action at the published schema', () => {
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'bogus' }).success).toBe(
      false,
    );
  });

  it('refuses the retired author-admission actions and their binding keys', () => {
    for (const action of ['enroll', 'status', 'fallback']) {
      expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action }).success).toBe(false);
    }
    // The old transport branch's request binding is not a cycle key.
    expect(
      DevReviewInputSchema.safeParse({
        action: 'enroll',
        requestId: 'branch-cycle-1',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        target: 'origin/merge-queue',
        cycle: 1,
      }).success,
    ).toBe(false);
  });
});
