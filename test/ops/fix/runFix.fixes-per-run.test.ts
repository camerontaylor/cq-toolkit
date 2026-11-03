// Split provenance: test/ops/fix/runFix.test.ts was split by subject into
// runFix.compare-links.test.ts, runFix.fixes-per-run.test.ts (this file),
// runFix.composition-context.test.ts, runFix.composition-metrics.test.ts,
// runFix.pr-base.test.ts and runFix.atomic-report.test.ts.
import { describe, expect, test } from 'vitest';
import { fixesPerRunOf } from '../../../src/ops/fix/runFix.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';

const task = (outcome: FixTaskReport['outcome'], commits: string[]): FixTaskReport => ({
  task: { id: `t-${commits.join()}-${outcome}`, files: [], failures: [] },
  attempts: [],
  outcome,
  branch: 'cq/fix/static/x',
  commits,
});

describe('M1 verified-commit evidence', () => {
  test('M1 nominal evidence', () => {
    expect(fixesPerRunOf([task('fixed', ['abc123']), task('fixed', ['abc123'])])).toBe(1);
    expect(fixesPerRunOf([task('fixed', ['abc']), task('fixed', ['def'])])).toBe(2);
  });

  test('M1 missing evidence', () => {
    // The #419 sibling fixed/no-commit row resolves nothing; a non-fixed row
    // contributes nothing even when attempt evidence carries SHAs.
    expect(
      fixesPerRunOf([
        task('fixed', ['abc']),
        task('fixed', []),
        task('unfixed', []),
        task('escalated-to-human', []),
      ]),
    ).toBe(1);
  });

  test('M1 failure evidence', () => {
    // A failed run's tasks (attempted, nothing verified) count zero, and a
    // todo/never-attempted row is not distinguishable from evidence here: at
    // the FixTaskReport layer only fixed outcomes with commit SHAs count.
    expect(fixesPerRunOf([task('unfixed', []), task('unfixed', ['dropped'])])).toBe(0);
  });
});
