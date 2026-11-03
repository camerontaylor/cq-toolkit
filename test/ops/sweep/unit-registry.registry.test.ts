// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// registry surface and the importer's honest-refusal binding.
import { describe, expect, test } from 'vitest';
import { registry as sweepRegistry } from '../../../src/ops/sweep/registry.js';
import { bindingsFromDispatch } from '../../../src/ops/sweep/unit.js';
import { fakeFactory, VALID } from './unit-registry.helpers.js';

describe('sweep.unit registry entry (jSKJF)', () => {
  test('the sweep registry surface: five ops, sweep.unit dispatchable by name', () => {
    expect(sweepRegistry.map((entry) => entry.name)).toEqual([
      'sweep.planSweep',
      'sweep.worktreeFor',
      'sweep.unit',
      'sweep.salvage',
      'sweep.cleanup',
    ]);
  });

  test('the importer resolves and refuses dispatch inputs without driver/check config', async () => {
    const entry = sweepRegistry.find((candidate) => candidate.name === 'sweep.unit');
    expect(entry).toBeDefined();
    const op = await entry?.importer();
    expect(typeof op).toBe('function');
    // No driver config: the binding refuses, the dispatch seam folds it into
    // an honest `failed` naming the field.
    const driverless = await op?.({
      repoRoot: '/repo',
      worktreesDir: 'worktrees',
      runPrefix: 'cq/x',
      base: 'main',
      package: 'alpha',
      fixer: 'fix',
      files: [],
      check: VALID.check,
    });
    expect(driverless?.status).toBe('failed');
    expect(driverless?.status === 'failed' && driverless.error).toMatch(/no driver config/);
    // No check config: the same refusal, naming check.
    const checkless = await op?.({
      repoRoot: '/repo',
      worktreesDir: 'worktrees',
      runPrefix: 'cq/x',
      base: 'main',
      package: 'alpha',
      fixer: 'fix',
      files: [],
      driver: VALID.driver,
    });
    expect(checkless?.status).toBe('failed');
    expect(checkless?.status === 'failed' && checkless.error).toMatch(/no check config/);
    // bindingsFromDispatch itself throws (the op wraps the throw).
    const { driver: _omitted, ...driverlessInput } = VALID;
    expect(() => bindingsFromDispatch(driverlessInput, fakeFactory)).toThrow(/no driver config/);
  });
});
