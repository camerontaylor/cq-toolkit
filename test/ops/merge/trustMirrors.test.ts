// Op-input mirrors of trust config (ADR-0009): a differing protectedBranch or
// baseBranch fails with a `config` error before any effect; equal or absent passes.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { errorClassOf } from '../../../src/driver/errors.js';
import { readCqEnv } from '../../../src/config/env.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import { registry } from '../../../src/ops/merge/registry.js';
import { buildRunInput, recheckedRegistryView } from '../../../src/selfhost/self-merge-prs.js';
import { FakeMergeEffects, NOW_MS } from './runPrs.helpers.js';

const env = (v: Record<string, string> = {}) => readCqEnv(v);
const runInput = { repoRoot: '.', prs: [], nowMs: NOW_MS };

afterEach(() => vi.unstubAllEnvs());

describe('trust mirrors', () => {
  test('runPlan forwards its snapshot to the production merge importer', async () => {
    vi.stubEnv('CQ_MERGE_BASE_BRANCH', 'main');
    vi.stubEnv('CQ_MERGE_PROTECTED_BRANCH', 'main');
    const entry = registry.find((e) => e.name === 'merge.runPrs')!;
    const report = await runPlan(
      {
        id: 'trust-snapshot',
        jobs: [
          {
            id: 'merge',
            op: entry.name,
            input: {
              ...runInput,
              baseBranch: 'trunk',
              protectedBranch: 'release',
            },
          },
        ],
      },
      {
        concurrency: 1,
        stopOnError: false,
        cqEnv: env({
          CQ_MERGE_BASE_BRANCH: 'trunk',
          CQ_MERGE_PROTECTED_BRANCH: 'release',
        }),
      },
      { get: () => entry as unknown as OpRegistryEntry<never, never> },
    );
    expect(report.jobs[0]?.result.status).toBe('ok');
  });

  test('self-host queue defaults to snapshot and ambient base config', () => {
    vi.stubEnv('CQ_MERGE_BASE_BRANCH', 'deliver');
    expect(
      buildRunInput(
        [],
        {
          repoRoot: '.',
          disableConflictResolution: true,
          cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk' }),
        },
        NOW_MS,
      ).baseBranch,
    ).toBe('trunk');
    expect(
      buildRunInput(
        [],
        {
          repoRoot: '.',
          disableConflictResolution: true,
        },
        NOW_MS,
      ).baseBranch,
    ).toBe('deliver');
  });

  test('self-host input resolves ambient protected branch without a supplied snapshot', () => {
    vi.stubEnv('CQ_MERGE_PROTECTED_BRANCH', 'release');
    const input = buildRunInput([], { repoRoot: '.', disableConflictResolution: true }, NOW_MS);
    expect(input.protectedBranch).toBe('release');
  });

  test('runPrs: differing protectedBranch fails (config) before any effect', async () => {
    const effects = new FakeMergeEffects();
    const op = makeRunMergePrsOp({ effects, cqEnv: env() });
    const err = await op({ ...runInput, baseBranch: 'main', protectedBranch: 'dev' }).catch(
      (e: unknown) => e,
    );
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).toMatch(/"dev".*CQ_MERGE_PROTECTED_BRANCH.*"main"/);
    expect(effects.calls).toEqual([]);
  });

  test('runPrs: CQ_MERGE_PROTECTED_BRANCH is the only way to a non-main protected branch', async () => {
    const cqEnv = env({ CQ_MERGE_PROTECTED_BRANCH: 'release' });
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv });
    expect((await op({ ...runInput, baseBranch: 'main', protectedBranch: 'release' })).status).toBe(
      'ok',
    );
    await expect(op({ ...runInput, baseBranch: 'main', protectedBranch: 'main' })).rejects.toThrow(
      /CQ_MERGE_PROTECTED_BRANCH/,
    );
  });

  test('runPrs: differing baseBranch names both values and the env key, no effect', async () => {
    const effects = new FakeMergeEffects();
    const op = makeRunMergePrsOp({ effects, cqEnv: env() });
    const err = await op({ ...runInput, baseBranch: 'evil' }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).toMatch(/"evil".*CQ_MERGE_BASE_BRANCH.*"main"/);
    expect(effects.calls).toEqual([]);
  });

  test('runPrs: baseBranch compares against CQ_MERGE_BASE_BRANCH when set', async () => {
    const cqEnv = env({ CQ_MERGE_BASE_BRANCH: 'trunk' });
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv });
    expect((await op({ ...runInput, baseBranch: 'trunk' })).status).toBe('ok');
    await expect(op({ ...runInput, baseBranch: 'main' })).rejects.toThrow(/CQ_MERGE_BASE_BRANCH/);
  });

  test('runPrs: same or absent protectedBranch passes', async () => {
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv: env() });
    expect((await op({ ...runInput, baseBranch: 'main', protectedBranch: 'main' })).status).toBe(
      'ok',
    );
    expect((await op({ ...runInput, baseBranch: 'main' })).status).toBe('ok');
  });

  test('the echoed plan value is truncated', async () => {
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv: env() });
    const err = await op({ ...runInput, baseBranch: 'x'.repeat(500) }).catch((e: unknown) => e);
    expect(String(err).length).toBeLessThan(400);
  });

  test('resolveConflict: differing protectedBranch throws config before any effect', async () => {
    const effects = new FakeMergeEffects();
    const op = makeResolveConflictOp({ effects, cqEnv: env() });
    const err = await op({
      pr: 1,
      repoRoot: '.',
      headBranch: 'feat/x',
      baseBranch: 'main',
      protectedBranch: 'dev',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(effects.calls).toEqual([]);
  });

  test('executeMerges (JSON dispatch route): schema-valid differing protectedBranch throws config', async () => {
    const entry = registry.find((e) => e.name === 'merge.executeMerges')!;
    const input = entry.inputSchema.parse({
      plan: { order: [], needsHuman: [], baseBranch: 'main' },
      repoRoot: '.',
      protectedBranch: 'dev',
    });
    const op = await entry.importer();
    expect(errorClassOf(await op(input).catch((e: unknown) => e))).toBe('config');
  });

  test('runPrs (JSON dispatch route): schema-valid plan data with a different baseBranch throws config', async () => {
    const entry = registry.find((e) => e.name === 'merge.runPrs')!;
    const input = entry.inputSchema.parse({ baseBranch: 'evil', repoRoot: '.', prs: [] });
    const op = await entry.importer();
    expect(errorClassOf(await op(input).catch((e: unknown) => e))).toBe('config');
  });

  test('self-host gated view: passes cfg.cqEnv, refuses a differing baseBranch before any effect', async () => {
    const effects = new FakeMergeEffects();
    const merge = registry.find((e) => e.name === 'merge.runPrs')!;
    const view = recheckedRegistryView({
      baseView: {
        get: (n) =>
          n === 'merge.runPrs' ? (merge as unknown as OpRegistryEntry<never, never>) : undefined,
      },
      innerEffects: effects,
      cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk' }),
      recheck: async () => ({ ok: false, reason: 'unused' }),
    });
    const op = (await view.get('merge.runPrs')!.importer()) as unknown as (
      i: unknown,
    ) => Promise<{ status: string }>;
    await expect(op({ ...runInput, baseBranch: 'main' })).rejects.toThrow(/CQ_MERGE_BASE_BRANCH/);
    expect(effects.calls).toEqual([]);
    expect((await op({ ...runInput, baseBranch: 'trunk' })).status).toBe('ok');
  });
});
