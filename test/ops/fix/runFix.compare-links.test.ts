// Split provenance: test/ops/fix/runFix.test.ts was split by subject into
// runFix.compare-links.test.ts (this file), runFix.fixes-per-run.test.ts,
// runFix.composition-context.test.ts, runFix.composition-metrics.test.ts,
// runFix.pr-base.test.ts and runFix.atomic-report.test.ts.
import { describe, expect, test } from 'vitest';
import { githubCompareBaseUrl } from '../../../src/ops/fix/runFix.js';

describe('failed-attempt compare links', () => {
  test('builds an encoded GitHub comparison URL from a remote and pinned base revision', () => {
    expect(githubCompareBaseUrl('git@github.com:example/scratch.git', 'a'.repeat(40))).toBe(
      `https://github.com/example/scratch/compare/${'a'.repeat(40)}...`,
    );
  });

  test('does not invent a GitHub link for a non-GitHub remote or invalid revision', () => {
    expect(githubCompareBaseUrl('/tmp/origin.git', 'a'.repeat(40))).toBeUndefined();
    expect(githubCompareBaseUrl('https://github.com/example/scratch.git', 'HEAD')).toBeUndefined();
  });
});
