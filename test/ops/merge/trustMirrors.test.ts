// Op-input mirrors of trust config (ADR-0009): a differing protectedBranch or
// baseBranch fails with a `config` error before any effect; equal or absent passes.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runPlan } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { errorClassOf } from '../../../src/driver/errors.js';
import { readCqEnv } from '../../../src/config/env.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import { safeArgs } from '../../../src/adapters/forge-github/mergeEffects.js';
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

  test('an invalid CQ_MERGE_PROTECTED_BRANCH snapshot is refused, never defaulted to main', async () => {
    const cqEnv = env({ CQ_MERGE_PROTECTED_BRANCH: 'release branch' });
    const effects = new FakeMergeEffects();
    const err = await makeRunMergePrsOp({ effects, cqEnv })({
      ...runInput,
      baseBranch: 'main',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(effects.calls).toEqual([]);
    const err2 = await makeResolveConflictOp({ effects, cqEnv })({
      pr: 1,
      repoRoot: '.',
      headBranch: 'feat/x',
      baseBranch: 'main',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err2)).toBe('config');
    const badBase = env({ CQ_MERGE_BASE_BRANCH: 'a..b' });
    const err3 = await makeRunMergePrsOp({ effects, cqEnv: badBase })({
      ...runInput,
      baseBranch: 'main',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err3)).toBe('config');
  });

  test('refs/heads/ spellings normalise to the bare name everywhere', async () => {
    const cqEnv = env({
      CQ_MERGE_PROTECTED_BRANCH: 'refs/heads/release',
      CQ_MERGE_BASE_BRANCH: 'refs/heads/trunk',
    });
    expect(cqEnv.errors).toEqual([]);
    expect(cqEnv.values['CQ_MERGE_PROTECTED_BRANCH']).toBe('release');
    expect(cqEnv.values['CQ_MERGE_BASE_BRANCH']).toBe('trunk');
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv });
    for (const protectedBranch of ['release', 'refs/heads/release']) {
      for (const baseBranch of ['trunk', 'refs/heads/trunk']) {
        expect((await op({ ...runInput, baseBranch, protectedBranch })).status).toBe('ok');
      }
    }
    await expect(
      op({ ...runInput, baseBranch: 'trunk', protectedBranch: 'main' }),
    ).rejects.toThrow();
    expect(env({ CQ_MERGE_PROTECTED_BRANCH: 'refs/heads/' }).errors).toHaveLength(1);
    // the bare destination spelling is refused once the resolved (bare) value is bound
    const resolved = cqEnv.values['CQ_MERGE_PROTECTED_BRANCH'] as string;
    expect(() =>
      safeArgs(['push', 'origin', 'HEAD:release'], { protectedBranch: resolved }),
    ).toThrow();
    expect(() =>
      safeArgs(['push', 'origin', 'HEAD:refs/heads/release'], { protectedBranch: resolved }),
    ).toThrow();
  });

  test('planMergeOrder / executeMerges dispatch: differing baseBranch fails, same or default passes', async () => {
    const plan = registry.find((e) => e.name === 'merge.planMergeOrder')!;
    const planOp = await plan.importer({ cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk' }) });
    expect(
      errorClassOf(await planOp({ baseBranch: 'main', prs: [] }).catch((e: unknown) => e)),
    ).toBe('config');
    expect(((await planOp({ baseBranch: 'trunk', prs: [] })) as { status: string }).status).toBe(
      'ok',
    );
    const exec = registry.find((e) => e.name === 'merge.executeMerges')!;
    const execOp = await exec.importer({ cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk' }) });
    const bad = await execOp({
      plan: { order: [], needsHuman: [], baseBranch: 'main' },
      repoRoot: '.',
    }).catch((e: unknown) => e);
    expect(errorClassOf(bad)).toBe('config');
    const good = (await execOp({
      plan: { order: [], needsHuman: [], baseBranch: 'trunk' },
      repoRoot: '.',
    })) as { status: string };
    expect(good.status).toBe('ok');
  });

  test('executeMerges / resolveConflict: protectedBranch same or absent passes, different fails before effects', async () => {
    const exec = registry.find((e) => e.name === 'merge.executeMerges')!;
    const op = await exec.importer({ cqEnv: env() });
    const plan = { order: [], needsHuman: [], baseBranch: 'main' };
    for (const protectedBranch of [undefined, 'main', 'refs/heads/main']) {
      const r = (await op({
        plan,
        repoRoot: '.',
        ...(protectedBranch !== undefined ? { protectedBranch } : {}),
      })) as { status: string };
      expect(r.status).toBe('ok');
    }
    expect(
      errorClassOf(
        await op({ plan, repoRoot: '.', protectedBranch: 'dev' }).catch((e: unknown) => e),
      ),
    ).toBe('config');
    const effects = new FakeMergeEffects();
    const resolve = makeResolveConflictOp({ effects, cqEnv: env() });
    const base = { pr: 1, repoRoot: '.', headBranch: 'feat/x', baseBranch: 'main' };
    // same value / absent pass the mirror (then stop at the missing modelSpec, a normal failed result)
    expect((await resolve({ ...base, protectedBranch: 'main' })).status).toBe('failed');
    expect((await resolve(base)).status).toBe('failed');
    expect(effects.calls).toEqual([]);
  });

  test('the cq merge-prs floor mirrors the host snapshot, so it passes under a non-main base', async () => {
    const { plan: floor } = await import('../../../src/plans/merge-prs.js');
    const imported = await floor.importer({
      cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk', CQ_MERGE_PROTECTED_BRANCH: 'release' }),
    });
    const input = imported.jobs[0]!.input as { baseBranch: string };
    expect(input.baseBranch).toBe('trunk');
    const op = makeRunMergePrsOp({
      effects: new FakeMergeEffects(),
      cqEnv: env({ CQ_MERGE_BASE_BRANCH: 'trunk', CQ_MERGE_PROTECTED_BRANCH: 'release' }),
    });
    expect((await op({ ...runInput, ...(input as object) } as never)).status).toBe('ok');
  });
});
