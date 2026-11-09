// Split provenance: test/ops/review/prWorktree.test.ts was split into
// prWorktree.helpers.ts (shared fixtures) and prWorktree.fetchFirst.test.ts,
// prWorktree.registryConsult.test.ts, prWorktree.scanReuse.test.ts,
// prWorktree.createPath.test.ts, prWorktree.ownership.test.ts,
// prWorktree.paths.test.ts, prWorktree.remove.test.ts,
// prWorktree.registryFile.test.ts.
//
// Shared fixtures and the fake git model (with the full pinned-behavior
// header) live in prWorktree.helpers.ts.
import { describe, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import {
  NOW,
  PR,
  LABEL,
  SHA_A,
  SHA_B,
  SHA_MAIN,
  mkModel,
  fakeGit,
  memRegistry,
  baseOpts,
} from './prWorktree.helpers.js';

// ---------------------------------------------------------------------------
// a. THE PR HEAD REF IS TRUTH
// ---------------------------------------------------------------------------

describe('fetch-first — origin branch is truth', () => {
  test('admission mismatch refuses before registry consult or stale checkout removal', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/stale/pr-7', branch: LABEL, createdAt: NOW - 1000 },
    });
    await expect(
      resolvePrWorktree({
        ...baseOpts(mkModel(), registry),
        run: fakeGit(mkModel(), calls),
        expectedHead: SHA_A,
      }),
    ).rejects.toThrow('changed since admission');
    expect(calls.map((args) => args[2])).toEqual(['rev-parse', 'fetch', 'rev-parse']);
    expect(registry.calls).toEqual([]);
    expect(registry.current()['7']?.path).toBe('/stale/pr-7');
  });
  test('the fetch runs FIRST and a fetch failure THROWS before the registry is even consulted', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/somewhere/pr-7', branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([], {
      fetchFails: { code: 128, stderr: "fatal: couldn't find remote ref refs/pull/7/head" },
    });
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/fetch origin refs\/pull\/7\/head failed.*couldn't find remote ref/s);
    // The fetch was the only thing attempted — registry untouched.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C',
      '/repo',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    expect(calls[1]).toEqual([
      '-C',
      '/repo',
      'fetch',
      'origin',
      '+refs/pull/7/head:refs/cq-review/pr-7',
    ]);
    expect(calls[1]).toEqual([
      '-C',
      '/repo',
      'fetch',
      'origin',
      '+refs/pull/7/head:refs/cq-review/pr-7',
    ]);
    expect(registry.calls).toEqual([]);
    // The pre-existing registry entry survives untouched (nothing decided).
    expect(registry.current()['7']).toBeDefined();
  });

  test('the fetched commit is NAMED: rev-parse FETCH_HEAD runs immediately after the fetch', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    // A tmpdir repoRoot: a full resolve reaches the real mkdir of the
    // worktree root, which must land somewhere writable.
    const repoRoot = await realTmpDir('cq-wt-fetchhead-');
    try {
      const model = mkModel();
      await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(calls[0]).toEqual([
        '-C',
        repoRoot,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      expect(calls[1]).toEqual([
        '-C',
        repoRoot,
        'fetch',
        'origin',
        '+refs/pull/7/head:refs/cq-review/pr-7',
      ]);
      expect(calls[2]).toEqual(['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a FORKED PR: headRefName names a branch that does NOT exist on origin — the pull-ref fetch still resolves the true head', async () => {
    const repoRoot = await realTmpDir('cq-wt-fork-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      // The contributor's branch name appears NOWHERE on origin or locally
      // (the fake fetch refuses every bare branch name) — only
      // refs/pull/7/head carries the PR's truth.
      const forkBranch = 'contributor-patch';
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }]);
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${forkBranch}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          headRefName: forkBranch,
          run: fakeGit(model, calls),
        }),
      );
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The truth came from the PULL REF, not the (nonexistent) branch name.
      expect(calls[1]).toEqual([
        '-C',
        repoRoot,
        'fetch',
        'origin',
        `+refs/pull/${PR}/head:refs/cq-review/pr-${PR}`,
      ]);
      // The local branch label was created AT the fetched sha.
      expect(model.headOf[expectedPath]).toEqual({ branch: LABEL, head: SHA_B });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an unnameable fetch (rev-parse of the PR-specific ref fails) THROWS — nothing is decided on unknown truth', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/somewhere/pr-7', branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([], {
      fetchHeadFails: { code: 128, stderr: 'fatal: ambiguous argument' },
    });
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/rev-parse refs\/cq-review\/pr-7 failed.*unnameable/s);
    // Only fetch + FETCH_HEAD ran; the registry was never consulted.
    expect(calls.map((args) => args[2])).toEqual(['rev-parse', 'fetch', 'rev-parse']);
    expect(registry.calls).toEqual([]);
    expect(registry.current()['7']).toBeDefined();
  });

  test('validation fails loud before any git invocation', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model = mkModel();
    const run = fakeGit(model, calls);
    await expect(resolvePrWorktree(baseOpts(model, registry, { pr: 0, run }))).rejects.toThrow(
      /resolvePrWorktree:/,
    );
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { headRefName: '', run })),
    ).rejects.toThrow(/resolvePrWorktree:/);
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { headRefName: '-evil', run })),
    ).rejects.toThrow(/resolvePrWorktree:/);
    expect(calls).toEqual([]);
    expect(registry.calls).toEqual([]);
  });
});
