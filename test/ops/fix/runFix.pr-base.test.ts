// Split provenance: test/ops/fix/runFix.test.ts was split by subject into
// runFix.compare-links.test.ts, runFix.fixes-per-run.test.ts,
// runFix.composition-context.test.ts, runFix.composition-metrics.test.ts,
// runFix.pr-base.test.ts (this file) and runFix.atomic-report.test.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { resolveFixPrBase } from '../../../src/ops/fix/runFix.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

test('PR base resolves the remote default, explicit branches and upstream; refuses revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-pr-base-'));
  const git = async (...args: string[]) =>
    promisify(execFile)('git', ['-C', root, ...args], { env: scrubbedGitEnv() });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@invalid');
    await git('commit', '--allow-empty', '-m', 'baseline');
    expect(await resolveFixPrBase(root)).toBeUndefined();
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git('update-ref', 'refs/remotes/origin/release', 'HEAD');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveFixPrBase(root)).toBe('main');
    expect(await resolveFixPrBase(root, 'origin/HEAD')).toBe('main');
    expect(await resolveFixPrBase(root, 'refs/remotes/origin/HEAD')).toBe('main');
    expect(await resolveFixPrBase(root, 'release')).toBe('release');
    expect(await resolveFixPrBase(root, 'origin/release')).toBe('release');
    expect(await resolveFixPrBase(root, 'HEAD~1')).toBeUndefined();
    await git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    await git('config', 'remote.origin.url', '.');
    await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git('config', 'branch.main.remote', 'origin');
    await git('config', 'branch.main.merge', 'refs/heads/main');
    expect(await resolveFixPrBase(root)).toBe('main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
