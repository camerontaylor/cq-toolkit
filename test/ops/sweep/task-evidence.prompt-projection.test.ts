// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus task-evidence.helpers.ts (shared fixtures). This file carries the retry
// prompt projection evidence.
import { expect, test } from 'vitest';
import { promptRound } from '../../../src/ops/sweep/taskLoop.js';

test('retry prompt projection excludes large baselines without mutating durable evidence', () => {
  const final = {
    tool: 'vitest',
    exitCode: 1,
    failures: [
      {
        file: 'other.test.ts',
        line: null,
        column: null,
        ruleId: null,
        message: 'LARGE_BASELINE'.repeat(1000),
        severity: 'error' as const,
      },
    ],
  };
  const round = {
    tier: 'worker' as const,
    attempt: 1,
    reason: 'regression',
    failedAttempt: { branch: 'failed', sha: 'a'.repeat(40) },
    validation: {
      verdict: 'fail' as const,
      regression: true as const,
      gates: [
        { gate: 'broader' as const, verdict: 'fail' as const, wallMs: 1, detail: 'new failure' },
      ],
      final,
    },
  };
  const baseline = { ...final, failures: [...final.failures] };
  final.failures.push({
    ...final.failures[0]!,
    file: 'novel.test.ts',
    message: 'NOVEL_DIAGNOSTIC' + 'x'.repeat(2000),
  });
  const before = JSON.stringify(round);
  const projection = promptRound(round, baseline);
  expect(JSON.stringify(projection)).not.toContain('LARGE_BASELINE');
  expect(projection?.validation?.novelFailures[0]?.message).toHaveLength(1000);
  expect(projection?.validation?.novelFailures[0]?.message).toContain('NOVEL_DIAGNOSTIC');
  expect(projection).toMatchObject({
    reason: 'regression',
    failedAttempt: round.failedAttempt,
    validation: { regression: true, verdict: 'fail', gates: round.validation.gates },
  });
  expect(JSON.stringify(round)).toBe(before);
  expect(promptRound(undefined, baseline)).toBeNull();
});
