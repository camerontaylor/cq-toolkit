import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  RUNNER_PROBE,
  refusingLiveness,
  runnerLiveness,
  type ProbeRequest,
  type RunnerLivenessEffects,
} from '../../../../src/ops/crq/deploy/runnerLiveness.js';

function effects(
  reply: { code: number; stdout: string } | Error,
  seen: { runner?: string; request?: ProbeRequest } = {},
): RunnerLivenessEffects {
  return {
    root: '/srv/crq',
    runProbe: (runner, request) => {
      seen.runner = runner;
      seen.request = request;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
}
const ask = (reply: { code: number; stdout: string } | Error): Promise<string> =>
  runnerLiveness(effects(reply))('/r/run1', 'item', 'run1', true);

describe('runnerLiveness', () => {
  test('hands the runner path and the request to the probe', async () => {
    const seen: { runner?: string; request?: ProbeRequest } = {};
    const probe = runnerLiveness(effects({ code: 0, stdout: '"alive"' }, seen));
    expect(await probe('/r/run1', 'item-1', 'run-1', false)).toBe('alive');
    expect(seen.runner).toBe('/srv/crq/apps/crq-python/crq.py');
    expect(seen.request).toEqual({
      rdir: '/r/run1',
      item: 'item-1',
      run: 'run-1',
      has_exit: false,
    });
  });

  test('accepts exactly the three states', async () => {
    expect(await ask({ code: 0, stdout: '"alive"' })).toBe('alive');
    expect(await ask({ code: 0, stdout: '"harvest"\n' })).toBe('harvest');
    expect(await ask({ code: 0, stdout: '"ambiguous"' })).toBe('ambiguous');
  });

  test('everything else is ambiguous, never alive or harvest', async () => {
    expect(await ask({ code: 1, stdout: '"alive"' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: '"dead"' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: '["alive"]' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: '{"alive":1}' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: 'null' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: 'alive' })).toBe('ambiguous');
    expect(await ask({ code: 0, stdout: '' })).toBe('ambiguous');
    expect(await ask(new Error('timeout'))).toBe('ambiguous');
  });

  test('refusingLiveness proves nothing', async () => {
    expect(await refusingLiveness()).toBe('ambiguous');
  });

  test('the probe source is the Python source, byte for byte', () => {
    const python = readFileSync(
      new URL('../../../../apps/crq-python/ops/deploy-controller.py', import.meta.url),
      'utf8',
    );
    const match = /^_RUNNER_PROBE = """(.*?)"""$/ms.exec(python);
    expect(match?.[1]).toBe(RUNNER_PROBE);
  });
});
