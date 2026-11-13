// Issue 1185 — sweep.unit's importer forwards the host's run snapshot
// (wiring.cqEnv) into createDriverFactory through factoryConfigOf, following
// the fix.run precedent (test/ops/fix/registry.test.ts). Layering: the
// per-dispatch wiring snapshot wins, then the makeRegistry deployment
// snapshot, then the ambient read. The deployment's other factory options
// (bindings/lanes) ride through every layer unchanged.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import * as factory from '../../../src/driver/factory.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeRegistry, registry as sweepRegistry } from '../../../src/ops/sweep/registry.js';

const unitEntryOf = (entries: OpRegistryEntry[]) => {
  const entry = entries.find((candidate) => candidate.name === 'sweep.unit');
  if (entry === undefined) throw new Error('sweep family: no registry entry named sweep.unit');
  return entry;
};

/** A dispatch input that fails binding AFTER the factory is constructed. */
const DRIVERLESS = {
  repoRoot: '/repo',
  worktreesDir: 'worktrees',
  runPrefix: 'cq/x',
  base: 'main',
  package: 'alpha',
  fixer: 'fix',
  files: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('sweep.unit importer driver snapshot wiring (issue 1185)', () => {
  test('dispatch-time wiring.cqEnv reaches the factory config', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      const op = (await unitEntryOf(sweepRegistry).importer({
        cqEnv,
      })) as (input: typeof DRIVERLESS) => Promise<{ status: string; error?: string }>;
      const result = await op(DRIVERLESS);
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/no driver config/);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual({ cqEnv });
    } finally {
      spy.mockRestore();
    }
  });

  test('unwired dispatch keeps the ambient read: no cqEnv key reaches the factory', async () => {
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      const op = (await unitEntryOf(sweepRegistry).importer()) as (
        input: typeof DRIVERLESS,
      ) => Promise<{ status: string }>;
      await op(DRIVERLESS);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  test('the forwarded snapshot disagrees with ambient: the factory reads the snapshot, not the room', async () => {
    const cqEnv = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    vi.stubEnv('CQ_SESSION_LOGS', 'on');
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      const op = (await unitEntryOf(sweepRegistry).importer({ cqEnv })) as (
        input: typeof DRIVERLESS,
      ) => Promise<unknown>;
      await op(DRIVERLESS);
      const captured = spy.mock.calls[0]?.[0];
      if (captured?.cqEnv === undefined)
        throw new Error('sweep.unit importer dropped wiring.cqEnv');
      expect(captured.cqEnv).toBe(cqEnv);
      expect(captured.cqEnv.values['CQ_SESSION_LOGS']).toBe('off');
      expect(process.env['CQ_SESSION_LOGS']).toBe('on');
    } finally {
      spy.mockRestore();
    }
  });

  test('makeRegistry layers the deployment snapshot under dispatch wiring, preserving bindings', async () => {
    const dispatchSnap = readCqEnv({ CQ_SESSION_LOGS: 'off' });
    const deploySnap = readCqEnv({ CQ_SESSION_LOGS: 'on' });
    const deployment = { bindings: { fixer: { 'cq-e2e': 'claude-code' } } } as const;
    const configured = makeRegistry({ driverFactory: { ...deployment }, cqEnv: deploySnap });
    const spy = vi.spyOn(factory, 'createDriverFactory');
    try {
      // Dispatch wiring wins over the deployment snapshot; bindings survive.
      const wired = (await unitEntryOf(configured).importer({ cqEnv: dispatchSnap })) as (
        input: typeof DRIVERLESS,
      ) => Promise<unknown>;
      await wired(DRIVERLESS);
      expect(spy.mock.calls[0]?.[0]).toEqual({ ...deployment, cqEnv: dispatchSnap });
      // Absent dispatch wiring, the deployment snapshot applies; bindings survive.
      spy.mockClear();
      const unwired = (await unitEntryOf(configured).importer()) as (
        input: typeof DRIVERLESS,
      ) => Promise<unknown>;
      await unwired(DRIVERLESS);
      expect(spy.mock.calls[0]?.[0]).toEqual({ ...deployment, cqEnv: deploySnap });
      // A deployment without a snapshot keeps the ambient read; bindings survive.
      spy.mockClear();
      const bare = makeRegistry({ driverFactory: { ...deployment } });
      const bareOp = (await unitEntryOf(bare).importer()) as (
        input: typeof DRIVERLESS,
      ) => Promise<unknown>;
      await bareOp(DRIVERLESS);
      const bareConfig = spy.mock.calls[0]?.[0];
      expect(bareConfig).toEqual({ ...deployment });
      expect(bareConfig !== undefined && 'cqEnv' in bareConfig).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
