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

describe('served-model assertion', () => {
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

  test('ACP may omit its observation but accepts one vendor-prefixed model', async () => {
    const absent = withServedModelAssertion(driverReturning(result(undefined)), 'acp');
    expect((await absent.run(invocation())).stopReason).toBe('complete');

    const prefixed = withServedModelAssertion(driverReturning(result('vendor/model-a')), 'acp');
    expect((await prefixed.run(invocation())).stopReason).toBe('complete');
  });

  test.each(['default', 'acp'] as const)(
    'construction path for the %s lane is wrapped',
    async (lane) => {
      const model = lane === 'acp' ? 'vendor/model-a' : 'model-a';
      const run = await withServedModelAssertion(driverReturning(result(model)), lane).run(
        invocation(),
      );
      expect(run.stopReason).toBe('complete');
    },
  );

  test('the shared construction wrapper rejects a mismatched served model', async () => {
    const wrapped = withServedModelAssertion(driverReturning(result('model-b')));
    const run = await wrapped.run(invocation());
    expect(run.stopReason).toBe('error');
  });
});
