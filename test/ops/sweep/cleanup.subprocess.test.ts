// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// subprocess adapter against REAL git (the dirty-refusal backstop,
// PR 156 r1 D).
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSubprocessCleanupEffects } from '../../../src/adapters/git/cleanup.js';

// ---------------------------------------------------------------------------
// 8. The subprocess adapter against REAL git (the dirty-refusal backstop,
//    PR 156 r1 D)
// ---------------------------------------------------------------------------

describe('subprocess cleanup effects (real git smoke)', () => {
  // Same auto-maintenance suppression and BOUNDED RETRY as the
  // worktreeFor.real-git.test.ts real-git idiom: the assertions are never relaxed,
  // a stalled spawn retries instead.
  const GIT_CALL_TIMEOUT_MS = 6_000;
  const GIT_CALL_ATTEMPTS = 4;
  const run = (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
        { cwd, timeout: GIT_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error(stderr.trim() || error.message));
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

  test('init → worktree add → dirty: plain remove REJECTED by git → --force succeeds → branchTimeMs parses → branch -D works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-smoke-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      mkdirSync(join(dir, 'seed'), { recursive: true });
      writeFileSync(join(dir, 'seed', 'data.txt'), 'tracked');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-m', 'seed tracked content'], dir));
      const wtPath = join(dir, 'wt', 'fix', 'core');
      await resilient(() =>
        run(['-C', dir, 'worktree', 'add', '-b', 'cq/x/fix/core', wtPath, 'main'], dir),
      );
      // Sweep locks active worktrees; a failed removal must restore that lock.
      await resilient(() => run(['-C', dir, 'worktree', 'lock', wtPath], dir));
      // Dirty the tree (untracked file: porcelain non-empty).
      writeFileSync(join(wtPath, 'dirty.txt'), 'dirty');

      const effects = makeSubprocessCleanupEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      // THE BACKSTOP: git itself refuses a dirty plain removal — the
      // adapter builds NO --flag unless the op's explicit force reached it.
      await expect(resilient(() => effects.worktreeRemove(dir, wtPath))).rejects.toThrow(
        /contains modified or untracked/,
      );
      expect(
        await resilient(() => run(['-C', dir, 'worktree', 'list', '--porcelain'], dir)),
      ).toMatch(/^locked/m);
      // --force is the explicit dirty path and succeeds.
      await resilient(() => effects.worktreeRemove(dir, wtPath, { force: true }));
      // The branch age parses as an integer ms (the H age-basis half).
      const tipMs = await resilient(() => effects.branchTimeMs(dir, 'cq/x/fix/core'));
      expect(Number.isInteger(tipMs)).toBe(true);
      expect(tipMs).toBeGreaterThan(0);
      // branch -D works AFTER the removal — no worktree holds the branch.
      await resilient(() => effects.branchDelete(dir, 'cq/x/fix/core'));
      // r2#2: the DELETED branch's for-each-ref output is EMPTY — the
      // adapter maps that to the ENOENT absence class the op keeps on.
      const goneErr = (await resilient(() =>
        effects.branchTimeMs(dir, 'cq/x/fix/core').then(
          () => null,
          (err: unknown) => err,
        ),
      )) as (Error & { code?: string }) | null;
      expect(goneErr).toBeInstanceOf(Error);
      expect(goneErr?.code).toBe('ENOENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a LOCKED registration whose dir vanished is unlocked and pruned, so branch -D succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-locked-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      writeFileSync(join(dir, 'seed.txt'), 'seed');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-q', '-m', 'seed'], dir));
      const wtPath = join(dir, 'wt', 'fix', 'core');
      await resilient(() =>
        run(['-C', dir, 'worktree', 'add', '-b', 'cq/x/fix/core', wtPath, 'main'], dir),
      );
      await resilient(() => run(['-C', dir, 'worktree', 'lock', wtPath], dir));
      rmSync(wtPath, { recursive: true, force: true });

      const effects = makeSubprocessCleanupEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      const registered = (await resilient(() => effects.listWorktrees())).find(
        (w) => w.branch === 'cq/x/fix/core',
      );
      expect(registered).toBeDefined();
      await resilient(() => effects.worktreePrune(dir, registered?.path));
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(false);
      await resilient(() => effects.branchDelete(dir, 'cq/x/fix/core'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a FAILED removal restores the sweep lock with its reason; an UNLOCKED tree stays unlocked', async () => {
    // Git reports canonical paths, including /private/var on macOS.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-relock-')));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      writeFileSync(join(dir, 'seed.txt'), 'seed');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-q', '-m', 'seed'], dir));
      const lockedPath = join(dir, 'wt', 'locked');
      const plainPath = join(dir, 'wt', 'plain');
      await resilient(() =>
        run(['-C', dir, 'worktree', 'add', '-b', 'cq/x/locked', lockedPath, 'main'], dir),
      );
      await resilient(() =>
        run(['-C', dir, 'worktree', 'add', '-b', 'cq/x/plain', plainPath, 'main'], dir),
      );
      await resilient(() =>
        run(['-C', dir, 'worktree', 'lock', '--reason', 'cq sweep active', lockedPath], dir),
      );
      // Dirty both so plain `remove` is refused by git (the refusal path).
      writeFileSync(join(lockedPath, 'dirty.txt'), 'dirty');
      writeFileSync(join(plainPath, 'dirty.txt'), 'dirty');

      const effects = makeSubprocessCleanupEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      await expect(resilient(() => effects.worktreeRemove(dir, lockedPath))).rejects.toThrow(
        /contains modified or untracked/,
      );
      await expect(resilient(() => effects.worktreeRemove(dir, plainPath))).rejects.toThrow(
        /contains modified or untracked/,
      );
      const porcelain = await resilient(() =>
        run(['-C', dir, 'worktree', 'list', '--porcelain'], dir),
      );
      // Porcelain entries are blank-line-separated blocks; find each tree's block.
      const blockOf = (wtPath: string): string[] =>
        porcelain
          .split('\n\n')
          .map((block) => block.split('\n'))
          .find((lines) => lines[0] === `worktree ${wtPath}`) ?? [];
      // The sweep lock is back WITH its reason; the never-locked tree gained none.
      expect(blockOf(lockedPath)).toContain('locked cq sweep active');
      expect(blockOf(plainPath).some((line) => line.startsWith('locked'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
