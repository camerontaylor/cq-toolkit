// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the op factory end-to-end: the default empty run and the
// drivers/harnessConfig thread-through.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
import {
  baseInput,
  conflicting,
  FakeMergeEffects,
  fakeDrivers,
  MODEL_SPEC,
  NOW_MS,
  ZERO_USAGE,
} from './runPrs.helpers.js';
import { scanClean } from './resolveConflict.helpers.js';

describe('runMergePrs', () => {
  test('the default op completes an empty run end to end — zero processes, zero driver runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runprs-empty-'));
    try {
      const runs: OpInvocation[] = [];
      const driver: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          runs.push(invocation);
          return { usage: ZERO_USAGE, denials: [], stopReason: 'complete' };
        },
      };
      const op = makeRunMergePrsOp({ drivers: fakeDrivers(driver) });

      const result = await op({ baseBranch: 'main', repoRoot: dir, prs: [], nowMs: NOW_MS });

      expect(result).toEqual({
        status: 'ok',
        value: {
          firstPass: { merged: [], retargeted: [], stale: [], failed: [], blocked: [] },
          secondPass: null,
          resolutions: [],
          needsHuman: [],
          diagnosis: {
            summary:
              'merge run: 0 merged, 0 retargeted, 0 need a human (state_drift: 0, merge_rejected: 0, blocked_by_ancestor: 0)',
            needsHuman: [],
            causes: [],
          },
        },
      });
      // Nothing conflicted, so the resolve path — and the driver behind it
      // — never ran.
      expect(runs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('makeRunMergePrsOp threads drivers + harnessConfig and dispatches identically (the harness rides the DriverRequest)', async () => {
    // Mirror of resolveConflict.factory-resolution.test.ts's
    // factory-resolution test. With a
    // FAKE factory injected the harnessConfig is observable only as data
    // on the captured DriverRequest (the live proof of a config's effect
    // is F5's scripted-agent path through a factory bound to the fixture
    // lane). Behaviorally: a dispatch with a harnessConfig present behaves
    // identically — the conflicting pr is dispatched, the acted
    // self-report is verified against a MOVING head, and the resolution
    // lands; and the op binds with the config alone (an empty run
    // dispatches nothing).
    const dir = await mkdtemp(join(tmpdir(), 'runprs-harness-'));
    try {
      const effects = new FakeMergeEffects();
      // The publication gate (#1193) reads the resolution from the
      // prepared worktree's branch; the fake answers a MOVED sha there by
      // default (the fake's resolutionSha), so the commit claim verifies.
      const runs: OpInvocation[] = [];
      const driver: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          runs.push(invocation);
          return {
            model: invocation.modelSpec.model,
            structuredOutput: { decision: 'acted', summary: 'config rode along' },
            usage: ZERO_USAGE,
            denials: [],
            stopReason: 'complete',
          };
        },
      };
      const factory = fakeDrivers(driver);
      const op = makeRunMergePrsOp({
        effects,
        drivers: factory,
        harnessConfig: defaultHarnessConfig,
        scan: scanClean,
      });
      const result = await op({
        ...baseInput([conflicting(45)], MODEL_SPEC),
        repoRoot: dir,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected an ok result');
      expect(result.value.resolutions).toEqual([
        { pr: 45, decision: 'acted', summary: 'config rode along' },
      ]);
      expect(runs).toHaveLength(1);
      // The resolve op resolved ONE request through the factory, carrying
      // the conflict-resolver role and the harness dep.
      expect(factory.requests).toHaveLength(1);
      expect(factory.requests[0]?.role).toBe('conflict-resolver');
      expect(factory.requests[0]?.harness).toBe(defaultHarnessConfig);

      // Build-only: the config alone binds fine (an empty run dispatches
      // nothing).
      const empty = makeRunMergePrsOp({ harnessConfig: defaultHarnessConfig });
      const emptyResult = await empty({
        baseBranch: 'main',
        repoRoot: dir,
        prs: [],
        nowMs: NOW_MS,
      });
      expect(emptyResult.status).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
