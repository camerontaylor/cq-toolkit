import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { resolveGhBin } from '../../src/adapters/forge-github/ghBin.js';
import { readCqEnv } from '../../src/config/env.js';
import { currentCqEnv, currentEntryEnv, runWithCqEnv } from '../../src/config/run-env.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWithCqEnv / currentCqEnv', () => {
  test('outside a run the fallback is a fresh read of the process env', () => {
    vi.stubEnv('CQ_SANDBOX', 'off');
    try {
      expect(currentCqEnv().values['CQ_SANDBOX']).toBe('off');
      vi.stubEnv('CQ_SANDBOX', 'required');
      expect(currentCqEnv().values['CQ_SANDBOX']).toBe('required');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('inside a run the snapshot is returned as-is, never re-read', () => {
    const snap = readCqEnv({ CQ_SANDBOX: 'off' });
    vi.stubEnv('CQ_SANDBOX', 'required');
    try {
      expect(runWithCqEnv(snap, () => currentCqEnv())).toBe(snap);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('the fallback applies only outside: it is back after a run ends', async () => {
    const snap = readCqEnv({ CQ_SANDBOX: 'off' });
    await runWithCqEnv(snap, async () => {
      await sleep(1);
      expect(currentCqEnv()).toBe(snap);
    });
    expect(currentCqEnv()).not.toBe(snap);
  });

  test('two overlapping runs with different snapshots never cross', async () => {
    const a = readCqEnv({ CQ_SANDBOX: 'off' });
    const b = readCqEnv({ CQ_SANDBOX: 'required' });
    const seen: Record<string, unknown[]> = { a: [], b: [] };
    const run = (name: string, snap: typeof a, delays: number[]): Promise<void> =>
      runWithCqEnv(snap, async () => {
        for (const delay of delays) {
          await sleep(delay);
          await Promise.resolve();
          seen[name]?.push(currentCqEnv());
        }
      });
    await Promise.all([run('a', a, [5, 1, 8, 2]), run('b', b, [2, 7, 1, 3])]);
    expect(seen['a']?.every((s) => s === a)).toBe(true);
    expect(seen['b']?.every((s) => s === b)).toBe(true);
    expect(seen['a']).toHaveLength(4);
    expect(seen['b']).toHaveLength(4);
  });

  test('a nested run overrides, then the outer snapshot is restored', async () => {
    const outer = readCqEnv({ CQ_SANDBOX: 'off' });
    const inner = readCqEnv({ CQ_SANDBOX: 'required' });
    await runWithCqEnv(outer, async () => {
      await runWithCqEnv(inner, async () => {
        await sleep(1);
        expect(currentCqEnv()).toBe(inner);
      });
      expect(currentCqEnv()).toBe(outer);
    });
  });

  test('timers, promise continuations and event emitters inherit the context', async () => {
    const snap = readCqEnv({ CQ_SANDBOX: 'off' });
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    await runWithCqEnv(snap, async () => {
      emitter.on('tick', () => seen.push(currentCqEnv()));
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          seen.push(currentCqEnv());
          resolve();
        }, 1),
      );
      await Promise.resolve().then(() => seen.push(currentCqEnv()));
      queueMicrotask(() => seen.push(currentCqEnv()));
      emitter.emit('tick');
      await sleep(1);
    });
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s === snap)).toBe(true);
  });

  test('a reader below the entry (gh binary) uses the run snapshot, not ambient', () => {
    const snap = readCqEnv({ CQ_GH_BIN: '/opt/run/gh' });
    vi.stubEnv('CQ_GH_BIN', '/opt/ambient/gh');
    try {
      expect(runWithCqEnv(snap, () => resolveGhBin())).toBe('/opt/run/gh');
      expect(resolveGhBin()).toBe('/opt/ambient/gh');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('currentEntryEnv (the run environment record)', () => {
  test('outside a run it is the live process environment', () => {
    vi.stubEnv('CQ_ENV_PROBE', 'outside');
    try {
      expect(currentEntryEnv()['CQ_ENV_PROBE']).toBe('outside');
      vi.stubEnv('CQ_ENV_PROBE', 'outside-2');
      expect(currentEntryEnv()['CQ_ENV_PROBE']).toBe('outside-2');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('inside a run it is the frozen entry record, never a live re-read', () => {
    vi.stubEnv('CQ_ENV_PROBE', 'entry');
    const owner = { CQ_ENV_PROBE: 'entry' };
    runWithCqEnv(
      readCqEnv({}),
      () => {
        vi.stubEnv('CQ_ENV_PROBE', 'drifted');
        expect(currentEntryEnv()['CQ_ENV_PROBE']).toBe('entry');
        // The record is a frozen copy, so even an in-place write cannot move it.
        expect(Object.isFrozen(currentEntryEnv())).toBe(true);
      },
      owner,
    );
    vi.unstubAllEnvs();
    // Back outside a run: the live (unfrozen) process environment applies.
    expect(Object.isFrozen(currentEntryEnv())).toBe(false);
    expect(currentEntryEnv()).toBe(process.env);
  });

  test('a nested run inherits the enclosing entry record when it supplies none', () => {
    const outer = { PATH: '/outer/bin' };
    const inner = { PATH: '/inner/bin' };
    runWithCqEnv(
      readCqEnv({}),
      () => {
        expect(currentEntryEnv()['PATH']).toBe('/outer/bin');
        runWithCqEnv(readCqEnv({}), () => expect(currentEntryEnv()['PATH']).toBe('/outer/bin'));
        runWithCqEnv(
          readCqEnv({}),
          () => expect(currentEntryEnv()['PATH']).toBe('/inner/bin'),
          inner,
        );
        expect(currentEntryEnv()['PATH']).toBe('/outer/bin');
      },
      outer,
    );
  });
});
