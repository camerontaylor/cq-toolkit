// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// push leg on a real (local, offline) origin.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makePushBranch } from '../../../src/ops/sweep/unit.js';
import { CLEANUP, registerCleanup } from './unit-registry.helpers.js';

registerCleanup();

// ---------------------------------------------------------------------------
// The push leg on a real (local, offline) origin
// ---------------------------------------------------------------------------

describe('makePushBranch (the shipped push binding, real git smoke)', () => {
  test(
    'publishes a local branch to a local bare origin; refuses an unknown remote',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'd4-push-'));
      CLEANUP.push(root);
      const repo = join(root, 'repo');
      const origin = join(root, 'origin.git');
      const git = (args: string[], cwd: string): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile(
            'git',
            ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
            { cwd, timeout: 10_000, killSignal: 'SIGKILL' },
            (error, stdout, stderr) => {
              if (error !== null) {
                reject(new Error(stderr.trim() || error.message));
                return;
              }
              resolve(stdout);
            },
          );
        });
      await git(['init', '-q', '-b', 'main', repo], root);
      await git(['-C', repo, 'config', 'user.email', 't@example.invalid'], repo);
      await git(['-C', repo, 'config', 'user.name', 'T'], repo);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      await git(['-C', repo, 'add', '-A'], repo);
      await git(['-C', repo, 'commit', '-q', '-m', 'seed'], repo);
      await git(['init', '-q', '--bare', origin], root);
      await git(['-C', repo, 'remote', 'add', 'origin', origin], repo);
      await git(['-C', repo, 'checkout', '-q', '-b', 'cq/x/fix/alpha'], repo);

      const push = makePushBranch();
      await push(repo, 'cq/x/fix/alpha');
      const heads = await git(['-C', repo, 'ls-remote', '--heads', 'origin'], repo);
      expect(heads).toContain('cq/x/fix/alpha');
      // No upstream tracking is written: concurrent sibling pushes outside the
      // mutex must not contend for the shared .git/config lock.
      await expect(
        git(['-C', repo, 'config', '--get', 'branch.cq/x/fix/alpha.remote'], repo),
      ).rejects.toThrow();

      // A repo with no origin rejects (the op folds the rejection into `failed`
      // naming the push failure).
      const orphan = mkdtempSync(join(tmpdir(), 'd4-push-orphan-'));
      CLEANUP.push(orphan);
      await git(['init', '-q', '-b', 'main', orphan], orphan);
      await expect(makePushBranch({})(orphan, 'cq/x/fix/alpha')).rejects.toThrow(/origin/);
    },
  );
});
