// Shipped defaults: the reviewFixHarness the plan rides with (round-3 item
// 9) and the package surface exporting the loop wiring (item 12).
import { describe, expect, test } from 'vitest';
import { reviewFixHarness } from '../../src/ops/review/fixReviewItem.js';
import { completeWorker, defaultWorld, fixLine, NEW_SHA, runLoop } from './review-loop.helpers.js';

describe('shipped fixer harness rides the plan (round-3 item 9)', () => {
  test('the plan default IS the shipped reviewFixHarness value', () => {
    expect(reviewFixHarness.tools.bash.enabled).toBe(true);
    expect(reviewFixHarness.tools.bash.commandPatterns[0]).toBe('git add');
  });

  test('the fix job input carries the git-commit-capable harness by default', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    const job = outcome.plan.jobs[0] as {
      input: { harness: { tools: { bash: { commandPatterns: string[] } } } };
    };
    expect(job.input.harness.tools.bash.commandPatterns).toEqual([
      'git add',
      'git commit',
      'git status',
      'git diff',
      'git log',
      'git rev-parse',
    ]);
  });
});

describe('package surface (round-3 item 12)', () => {
  test('src/index.js resolves the review-loop wiring, builder, and registry entry', async () => {
    const surface = (await import('../../src/index.js')) as Record<string, unknown>;
    expect(typeof surface['runReviewLoop']).toBe('function');
    expect(typeof surface['buildReviewLoopPlan']).toBe('function');
    expect(surface['plan']).toBeDefined();
  });
});
