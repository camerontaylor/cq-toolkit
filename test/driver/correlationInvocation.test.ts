import { describe, expect, it } from 'vitest';
import { correlationInvocation } from '../../src/driver/correlationInvocation.js';
import { runLadder } from '../../src/kernel/governor.js';
import { makeFixReviewItem } from '../../src/ops/review/fixReviewItem.js';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';
import type { DriverFactory, DriverRequest } from '../../src/driver/factory.js';
import type { FixReviewItemInput } from '../../src/ops/review/fixReviewItem.js';

// M5b0 nominal evidence: shared helper returns the current governed
// correlation unchanged; absent role falls back to the preserved 'fixer'
// default.
describe('correlationInvocation', () => {
  it('M5b0 nominal evidence', async () => {
    const seen: Array<ReturnType<typeof correlationInvocation>> = [];
    const correlation = { workId: 'w-1', task: 'review' } as const;
    await runLadder(
      async () => {
        seen.push(correlationInvocation({ ...correlation }));
      },
      { wallClockMs: 5000 },
      { op: 'review.fixItem', jobKey: 'j-1', attempt: 1, correlation: { ...correlation } },
    );
    expect(seen).toEqual([{ correlation: { ...correlation, role: 'fixer' } }]);

    const governed = { workId: 'w-2', role: 'critic', runId: 'r-1' } as const;
    const withRole: Array<ReturnType<typeof correlationInvocation>> = [];
    await runLadder(
      async () => {
        withRole.push(correlationInvocation({ ...governed }));
      },
      { wallClockMs: 5000 },
      { op: 'review.fixItem', jobKey: 'j-2', attempt: 1, correlation: { ...governed } },
    );
    expect(withRole).toEqual([{ correlation: { ...governed } }]);
  });

  // M5b0 missing evidence: absent context preserves the existing fallback
  // — an empty fragment, no correlation invented.
  it('M5b0 missing evidence', () => {
    expect(correlationInvocation(undefined)).toEqual({});
  });

  // M5b0 failure evidence: fixReviewItem imports the helper without
  // changing identity — under a governed dispatch whose correlation lacks
  // a role, the op's driver invocation still carries workId with the
  // 'fixer' default role.
  it('M5b0 failure evidence', async () => {
    const invocations: OpInvocation[] = [];
    const drivers: DriverFactory = {
      resolve: (_req: DriverRequest) => ({
        driver: {
          run: async (invocation: OpInvocation) => {
            invocations.push(invocation);
            const worker: WorkerResult = {
              structuredOutput: {
                disposition: 'unchanged_with_reason',
                summary: 'Already satisfied: src/a.ts line 3 already handles this case.',
                commits: [],
                evidence: [{ path: 'src/a.ts', line: 3 }],
              },
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              model: 'test-model',
            };
            return worker;
          },
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'test-provider', model: 'test-model' },
      }),
    };
    const op = makeFixReviewItem({ drivers });
    const input: FixReviewItemInput = {
      pr: 7,
      item: {
        id: 'PRRT_kwDOAbc123',
        path: 'src/a.ts',
        line: 42,
        body: 'The retry loop swallows the abort signal.',
        comments: [
          {
            authorLogin: 'reviewer',
            body: 'Also check the timeout path.',
            createdAt: '2026-09-15T10:00:00Z',
          },
        ],
      },
      worktree: { path: '/tmp/cq-fix-review/pr-7', branch: 'cq-review/pr-7' },
      driver: { model: 'test-model', provider: 'test-provider' },
    };
    const result = await runLadder(
      () => op(input),
      {},
      {
        op: 'review.fixItem',
        jobKey: 'j-fix',
        attempt: 1,
        // A correlation with NO role: the helper must supply the 'fixer'
        // default without dropping any governed field.
        correlation: { workId: 'run:j-fix:1', runId: 'run' },
      },
    );
    expect(result.outcome).toBe('completed');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.correlation).toEqual({
      workId: 'run:j-fix:1',
      runId: 'run',
      role: 'fixer',
    });
  });
});
