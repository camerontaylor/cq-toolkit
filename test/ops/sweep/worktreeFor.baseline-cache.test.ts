// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the I7 baseline-cache evidence: a reused tree has its
// configured cache dirs evicted and listed, absent ones are not, and any
// refused entry fails the reuse. Shared fixtures live in
// ./worktreeFor.helpers.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeWorktreeFor } from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeEffects } from '../../../src/adapters/git/worktreeFor.js';
import {
  BRANCH,
  effectsOf,
  failedAt,
  fakeRepo,
  INPUT,
  okWorkspace,
  PATH,
} from './worktreeFor.helpers.js';

// ---------------------------------------------------------------------------
// 4. I7 — the baseline is never cached on reuse
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor baseline-cache eviction (I7)', () => {
  const CACHES = ['.cq/baseline', 'node_modules/.cache/probe'];

  test('reuse removes the configured cache dirs present in the tree and lists them', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    repo.dirs.add(`${PATH}/.cq/baseline`); // present…
    // …`node_modules/.cache/probe` absent: it must not be removed nor listed.
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.reused).toBe(true);
    expect(workspace.clearedBaselineCaches).toEqual(['.cq/baseline']);
    expect(repo.removed).toEqual([`${PATH}/.cq/baseline`]);
  });

  test('reuse with no cache dirs present lists an empty eviction', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
  });

  test('the create path never evicts: clearedBaselineCaches is [] even when configured', async () => {
    const repo = fakeRepo();
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.reused).toBe(false);
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
  });

  test('containment: ANY refused cache entry FAILS the reuse — a stale cache is never certified (I7)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const hostile = ['../outside', '.', '/etc/tool-cache', '../wt-sibling/cache'];
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: hostile,
    });
    // The refusal fails the reuse and names EVERY refused entry…
    expect(error).toMatch(/refused baseline cache entries/);
    for (const entry of hostile) {
      expect(error).toContain(entry);
    }
    expect(error).toMatch(/clean them up manually/);
    // …and the refusal is total: nothing was deleted or even probed.
    expect(repo.removed).toHaveLength(0);
    expect(repo.calls.some((call) => call.startsWith('pathExists:'))).toBe(false);
  });

  test('a cache entry holding TRACKED files is refused — deleting would dirty the certified tree (jFhPh)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH); // files unmodified, so strict-clean PASSES…
    repo.tracked.set('.cq/baseline', ['.cq/baseline/committed.data']);
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: ['.cq/baseline'],
    });
    expect(error).toMatch(/refused baseline cache entries/);
    expect(error).toMatch(/tracked file/);
    expect(error).toContain('.cq/baseline');
    // The query ran against the CANDIDATE worktree (jGSnx) — its index,
    // not the primary's.
    expect(
      repo.calls.some((call) => call.startsWith(`trackedFilesUnder:${PATH}|.cq/baseline`)),
    ).toBe(true);
    // Refusal is total: the tracked contents were never touched.
    expect(repo.removed).toHaveLength(0);
  });

  test('a backslash-carrying cache entry is refused — posix separators only, never reinterpreted (jEXRZ)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: ['link\\cache'],
    });
    // The backslash is refused AS A BACKSLASH: on posix it is a legal
    // filename literal (converting would corrupt it) and on win32 a
    // separator (interpreting it as a literal would hide the 'link'
    // component from the intermediate-symlink guard).
    expect(error).toMatch(/refused baseline cache entries/);
    expect(error).toContain('link\\cache');
    expect(error).toMatch(/posix separators/);
    expect(repo.removed).toHaveLength(0);
  });

  test('a mixed set (legit subdir + hostile entry) also fails — partial eviction cannot precede certification', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    repo.dirs.add(`${PATH}/.cq/baseline`);
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: ['.cq/baseline', '../outside'],
    });
    expect(error).toMatch(/refused baseline cache entries/);
    expect(error).toContain('../outside');
    expect(repo.removed).toHaveLength(0);
  });

  test('an intermediate SYMLINK refuses the entry and FAILS the reuse — nothing is deleted through it', async () => {
    // REAL fs: the intermediate-symlink guard lstats actual segments.
    const dir = mkdtempSync(join(tmpdir(), 'worktree-evict-'));
    try {
      const wt = join(dir, 'wt', 'fix', 'core'); // the derived path for this input
      mkdirSync(wt, { recursive: true });
      mkdirSync(join(dir, 'outside'));
      writeFileSync(join(dir, 'outside', 'keep.txt'), 'keep');
      symlinkSync(join(dir, 'outside'), join(wt, '.cq')); // intermediate symlink
      const repo = fakeRepo();
      repo.worktrees = [{ path: wt, branch: BRANCH }];
      // The op probes strict-clean at the CANONICAL tree path (realpath'd
      // prefix) — seed the same form the comparisons will use.
      repo.clean.add(realpathSync(wt));
      const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
        ...INPUT,
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        baselineCacheDirs: ['.cq/baseline'],
      });
      expect(error).toMatch(/refused baseline cache entries/);
      expect(error).toContain('.cq/baseline');
      expect(error).toMatch(/clean them up manually/);
      expect(repo.removed).toHaveLength(0);
      // The symlink and its target are untouched.
      expect(existsSync(join(wt, '.cq'))).toBe(true);
      expect(existsSync(join(dir, 'outside', 'keep.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a FINAL-segment symlink is unlinked ITSELF, never followed (real rm)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-evict-'));
    try {
      const wt = join(dir, 'wt', 'fix', 'core');
      mkdirSync(wt, { recursive: true });
      mkdirSync(join(dir, 'outside'));
      writeFileSync(join(dir, 'outside', 'keep.txt'), 'keep');
      symlinkSync(join(dir, 'outside'), join(wt, 'cache-link')); // FINAL-segment symlink
      const canonicalWt = realpathSync(wt);
      const repo = fakeRepo();
      repo.worktrees = [{ path: wt, branch: BRANCH }];
      // The op probes strict-clean at the CANONICAL tree path (realpath'd
      // prefix) — seed the same form the comparisons will use.
      repo.clean.add(canonicalWt);
      repo.dirs.add(join(canonicalWt, 'cache-link'));
      const effects: WorktreeEffects = {
        ...effectsOf(repo),
        rmDir: async (p) => {
          repo.calls.push(`rmDir:${p}`);
          repo.removed.push(p);
          await rm(p, { recursive: true, force: true });
        },
      };
      const workspace = await okWorkspace(makeWorktreeFor(effects), {
        ...INPUT,
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        baselineCacheDirs: ['cache-link'],
      });
      expect(workspace.clearedBaselineCaches).toEqual(['cache-link']);
      expect(repo.removed).toEqual([join(canonicalWt, 'cache-link')]);
      // The LINK is gone; the target directory and its file survive.
      expect(existsSync(join(wt, 'cache-link'))).toBe(false);
      expect(existsSync(join(dir, 'outside', 'keep.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stat FAULT on a cache path is a failed result naming it — never a silent skip (I7)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      pathExists: async (p) => {
        if (p.endsWith('guarded')) {
          throw new Error(`EACCES: permission denied, stat '${p}'`);
        }
        return repo.dirs.has(p);
      },
    };
    const error = await failedAt(makeWorktreeFor(effects), {
      ...INPUT,
      baselineCacheDirs: ['node_modules/.cache/guarded'],
    });
    expect(error).toMatch(/could not check for baseline cache/);
    expect(error).toMatch(/guarded/);
    expect(repo.removed).toHaveLength(0);
  });

  test('an ABSENT cache path is still honestly skipped (absence class only)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: ['node_modules/.cache/absent'],
    });
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
  });
});
