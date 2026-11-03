// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// budget and cancellation tests.
import { describe, expect, it } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('returns budget-exhausted before planning or driver resolution for zero allowance', async () => {
    const fake = fakeDrivers();
    expect((await runAgentReviewer(fake.drivers, reviewerInput({ maxTokens: 0 }))).status).toBe(
      'budget-exhausted',
    );
    expect(fake.resolveDriver).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('does not dispatch when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const fake = fakeDrivers();
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({ signal: controller.signal }),
    );
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'agent review cancelled before dispatch',
    });
    expect(fake.resolveDriver).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('cancels an active driver at the wall deadline and keeps an immutable no-delivery snapshot', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fake = fakeDrivers({
      skipHook: true,
      run: async (_invocation, options) => {
        receivedSignal = options?.signal;
        return new Promise<WorkerResult>(() => undefined);
      },
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput({ wallMs: 20 }));
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ report: { budgetExhausted: true } });
    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      report: { coverage: { pieces: [{ state: 'planned' }], sessions: [{ status: 'aborted' }] } },
    });
  });

  it('relays parent job cancellation to the active driver', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fake = fakeDrivers({
      skipHook: true,
      run: async (_invocation, options) => {
        receivedSignal = options?.signal;
        controller.abort(new Error('parent cancelled'));
        return new Promise<WorkerResult>(() => undefined);
      },
    });
    const outcome = await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput({ signal: controller.signal })),
      { wallClockMs: 1_000, abortGraceMs: 50, killGraceMs: 50 },
      { op: 'review.run', jobKey: 'review-cancel', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') {
      expect(outcome.value.status).toBe('needs-human');
      expect(outcome.value).toMatchObject({ report: { cancelled: true } });
      expect(outcome.value).not.toMatchObject({ report: { budgetExhausted: true } });
    }
    expect(receivedSignal?.aborted).toBe(true);
  });
});
