import { REPO } from './prWorktree.helpers.js';
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
import { resolvePrWorktree, reviewBranchFor } from '../../../src/adapters/git/prWorktree.js';
import {
  NOW,
  PR,
  BRANCH,
  LABEL,
  SHA_B,
  SHA_MAIN,
  mkModel,
  fakeGit,
  memRegistry,
  baseOpts,
} from './prWorktree.helpers.js';

// ---------------------------------------------------------------------------
// d. Create path + sanitization
// ---------------------------------------------------------------------------

describe('create path', () => {
  test('no registry entry and no existing checkout → add -B … <expectedSha> under the DEFAULT worktreeRoot, registered, reused=false', async () => {
    const repoRoot = await realTmpDir('cq-wt-create-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([{ path: `${REPO}`, branch: 'main', head: SHA_MAIN }]);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The create rides the RESOLVED sha (not the FETCH_HEAD name): the
      // tree is pinned to the exact commit the fetch landed on.
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        expectedPath,
        SHA_B,
      ]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: LABEL, createdAt: NOW },
      });
      // The created tree sits AT the fetched sha (-B moved the branch).
      expect(model.headOf[expectedPath]).toEqual({ branch: LABEL, head: SHA_B });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an explicit worktreeRoot wins over the default', async () => {
    const repoRoot = await realTmpDir('cq-wt-root-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel();
      const explicit = join(repoRoot, 'custom-trees');
      await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, worktreeRoot: explicit, run: fakeGit(model, calls) }),
      );
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        join(explicit, `pr-${PR}-${BRANCH}`),
        SHA_B,
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('sanitize mapping: every character outside [A-Za-z0-9._-] becomes "-" — "/" can never smuggle a directory hop — and the pr-<pr>- prefix disambiguates sanitize collisions', async () => {
    const repoRoot = await realTmpDir('cq-wt-san-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel();
      await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          headRefName: 'feature/fix+42_x retest',
          run: fakeGit(model, calls),
        }),
      );
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[6]).toBe(
        join(repoRoot, '.git', 'cq-review-worktrees', 'pr-7-feature-fix-42_x-retest'),
      );
      // The create rides the RESOLVED sha.
      expect(addArgs?.[7]).toBe(SHA_B);
      // The added DIRECTORY is one path segment under the worktree root.
      expect(addArgs?.[6]?.startsWith(join(repoRoot, '.git', 'cq-review-worktrees') + '/')).toBe(
        true,
      );
      expect(
        addArgs?.[6]?.slice((join(repoRoot, '.git', 'cq-review-worktrees') + '/').length),
      ).not.toContain('/');
      // The collision rule: "feat/x" and "feat-x" sanitize to the SAME
      // segment, but each PR's directory carries its own number — two
      // branches can never share one review tree path.
      expect('feat/x'.replace(/[^A-Za-z0-9._-]/g, '-')).toBe(
        'feat-x'.replace(/[^A-Za-z0-9._-]/g, '-'),
      );
      expect('pr-1-feat-x').not.toBe('pr-2-feat-x');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an add FAILURE throws with git stderr and leaves the registry untouched', async () => {
    const repoRoot = await realTmpDir('cq-wt-addfail-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([], {
        addFails: {
          code: 128,
          stderr: `fatal: '${LABEL}' is already checked out at '/elsewhere/${LABEL}'`,
        },
      });
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(
        new RegExp(
          `worktree add -B ${LABEL}.*failed.*already checked out`.replace(/\//g, '\\/'),
          's',
        ),
      );
      expect(registry.calls).toEqual(['load']); // load happened, save NEVER did
      expect(registry.current()).toEqual({});
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PR-keyed branch labels — two PRs sharing a headRefName never collide
// ---------------------------------------------------------------------------

describe('PR-keyed branch labels', () => {
  test('PR 7 and PR 9 both headRefName "main": distinct labels, distinct paths, no cross-claim', async () => {
    const repoRoot = await realTmpDir('cq-wt-two-');
    try {
      const registry = memRegistry();
      // PR 7 resolves first: its label is cq-review/pr-7, its path pr-7-main.
      const model = mkModel([{ path: `${REPO}`, branch: 'main', head: SHA_MAIN }]);
      const r7 = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, headRefName: 'main', run: fakeGit(model) }),
      );
      const path7 = join(repoRoot, '.git', 'cq-review-worktrees', 'pr-7-main');
      expect(r7).toEqual({ path: path7, reused: false, branch: reviewBranchFor(7), foreign: [] });
      // PR 9 — the SAME headRefName — must neither claim nor remove PR 7's
      // tree: the label is pr-keyed, so PR 7's tree can never read as PR 9's.
      const r9 = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, pr: 9, headRefName: 'main', run: fakeGit(model) }),
      );
      const path9 = join(repoRoot, '.git', 'cq-review-worktrees', 'pr-9-main');
      expect(r9).toEqual({ path: path9, reused: false, branch: reviewBranchFor(9), foreign: [] });
      // One registry, two keys, two different paths — the two-keys-one-path
      // confusion is gone because the labels are pr-keyed.
      expect(registry.current()['7']).toEqual({
        path: path7,
        branch: reviewBranchFor(7),
        createdAt: NOW,
      });
      expect(registry.current()['9']).toEqual({
        path: path9,
        branch: reviewBranchFor(9),
        createdAt: NOW,
      });
      // PR 7's tree still stands, untouched, on its own label.
      expect(
        model.worktrees.some((wt) => wt.path === path7 && wt.branch === reviewBranchFor(7)),
      ).toBe(true);
      expect(
        model.worktrees.some((wt) => wt.path === path9 && wt.branch === reviewBranchFor(9)),
      ).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
