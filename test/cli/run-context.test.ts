// The CLI's direct-op path runs the op inside the entry's CqEnv snapshot
// (ADR-0009 resolve once): currentCqEnv() below the entry is that snapshot.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { capture, opsRoot } from './i1-helpers.js';

const entered: unknown[] = [];
vi.mock('../../src/registry/entry-env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/registry/entry-env.js')>();
  return {
    ...real,
    runWithCqEnv: ((cqEnv: unknown, fn: () => unknown) => {
      entered.push(cqEnv);
      return real.runWithCqEnv(cqEnv as never, fn as never);
    }) as typeof real.runWithCqEnv,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  entered.length = 0;
});

describe('CLI direct dispatch', () => {
  test('the op is entered with the entry snapshot', async () => {
    vi.stubEnv('CQ_SANDBOX', 'off');
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(0);
    expect(entered).toHaveLength(1);
    const snapshot = entered[0] as {
      values: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(snapshot.values['CQ_SANDBOX']).toBe('off');
    expect(snapshot.sources['CQ_SANDBOX']).toBe('env');
  });
});
