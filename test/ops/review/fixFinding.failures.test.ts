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
      expect(result.error).toBe('fixFinding: complete run carried no parseable fix contract');
      expect(result.error).not.toContain('store-1');
      expect(result.error).not.toContain('nonsense');
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
      expect(result.detail).toBe('fixFinding: driver aborted the run');
      expect(result.detail).not.toContain('store-1');
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
      expect(result.error).toBe('fixFinding: driver reported an error stop; errorClass=rate-limit');
      expect(result.error).not.toContain('429 with retry-after');
      expect(result.error).not.toContain('store-1');
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
      expect(result.reason).toBe(
        'fixFinding: the fix worker could not dispatch (driver resolution failed)',
      );
      expect(result.reason).not.toContain('no lane binding');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'transient' });
  });

  test('a driver run throw → needs-human / transient (no worker verdict observed)', async () => {
    const scripted = scriptedFactory([]);
    const op = makeFixFinding({ drivers: scripted.drivers });
    const result = await op(findingInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toBe('fixFinding: the driver could not dispatch the worker');
      expect(result.reason).not.toContain('scriptedFactory');
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
      if (outcome.value.status === 'indeterminate') {
        expect(outcome.value.detail).toBe('fixFinding: the driver run was cancelled');
        expect(outcome.value.detail).not.toContain('scriptedFactory');
      }
      expect(reportOf(outcome.value)).toEqual({ failureClass: 'transient' });
    }
  });

  test('a run throw carrying the invocation prompt does not leak it into the artifact', async () => {
    const marker = 'SECRET_INSTRUCTION_MARKER';
    const op = makeFixFinding({
      drivers: {
        resolve: (req) => ({
          driver: {
            run: async (invocation) => {
              throw new Error(`driver exploded: ${invocation.prompt}`);
            },
          },
          lane: 'ai-sdk',
          modelSpec: req.modelSpec,
        }),
      },
    });
    const result = await op(findingInput({ instructions: marker }));
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toBe('fixFinding: the driver could not dispatch the worker');
      expect(result.reason).not.toContain(marker);
      expect(result.reason).not.toContain('driver exploded');
    }
    expect(reportOf(result)).toEqual({ failureClass: 'transient' });
  });

  test('an error stop carrying request text exposes only the typed errorClass', async () => {
    const marker = 'SECRET_ERROR_MARKER';
    const { op } = scriptedFindingOp([
      completeWorker(undefined, {
        stopReason: 'error',
        errorClass: 'provider-error',
        error: `upstream failed: ${marker}`,
        usage: EVIDENCE,
        denials: DENIALS,
        sessionId: 'session-SECRET',
      }),
    ]);
    const result = await op(findingInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe(
        'fixFinding: driver reported an error stop; errorClass=provider-error',
      );
      expect(result.error).not.toContain(marker);
      expect(result.error).not.toContain('session-SECRET');
    }
    expect(reportOf(result)).toEqual({
      failureClass: 'exhausted',
      errorClass: 'provider-error',
      usage: EVIDENCE,
      denials: DENIALS,
      sessionId: 'session-SECRET',
    });
  });

  test('an ok result carries no report envelope', async () => {
    const { op } = scriptedFindingOp([completeWorker(UNCHANGED)]);
    const result = await op(findingInput());
    expect(result.status).toBe('ok');
    expect(Object.hasOwn(result, 'report')).toBe(false);
  });
});
