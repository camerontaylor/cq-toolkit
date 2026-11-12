import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevReviewInputSchema, registry } from '../../../src/ops/dev/registry.js';
import type { DevCycleInput } from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { admissionInput, cycleReview, managedTerminal, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
// ---------------------------------------------------------------------------
// The ONE-op union contract: dispatch on `action`, branch strictness, and
// the byte-for-byte crq invocation.
// ---------------------------------------------------------------------------

describe('dev.review — one op discriminated on action', () => {
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

  it('the union schema refuses branch-crossing spellings', () => {
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'bogus' }).success).toBe(
      false,
    );
    // An admission action without the transport binding fields matches no branch.
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'enroll' }).success).toBe(
      false,
    );
    // A cycle-only key on the transport branch matches no branch.
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, repoRoot: '/repo' }).success).toBe(
      false,
    );
  });

  it('keeps the crq worker-transport invocation working byte-for-byte (worker-transport.md:29)', () => {
    // The exact CLI spelling from apps/crq-python/ops/worker-transport.md:29;
    // the CLI JSON-parses flag values, so --cycle=1 arrives as the number 1.
    expect(
      DevReviewInputSchema.safeParse({
        action: 'enroll',
        requestId: 'branch-cycle-1',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        target: 'origin/merge-queue',
        cycle: 1,
      }).success,
    ).toBe(true);
  });

  it('the registry admission dispatch without the ambient alias reports the configuration gap', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer();
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await op?.(admissionInput);
      expect(result).toMatchObject({ status: 'needs-human' });
      if (result !== null && typeof result === 'object' && 'reason' in result) {
        expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
      }
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });
});
