// Op-input mirrors of trust config (ADR-0009): a differing protectedBranch or
// baseBranch fails with a `config` error before any effect; equal or absent passes.
import { describe, expect, test } from 'vitest';
import { errorClassOf } from '../../../src/driver/errors.js';
import { readCqEnv } from '../../../src/config/env.js';
import { makeRunMergePrsOp } from '../../../src/ops/merge/runPrs.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import { registry } from '../../../src/ops/merge/registry.js';
import { FakeMergeEffects, NOW_MS } from './runPrs.helpers.js';

const env = (v: Record<string, string> = {}) => readCqEnv(v);
const runInput = { repoRoot: '.', prs: [], nowMs: NOW_MS };

describe('trust mirrors', () => {
  test('runPrs: differing protectedBranch fails (config) before any effect', async () => {
    const effects = new FakeMergeEffects();
    const op = makeRunMergePrsOp({ effects, cqEnv: env() });
    const err = await op({ ...runInput, baseBranch: 'main', protectedBranch: 'dev' }).catch(
      (e: unknown) => e,
    );
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).toContain('"dev"');
    expect(String(err)).toContain('"main"');
  });

  test('runPrs: differing baseBranch names both values and the env key', async () => {
    const op = makeRunMergePrsOp({ effects: new FakeMergeEffects(), cqEnv: env() });
    const err = await op({ ...runInput, baseBranch: 'evil' }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
    expect(String(err)).toMatch(/"evil".*CQ_MERGE_BASE_BRANCH.*"main"/);
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

  test('resolveConflict: differing protectedBranch throws config before any effect', async () => {
    const effects = new FakeMergeEffects();
    const op = makeResolveConflictOp({ effects });
    const err = await op({
      pr: 1,
      repoRoot: '.',
      headBranch: 'feat/x',
      baseBranch: 'main',
      protectedBranch: 'dev',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
  });

  test('executeMerges: differing protectedBranch throws config before any effect', async () => {
    const entry = registry.find((e) => e.name === 'merge.executeMerges')!;
    const op = await entry.importer();
    const err = await op({
      plan: { order: [], needsHuman: [], baseBranch: 'main' },
      repoRoot: '.',
      protectedBranch: 'dev',
    }).catch((e: unknown) => e);
    expect(errorClassOf(err)).toBe('config');
  });
});
