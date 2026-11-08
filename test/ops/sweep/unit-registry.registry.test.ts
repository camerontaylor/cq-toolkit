// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// registry surface and the importer's honest-refusal binding.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeRegistry, registry as sweepRegistry } from '../../../src/ops/sweep/registry.js';
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

  test('makeRegistry binds the deployment DriverFactoryConfig into sweep.unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sweep-registry-factory-'));
    try {
      const configured = makeRegistry({
        // 'cq-e2e' is not a default provider: only this deployment binding
        // resolves it. The dispatch therefore gets past the factory and fails
        // later on the real effects (a non-repository root), never on config.
        driverFactory: { bindings: { fixer: { 'cq-e2e': 'claude-code' } } },
      });
      const entry = configured.find((candidate) => candidate.name === 'sweep.unit');
      expect(entry).toBeDefined();
      const op = await entry?.importer();
      const result = await op?.({ ...VALID, repoRoot: root });
      expect(result?.status).not.toBe('needs-human');
      if (result?.status === 'failed')
        expect(result.error).not.toMatch(/no lane bound|unbound provider/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('dispatch wiring overrides the deployment alias-notice sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sweep-registry-alias-'));
    const deploymentNotices: string[] = [];
    const wiringNotices: string[] = [];
    try {
      const configured = makeRegistry({
        driverFactory: { onDeprecatedAlias: (message) => deploymentNotices.push(message) },
      });
      const op = await configured.find((candidate) => candidate.name === 'sweep.unit')?.importer();
      await op?.({
        ...VALID,
        repoRoot: root,
        driver: { ...VALID.driver, provider: 'ai-sdk' },
      });
      expect(deploymentNotices.some((message) => message.includes('deprecated'))).toBe(true);
      await op?.({
        ...VALID,
        repoRoot: root,
        driver: { ...VALID.driver, provider: 'ai-sdk' },
      });
      // Re-dispatch through an importer built with dispatch wiring: the host's
      // sink wins over the deployment's.
      const opWired = await configured
        .find((candidate) => candidate.name === 'sweep.unit')
        ?.importer({ onDeprecatedAlias: (message) => wiringNotices.push(message) });
      await opWired?.({
        ...VALID,
        repoRoot: root,
        driver: { ...VALID.driver, provider: 'ai-sdk' },
      });
      expect(wiringNotices.some((message) => message.includes('deprecated'))).toBe(true);
      expect(deploymentNotices).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
