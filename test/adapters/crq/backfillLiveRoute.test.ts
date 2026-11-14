import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/adapters/crq/backfillRequired.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/adapters/crq/backfillRequired.js')>();
  return {
    ...original,
    collectRequired: (options: Parameters<typeof original.collectRequired>[0]) =>
      original.collectRequired({ ...options, required: { rows: [] } }),
    fetchRequiredPr: async () => {
      throw new Error('unexpected external forge request in local fixture');
    },
  };
});
import { runBackfillUnit } from '../../../src/adapters/crq/backfillSource.js';

describe('live backfill inventory route', () => {
  it('captures and reports a local repository through the live route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-live-git-'));
    const stateRoot = join(root, 'state');
    const cloneRoot = join(root, 'clone');
    const runnerRoot = join(root, 'runner');
    const origin = join(root, 'origin.git');
    await mkdir(stateRoot);
    await mkdir(join(runnerRoot, 'policy'), { recursive: true });
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).trim();
    git(root, 'init', '--bare', origin);
    git(root, 'init', '-b', 'main', cloneRoot);
    await writeFile(join(cloneRoot, 'sample.txt'), 'hello\n');
    git(cloneRoot, 'add', 'sample.txt');
    git(cloneRoot, 'commit', '-m', 'initial');
    git(cloneRoot, 'remote', 'add', 'origin', origin);
    git(cloneRoot, 'push', 'origin', 'main');
    const emptyTree = git(cloneRoot, 'mktree');
    const genesis = git(cloneRoot, 'commit-tree', emptyTree, '-m', 'ledger genesis');
    git(cloneRoot, 'push', 'origin', `${genesis}:refs/heads/cq/review-ledger`);
    for (const name of ['review-tiers.json', 'review-limits.json', 'protected-paths.json']) {
      await writeFile(
        join(runnerRoot, 'policy', name),
        await readFile(new URL(`../../../policy/${name}`, import.meta.url)),
      );
    }
    await writeFile(
      join(runnerRoot, 'policy', 'review-required-list.json'),
      JSON.stringify({ version: 1, rows: [], explicit_unions: [] }),
    );
    await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}');
    await writeFile(
      join(stateRoot, 'backfill-rollout.json'),
      JSON.stringify({
        enabled: true,
        operational_ruling: 'approved',
        no_live_run_verification: 'verified',
        owner_branch_ruleset_evidence: 'evidence',
        durable_artifact_root: join(root, 'artifacts'),
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
      }),
    );
    const result = await runBackfillUnit(['inventory', '--report-only'], {
      stateRoot,
      cloneRoot,
      runnerRoot,
    });
    if (result.artifact.status === 'failed') throw new Error(result.artifact.error);
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(await readFile(join(stateRoot, 'backfill/latest-ranked.json'), 'utf8')),
    ).toHaveProperty('candidates');
    expect(JSON.parse(await readFile(join(stateRoot, 'queue.json'), 'utf8'))).toHaveProperty(
      'backfill_last_manifest',
    );
    const enqueued = await runBackfillUnit(['inventory'], { stateRoot, cloneRoot, runnerRoot });
    if (enqueued.artifact.status === 'failed') throw new Error(enqueued.artifact.error);
    expect(enqueued.exitCode).toBe(0);
    const queue = JSON.parse(await readFile(join(stateRoot, 'queue.json'), 'utf8')) as {
      items: unknown[];
    };
    expect(queue.items.length).toBeGreaterThan(0);
    expect((await readdir(join(stateRoot, 'backfill/publication/pending'))).length).toBeGreaterThan(
      0,
    );
  });
  it('refuses disabled enqueue before Git or queue mutations', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'backfill-route-'));
    const queue = '{"items":[],"scheduler":42}';
    await writeFile(join(stateRoot, 'queue.json'), queue);
    await writeFile(
      join(stateRoot, 'backfill-rollout.json'),
      JSON.stringify({
        enabled: false,
        operational_ruling: 'approved',
        no_live_run_verification: 'verified',
        owner_branch_ruleset_evidence: 'evidence',
        durable_artifact_root: '/artifacts',
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
      }),
    );
    const result = await runBackfillUnit(['inventory'], {
      stateRoot,
      cloneRoot: join(stateRoot, 'missing-clone'),
      runnerRoot: join(stateRoot, 'missing-runner'),
    });
    expect(result.exitCode).toBe(3);
    expect(result.artifact.status).toBe('failed');
    if (result.artifact.status === 'failed')
      expect(result.artifact.error).toContain('rollout must be enabled');
    expect(await readFile(join(stateRoot, 'queue.json'), 'utf8')).toBe(queue);
    await expect(readFile(join(stateRoot, 'backfill/latest-report.json'))).rejects.toThrow();
  });
  it('reports a failing Git invocation as an execution error', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'backfill-git-failure-'));
    const queue = '{"items":[]}';
    await writeFile(join(stateRoot, 'queue.json'), queue);
    await writeFile(
      join(stateRoot, 'backfill-rollout.json'),
      JSON.stringify({
        enabled: true,
        operational_ruling: 'approved',
        no_live_run_verification: 'verified',
        owner_branch_ruleset_evidence: 'evidence',
        durable_artifact_root: join(stateRoot, 'artifacts'),
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
      }),
    );
    const result = await runBackfillUnit(['inventory'], {
      stateRoot,
      cloneRoot: stateRoot,
      runnerRoot: stateRoot,
    });
    expect(result.exitCode).toBe(1);
    expect(await readFile(join(stateRoot, 'queue.json'), 'utf8')).toBe(queue);
  });
  it('rejects invalid arguments before reading state', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'backfill-route-'));
    const result = await runBackfillUnit(['inventory', '--report-only', '--report-only'], {
      stateRoot,
      cloneRoot: stateRoot,
      runnerRoot: stateRoot,
    });
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(stateRoot, 'tick.lock'))).rejects.toThrow();
  });
});
