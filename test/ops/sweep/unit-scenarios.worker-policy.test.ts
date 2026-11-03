// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import type { Driver } from '../../../src/driver/types.js';
import { bindingsFromDispatch } from '../../../src/ops/sweep/unit.js';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

describe('sweep unit in-process scenarios', () => {
  test('default unit worker can read before editing an existing file', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const seen: unknown[] = [];
    try {
      await runUnit(world, {
        driver: {
          run: async (invocation) => {
            seen.push(invocation.toolPolicy);
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        },
      });
      expect(seen).toEqual([{ allow: ['read', 'edit'], mode: 'allowlist' }]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});

test.each(['none', 'edit-only'] as const)(
  'task-specific harness never widens explicit %s policy',
  async (mode) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const seen: unknown[] = [];
    try {
      const driver: Driver = {
        run: async (invocation) => {
          seen.push(invocation.toolPolicy);
          return {
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
          };
        },
      };
      await runUnit(world, {
        taskLoop: {},
        driver,
        taskWorker: () => ({ driver, modelSpec: { provider: 'test', model: 'fake' } }),
        toolPolicy:
          mode === 'none'
            ? { mode: 'none', allow: ['read', 'edit', 'run'] }
            : { mode: 'allowlist', allow: ['edit'] },
      });
      expect(seen).toHaveLength(2);
      expect(
        seen.every(
          (policy) =>
            JSON.stringify(policy) ===
            JSON.stringify(
              mode === 'none'
                ? { allow: [], mode: 'none' }
                : { allow: ['edit'], mode: 'allowlist' },
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

// Direct SDK callers bypass the registry schema: refuse escaping check roots before resolving a driver.
test.each(['/tmp/outside', '../outside', 'nested/../../outside', 'C:\\outside'])(
  'direct dispatch refuses escaping check.cwd %s',
  (cwd) => {
    const resolve = vi.fn(() => {
      throw new Error('driver must not resolve');
    });
    expect(() =>
      bindingsFromDispatch(
        {
          repoRoot: '/repo',
          runPrefix: 'fix',
          base: 'HEAD',
          package: 'alpha',
          fixer: 'fix',
          files: [],
          driver: { provider: 'test', model: 'test', budget: { wallClockMs: 1000 } },
          check: { adapter: 'vitest-json', command: 'node', args: [], cwd },
        },
        { resolve },
      ),
    ).toThrow('check.cwd must remain inside');
    expect(resolve).not.toHaveBeenCalled();
  },
);
