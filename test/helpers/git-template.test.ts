import { execFile } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cloneTemplate, createGitTemplate, scrubbedGitEnv } from './git-template.js';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      {
        cwd,
        env: scrubbedGitEnv(),
        timeout: 6_000,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function seedSmokeRepo(repo: string): Promise<void> {
  writeFileSync(join(repo, 'seed.txt'), 'template seed\n');
  await git(['init', '-q', '-b', 'main', repo], repo);
  await git(['-C', repo, 'config', 'user.email', 'template@example.invalid'], repo);
  await git(['-C', repo, 'config', 'user.name', 'Template test'], repo);
  await git(['-C', repo, 'add', 'seed.txt'], repo);
  await git(['-C', repo, 'commit', '-q', '-m', 'seed template'], repo);
}

describe('git-template clone smoke', () => {
  test(
    'copies a clean template, then worktree-adds, commits, pushes, and publishes the ref',
    { timeout: 60_000 },
    async () => {
      const template = await createGitTemplate(seedSmokeRepo);
      let clone: Awaited<ReturnType<typeof cloneTemplate>> | undefined;
      try {
        clone = await cloneTemplate(template);
        const worktree = join(clone.root, 'smoke-worktree');
        await git(
          ['-C', clone.repo, 'worktree', 'add', '-b', 'smoke', worktree, 'main'],
          clone.root,
        );
        writeFileSync(join(worktree, 'smoke.txt'), 'template clone works\n');
        await git(['-C', worktree, 'add', 'smoke.txt'], clone.root);
        await git(['-C', worktree, 'commit', '-q', '-m', 'smoke commit'], clone.root);
        await git(['-C', worktree, 'push', '-q', '-u', 'origin', 'smoke'], clone.root);

        expect((await git(['remote', 'get-url', 'origin'], clone.repo)).trim()).toBe(clone.origin);
        expect(await git(['ls-remote', '--heads', 'origin', 'smoke'], clone.repo)).toContain(
          'refs/heads/smoke',
        );
      } finally {
        if (clone !== undefined) rmSync(clone.root, { recursive: true, force: true });
        rmSync(template.root, { recursive: true, force: true });
      }
    },
  );

  test('rejects a copied gitfile before rewriting the origin', { timeout: 30_000 }, async () => {
    let template: Awaited<ReturnType<typeof createGitTemplate>> | undefined;
    try {
      template = await createGitTemplate(async (repo) => {
        await seedSmokeRepo(repo);
        const externalGitDir = join(repo, 'external-git-dir');
        renameSync(join(repo, '.git'), externalGitDir);
        writeFileSync(join(repo, '.git'), `gitdir: ${externalGitDir}\n`);
      });
      await expect(cloneTemplate(template)).rejects.toThrow(
        'cloned git template .git must be a real directory, not a symlink or gitfile',
      );
    } finally {
      if (template !== undefined) rmSync(template.root, { recursive: true, force: true });
    }
  });
});
