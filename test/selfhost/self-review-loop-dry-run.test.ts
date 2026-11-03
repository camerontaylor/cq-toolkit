// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { afterEach, describe, expect, test } from 'vitest';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';
import {
  type RecordedCall,
  baseCfg,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  pullRow,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('runSelfReviewLoop — dry run', () => {
  test('returns empty results and NEVER calls the loop; wouldRun carries the structural summary', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    const gh = fakeGh([pullRow(7), pullRow(9, { draft: true })], {
      stateRoutes: true,
      calls: ghCalls,
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async () => {
          throw new Error('the loop must not run in dry-run mode');
        }),
      ),
      baseCfg({ journalRoot: '/j', dryRun: true }),
    );

    expect(calls).toHaveLength(0); // no loop, no worktree, no dispatch
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.dryRun).toBe(true);
    // No head-ref revalidation either: the dry run dispatches nothing, so
    // it cannot push to a stale branch and makes no single-PR reads (the
    // strict shape excludes the review-state comments/reviews routes).
    expect(ghCalls.some((line) => /^api repos\/octo\/widget\/pulls\/\d+$/.test(line))).toBe(false);
    // Dry-run mode carries NO excluded rows — the exclusions ride the
    // wouldRun lines (the real run's shape, mirrored below).
    expect(summary.excluded).toBeUndefined();
    // D11b: a dry run dispatches no fix worker, so its usage report is the
    // zeroed bookkeeping at the full (default) cap — honest zeros, not an
    // omission.
    expect(summary.usage).toEqual({
      capTokens: SelfhostDefaults.maxTokens,
      totalTokensUsed: 0,
      perPrTokens: [],
      remainingTokens: SelfhostDefaults.maxTokens,
      exhausted: false,
    });
    expect(summary.wouldRun).toEqual([
      '#7 would-run head=pr-7 threads=0 reviews=0 issueComments=0 truncated=false',
      '#9 excluded draft',
    ]);
  });

  test('a dry-run state-read failure is isolated into the wouldRun lines, never fatal', async () => {
    const calls: RecordedCall[] = [];
    // stateRoutes omitted — every review-state read fails against the
    // unrouted-argv stub, and each PR degrades to an excluded line.
    const gh = fakeGh([pullRow(7)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: '/j', dryRun: true }),
    );
    expect(summary.wouldRun?.[0]).toMatch(/^#7 excluded fetch-failed: /);
  });
});
