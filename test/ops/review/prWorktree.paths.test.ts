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
import { mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import {
  NOW,
  PR,
  BRANCH,
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
// Path canonicalization — the ownership boundary is symlink-proof
// ---------------------------------------------------------------------------

describe('path canonicalization — symlink-proof ownership', () => {
  test('a porcelain tree stored under the CANONICAL spelling is classified in-root (and refreshed) even when the caller spelled worktreeRoot through an alias', async () => {
    const repoRoot = await realTmpDir('cq-wt-sym-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const canonicalRoot = join(repoRoot, '.cq-review-worktrees');
      await mkdir(canonicalRoot, { recursive: true });
      // The caller's alias: a symlink to the same directory whose spelling
      // diverges from the canonical one (on macOS tmpdir() itself sits
      // behind /var → /private/var; the symlink makes the divergence
      // explicit and platform-independent).
      const aliasRoot = join(repoRoot, 'alias-link');
      await symlink(canonicalRoot, aliasRoot, 'dir');
      // The stale round-1 tree exists under the CANONICAL spelling (what
      // git/porcelain report), holding the branch at a stale sha.
      const stalePath = join(canonicalRoot, `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: LABEL, head: SHA_A },
      ]);
      const aliasPath = join(aliasRoot, `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          worktreeRoot: aliasRoot,
          run: fakeGit(model, calls),
        }),
      );
      // Canonicalization, not a raw prefix compare: the stale tree is OURS
      // (its canonical path lives inside the canonicalized root) — so it is
      // REFRESHED (removed + recreated), never misclassified as foreign and
      // never left blocking the create with a phantom branch hold.
      expect(result).toEqual({ path: aliasPath, reused: false, branch: LABEL, foreign: [] });
      expect(calls).toContainEqual(['-C', repoRoot, 'worktree', 'remove', stalePath]);
      const canonicalPath = await realpath(aliasPath);
      expect(calls.slice(-3)).toEqual([
        ['-C', repoRoot, 'worktree', 'add', '-B', LABEL, aliasPath, SHA_B],
        ['-C', canonicalPath, 'rev-parse', '--absolute-git-dir'],
        ['-C', canonicalPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ]);
      expect(registry.current()['7']?.path).toBe(await realpath(aliasPath));
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Codex threads r4-followups — cwd independence + canonical reclaim
// ---------------------------------------------------------------------------

describe('cwd independence — a RELATIVE repoRoot resolves everywhere', () => {
  test('a relative repoRoot produces ABSOLUTE -C args and an absolute worktree path (mkdir and git must not straddle two resolvers)', async () => {
    const absRepo = await realTmpDir('cq-wt-rel-');
    try {
      // The relative spelling of the absolute tmpdir repo: pathResolve(rel)
      // must land back on absRepo no matter which cwd the caller runs from.
      const rel = relative(process.cwd(), absRepo);
      const calls: string[][] = [];
      const model = mkModel([{ path: absRepo, branch: 'main', head: SHA_MAIN }]);
      const result = await resolvePrWorktree({
        repoRoot: rel,
        pr: PR,
        headRefName: 'main',
        run: fakeGit(model, calls),
        registry: memRegistry(),
        nowMs: NOW,
      });
      // The fetch rode the absolute repo root, not the relative spelling.
      const fetchArgs = calls.find((args) => args.includes('fetch'));
      expect(fetchArgs?.[1]).toBe(absRepo);
      // The create landed inside the ABSOLUTE repo's .git (never a doubled
      // rel/rel prefix, never a cwd-dependent location).
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[1]).toBe(absRepo);
      expect(addArgs?.[6]).toBe(join(absRepo, '.git', 'cq-review-worktrees', `pr-${PR}-main`));
      expect(result.path).toBe(join(absRepo, '.git', 'cq-review-worktrees', `pr-${PR}-main`));
    } finally {
      await rm(absRepo, { recursive: true, force: true });
    }
  });
});

describe('canonical reclaim — the target slot matches across spelling divergence', () => {
  test('a porcelain tree at the target slot under the CANONICAL root spelling is reclaimed even when the caller spelled worktreeRoot through an alias', async () => {
    const repoRoot = await realTmpDir('cq-wt-rc-');
    try {
      const calls: string[][] = [];
      const canonicalRoot = join(repoRoot, '.git', 'cq-review-worktrees');
      await mkdir(canonicalRoot, { recursive: true });
      const aliasRoot = join(repoRoot, 'alias-link');
      await symlink(canonicalRoot, aliasRoot, 'dir');
      // A tree parked at the PR's CURRENT target slot under the CANONICAL
      // spelling (what real git porcelain reports through a symlinked
      // tmpdir), on some OTHER branch (a branch rename left it there).
      // The caller's targetPath spells the alias; only the canonicalized
      // comparison can see that both name the same directory.
      const realCanonicalRoot = await realpath(canonicalRoot);
      const parkedPath = join(realCanonicalRoot, `pr-${PR}-main`);
      await mkdir(parkedPath, { recursive: true });
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: parkedPath, branch: 'renamed-away', head: SHA_A },
      ]);
      const result = await resolvePrWorktree({
        repoRoot,
        pr: PR,
        headRefName: 'main',
        // The caller spells the root through the alias; only canonicalization
        // can pair the alias-spelled target slot with the canonical parked
        // tree real git porcelain reports.
        worktreeRoot: aliasRoot,
        run: fakeGit(model, calls),
        registry: memRegistry(),
        nowMs: NOW,
      });
      // The parked tree was REMOVED (non-forced) and the create landed in
      // the freed slot — the raw-spelling equality would have skipped the
      // reclaim and wedged on the double-checkout refusal.
      const removeArgs = calls.find((args) => args.includes('remove'));
      expect(removeArgs?.[removeArgs.length - 1]).toBe(parkedPath);
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[6]).toBe(join(aliasRoot, `pr-${PR}-main`));
      expect(addArgs?.[7]).toBe(SHA_B);
      expect(result.reused).toBe(false);
      expect(result.path).toBe(join(aliasRoot, `pr-${PR}-main`));
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
