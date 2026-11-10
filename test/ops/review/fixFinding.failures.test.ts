// review.fixFinding — typed non-ok mapping and the strict failure report.
//
// Pinned here:
//   1. Malformed contract → failed / evidence.
//   2. Budget stop → budget-exhausted / exhausted.
//   3. Driver aborted stop and governed cancellation → indeterminate /
//      transient.
//   4. Typed driver error stop → failed; rate-limit is transient, every other
//      structured errorClass is exhausted. No prose is inspected.
//   5. A resolve/run throw → needs-human / transient (a pre-dispatch
//      environment gap, never an owner decision).
//   6. Every non-ok report preserves the worker's usage/cost/denials/session
//      when a worker ran, and carries no transcript.
import { describe, expect, test } from 'vitest';
import { currentJobContext, runLadder } from '../../../src/kernel/governor.js';
import { makeFixFinding } from '../../../src/ops/review/fixFinding.js';
import { completeWorker, scriptedFactory, UNCHANGED } from './fixReviewItem.helpers.js';
import { findingInput, reportOf, scriptedFindingOp } from './fixFinding.helpers.js';

const EVIDENCE = { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 };
const DENIALS = [{ tool: 'bash', reason: 'denied by policy' }];

describe('review.fixFinding non-ok mapping', () => {
  test('a malformed contract → failed / evidence, with spend and session evidence', async () => {
    const { op } = scriptedFindingOp([
      completeWorker(
        { nonsense: true },
        { usage: EVIDENCE, denials: DENIALS, costUSD: 0.02, sessionId: 'store-1' },
      ),
    ]);
    const result = await op(findingInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('no parseable fix contract');
      expect(result.error).toContain('store-1');
    }
    expect(reportOf(result)).toEqual({
      failureClass: 'evidence',
      usage: EVIDENCE,
      costUSD: 0.02,
      denials: DENIALS,
      sessionId: 'store-1',
    });
  });

  test('a budget stop → budget-exhausted / exhausted, preserving the worker evidence', async () => {
    const { op } = scriptedFindingOp([
      completeWorker(undefined, {
        stopReason: 'budget',
        usage: EVIDENCE,
        denials: DENIALS,
        sessionId: 'store-1',
      }),
    ]);
    const result = await op(findingInput());
    expect(result.status).toBe('budget-exhausted');
    expect(reportOf(result)).toEqual({
      failureClass: 'exhausted',
      usage: EVIDENCE,
      denials: DENIALS,
      sessionId: 'store-1',
    });
  });

  test('a driver aborted stop → indeterminate / transient, naming the session', async () => {
    const { op } = scriptedFindingOp([
      completeWorker(undefined, {
        stopReason: 'aborted',
        usage: EVIDENCE,
        denials: DENIALS,
        sessionId: 'store-1',
      }),
    ]);
    const result = await op(findingInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('driver aborted the run');
      expect(result.detail).toContain('store-1');
    }
    expect(reportOf(result)).toEqual({
      failureClass: 'transient',
      usage: EVIDENCE,
      denials: DENIALS,
      sessionId: 'store-1',
    });
  });

  test('a rate-limit error stop → failed / transient with the typed errorClass', async () => {
    const { op } = scriptedFindingOp([
      completeWorker(undefined, {
        stopReason: 'error',
        errorClass: 'rate-limit',
        error: '429 with retry-after',
        usage: EVIDENCE,
        denials: DENIALS,
        sessionId: 'store-1',
      }),
    ]);
    const result = await op(findingInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('errorClass=rate-limit');
      expect(result.error).toContain('429 with retry-after');
    }
    expect(reportOf(result)).toEqual({
      failureClass: 'transient',
      errorClass: 'rate-limit',
      usage: EVIDENCE,
      denials: DENIALS,
      sessionId: 'store-1',
    });
  });

  test.each(['output-invalid', 'quota', 'auth', 'provider-error', 'harness', 'unknown'] as const)(
    'a %s error stop → failed / exhausted',
    async (errorClass) => {
      const { op } = scriptedFindingOp([
        completeWorker(undefined, {
          stopReason: 'error',
          errorClass,
          error: 'driver failure',
          usage: EVIDENCE,
          denials: DENIALS,
        }),
      ]);
      const result = await op(findingInput());
      expect(result.status).toBe('failed');
      expect(reportOf(result)).toEqual({
        failureClass: 'exhausted',
        errorClass,
        usage: EVIDENCE,
        denials: DENIALS,
      });
    },
  );

  test('a factory.resolve throw → needs-human / transient (a dispatch environment gap)', async () => {
    const op = makeFixFinding({
      drivers: {
        resolve: () => {
          throw new Error('no lane binding for role fixer');
        },
      },
    });
    const result = await op(findingInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('the fix worker could not dispatch');
      expect(result.reason).toContain('no lane binding for role fixer');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'transient' });
  });

  test('a driver run throw → needs-human / transient (no worker verdict observed)', async () => {
    const scripted = scriptedFactory([]);
    const op = makeFixFinding({ drivers: scripted.drivers });
    const result = await op(findingInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('driver could not dispatch the worker');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'transient' });
  });

  test('a run throw under an aborted governed signal → indeterminate / transient', async () => {
    const scripted = scriptedFactory([]);
    const op = makeFixFinding({ drivers: scripted.drivers });
    const outcome = await runLadder(
      async () => {
        const signal = currentJobContext()?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return op(findingInput());
      },
      { wallClockMs: 5, abortGraceMs: 60_000, killGraceMs: 60_000 },
      { op: 'review.fixFinding', jobKey: 'ff-abort', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') {
      expect(outcome.value.status).toBe('indeterminate');
      expect(reportOf(outcome.value)).toEqual({ failureClass: 'transient' });
    }
  });

  test('an ok result carries no report envelope', async () => {
    const { op } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput());
    expect(result.status).toBe('ok');
    expect(Object.hasOwn(result, 'report')).toBe(false);
  });
});
