// Plan-supplied clocks on the review ops are compared with the real clock
// (shared assertPlanClock): a future or invalid nowMs fails `config` before any effect.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { errorClassOf } from '../../../src/driver/errors.js';
import { registry } from '../../../src/ops/review/registry.js';
import { assertPlanClock } from '../../../src/shared/planClock.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const BAD: unknown[] = [
  4102444800123,
  Date.now() + 86_400_000,
  Number.NaN,
  -1,
  Infinity,
  'x',
  null,
];

describe('shared plan clock guard', () => {
  test('accepts a past reading, refuses the rest value-free', () => {
    expect(assertPlanClock('t', 1_700_000_000_000)).toBe(1_700_000_000_000);
    for (const bad of BAD) {
      let err: unknown;
      try {
        assertPlanClock('t', bad);
      } catch (e) {
        err = e;
      }
      expect(errorClassOf(err)).toBe('config');
      expect(String(err)).not.toContain('4102444800123');
    }
  });
});

describe('review ops with a plan nowMs', () => {
  test('review.classifyThreads refuses a future or invalid nowMs with config', async () => {
    const op = await registry.find((e) => e.name === 'review.classifyThreads')!.importer();
    for (const bad of BAD) {
      const err = await op({ state: {}, nowMs: bad } as never).catch((e: unknown) => e);
      expect(errorClassOf(err), String(bad)).toBe('config');
    }
  });

  test('review.replyAndResolve refuses a future or invalid nowMs with config before any effect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planclock-'));
    dirs.push(dir);
    const log = join(dir, 'dispatch.ndjson');
    const op = await registry.find((e) => e.name === 'review.replyAndResolve')!.importer();
    for (const bad of BAD) {
      const err = await op({
        actions: [],
        owner: 'o',
        repo: 'r',
        pr: 1,
        dispatchLogPath: log,
        nowMs: bad,
      } as never).catch((e: unknown) => e);
      expect(errorClassOf(err), String(bad)).toBe('config');
    }
    expect(existsSync(log)).toBe(false);
  });
});
