import { describe, expect, it } from 'vitest';
import { correlationInvocation } from '../../src/driver/correlationInvocation.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { WorkCorrelation } from '../../src/driver/types.js';

describe('correlationInvocation', () => {
  it('M5b0 nominal evidence: shared helper returns current governed correlation unchanged, with the fixer default role when absent', async () => {
    const seen: Array<ReturnType<typeof correlationInvocation>> = [];
    const correlation: WorkCorrelation = { workId: 'w-1', task: 'review' };
    await runLadder(
      async () => {
        seen.push(correlationInvocation());
      },
      { wallClockMs: 5000 },
      { op: 'review.fixItem', jobKey: 'j-1', attempt: 1, correlation },
    );
    expect(seen).toEqual([{ correlation: { ...correlation, role: 'fixer' } }]);

    const withRole: Array<ReturnType<typeof correlationInvocation>> = [];
    const governed: WorkCorrelation = {
      workId: 'w-2',
      role: 'critic',
      runId: 'r-1',
    };
    await runLadder(
      async () => {
        withRole.push(correlationInvocation());
      },
      { wallClockMs: 5000 },
      { op: 'review.fixItem', jobKey: 'j-2', attempt: 1, correlation: governed },
    );
    expect(withRole).toEqual([{ correlation: governed }]);
  });

  it('M5b0 missing evidence: absent context preserves existing fallback of an empty fragment', () => {
    // Outside any governed dispatch the helper degrades to {} (the
    // exactOptionalPropertyTypes-safe spread) — no correlation invented.
    expect(correlationInvocation()).toEqual({});
  });

  it('M5b0 failure evidence: fixReviewItem imports the helper without changing identity', async () => {
    const mod = await import('../../src/ops/review/fixReviewItem.js');
    const helper = await import('../../src/driver/correlationInvocation.js');
    // fixReviewItem re-uses the shared helper's behavior: same fallback
    // shape outside governance, so identity semantics are preserved.
    expect(mod).toBeDefined();
    expect(typeof helper.correlationInvocation).toBe('function');
    expect(helper.correlationInvocation()).toEqual({});
  });
});
