// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the ONE fast real-git smoke (init → worktree add →
// strict-clean → prune), the literal-cache-path refusals and the REAL-git
// create→reuse round trip — the adapters' only process touch. Shared fixtures
// live in ./worktreeFor.helpers.ts.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  makeSubprocessWorktreeEffects,
  makeWorktreeFor,
} from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeEffects, WorktreeForInput } from '../../../src/adapters/git/worktreeFor.js';
import { okWorkspace } from './worktreeFor.helpers.js';

describe('subprocess worktree-effects (real git smoke)', () => {
  // Same auto-maintenance suppression as the adapter's runGit: a commit's
  // randomized background `gc --auto` inheriting these pipes would hang the
  // callback past git's own exit (the exact hang class the adapter fixes).
  // BOUNDED RETRY: some sandboxed dev environments stall child spawns
  // nondeterministically (observed ~1-in-10 here); the adapter's timeout
  // SIGKILLs a stalled git and each step retries — the ASSERTIONS are never
  // relaxed, a false result still fails the test outright.
  const GIT_CALL_TIMEOUT_MS = 6_000;
  const GIT_CALL_ATTEMPTS = 4;
  const run = (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', ...args],
        { cwd, timeout: GIT_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error(`${stderr.trim() || error.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  const resilient = async <T>(step: () => Promise<T>): Promise<T> => {
    let last: unknown;
    for (let attempt = 1; attempt <= GIT_CALL_ATTEMPTS; attempt++) {
      try {
        return await step();
      } catch (err) {
        last = err;
      }
    }
    throw last;
  };

  test('init → worktree add → strict-clean → prune, on a real repo in a tmpdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-smoke-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      mkdirSync(join(dir, 'cache'), { recursive: true });
      writeFileSync(join(dir, 'cache', 'data.txt'), 'tracked seed');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-m', 'seed tracked cache content'], dir));
      const effects = makeSubprocessWorktreeEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });

      expect(await resilient(() => effects.listBranches())).toEqual(['main']);
      expect(await resilient(() => effects.listWorktrees())).toHaveLength(1); // the checkout itself

      const wtPath = join(dir, 'wt', 'fix', 'core');
      await resilient(() =>
        effects.worktreeAdd({
          repoRoot: dir,
          path: wtPath,
          branch: 'cq/x/fix/core',
          base: 'main',
        }),
      );
      expect(await resilient(() => effects.pathExists(wtPath))).toBe(true);
      expect(await resilient(() => effects.isStrictClean(wtPath))).toBe(true);
      // jGSnx: the tracked-content query runs against the CANDIDATE
      // worktree (cwd = its root) and reads THAT index — the tracked seed
      // under the cache dir is visible from the linked worktree.
      expect(await resilient(() => effects.trackedFilesUnder(wtPath, 'cache'))).toEqual([
        'cache/data.txt',
      ]);
      const worktrees = await resilient(() => effects.listWorktrees());
      const onBranch = worktrees.find((w) => w.branch === 'cq/x/fix/core');
      expect(onBranch?.path).toMatch(/wt\/fix\/core$/);

      // An untracked file breaks the STRICT clean (porcelain non-empty).
      writeFileSync(join(wtPath, 'untracked.txt'), 'dirty');
      expect(await resilient(() => effects.isStrictClean(wtPath))).toBe(false);
      await resilient(() => effects.rmDir(wtPath));
      expect(await resilient(() => effects.pathExists(wtPath))).toBe(false);

      // A locked worktree survives prune even after its directory vanishes.
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(true);
      await resilient(() => effects.worktreePrune(dir));
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(true);
      await resilient(() => run(['-C', dir, 'worktree', 'unlock', wtPath], dir));
      await resilient(() => effects.worktreePrune(dir));
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(false);

      // Git failures reject with the stderr text (fast faults, not hangs).
      await expect(
        resilient(() => effects.isStrictClean(join(dir, 'nope')).then(() => 'ran' as const)),
      ).rejects.toThrow(/git status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test.each([':(literal)cache', 'cache[1]'])(
    'refuses eviction of tracked cache contents under the literal path %s',
    async (cacheDir) => {
      const dir = mkdtempSync(join(tmpdir(), 'worktree-literal-cache-'));
      try {
        await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
        await resilient(() => run(['config', 'user.email', 't@example.invalid'], dir));
        await resilient(() => run(['config', 'user.name', 'T'], dir));
        mkdirSync(join(dir, cacheDir));
        writeFileSync(join(dir, cacheDir, 'tracked.data'), 'tracked cache content');
        await resilient(() => run(['add', '.'], dir));
        await resilient(() => run(['commit', '-m', 'seed literal cache path'], dir));
        const effects = makeSubprocessWorktreeEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
        const op = makeWorktreeFor(effects);
        const input: WorktreeForInput = {
          repoRoot: dir,
          worktreesDir: join(dir, 'wt'),
          runPrefix: 'cq/x',
          kind: 'fix',
          slug: 'core',
          base: 'main',
        };
        const first = await resilient(() => okWorkspace(op, input));
        expect(await effects.trackedFilesUnder(first.path, cacheDir)).toEqual([
          `${cacheDir}/tracked.data`,
        ]);
        const refused = await op({ ...input, baselineCacheDirs: [cacheDir] });
        expect(refused.status).toBe('failed');
        if (refused.status === 'failed') {
          expect(refused.error).toContain('holds tracked files');
          expect(refused.error).toContain(cacheDir);
        }
        expect(existsSync(join(first.path, cacheDir, 'tracked.data'))).toBe(true);
        expect(await effects.isStrictClean(first.path)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test('REAL-git create→reuse round trip through makeWorktreeFor: second call REUSES (canonicalized paths)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-roundtrip-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      // Seed TRACKED content under a cache dir: the linked worktree will
      // carry it after checkout, so the eviction refusal (jFhPh) can be
      // exercised against a REAL candidate index.
      mkdirSync(join(dir, 'cache-dir'), { recursive: true });
      writeFileSync(join(dir, 'cache-dir', 'committed.data'), 'tracked');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-m', 'seed tracked cache content'], dir));

      let adds = 0;
      const subprocess = makeSubprocessWorktreeEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      const effects: WorktreeEffects = {
        ...subprocess,
        worktreeAdd: async (req) => {
          adds += 1;
          await subprocess.worktreeAdd(req);
        },
      };
      const op = makeWorktreeFor(effects);
      const input: WorktreeForInput = {
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        runPrefix: 'cq/x',
        kind: 'fix',
        slug: 'core',
        base: 'main',
      };
      // No origin remote exists here — the remote namespace is vacuously
      // empty (the missing-origin tolerance under test in this round).
      const first = await resilient(() => okWorkspace(op, input));
      expect(first.reused).toBe(false);
      expect(adds).toBe(1);
      // mkdtemp prefixes often carry a symlink (macOS /var → /private/var):
      // the canonical tree path is what a later comparison must match.
      const canonicalFirst = realpathSync(first.path);

      // A symlinked worktreesDir component must resolve to the SAME tree —
      // the create→reuse round trip would self-collide under lexical
      // comparison.
      symlinkSync(join(dir, 'wt'), join(dir, 'wt-link'));
      const viaLink = await resilient(() =>
        okWorkspace(op, { ...input, worktreesDir: join(dir, 'wt-link') }),
      );
      expect(viaLink.reused).toBe(true);
      expect(viaLink.path).toBe(canonicalFirst);
      expect(viaLink.requestedBase).toBe('main');
      expect(adds).toBe(1); // the second call did NOT create

      // jGSnx end-to-end: the eviction of a cache dir holding TRACKED files
      // refuses the reuse — the candidate index is queried through the
      // candidate worktree, and the tracked contents were never deleted.
      const refused = await resilient(() =>
        op({ ...input, worktreesDir: join(dir, 'wt-link'), baselineCacheDirs: ['cache-dir'] }),
      );
      expect(refused.status).toBe('failed');
      if (refused.status === 'failed') {
        expect(refused.error).toMatch(/tracked file/);
        expect(refused.error).toContain('cache-dir');
      }
      expect(adds).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
