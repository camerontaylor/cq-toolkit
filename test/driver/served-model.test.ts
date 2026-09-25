import { describe, expect, test } from 'vitest';
import { withServedModelAssertion } from '../../src/driver/served-model.js';
import type { Driver, OpInvocation, WorkerResult } from '../../src/driver/types.js';

const invocation = (model = 'model-a'): OpInvocation => ({
  prompt: 'served-model test',
  modelSpec: { provider: 'test', model },
  toolPolicy: { allow: [], mode: 'none' },
  sandboxPolicy: { level: 'none' },
  budget: {},
});

const result = (
  model: string | undefined,
  stopReason: WorkerResult['stopReason'] = 'complete',
): WorkerResult => ({
  ...(model === undefined ? {} : { model }),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason,
});

const driverReturning = (value: WorkerResult): Driver => ({
  run: async () => value,
});

describe('served-model assertion wrapper unit policy', () => {
  test('default lane is fail-closed when the served model is absent or mismatched', async () => {
    const absent = withServedModelAssertion(driverReturning(result(undefined)));
    const absentResult = await absent.run(invocation());
    expect(absentResult.stopReason).toBe('error');
    expect(absentResult.error).toContain('no served model');

    const mismatch = withServedModelAssertion(driverReturning(result('model-b')));
    const mismatchResult = await mismatch.run(invocation());
    expect(mismatchResult.stopReason).toBe('error');
    expect(mismatchResult.error).toContain("requested 'model-a'");
  });

  test('ACP unit policy may omit its observation but accepts one vendor-prefixed model', async () => {
    const absent = withServedModelAssertion(driverReturning(result(undefined)), 'acp');
    expect((await absent.run(invocation())).stopReason).toBe('complete');

    const prefixed = withServedModelAssertion(driverReturning(result('vendor/model-a')), 'acp');
    expect((await prefixed.run(invocation())).stopReason).toBe('complete');
  });

  test.each(['default', 'acp'] as const)(
    '%s wrapper unit policy accepts its matching model',
    async (lane) => {
      const model = lane === 'acp' ? 'vendor/model-a' : 'model-a';
      const run = await withServedModelAssertion(driverReturning(result(model)), lane).run(
        invocation(),
      );
      expect(run.stopReason).toBe('complete');
    },
  );

  test.each([
    ['acp', 'ai-sdk/glm-5.3-flash', 'ai-sdk/glm-5.3-flash', 'complete'],
    ['acp', 'vendor/model-a', 'vendor/model-a', 'complete'],
    ['acp', 'vendor\\model-a', 'vendor\\model-a', 'complete'],
    ['acp', 'ai-sdk/glm-5.3-flash', 'vendor/ai-sdk/glm-5.3-flash', 'complete'],
    ['acp', 'ai-sdk/glm-5.3-flash', 'vendor\\ai-sdk/glm-5.3-flash', 'complete'],
    ['acp', 'ai-sdk/model-a', 'different/model-a', 'error'],
    ['acp', 'ai-sdk/model-a', 'vendor/ai-sdk/model-b', 'error'],
    ['acp', 'model-a', 'vendor/extra/model-a', 'error'],
    ['default', 'ai-sdk/model-a', 'ai-sdk/model-a', 'complete'],
    ['default', 'ai-sdk/model-a', 'vendor/ai-sdk/model-a', 'error'],
  ] as const)(
    '%s compares requested %s with observed %s before optional prefix normalization',
    async (lane, requested, observed, stopReason) => {
      const raw = { ...result(observed), structuredOutput: { success: true } };
      const verdict = await withServedModelAssertion(driverReturning(raw), lane).run(
        invocation(requested),
      );
      expect(verdict.stopReason).toBe(stopReason);
      if (stopReason === 'complete') {
        expect(verdict).toBe(raw);
      } else {
        expect(verdict.error).toContain('served model assertion');
        expect(verdict).not.toHaveProperty('structuredOutput');
      }
    },
  );

  test('the shared wrapper unit policy rejects a mismatched served model', async () => {
    const wrapped = withServedModelAssertion(driverReturning(result('model-b')));
    const run = await wrapped.run(invocation());
    expect(run.stopReason).toBe('error');
  });

  test.each([undefined, 'model-b'])(
    'rejected served model %s drops structuredOutput without mutating the driver result',
    async (model) => {
      const raw = { ...result(model), structuredOutput: { success: true } };
      const verdict = await withServedModelAssertion(driverReturning(raw)).run(invocation());
      expect(verdict.stopReason).toBe('error');
      expect(verdict.error).toContain('served model assertion');
      expect(verdict).not.toHaveProperty('structuredOutput');
      expect(raw.structuredOutput).toEqual({ success: true });
    },
  );
});
