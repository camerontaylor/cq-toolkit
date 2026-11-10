import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { makeTestRepo, type TestRepo } from '../dev/repo.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';

export const authorityStore = (guardPath: string) =>
  join(dirname(guardPath), 'cq-review-address-ownership.store');
export async function authorityState(guardPath: string): Promise<{ state: string; epoch: string }> {
  const anchor = JSON.parse(await readFile(guardPath, 'utf8')) as {
    version: number;
    state: string;
    epoch: string;
  };
  if (anchor.version !== 3) return anchor; // Deliberately foreign damage fixture.
  const store = authorityStore(guardPath);
  const names = (await readdir(store)).filter((name) => /^[0-9]{6}\.json$/.test(name)).sort();
  return JSON.parse(await readFile(join(store, names.at(-1)!), 'utf8')) as {
    state: string;
    epoch: string;
  };
}

export const NOW = 1_793_145_600_000;

export async function identityRepo() {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Fixture User');
  repo.git('config', 'user.email', 'fixture@example.invalid');
  return repo;
}

export async function fixture() {
  const repo = await identityRepo();
  try {
    const first = repo.git('rev-parse', 'HEAD').trim();
    await repo.write('src/sibling.ts', 'export const sibling = 2;\n');
    const second = repo.commitAll('second PR head');
    repo.git('push', '-q', 'origin', `${first}:refs/pull/7/head`, `${second}:refs/pull/9/head`);
    const root = dirname(repo.root);
    const registryPath = join(root, 'worktrees.json');
    const worktreeRoot = join(root, 'review');
    const run = makeGhRunner({
      bin: 'git',
      cwd: repo.root,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' },
    });
    // Scripted forge metadata only; the local bare origin supplies actual Git truth.
    const prs = [
      { number: 7, headRefName: 'feature/x', headRefOid: first },
      { number: 9, headRefName: 'feature/x', headRefOid: second },
    ] as const;
    const resolve = (pr: (typeof prs)[number]) =>
      resolvePrWorktree({
        repoRoot: repo.root,
        pr: pr.number,
        headRefName: pr.headRefName,
        run,
        // Separate handles share the real file lock and persistence boundary.
        registry: slotWorktreeRegistry(
          repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
        ),
        worktreeRoot,
        nowMs: NOW + pr.number,
      });
    return { repo, prs, resolve, registryPath, root, run, worktreeRoot };
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
}

export async function checkoutSnapshot(repo: TestRepo, path: string) {
  return {
    head: repo.git('-C', path, 'rev-parse', 'HEAD'),
    branch: repo.git('-C', path, 'symbolic-ref', 'HEAD'),
    status: repo.git('-C', path, 'status', '--porcelain=v1', '--untracked-files=all'),
    staged: repo.git('-C', path, 'diff', '--cached', '--binary'),
    unstaged: repo.git('-C', path, 'diff', '--binary'),
    untracked: await readFile(join(path, 'private-note.txt'), 'utf8'),
  };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const FOREIGN_GUARD = '{"version":1,"epoch":"foreign","state":"active","resources":[]}\n';
export async function damageGuard(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await unlink(guardPath);
  else if (damage === 'rewrite') await writeFile(guardPath, FOREIGN_GUARD);
  else {
    const foreign = `${guardPath}.foreign`;
    await writeFile(foreign, FOREIGN_GUARD);
    await rename(foreign, guardPath);
  }
}
export async function preservedDamage(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await expect(lstat(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(guardPath, 'utf8')).toBe(FOREIGN_GUARD);
}
export function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause)
    messages.push(current.message);
  return messages.join(' / ');
}
export function terminalReport(path: string): ReviewAddressReport {
  return {
    version: 1,
    source: 'local',
    reportPath: path,
    rounds: [],
    findings: [],
    openBlocking: [],
    fixes: [],
    attempts: [],
    failed: [],
    fixesPerRun: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    wallMs: 0,
    reasons: [],
  };
}
export function terminalInput(repo: TestRepo) {
  const parent = repo.git('rev-parse', 'HEAD').trim();
  return {
    root: repo.root,
    file: 'src/a.ts',
    parent,
    executionHead: parent,
    runPrefix: 'terminal-fixture',
    finding: 'terminal-a',
    slug: 'fixture',
    ordinal: 1,
    tier: 'worker' as const,
    model: { provider: 'mock', model: 'offline' },
  };
}
// Counter-bound fixtures use deterministic streams, not OS-child lifetime
// evidence. The separate fixed-Node cases above exercise real close/kill.
export function boundedFixtureProcess(output: string, code = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  Object.assign(child, { stdin: input, stdout, stderr, kill: () => true });
  input.resume();
  queueMicrotask(() => {
    child.emit('spawn');
    stdout.end(output);
    stderr.end();
    child.emit('close', code, null);
  });
  return child;
}
