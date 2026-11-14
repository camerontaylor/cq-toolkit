import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ledgerLoads } from '../../../src/policy/crq/ledger.js';

const seen = vi.hoisted(() => ({ required: [] as unknown[] }));
vi.mock('../../../src/adapters/crq/backfillRequired.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/adapters/crq/backfillRequired.js')>();
  return {
    ...original,
    collectRequired: (options: Parameters<typeof original.collectRequired>[0]) => {
      seen.required.push(options.required);
      return original.collectRequired({ ...options, required: { rows: [] } });
    },
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
    expect(seen.required[0]).toEqual(
      ledgerLoads(
        await readFile(new URL('../../../policy/review-required-list.json', import.meta.url)),
      ),
    );
    expect(
      JSON.parse(await readFile(join(stateRoot, 'backfill/latest-ranked.json'), 'utf8')),
    ).toHaveProperty('candidates');
    expect(JSON.parse(await readFile(join(stateRoot, 'queue.json'), 'utf8'))).toHaveProperty(
      'backfill_last_manifest',
    );
    const rankedPath = join(stateRoot, 'backfill/latest-ranked.json');
    const rankedBytes = await readFile(rankedPath);
    const ranked = JSON.parse(rankedBytes.toString()) as Record<string, unknown>;
    await writeFile(rankedPath, JSON.stringify({ ...ranked, manifest_id: 'interrupted' }));
    const mismatch = await runBackfillUnit(['baseline'], { stateRoot, cloneRoot, runnerRoot });
    expect(mismatch.exitCode).toBe(3);
    if (mismatch.artifact.status === 'failed')
      expect(mismatch.artifact.error).toContain('does not match queue manifest');
    await expect(readFile(join(stateRoot, 'backfill/baseline.json'))).rejects.toThrow();
    await writeFile(rankedPath, rankedBytes);
    const configPath = join(stateRoot, 'backfill-rollout.json');
    const configBytes = await readFile(configPath);
    const config = JSON.parse(configBytes.toString()) as Record<string, unknown>;
    const blocked = join(root, 'blocked-store');
    await writeFile(blocked, 'not a directory');
    await writeFile(configPath, JSON.stringify({ ...config, durable_artifact_root: blocked }));
    const failedStore = await runBackfillUnit(['baseline'], { stateRoot, cloneRoot, runnerRoot });
    expect(failedStore.exitCode).toBe(3);
    await expect(readFile(join(stateRoot, 'backfill/baseline.json'))).rejects.toThrow();
    await writeFile(configPath, configBytes);
    const pins = await Promise.all([
      runBackfillUnit(['baseline'], { stateRoot, cloneRoot, runnerRoot }),
      runBackfillUnit(['baseline'], { stateRoot, cloneRoot, runnerRoot }),
    ]);
    expect(pins.map((pin) => pin.exitCode).sort()).toEqual([0, 3]);
    const refused = pins.find((pin) => pin.exitCode === 3)?.artifact;
    expect(refused?.status).toBe('failed');
    if (refused?.status === 'failed') expect(refused.error).toContain('already pinned');
    const pinned = await readFile(join(stateRoot, 'backfill', 'baseline.json'));
    const digest = createHash('sha256').update(pinned).digest('hex');
    expect(await readFile(join(root, 'artifacts', 'sha256', digest))).toEqual(pinned);
    expect(JSON.parse(pinned.toString())).toMatchObject({
      schema: 'cq.backfill-baseline/v1',
      tree: git(cloneRoot, 'rev-parse', 'HEAD^{tree}'),
    });
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
    expect(
      (await runBackfillUnit(['baseline', '--extra'], { stateRoot, cloneRoot: stateRoot }))
        .exitCode,
    ).toBe(2);
    await expect(readFile(join(stateRoot, 'tick.lock'))).rejects.toThrow();
  });
  it('refuses baseline without rollout configuration and preserves queue bytes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'backfill-baseline-'));
    const queue = '{"items":[],"unknown":1.0}';
    await writeFile(join(stateRoot, 'queue.json'), queue);
    const result = await runBackfillUnit(['baseline'], { stateRoot, cloneRoot: stateRoot });
    expect(result.exitCode).toBe(3);
    if (result.artifact.status === 'failed')
      expect(result.artifact.error).toContain('rollout configuration is absent');
    expect(await readFile(join(stateRoot, 'queue.json'), 'utf8')).toBe(queue);
    await expect(readFile(join(stateRoot, 'backfill/baseline.json'))).rejects.toThrow();
  });
});
