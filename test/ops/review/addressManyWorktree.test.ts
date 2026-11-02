import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { isolateAddressMany, makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { fileWorktreeRegistry, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { makeTestRepo, type TestRepo } from '../dev/repo.js';
import * as addressModule from '../../../src/ops/review/address.js';
import { runReviewLoop, type ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { FixReviewItemInputSchema } from '../../../src/ops/review/registry.js';
import {
  makeAddressOwnership,
  runAddressReviewLoop,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';

import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import * as ownershipModule from '../../../src/ops/review/internal/addressOwnership.js';
import { OpResultArtifactSchema } from '../../../src/kernel/schema.js';
import { exitCodeForOpResult } from '../../../src/cli/exit.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';

// Only fixed fixture Node programs replace the private terminal spawn. Ordinary
// Git and the existing offline harness keep their actual implementations.
const terminalProcessFaults = vi.hoisted(() => ({
  spawn: undefined as
    | undefined
    | ((
        command: string,
        args: readonly string[],
        options: SpawnOptions,
      ) => ChildProcess | undefined),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      terminalProcessFaults.spawn?.(command, args, options) ?? actual.spawn(command, args, options),
  };
});

// Filesystem fault gates are test-only. Every unaffected operation is real.
const fsFaults = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void),
  link: undefined as
    | undefined
    | ((phase: 'before' | 'after', source: string, destination: string) => Promise<void>),
  open: undefined as
    | undefined
    | ((path: string, flags: string | number | undefined) => Promise<void>),
  sync: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      fsFaults.effect?.();
      return actual.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.effect?.();
      return actual.writeFile(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      fsFaults.effect?.();
      await fsFaults.link?.('before', String(args[0]), String(args[1]));
      await actual.link(...args);
      await fsFaults.link?.('after', String(args[0]), String(args[1]));
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      fsFaults.effect?.();
      await fsFaults.open?.(String(args[0]), args[1]);
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        fsFaults.effect?.();
        await fsFaults.sync?.(String(args[0]));
        await sync();
      };
      return file;
    },
  };
});

const mutexFaults = vi.hoisted(() => ({
  afterRelease: undefined as undefined | (() => Promise<void>),
  compromise: false,
  releaseFailed: undefined as undefined | (() => void),
}));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      const release = await actual.lock(...args);
      return async () => {
        const governed = args[0].endsWith('/cq-review-address-ownership');
        try {
          await release();
        } catch (error) {
          if (governed) mutexFaults.releaseFailed?.();
          throw error;
        }
        if (!governed) return;
        if (mutexFaults.compromise)
          args[1]?.onCompromised?.(new Error('observed compromise fixture'));
        await mutexFaults.afterRelease?.();
      };
    },
  };
});

const authorityStore = (guardPath: string) =>
  join(dirname(guardPath), 'cq-review-address-ownership.store');
async function authorityState(guardPath: string): Promise<{ state: string; epoch: string }> {
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

const NOW = 1_793_145_600_000;

async function identityRepo() {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Fixture User');
  repo.git('config', 'user.email', 'fixture@example.invalid');
  return repo;
}

async function fixture() {
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
        registry: fileWorktreeRegistry(registryPath),
        worktreeRoot,
        nowMs: NOW + pr.number,
      });
    return { repo, prs, resolve, registryPath, root, run, worktreeRoot };
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
}

async function checkoutSnapshot(repo: TestRepo, path: string) {
  return {
    head: repo.git('-C', path, 'rev-parse', 'HEAD'),
    branch: repo.git('-C', path, 'symbolic-ref', 'HEAD'),
    status: repo.git('-C', path, 'status', '--porcelain=v1', '--untracked-files=all'),
    staged: repo.git('-C', path, 'diff', '--cached', '--binary'),
    unstaged: repo.git('-C', path, 'diff', '--binary'),
    untracked: await readFile(join(path, 'private-note.txt'), 'utf8'),
  };
}

test('concurrent PRs sharing a head ref retain distinct exact-head worktrees and both registry entries', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(f.prs.map(f.resolve));
    expect(new Set(await Promise.all(results.map((result) => realpath(result.path)))).size).toBe(2);
    expect(new Set(results.map((result) => result.branch)).size).toBe(2);
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(Object.keys(entries).sort()).toEqual(['7', '9']);
    for (const [index, pr] of f.prs.entries()) {
      const result = results[index]!;
      expect(result.reused).toBe(false);
      expect(f.repo.git('-C', result.path, 'rev-parse', 'HEAD').trim()).toBe(pr.headRefOid);
      expect(f.repo.git('-C', result.path, 'symbolic-ref', 'HEAD').trim()).toBe(
        `refs/heads/${result.branch}`,
      );
      expect(entries[String(pr.number)]).toEqual({
        path: result.path,
        branch: result.branch,
        createdAt: NOW + pr.number,
      });
    }
    expect(f.prs[0].headRefOid).not.toBe(f.prs[1].headRefOid);
    // Reopening both through fresh handles must preserve each PR's identity.
    const reused = await Promise.all(f.prs.map(f.resolve));
    // Git may canonicalize macOS /var paths to /private/var between creation and reuse.
    expect(
      await Promise.all(
        reused.map(async (result) => ({ ...result, path: await realpath(result.path) })),
      ),
    ).toEqual(
      await Promise.all(
        results.map(async (result) => ({
          ...result,
          path: await realpath(result.path),
          reused: true,
        })),
      ),
    );
  } finally {
    await f.repo.cleanup();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('direct loop owns lifetime; only a live private bridge reenters and inherited callbacks cannot replay', async () => {
  for (const viaAddress of [false, true]) {
    const f = await fixture();
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      let stale: (() => Promise<unknown>) | undefined;
      let visited = false;
      const opts: ReviewLoopOpts = {
        owner: 'fixture',
        repo: 'base',
        pr: 7,
        headRefName: 'feature/x',
        repoRoot: f.repo.root,
        git: f.run,
        gh: async () => {
          throw new Error('forge must not dispatch');
        },
        registry: fileWorktreeRegistry(f.registryPath),
        driver: { provider: 'test', model: 'test' },
        nowMs: NOW,
        dispatchLogPath: join(f.root, 'dispatch.jsonl'),
        beforeWorktreeResolve: async () => {
          visited = true;
          await expect(runReviewLoop(opts)).rejects.toThrow(/consumed|active or quarantined/);
          await expect(
            withAddressOwnership(
              { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
              async () => undefined,
            ),
          ).rejects.toThrow('active or quarantined');
          throw new Error('stop before mutable resolution');
        },
      };
      if (viaAddress) {
        await expect(
          owner.withLock(async () => {
            const lease = owner.lease();
            stale = () => runAddressReviewLoop(lease, opts);
            await expect(runAddressReviewLoop({ ...lease }, opts)).rejects.toThrow(
              'forged loop lease',
            );
            await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
            return runAddressReviewLoop(lease, opts);
          }),
        ).rejects.toThrow('stop before mutable resolution');
        await expect(stale!()).rejects.toThrow(/owner inactive|admissions closed/);
        await expect(owner.withLock(async () => undefined)).rejects.toThrow(
          'lifetime already consumed',
        );
      } else {
        await expect(runReviewLoop(opts)).rejects.toThrow('stop before mutable resolution');
      }
      expect(visited).toBe(true);
      expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    } finally {
      await f.repo.cleanup();
    }
  }
});

test.each(['detach', 'parent-abort', 'parent-and-owner-loss'] as const)(
  'actual registry fixer lifetime: %s',
  async (mode) => {
    const f = await fixture();
    const release = deferred(),
      finished = deferred(),
      entered = deferred();
    const parent = new AbortController();
    let postAbortCommands = 0;
    let started = false;
    let checkout = '';
    const head = f.prs[0].headRefOid;
    const opts: ReviewLoopOpts = {
      owner: 'fixture',
      repo: 'base',
      pr: 7,
      headRefName: 'feature/x',
      repoRoot: f.repo.root,
      git: (args) => {
        if (parent.signal.aborted) postAbortCommands++;
        return f.run(args);
      },
      gh: async (args) => {
        if (parent.signal.aborted) postAbortCommands++;
        const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
        if (args.includes('graphql')) {
          const snapshot = args.some(
            (arg) => arg.startsWith('query=') && arg.includes('threadsCursor'),
          );
          const pageInfo = { hasNextPage: false, endCursor: null };
          return json({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'author' },
                  headRefName: 'feature/x',
                  headRefOid: head,
                  reviewThreads: {
                    pageInfo,
                    nodes: snapshot
                      ? []
                      : [
                          {
                            id: 'T1',
                            isResolved: false,
                            isOutdated: false,
                            path: 'src/a.ts',
                            line: 1,
                            comments: {
                              nodes: [
                                {
                                  databaseId: 101,
                                  author: { login: 'reviewer' },
                                  body: 'Fix src/a.ts.',
                                  createdAt: new Date(NOW - 60_000).toISOString(),
                                },
                              ],
                            },
                          },
                        ],
                  },
                  reviews: { pageInfo, nodes: [] },
                },
              },
            },
          });
        }
        if (args.includes('repos/fixture/base/pulls/7')) return json({ head: { sha: head } });
        if (args.some((arg) => arg.startsWith('repos/fixture/base/'))) return json([]);
        throw new Error('unexpected scripted forge call');
      },
      registry: fileWorktreeRegistry(f.registryPath),
      driver: { provider: 'test', model: 'test' },
      driverRegistryView: {
        get: (name) =>
          name === 'review.fixItem'
            ? ({
                name,
                inputSchema: FixReviewItemInputSchema,
                importer: async () => async () => {
                  started = true;
                  entered.resolve();
                  try {
                    await release.promise;
                    // Deliberately uncooperative in-process implementation: the outer
                    // killed report cannot prove this actual promise stopped writing.
                    if (mode === 'detach')
                      await writeFile(join(checkout, 'late-write.txt'), 'survivor edit\n');
                    return { status: 'needs-human', reason: 'late actual operation settled' };
                  } finally {
                    finished.resolve();
                  }
                },
              } as unknown as OpRegistryEntry<never, never>)
            : undefined,
      },
      ...(mode === 'detach' ? { limits: { perJobWallClockMs: 1 } } : {}),
      signal: parent.signal,
      allowAdvisoryBudget: true,
      publish: false,
      nowMs: NOW,
      dispatchLogPath: join(f.root, 'dispatch-detached.jsonl'),
      worktreeRoot: f.worktreeRoot,
      onWorktreeResolved: async (info) => {
        checkout = info.path;
      },
    };
    try {
      const pending = runReviewLoop(opts);
      if (mode !== 'detach') {
        await entered.promise;
        if (mode === 'parent-and-owner-loss') {
          const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
          await writeFile(
            owner.guardPath,
            JSON.stringify({ version: 1, epoch: 'foreign', state: 'active', resources: [] }),
          );
        }
        parent.abort();
        release.resolve();
        if (mode === 'parent-and-owner-loss') {
          await expect(pending).rejects.toThrow(/lost owner|owner inactive/);
          await expect(
            runReviewLoop({ ...opts, git: f.run, signal: new AbortController().signal }),
          ).rejects.toThrow('active or quarantined');
        } else {
          const outcome = await pending;
          expect(outcome.status).toBe('needs-human');
          expect(outcome.reasons.join(' ')).toContain('parent cancelled');
          expect(outcome.fixReport).toBeDefined();
          expect(outcome.actionsPosted).toBe(0);
          expect(outcome.verify).toBeUndefined();
          expect(outcome.reply).toBeUndefined();
          await withAddressOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async (lease) => lease.assertOwned(),
          );
        }
        expect(postAbortCommands).toBe(0);
        return;
      }
      await expect(pending).rejects.toThrow('detached work requires quarantine');
      expect(started).toBe(true);
      await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
      release.resolve();
      await finished.promise;
      expect(await readFile(join(checkout, 'late-write.txt'), 'utf8')).toBe('survivor edit\n');
      await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
    } finally {
      release.resolve();
      if (started) await finished.promise;
      await f.repo.cleanup();
    }
  },
);

test('concurrent production child reentry consumes its private permit before identity awaits', async () => {
  const f = await fixture();
  let admitted = 0;
  const factory = vi
    .spyOn(addressModule, 'makeReviewAddress')
    .mockImplementation(() => async (input) => {
      const options = {
        repoRoot: input.repoRoot,
        git: f.run,
        source: input.source,
        production: true,
      };
      const first = withAddressOwnership(options, async () => {
        admitted++;
        return { status: 'needs-human' as const, reason: 'private permit fixture' };
      });
      await expect(
        withAddressOwnership(options, async () => {
          admitted++;
          throw new Error('replayed child entered');
        }),
      ).rejects.toThrow('invalid production child permit');
      return first;
    });
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () =>
      owner.address(
        { pr: 7, head: f.prs[0].headRefOid, headRepo: 'fixture/base', headRefName: 'feature/x' },
        { repoRoot: f.repo.root, source: 'pr:7' },
      ),
    );
    expect(admitted).toBe(1);
  } finally {
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test('unawaited admission is registered before asynchronous ownership validation', async () => {
  const f = await fixture();
  let task: Promise<unknown> | undefined;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(
      owner.withLock(async () => {
        task = owner.lease().track(async () => undefined);
      }),
    ).rejects.toThrow('detached work requires quarantine');
    await task?.catch(() => undefined);
    expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('active or quarantined');
  } finally {
    await f.repo.cleanup();
  }
});

test('lifetime owner excludes linked, symlinked and injected callers through edits and commit', async () => {
  const f = await fixture();
  try {
    const linked = await f.resolve(f.prs[0]);
    const alias = join(f.root, 'checkout-alias');
    await symlink(linked.path, alias, 'dir');
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      for (const repoRoot of [f.repo.root, linked.path, alias]) {
        let entered = false;
        await expect(
          withAddressOwnership(
            {
              repoRoot,
              git: f.run,
              source: 'local',
              production: false,
            },
            async () => {
              entered = true;
            },
          ),
        ).rejects.toThrow(/active|quarantined/);
        expect(entered).toBe(false);
      }
      await writeFile(join(linked.path, 'README.md'), 'owned edit\n');
      f.repo.git('-C', linked.path, 'add', '--', 'README.md');
      f.repo.git('-C', linked.path, 'commit', '-q', '-m', 'owned commit');
      await owner.assertOwned();
    });
    // A clean settle permits a fresh owner, including through an alias.
    await withAddressOwnership(
      {
        repoRoot: alias,
        git: f.run,
        source: 'local',
        production: false,
      },
      async (lease) => {
        await lease.assertOwned();
      },
    );
  } finally {
    await f.repo.cleanup();
  }
});

test('expected fetched-head fence preserves dirty stale checkout and registry byte for byte', async () => {
  const f = await fixture();
  try {
    const checkout = await f.resolve(f.prs[0]);
    await writeFile(join(checkout.path, 'README.md'), 'private stale edit\n');
    const before = await readFile(f.registryPath, 'utf8');
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    await expect(
      resolvePrWorktree({
        repoRoot: f.repo.root,
        pr: 7,
        headRefName: 'feature/x',
        expectedHead: f.prs[0].headRefOid,
        run: f.run,
        registry: fileWorktreeRegistry(f.registryPath),
        worktreeRoot: f.worktreeRoot,
        nowMs: NOW,
      }),
    ).rejects.toThrow('changed since admission');
    expect(await readFile(f.registryPath, 'utf8')).toBe(before);
    expect(await readFile(join(checkout.path, 'README.md'), 'utf8')).toBe('private stale edit\n');
    expect(f.repo.git('-C', checkout.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
  } finally {
    await f.repo.cleanup();
  }
});

test('private production child harness overlaps distinct lanes and refuses remote and branch aliases', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let active = 0,
    maximum = 0,
    started = 0;
  // Explicit contract harness replaces ONLY the production factory. No runtime
  // caller dependency, skipLock flag or serialized permit is accepted.
  const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
    () => async (input) =>
      withAddressOwnership(
        {
          repoRoot: input.repoRoot,
          git: f.run,
          source: input.source,
          production: true,
        },
        async (lease) => {
          const pr = f.prs.find((item) => input.source === `pr:${item.number}`)!;
          await expect(
            withAddressOwnership(
              {
                repoRoot: input.repoRoot,
                git: f.run,
                source: input.source,
                production: false,
              },
              async () => undefined,
            ),
          ).rejects.toThrow('invalid production child permit');
          await lease.assertSelection({
            pr: pr.number,
            headRepo: `fixture/fork${pr.number}`,
            headRefName: 'feature/x',
          });
          const worktree = await resolvePrWorktree({
            repoRoot: input.repoRoot,
            pr: pr.number,
            headRefName: 'feature/x',
            expectedHead: lease.expectedHead!,
            run: f.run,
            registry: lease.registry!,
            nowMs: NOW,
            worktreeRoot: f.worktreeRoot,
          });
          await lease.claimCheckout({ ...worktree, head: pr.headRefOid });
          return lease.track(async () => {
            active++;
            started++;
            maximum = Math.max(maximum, active);
            if (started === 2) entered.resolve();
            await release.promise;
            await lease.assertOwned();
            await writeFile(join(worktree.path, 'README.md'), `PR ${pr.number} owned edit\n`);
            f.repo.git('-C', worktree.path, 'add', '--', 'README.md');
            f.repo.git('-C', worktree.path, 'commit', '-q', '-m', `PR ${pr.number} owned commit`);
            active--;
            return { status: 'needs-human', reason: 'contract harness settled' };
          });
        },
      ),
  );
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      const selections = f.prs.map((pr) => ({
        pr: pr.number,
        head: pr.headRefOid,
        headRepo: `fixture/fork${pr.number}`,
        headRefName: 'feature/x',
      }));
      const work = selections.map((selection) =>
        owner.address(selection, {
          repoRoot: f.repo.root,
          source: `pr:${selection.pr}`,
        }),
      );
      await entered.promise;
      expect(maximum).toBe(2);
      await expect(
        owner.address(
          { ...selections[0]!, pr: 11 },
          {
            repoRoot: f.repo.root,
            source: 'pr:11',
          },
        ),
      ).rejects.toThrow('conflicting child resource');
      await expect(
        owner.address(
          { ...selections[0]!, headRepo: 'fixture/other', headRefName: 'other' },
          {
            repoRoot: f.repo.root,
            source: 'pr:7',
          },
        ),
      ).rejects.toThrow('conflicting child resource');
      expect(factory).toHaveBeenCalledTimes(2);
      release.resolve();
      await Promise.all(work);
    });
    expect(active).toBe(0);
  } finally {
    release.resolve();
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test('abandoned inner work quarantines immediately and later settlement cannot reclaim ownership', async () => {
  const f = await fixture();
  const started = deferred(),
    release = deferred();
  let inner!: Promise<void>;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(
      owner.withLock(async () => {
        inner = owner.lease().track(async () => {
          started.resolve();
          await release.promise;
          // Models an uncooperative survivor making a late direct filesystem edit.
          await f.repo.write('late.txt', 'late survivor\n');
        });
        await started.promise;
        // Models the governor returning while the actual implementation survives.
      }),
    ).rejects.toThrow('detached work requires quarantine');
    expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    release.resolve();
    await inner;
    expect(await readFile(join(f.repo.root, 'late.txt'), 'utf8')).toBe('late survivor\n');
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
  } finally {
    release.resolve();
    await inner;
    await f.repo.cleanup();
  }
});

test.each(['abort', 'guard', 'guard-abort'] as const)(
  'parent abort and replaced ownership guard refuse subsequent tracked mutations: %s',
  async (fault) => {
    const f = await fixture();
    try {
      const parent = new AbortController();
      const owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      let mutations = 0;
      await expect(
        owner.withLock(async () => {
          if (fault === 'abort') parent.abort(new Error('parent fixture cancelled'));
          else
            await writeFile(
              owner.guardPath,
              JSON.stringify({ version: 1, epoch: 'foreign', state: 'active', resources: [] }),
            );
          if (fault === 'guard-abort') parent.abort(new Error('parent fixture cancelled'));
          await owner.lease().track(async () => {
            mutations++;
          });
        }),
      ).rejects.toThrow(/parent fixture cancelled|lost owner/);
      expect(mutations).toBe(0);
      const guard = await authorityState(owner.guardPath);
      expect(guard.state).toBe(fault === 'abort' ? 'quarantined' : 'active');
      if (fault !== 'abort') expect(guard.epoch).toBe('foreign');
      const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    } finally {
      await f.repo.cleanup();
    }
  },
);

const FOREIGN_GUARD = '{"version":1,"epoch":"foreign","state":"active","resources":[]}\n';
async function damageGuard(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await unlink(guardPath);
  else if (damage === 'rewrite') await writeFile(guardPath, FOREIGN_GUARD);
  else {
    const foreign = `${guardPath}.foreign`;
    await writeFile(foreign, FOREIGN_GUARD);
    await rename(foreign, guardPath);
  }
}
async function preservedDamage(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await expect(lstat(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(guardPath, 'utf8')).toBe(FOREIGN_GUARD);
}
function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause)
    messages.push(current.message);
  return messages.join(' / ');
}

for (const transition of ['activation', 'child', 'checkout', 'settlement', 'quarantine'] as const) {
  for (const phase of ['before', 'after'] as const) {
    test.each(['replace', 'remove', 'rewrite'] as const)(
      `immutable ${transition} ${phase}-link damage: %s`,
      async (damage) => {
        const f = await fixture();
        const reached = deferred(),
          release = deferred();
        let damaged = false,
          dispatchAfterDamage = 0,
          completed = false,
          rootEntered = false;
        const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        const checkout = await f.resolve(f.prs[0]);
        const sequence = { activation: 1, child: 2, checkout: 3, settlement: 4, quarantine: 4 }[
          transition
        ];
        const target = join(
          authorityStore(owner.guardPath),
          `${String(sequence).padStart(6, '0')}.json`,
        );
        const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
          () => async (input) =>
            withAddressOwnership(
              { repoRoot: input.repoRoot, git: f.run, source: input.source, production: true },
              async (lease) => {
                await lease.claimCheckout({ ...checkout, head: f.prs[0].headRefOid });
                return lease.track(async () => {
                  if (damaged) dispatchAfterDamage++;
                  return { status: 'needs-human', reason: 'immutable transition fixture' };
                });
              },
            ),
        );
        fsFaults.link = async (when, _source, destination) => {
          if (when === phase && destination === target) {
            reached.resolve();
            await release.promise;
          }
        };
        let pending: Promise<unknown> | undefined;
        try {
          pending = owner
            .withLock(async () => {
              rootEntered = true;
              await owner.address(
                {
                  pr: 7,
                  head: f.prs[0].headRefOid,
                  headRepo: 'fixture/base',
                  headRefName: 'feature/x',
                },
                { repoRoot: f.repo.root, source: 'pr:7' },
              );
              if (transition === 'quarantine') throw new Error('quarantine fixture failure');
            })
            .then(() => {
              completed = true;
            });
          void pending.catch(() => undefined);
          await reached.promise;
          await damageGuard(owner.guardPath, damage);
          damaged = true;
          release.resolve();
          await expect(pending).rejects.toThrow(
            transition === 'quarantine'
              ? 'quarantine fixture failure'
              : /lost owner|active or quarantined|completion staging changed/,
          );
          expect(completed).toBe(false);
          expect(dispatchAfterDamage).toBe(0);
          if (transition === 'activation') expect(rootEntered).toBe(false);
          await preservedDamage(owner.guardPath, damage);
          await expect(async () =>
            owner.lease().track(async () => {
              dispatchAfterDamage++;
            }),
          ).rejects.toThrow(/inactive|lost owner/);
          const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
          await expect(
            contender.withLock(async () => {
              dispatchAfterDamage++;
            }),
          ).rejects.toThrow('attended recovery');
          expect(dispatchAfterDamage).toBe(0);
          await preservedDamage(owner.guardPath, damage);
        } finally {
          release.resolve();
          await pending?.catch(() => undefined);
          fsFaults.link = undefined;
          factory.mockRestore();
          await f.repo.cleanup();
        }
      },
    );
  }
}

for (const phase of ['before-head', 'after-head'] as const) {
  test.each(['replace', 'remove'] as const)(
    `last checkout identity ${phase}: %s`,
    async (damage) => {
      const f = await fixture();
      const checkout = await f.resolve(f.prs[0]);
      const reached = deferred(),
        release = deferred();
      let dispatched = 0;
      const git: typeof f.run = async (args) => {
        if (args[1] === checkout.path && args.slice(2).join(' ') === 'rev-parse HEAD') {
          const result = phase === 'after-head' ? await f.run(args) : undefined;
          reached.resolve();
          await release.promise;
          return result ?? f.run(args);
        }
        return f.run(args);
      };
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git });
      const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
        () => async (input) =>
          withAddressOwnership(
            { repoRoot: input.repoRoot, git, source: input.source, production: true },
            async (lease) => {
              await lease.claimCheckout({ ...checkout, head: f.prs[0].headRefOid });
              return lease.track(async () => {
                dispatched++;
                return { status: 'needs-human', reason: 'identity fixture' };
              });
            },
          ),
      );
      const pending = owner.withLock(async () =>
        owner.address(
          { pr: 7, head: f.prs[0].headRefOid, headRepo: 'fixture/base', headRefName: 'feature/x' },
          { repoRoot: f.repo.root, source: 'pr:7' },
        ),
      );
      void pending.catch(() => undefined);
      try {
        await reached.promise;
        await damageGuard(owner.guardPath, damage);
        release.resolve();
        await expect(pending).rejects.toThrow('lost owner');
        expect(dispatched).toBe(0);
        await preservedDamage(owner.guardPath, damage);
        await expect(
          (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
            async () => undefined,
          ),
        ).rejects.toThrow('attended recovery');
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        factory.mockRestore();
        await f.repo.cleanup();
      }
    },
  );
}

test.each(['EXDEV', 'EPERM', 'ENOSYS', 'nofollow', 'fsync'] as const)(
  'unsupported authority primitive fails closed: %s',
  async (failure) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let dispatched = false;
    const unavailable = () => {
      throw Object.assign(new Error('unsupported fixture'), { code: failure });
    };
    if (failure === 'nofollow')
      fsFaults.open = async (path) => {
        if (path.startsWith(authorityStore(owner.guardPath))) unavailable();
      };
    else if (failure === 'fsync')
      fsFaults.sync = async (path) => {
        if (path.startsWith(authorityStore(owner.guardPath))) unavailable();
      };
    else
      fsFaults.link = async (_phase, _source, destination) => {
        if (destination === owner.guardPath) unavailable();
      };
    try {
      await expect(
        owner.withLock(async () => {
          dispatched = true;
        }),
      ).rejects.toThrow();
      fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          dispatched = true;
        }),
      ).rejects.toThrow('attended recovery');
      expect(dispatched).toBe(false);
      await expect(lstat(owner.guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test('bootstrap collision and partial history preserve evidence without repair', async () => {
  for (const partial of [false, true]) {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    try {
      if (partial) await mkdir(authorityStore(owner.guardPath));
      else await writeFile(owner.guardPath, FOREIGN_GUARD);
      await expect(
        owner.withLock(async () => {
          throw new Error('must not enter');
        }),
      ).rejects.toThrow('attended recovery');
      if (partial) await expect(lstat(owner.guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
    } finally {
      await f.repo.cleanup();
    }
  }
});

test('atomic link collision preserves destination and never falls back to rename', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const target = join(authorityStore(owner.guardPath), '000001.json');
  let calls = 0;
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination === target) {
      calls++;
      await writeFile(target, 'foreign slot bytes');
    }
  };
  try {
    await expect(
      owner.withLock(async () => {
        throw new Error('must not enter');
      }),
    ).rejects.toThrow('lost owner');
    expect(calls).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('foreign slot bytes');
    fsFaults.link = undefined;
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('attended recovery');
  } finally {
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test.each(['store', 'physical-lock'] as const)(
  'authority publication refuses replaced identity: %s',
  async (identity) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const path =
      identity === 'store'
        ? authorityStore(owner.guardPath)
        : join(dirname(owner.guardPath), 'cq-review-address-ownership.lock');
    let replaced = false,
      dispatched = 0;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase === 'before' && destination.endsWith('/000002.json') && !replaced) {
        replaced = true;
        await rename(path, `${path}.preserved`);
        await mkdir(path);
      }
    };
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'identity fixture' };
      });
    try {
      await expect(
        owner.withLock(async () =>
          owner.address(
            {
              pr: 7,
              head: f.prs[0].headRefOid,
              headRepo: 'fixture/base',
              headRefName: 'feature/x',
            },
            { repoRoot: f.repo.root, source: 'pr:7' },
          ),
        ),
      ).rejects.toThrow('lost owner');
      expect(dispatched).toBe(0);
      fsFaults.link = undefined;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('attended recovery');
    } finally {
      fsFaults.link = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test('foreign bootstrap collision inside the hard-link window is never overwritten', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination === owner.guardPath)
      await writeFile(owner.guardPath, FOREIGN_GUARD);
  };
  try {
    await expect(
      owner.withLock(async () => {
        throw new Error('must not enter');
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
    fsFaults.link = undefined;
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('attended recovery');
    expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
  } finally {
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test('settlement closes tracked admission before its awaited publication window', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  let dispatches = 0;
  let lease: ReturnType<typeof owner.lease> | undefined;
  const phases: string[] = [];
  const refuseClaim = async (phase: string) => {
    const owned = vi.spyOn(owner, 'assertOwned');
    try {
      await expect(
        lease!.claimCheckout({ path: f.repo.root, branch: 'unused', head: f.prs[0].headRefOid }),
      ).rejects.toThrow('admissions closed');
      expect(owned).not.toHaveBeenCalled();
      phases.push(phase);
    } finally {
      owned.mockRestore();
    }
  };
  fsFaults.open = async (path, flags) => {
    if (
      path.endsWith('/pending-000002.json') &&
      typeof flags === 'number' &&
      flags & constants.O_CREAT
    )
      await refuseClaim('closing');
  };
  mutexFaults.afterRelease = async () => refuseClaim('prepared');
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination.endsWith('/000002.json')) {
      await expect(
        lease!.track(async () => {
          dispatches++;
        }),
      ).rejects.toThrow(/admissions closed|owner inactive/);
    }
  };
  try {
    await owner.withLock(async () => {
      lease = owner.lease();
    });
    await refuseClaim('retired');
    expect(phases).toEqual(['closing', 'prepared', 'retired']);
    expect(dispatches).toBe(0);
    fsFaults.open = undefined;
    mutexFaults.afterRelease = undefined;
    fsFaults.link = undefined;
    await (
      await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
    ).withLock(async () => undefined);
  } finally {
    fsFaults.open = undefined;
    mutexFaults.afterRelease = undefined;
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test('post-certificate fsync failure with no further writes fails old result but permits only durable fresh activation', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  let linked = false,
    dispatched = 0;
  const unavailable = () =>
    Object.assign(new Error('all further writes unavailable'), { code: 'EIO' });
  fsFaults.link = async (phase, _source, destination) => {
    if (linked && phase === 'before') throw unavailable();
    if (phase === 'after' && destination.endsWith('/000002.json')) linked = true;
  };
  fsFaults.open = async (_path, flags) => {
    if (
      linked &&
      typeof flags === 'number' &&
      flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)
    )
      throw unavailable();
  };
  fsFaults.sync = async () => {
    if (linked) throw unavailable();
  };
  try {
    await expect(owner.withLock(async () => 'provisional')).rejects.toThrow(
      'all further writes unavailable',
    );
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
    expect(
      (await readdir(authorityStore(owner.guardPath))).some((name) =>
        name.startsWith('quarantined-'),
      ),
    ).toBe(false);
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow('all further writes unavailable');
    expect(dispatched).toBe(0);
    fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
    await (
      await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
    ).withLock(async (fresh) => {
      expect((await authorityState(fresh.guardPath)).state).toBe('active');
      dispatched++;
    });
    expect(dispatched).toBe(1);
    await expect(
      owner.withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow('lifetime already consumed');
  } finally {
    fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
    await f.repo.cleanup();
  }
});

test.each(['release-rejection', 'observed-compromise', 'real-rmdir-rejection'] as const)(
  'entire real mutex completion must succeed before certificate: %s',
  async (mode) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let storageFailed = false,
      callbacks = 0;
    mutexFaults.compromise = mode === 'observed-compromise';
    mutexFaults.releaseFailed = () => {
      storageFailed = true;
    };
    mutexFaults.afterRelease = async () => {
      storageFailed = true;
      if (mode === 'release-rejection') throw new Error('real release boundary rejection');
    };
    fsFaults.open = async (_path, flags) => {
      if (storageFailed && typeof flags === 'number' && flags & constants.O_CREAT)
        throw new Error('no further writes');
    };
    fsFaults.link = async (phase) => {
      if (storageFailed && phase === 'before') throw new Error('no further writes');
    };
    fsFaults.sync = async () => {
      if (storageFailed) throw new Error('no further writes');
    };
    try {
      await expect(
        owner.withLock(async () => {
          callbacks++;
          if (mode === 'real-rmdir-rejection')
            await writeFile(
              join(dirname(owner.guardPath), 'cq-review-address-ownership.lock', 'prevent-rmdir'),
              'real cleanup failure fixture',
            );
        }),
      ).rejects.toThrow(/release.*failed|was compromised/);
      expect(callbacks).toBe(1);
      expect((await authorityState(owner.guardPath)).state).toBe('active');
      expect(await readdir(authorityStore(owner.guardPath))).toContain('pending-000002.json');
      expect(await readdir(authorityStore(owner.guardPath))).not.toContain('000002.json');
      const physical = join(dirname(owner.guardPath), 'cq-review-address-ownership.lock');
      if (mode === 'real-rmdir-rejection') {
        expect((await lstat(physical)).isDirectory()).toBe(true);
        expect(await readFile(join(physical, 'prevent-rmdir'), 'utf8')).toBe(
          'real cleanup failure fixture',
        );
        expect(storageFailed).toBe(true);
      } else await expect(lstat(physical)).rejects.toMatchObject({ code: 'ENOENT' });
      mutexFaults.afterRelease = undefined;
      mutexFaults.releaseFailed = undefined;
      mutexFaults.compromise = false;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          callbacks++;
        }),
      ).rejects.toThrow('attended recovery');
      expect(callbacks).toBe(1);
    } finally {
      mutexFaults.afterRelease = undefined;
      mutexFaults.releaseFailed = undefined;
      mutexFaults.compromise = false;
      fsFaults.open = fsFaults.link = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each(['success', 'old-sync-fails'] as const)(
  'retired publisher validates exact certificate prefix under a real live successor: %s',
  async (mode) => {
    const f = await fixture();
    const old = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const certificate = deferred(),
      resume = deferred(),
      entered = deferred(),
      release = deferred();
    let next: Promise<unknown> | undefined, prior: Promise<unknown> | undefined;
    let staleLease: ReturnType<typeof old.lease> | undefined;
    let oldFailed = false;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase === 'after' && destination.endsWith('/000002.json')) {
        certificate.resolve();
        await resume.promise;
        if (mode === 'old-sync-fails') oldFailed = true;
      }
    };
    fsFaults.sync = async (path) => {
      if (oldFailed && path === authorityStore(old.guardPath))
        throw new Error('old postlink sync failure');
    };
    try {
      prior = old.withLock(async () => {
        staleLease = old.lease();
        return 'old observed result';
      });
      void prior.catch(() => undefined);
      await certificate.promise;
      await expect(
        staleLease!.track(async () => {
          throw new Error('old dispatch');
        }),
      ).rejects.toThrow('admissions closed');
      await expect(staleLease!.assertOwned()).rejects.toThrow('admissions closed');
      const successor = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      next = successor.withLock(async () =>
        successor.lease().track(async () => {
          entered.resolve();
          await release.promise;
          return 'new actual work';
        }),
      );
      void next.catch(() => undefined);
      await entered.promise;
      const active = await authorityState(old.guardPath);
      expect(active.state).toBe('active');
      resume.resolve();
      if (mode === 'success') await expect(prior).resolves.toBe('old observed result');
      else await expect(prior).rejects.toThrow('old postlink sync failure');
      expect(await authorityState(old.guardPath)).toEqual(active);
      expect(
        (await readdir(authorityStore(old.guardPath))).some((name) =>
          name.startsWith('quarantined-'),
        ),
      ).toBe(false);
      fsFaults.sync = undefined;
      release.resolve();
      await next;
    } finally {
      resume.resolve();
      release.resolve();
      oldFailed = false;
      await Promise.allSettled([prior, next]);
      fsFaults.link = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each(['anchor', 'certificate', 'foreign-epoch', 'missing-certificate', 'store'] as const)(
  'postlink prefix corruption is never adopted or repaired: %s',
  async (damage) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const store = authorityStore(owner.guardPath);
    let evidence: string | undefined;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase !== 'after' || !destination.endsWith('/000002.json')) return;
      if (damage === 'anchor') await damageGuard(owner.guardPath, 'replace');
      else if (damage === 'missing-certificate') await unlink(destination);
      else if (damage === 'store') await rename(store, `${store}.foreign-preserved`);
      else {
        const data = JSON.parse(await readFile(destination, 'utf8')) as {
          epoch: string;
          resources: string[];
        };
        if (damage === 'foreign-epoch') data.epoch = randomUUID();
        else data.resources = ['forged-terminal-extra-resource'];
        evidence = JSON.stringify(data);
        await writeFile(destination, evidence);
      }
    };
    try {
      await expect(owner.withLock(async () => 'unconfirmed')).rejects.toThrow(
        /lost owner|attended recovery|ENOENT/,
      );
      fsFaults.link = undefined;
      let dispatched = 0;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          dispatched++;
        }),
      ).rejects.toThrow('attended recovery');
      expect(dispatched).toBe(0);
      if (evidence) expect(await readFile(join(store, '000002.json'), 'utf8')).toBe(evidence);
      if (damage === 'anchor') expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
      if (damage === 'missing-certificate')
        await expect(lstat(join(store, '000002.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (damage === 'store') await expect(lstat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fsFaults.link = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each([
  'certificate-sync',
  'adoption-store-sync',
  'prepare-sync',
  'before-link',
  'after-link',
  'active-store-sync',
] as const)('fresh adoption/activation failure dispatches zero work: %s', async (fault) => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const store = authorityStore(owner.guardPath);
  let activeLinked = false,
    dispatched = 0;
  try {
    await owner.withLock(async () => undefined);
    fsFaults.link = async (phase, _source, destination) => {
      if (!destination.endsWith('/000003.json')) return;
      if (phase === 'after') activeLinked = true;
      if (
        (fault === 'before-link' && phase === 'before') ||
        (fault === 'after-link' && phase === 'after')
      )
        throw new Error('fresh activation fault');
    };
    fsFaults.sync = async (path) => {
      if (
        (fault === 'certificate-sync' && path === join(store, '000002.json')) ||
        (fault === 'adoption-store-sync' && path === store) ||
        (fault === 'prepare-sync' && path === join(store, 'pending-000003.json')) ||
        (fault === 'active-store-sync' && activeLinked && path === store)
      )
        throw new Error('fresh activation fault');
    };
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow(/fresh activation fault|lost owner/);
    expect(dispatched).toBe(0);
    fsFaults.link = fsFaults.sync = undefined;
    const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    if (fault === 'certificate-sync' || fault === 'adoption-store-sync')
      await retry.withLock(async () => {
        dispatched++;
      });
    else
      await expect(
        retry.withLock(async () => {
          dispatched++;
        }),
      ).rejects.toThrow('attended recovery');
    expect(dispatched).toBe(
      fault === 'certificate-sync' || fault === 'adoption-store-sync' ? 1 : 0,
    );
  } finally {
    fsFaults.link = fsFaults.sync = undefined;
    await f.repo.cleanup();
  }
});

test('v2 authority requires attended migration and is never automatically reused', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  try {
    await owner.withLock(async () => undefined);
    const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { version: number };
    anchor.version = 2;
    const evidence = JSON.stringify(anchor);
    await writeFile(owner.guardPath, evidence);
    let failure: unknown,
      dispatched = 0;
    try {
      await (
        await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
      ).withLock(async () => {
        dispatched++;
      });
    } catch (error) {
      failure = error;
    }
    expect(errorChain(failure)).toContain('v2 requires attended migration');
    expect(dispatched).toBe(0);
    expect(await readFile(owner.guardPath, 'utf8')).toBe(evidence);
  } finally {
    await f.repo.cleanup();
  }
});

test('callback values cannot forge completion and retired lease/proof replay cannot reopen admission', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  // Private methods are deliberately reached only here to test runtime brands,
  // not exposed to callers as a production certificate or bypass API.
  const publisher = owner as unknown as { publishCompletion(proof: object): Promise<void> };
  const fake = { owner, sequence: 2, state: 'quiescent' };
  let lease: ReturnType<typeof owner.lease> | undefined;
  let consumed: object | undefined;
  const publish = publisher.publishCompletion.bind(owner);
  const observed = vi.spyOn(publisher, 'publishCompletion').mockImplementation(async (proof) => {
    consumed = proof;
    await publish(proof);
  });
  try {
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    expect(
      await owner.withLock(async () => {
        lease = owner.lease();
        return fake;
      }),
    ).toBe(fake);
    observed.mockRestore();
    expect(consumed).toBeDefined();
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    await expect(
      lease!.track(async () => {
        throw new Error('stale dispatch');
      }),
    ).rejects.toThrow('admissions closed');
    await expect(owner.withLock(async () => undefined)).rejects.toThrow(
      'lifetime already consumed',
    );
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
  } finally {
    observed.mockRestore();
    await f.repo.cleanup();
  }
});

test('a genuine active-guard refusal preserves the owner and returns without report IO', async () => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const journalDir = join(f.root, 'admission-refusal-journal');
  let dispatches = 0;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      const before = await authorityState(owner.guardPath);
      const result = await addressModule.makeReviewAddress({
        config: {
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
          roles: { worker: role, reviewer: role },
          budgets: { run: { maxTokens: 1000 } },
          review: { reviewers: ['agent'] },
        },
        git: f.run,
        review: async () => {
          dispatches++;
          throw new Error('no review expected');
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir, push: true });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') throw new Error('admission was not refused');
      expect(result.reason).toContain('could not acquire');
      expect(result.report?.stop).toBeUndefined();
      expect(dispatches).toBe(0);
      await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await authorityState(owner.guardPath)).toEqual(before);
    });
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
  } finally {
    await f.repo.cleanup();
  }
});

test.each([
  'sync',
  'deferred',
  'unprintable',
  'unprintable-message',
  'forged-admission',
  'nested-admission',
  'late-cleanup',
  'late-budget-facts',
] as const)('address lifetime catch is pure and preserves observed report: %s', async (mode) => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
    roles: { worker: role, reviewer: role },
    budgets: { run: { maxTokens: 1000 } },
    review: { reviewers: ['agent'] },
  };
  const journalDir = join(f.root, 'pure-adapter-journal');
  let closed = false,
    effectsAfterClose = 0;
  const effect = () => {
    if (closed) effectsAfterClose++;
  };
  fsFaults.effect = effect;
  const cause =
    mode === 'unprintable'
      ? {
          toString: () => {
            throw new Error('cannot render');
          },
        }
      : new Error('ownership finalization fixture');
  if (mode === 'forged-admission')
    Object.assign(cause, {
      message: 'could not acquire address ownership: active or quarantined guard',
      admissionRefusal: true,
    });
  if (mode === 'unprintable-message')
    Object.defineProperty(cause, 'message', {
      get: () => {
        throw new Error('cannot read message');
      },
    });
  const late =
    mode === 'late-cleanup' || mode === 'late-budget-facts' || mode === 'nested-admission';
  const facts = mode === 'late-budget-facts';
  const original = ownershipModule.withAddressOwnership;
  const spy = vi.spyOn(ownershipModule, 'withAddressOwnership');
  if (
    mode === 'sync' ||
    mode === 'unprintable' ||
    mode === 'unprintable-message' ||
    mode === 'forged-admission'
  )
    spy.mockImplementation(() => {
      closed = true;
      throw cause;
    });
  else if (mode === 'deferred')
    spy.mockImplementation(async () => {
      await Promise.resolve();
      closed = true;
      throw cause;
    });
  else if (mode === 'nested-admission')
    spy.mockImplementation((opts, action) =>
      original(opts, async (lease) => {
        const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        let refusal: unknown;
        try {
          await contender.withLock(async () => undefined);
        } catch (error) {
          refusal = error;
        }
        expect(ownershipModule.isAddressOwnershipAdmissionRefusal(refusal)).toBe(true);
        await action(lease);
        throw refusal;
      }).catch((error: unknown) => {
        closed = true;
        throw error;
      }),
    );
  else {
    spy.mockImplementation(original);
    mutexFaults.afterRelease = async () => {
      closed = true;
      throw cause;
    };
  }
  try {
    const result = await addressModule.makeReviewAddress({
      config,
      git: async (args) => {
        effect();
        return f.run(args);
      },
      gh: async () => {
        effect();
        throw new Error('no forge expected');
      },
      initialRecord: {
        schemaVersion: 1,
        branch: 'feature/x',
        reviewed: {
          base: f.repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
          scope: 'full',
        },
        head: f.repo.git('rev-parse', 'HEAD').trim(),
        sources: [{ kind: 'agent', status: 'terminal' }],
        findings: facts
          ? ['a', 'b'].map((id) => ({
              id,
              file: `src/${id}.ts`,
              source: 'agent' as const,
              severity: 'major' as const,
              status: 'open' as const,
              text: `fix ${id}`,
            }))
          : [],
        advisories: ['retained review advisory'],
      },
      ...(facts
        ? {
            disposition: async () => {
              effect();
              return { status: 'ok' as const, value: {} };
            },
          }
        : {}),
      workerFactory: (deps) => {
        effect();
        if (!facts) throw new Error('no worker expected');
        return {
          escalation: () => {
            effect();
            return createEscalationState();
          },
          fix: async (item) => {
            effect();
            deps.account({
              stopReason: 'complete',
              usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
              costUSD: 0.25,
              denials: [],
            });
            return {
              finding: { ...item, status: 'deferred' as const, reason: 'needs owner' },
              observedHead: f.repo.git('rev-parse', 'HEAD').trim(),
              reason: 'needs owner',
              validation: [],
            };
          },
        };
      },
      review: async () => {
        effect();
        throw new Error('no review expected');
      },
    })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir,
      ...(facts ? { maxTokens: 10, concurrency: 1 } : {}),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('failed surface required');
    expect(result.error).toContain('finalization failed; durability unconfirmed');
    if (mode === 'unprintable' || mode === 'unprintable-message')
      expect(result.error).toContain('unprintable ownership error');
    expect(result.report?.stop).toBeUndefined();
    expect(result.report?.reasons.filter((reason) => reason === result.error)).toHaveLength(1);
    expect(OpResultArtifactSchema.safeParse(result).success).toBe(true);
    expect(exitCodeForOpResult(result)).toBe(1);
    expect(effectsAfterClose).toBe(0);
    if (late) {
      if (!facts) expect(result.report?.admissionHead).toBe(f.repo.git('rev-parse', 'HEAD').trim());
      const persisted = JSON.parse(
        await readFile(join(journalDir, 'review-address-report.json'), 'utf8'),
      ) as addressModule.ReviewAddressReport;
      expect(persisted.reasons).not.toContain(result.error);
      const { stop: _stop, ...retained } = persisted;
      expect(result.report).toEqual({ ...retained, reasons: [...persisted.reasons, result.error] });
      if (facts) {
        expect(persisted.stop).toBe('budget');
        expect(result.report?.usage).toEqual({
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 2,
        });
        expect(result.report?.costUSD).toBe(0.25);
        expect(result.report?.fixes).toHaveLength(1);
        expect(result.report?.fixes[0]?.finding.status).toBe('deferred');
        expect(result.report?.rounds[0]?.runs).toHaveLength(1);
        expect(result.report?.advisories).toEqual(['retained review advisory']);
      }
    } else await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    spy.mockRestore();
    mutexFaults.afterRelease = undefined;
    fsFaults.effect = undefined;
    await f.repo.cleanup();
  }
});

test('immutable write loss with detached work refuses again after late settlement', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const entered = deferred(),
    release = deferred();
  let actual: Promise<unknown> | undefined;
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'after' && destination.endsWith('/000002.json'))
      await damageGuard(owner.guardPath, 'replace');
  };
  try {
    await expect(
      owner.withLock(async () => {
        actual = owner.lease().track(async () => {
          entered.resolve();
          await release.promise;
          await f.repo.write('survivor.txt', 'late survivor');
        });
        await entered.promise;
        throw new Error('force error-path quarantine while actual work remains');
      }),
    ).rejects.toThrow('force error-path');
    await preservedDamage(owner.guardPath, 'replace');
    fsFaults.link = undefined;
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    release.resolve();
    await actual;
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    await preservedDamage(owner.guardPath, 'replace');
  } finally {
    release.resolve();
    await actual;
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test.each(['records', 'per-record', 'total-bytes', 'resource-count', 'resource-bytes'] as const)(
  'authority writer bound requires attended compaction: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let dispatched = 0,
      failure: unknown;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'bound fixture' };
      });
    try {
      try {
        await owner.withLock(async () => {
          for (let index = 0; index < 65; index++) {
            const unique = bound === 'resource-count' || bound === 'per-record';
            const length =
              bound === 'per-record' || bound === 'total-bytes'
                ? 1900
                : bound === 'resource-bytes'
                  ? 2100
                  : 10;
            await owner.address(
              {
                pr: unique ? index + 1 : 7,
                head: f.prs[0].headRefOid,
                headRepo: 'fixture/base',
                headRefName: `${'x'.repeat(length)}${unique ? index : ''}`,
              },
              { repoRoot: f.repo.root, source: `pr:${unique ? index + 1 : 7}` },
            );
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('bound reached; attended compaction required');
      const names = (await readdir(authorityStore(owner.guardPath)))
        .filter((name) => /^[0-9]{6}\.json$/.test(name))
        .sort();
      const records = await Promise.all(
        names.map((name) => readFile(join(authorityStore(owner.guardPath), name))),
      );
      expect(names.length).toBeLessThanOrEqual(64);
      expect(records.every((record) => record.length <= 16_384)).toBe(true);
      expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThanOrEqual(131_072);
      const last = JSON.parse(records.at(-1)!.toString()) as { resources: string[] };
      expect(last.resources.length).toBeLessThanOrEqual(64);
      expect(last.resources.every((key) => Buffer.byteLength(key) <= 2048)).toBe(true);
      if (bound === 'records') expect(names.length).toBe(64);
      if (bound === 'resource-count') expect(last.resources.length).toBe(64);
      if (bound === 'resource-bytes') expect(dispatched).toBe(0);
      if (bound === 'per-record') {
        expect(last.resources.length).toBe(16);
        expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThan(131_072);
      }
      if (bound === 'total-bytes') {
        const total =
          records.reduce((sum, record) => sum + record.length, 0) +
          (await readFile(owner.guardPath)).length;
        expect(total).toBeLessThanOrEqual(131_072);
        expect(total + records.at(-1)!.length).toBeGreaterThan(131_072);
      }
      expect(dispatched).toBeLessThan(65);
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('attended recovery');
    } finally {
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
  120_000, // Bounded 64-record real-filesystem history; do not leave timed-out work running.
);

test.each(['anchor-bytes', 'record-bytes', 'total-bytes', 'enumeration'] as const)(
  'authority reader bounds allocation before parsing: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    try {
      await owner.withLock(async () => undefined);
      if (bound === 'anchor-bytes') await writeFile(owner.guardPath, '!'.repeat(257));
      else if (bound === 'record-bytes')
        await writeFile(join(authorityStore(owner.guardPath), '000001.json'), '!'.repeat(16_385));
      else if (bound === 'total-bytes') {
        const store = authorityStore(owner.guardPath);
        const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
        let previous = createHash('sha256')
          .update(await readFile(join(store, '000002.json')))
          .digest('hex');
        const epoch = randomUUID();
        for (let sequence = 3; sequence <= 63; sequence++) {
          const bytes = JSON.stringify({
            version: 3,
            anchor: anchor.anchor,
            sequence,
            previous,
            epoch,
            state: 'active',
            resources: sequence === 3 ? [] : ['x'.repeat(2048)],
          });
          const name = `${String(sequence).padStart(6, '0')}.json`;
          await writeFile(join(store, `pending-${name}`), bytes);
          await link(join(store, `pending-${name}`), join(store, name));
          previous = createHash('sha256').update(bytes).digest('hex');
        }
      } else
        for (let sequence = 3; sequence <= 65; sequence++) {
          const pending = join(
            authorityStore(owner.guardPath),
            `pending-${String(sequence).padStart(6, '0')}.json`,
          );
          await writeFile(pending, '!');
          await link(
            pending,
            join(authorityStore(owner.guardPath), `${String(sequence).padStart(6, '0')}.json`),
          );
        }
      let failure: unknown;
      try {
        await (
          await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
        ).withLock(async () => undefined);
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('bound reached; attended compaction required');
      expect(errorChain(failure)).not.toContain('SyntaxError');
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('a dirty stale PR refuses while its sibling resolves without changing caller or foreign worktrees', async () => {
  const f = await fixture();
  try {
    const stale = await f.resolve(f.prs[0]);
    await writeFile(join(stale.path, 'README.md'), 'unpublished PR 7 work\n');
    const entriesBefore = await fileWorktreeRegistry(f.registryPath).load();
    // The PR advances after its first checkout; refreshing must preserve dirty work.
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    const foreign = join(f.root, 'foreign');
    f.repo.git('worktree', 'add', '-q', '-b', 'foreign-fixture', foreign, f.prs[0].headRefOid);
    for (const path of [f.repo.root, foreign]) {
      await writeFile(join(path, 'src/a.ts'), 'export const staged = 3;\n');
      f.repo.git('-C', path, 'add', '--', 'src/a.ts');
      await writeFile(join(path, 'README.md'), 'unstaged caller-owned work\n');
      await writeFile(join(path, 'private-note.txt'), `untracked content in ${path}\n`);
    }
    const callerBefore = await checkoutSnapshot(f.repo, f.repo.root);
    const foreignBefore = await checkoutSnapshot(f.repo, foreign);
    const [refused, sibling] = await Promise.allSettled([f.resolve(f.prs[0]), f.resolve(f.prs[1])]);
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') throw new Error('dirty stale PR unexpectedly resolved');
    expect(refused.reason).toBeInstanceOf(Error);
    expect((refused.reason as Error).message).toMatch(/modified|untracked|dirty/i);
    expect(sibling.status).toBe('fulfilled');
    if (sibling.status !== 'fulfilled') throw sibling.reason;
    expect(sibling.value.path).not.toBe(stale.path);
    expect(sibling.value.branch).not.toBe(stale.branch);
    expect(f.repo.git('-C', sibling.value.path, 'rev-parse', 'HEAD').trim()).toBe(
      f.prs[1].headRefOid,
    );
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(entries['7']).toEqual(entriesBefore['7']);
    expect(entries['9']).toEqual({
      path: sibling.value.path,
      branch: sibling.value.branch,
      createdAt: NOW + 9,
    });
    expect(f.repo.git('-C', stale.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
    expect(await readFile(join(stale.path, 'README.md'), 'utf8')).toBe('unpublished PR 7 work\n');
    expect(await checkoutSnapshot(f.repo, f.repo.root)).toEqual(callerBefore);
    expect(await checkoutSnapshot(f.repo, foreign)).toEqual(foreignBefore);
  } finally {
    await f.repo.cleanup();
  }
});

test('bulk clone isolation gives sibling legs independent common directories and preserves origin', async () => {
  const repo = await identityRepo();
  try {
    const roots = await Promise.all([
      isolateAddressMany(repo.root, 7, {
        cloneRoot: join(dirname(repo.root), 'clones'),
        target: 'merge-queue',
      }),
      isolateAddressMany(repo.root, 9, {
        cloneRoot: join(dirname(repo.root), 'clones'),
        target: 'merge-queue',
      }),
    ]);
    const common = roots.map((root) =>
      repo.git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    expect(new Set(common).size).toBe(2);
    expect(common).not.toContain(
      repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    for (const root of roots)
      expect(repo.git('-C', root, 'remote', 'get-url', 'origin')).toBe(
        repo.git('remote', 'get-url', 'origin'),
      );
  } finally {
    await repo.cleanup();
  }
});

test('bulk clones refresh the remote target even when the caller local main is stale', async () => {
  const repo = await identityRepo();
  try {
    const old = repo.git('rev-parse', 'origin/merge-queue').trim();
    const current = repo.git('rev-parse', 'HEAD').trim();
    repo.git('branch', '-f', 'main', old);
    repo.git('push', 'origin', `${current}:refs/heads/main`);
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
    });
    expect(repo.git('-C', root, 'rev-parse', 'origin/main').trim()).toBe(current);
    expect(repo.git('rev-parse', 'main').trim()).toBe(old);
  } finally {
    await repo.cleanup();
  }
});

test('clone retains effective author and committer identity configured only in the caller', async () => {
  const repo = await identityRepo();
  try {
    repo.git('config', 'user.name', 'Repository User');
    repo.git('config', 'user.email', 'repo@example.invalid');
    repo.git('config', 'author.name', 'Repository Author');
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
      target: 'merge-queue',
    });
    // TestRepo supplies an environment identity; inspect the copied configuration itself.
    expect(repo.git('-C', root, 'config', 'author.name').trim()).toBe('Repository Author');
    expect(repo.git('-C', root, 'config', 'author.email').trim()).toBe('repo@example.invalid');
    expect(repo.git('-C', root, 'config', 'committer.name').trim()).toBe('Repository User');
  } finally {
    await repo.cleanup();
  }
});

test('failed isolation removes its partial clone directory', async () => {
  const repo = await identityRepo();
  try {
    const cloneRoot = join(dirname(repo.root), 'clones');
    await expect(
      isolateAddressMany(repo.root, 7, { cloneRoot, target: 'missing-target' }),
    ).rejects.toThrow();
    expect(await readdir(cloneRoot)).toEqual([]);
  } finally {
    await repo.cleanup();
  }
});

test.each(['credential.helper', 'commit.gpgsign', 'gpg.format', 'user.signingkey'])(
  'bulk explicitly refuses repository-local %s without copying its value',
  async (key) => {
    const repo = await identityRepo();
    try {
      repo.git('config', key, 'local-sensitive-setting');
      await expect(
        isolateAddressMany(repo.root, 7, { cloneRoot: join(dirname(repo.root), 'clones') }),
      ).rejects.toThrow('require plain review.address');
    } finally {
      await repo.cleanup();
    }
  },
);

test.each(['--local', '--worktree'])(
  'bulk refuses URL-scoped HTTP auth in %s config without copying its value',
  async (scope) => {
    const repo = await identityRepo();
    try {
      repo.git('config', 'extensions.worktreeConfig', 'true');
      repo.git('config', scope, 'http.https://github.com/.extraheader', 'auth-fixture-value');
      await expect(
        isolateAddressMany(repo.root, 7, { cloneRoot: join(dirname(repo.root), 'clones') }),
      ).rejects.toThrow('require plain review.address');
    } finally {
      await repo.cleanup();
    }
  },
);

test('ordinary repositories with linked worktrees do not require worktree config support', async () => {
  const repo = await identityRepo();
  try {
    repo.git('worktree', 'add', '--detach', join(dirname(repo.root), 'linked'), 'HEAD');
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
    });
    expect(repo.git('-C', root, 'rev-parse', 'origin/main')).toBe(
      repo.git('rev-parse', 'origin/main'),
    );
  } finally {
    await repo.cleanup();
  }
});

test('missing effective caller identity is a needs-human leg with no dispatch', async () => {
  const repo = await identityRepo();
  try {
    vi.stubEnv('GIT_AUTHOR_NAME', '');
    const address = vi.fn();
    const gh = async (args: string[]) => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'repo'
          ? { nameWithOwner: 'owner/repo' }
          : {
              number: 1,
              state: 'open',
              merged: false,
              draft: false,
              user: { login: 'owner', type: 'User' },
              head: { sha: 'a'.repeat(40), ref: 'feature/x', repo: { full_name: 'owner/repo' } },
            },
      ),
    });
    const result = await makeReviewAddressMany({ gh, address })({
      repoRoot: repo.root,
      repo: 'owner/repo',
      owner: 'owner',
      pulls: [1],
      maxTokens: 100,
      tokensPerPr: 50,
    });
    expect(result.status).toBe('needs-human');
    const leg = result.report?.rows[0]?.result;
    expect(leg?.status).toBe('needs-human');
    if (leg?.status === 'needs-human') expect(leg.reason).toContain('caller author identity');
    expect(address).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await repo.cleanup();
  }
});
function terminalReport(path: string): ReviewAddressReport {
  return {
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
function terminalInput(repo: TestRepo) {
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

test.each(['success', 'report-failure', 'owner-loss', 'alias', 'alias-caught', 'opaque'] as const)(
  'cancelled bulk participants drain every actual writer before shared reports: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const started = [deferred(), deferred()],
      arrive = deferred(),
      releaseWriter = deferred(),
      aliasDetected = deferred(),
      firstWriterReady = deferred();
    const alias = mode === 'alias' || mode === 'alias-caught';
    const writers: Promise<unknown>[] = [];
    const reports = [
      terminalReport(join(f.root, 'terminal-seven.json')),
      terminalReport(join(f.root, 'terminal-nine.json')),
    ];
    if (alias) reports[1]!.reportPath = reports[0]!.reportPath;
    let owner: Awaited<ReturnType<typeof makeAddressOwnership>>;
    let reportWrites = 0;
    let terminalReturns = 0;
    const reportOrder: string[] = [];
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        if (index === 1 && (mode === 'report-failure' || alias)) await firstWriterReady.promise;
        return withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            try {
              await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            } catch (error) {
              aliasDetected.resolve();
              if (mode === 'alias-caught')
                return { status: 'needs-human' as const, reason: 'caught alias fixture' };
              throw error;
            }
            writers.push(
              lease.track(async () => {
                if (mode === 'opaque' && index === 0)
                  ownershipModule.noteAddressOpaqueInvocation(lease);
                started[index]!.resolve();
                if (index === 0) firstWriterReady.resolve();
                try {
                  await releaseWriter.promise;
                } finally {
                  await writeFile(
                    join(f.root, `actual-finally-${index}`),
                    'writer finally settled',
                  );
                }
              }),
            );
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease).finally(() => {
              terminalReturns++;
            });
          },
        );
      });
    let pending: Promise<unknown> | undefined;
    try {
      owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      fsFaults.open = async (path, flags) => {
        if (
          (path === reports[0]!.reportPath || path === reports[1]!.reportPath) &&
          typeof flags === 'number' &&
          flags & constants.O_CREAT
        ) {
          reportWrites++;
          reportOrder.push(path);
          if (mode === 'report-failure' && path === reports[1]!.reportPath)
            throw new Error('terminal report persistence fault');
        }
      };
      pending = owner.withLock(async () => {
        const children = [7, 9].map((pr, index) =>
          owner.address(
            {
              pr,
              head: f.prs[index]!.headRefOid,
              headRepo: 'fixture/base',
              headRefName: `fixture-distinct-${pr}`,
            },
            { repoRoot: f.repo.root, source: `pr:${pr}` },
          ),
        );
        // Observe rejection immediately; alias refusal can precede cancellation.
        const outcomes = Promise.allSettled(children);
        if (alias) {
          await aliasDetected.promise;
          parent.abort();
          arrive.resolve();
          return outcomes.then((rows) => {
            if (mode === 'alias-caught') return;
            if (rows.some((row) => row.status === 'rejected'))
              throw new Error('terminal report target alias');
          });
        }
        await Promise.all(started.map((entry) => entry.promise));
        parent.abort();
        arrive.resolve();
        return Promise.all(children);
      });
      const observed = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (alias) await aliasDetected.promise;
      else await Promise.all(started.map((entry) => entry.promise));
      await arrive.promise;
      // Child control arrivals alone cannot settle an actual writer/finally.
      expect(reportWrites).toBe(0);
      expect(terminalReturns).toBe(0);
      await expect(lstat(reports[0]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await authorityState(owner.guardPath)).state).toBe('active');
      if (mode === 'owner-loss') await damageGuard(owner.guardPath, 'replace');
      releaseWriter.resolve();
      const outcome = await observed;
      await Promise.allSettled(writers);
      expect(await readFile(join(f.root, 'actual-finally-0'), 'utf8')).toContain('settled');
      if (mode === 'success') {
        expect(outcome).toHaveProperty('value');
        for (let index = 0; index < 2; index++) {
          expect(await readFile(join(f.root, `actual-finally-${index}`), 'utf8')).toContain(
            'settled',
          );
          const report = JSON.parse(
            await readFile(reports[index]!.reportPath, 'utf8'),
          ) as ReviewAddressReport;
          expect(report.reasons).toEqual(['parent cancelled']);
          expect(report.failed).toEqual([]);
        }
        expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('error');
        if (mode === 'report-failure') {
          if ('error' in outcome)
            expect(String(outcome.error)).toContain('terminal report persistence fault');
          expect(reportOrder).toEqual(reports.map((report) => report.reportPath));
          expect(
            (JSON.parse(await readFile(reports[0]!.reportPath, 'utf8')) as ReviewAddressReport)
              .reasons,
          ).toEqual(['parent cancelled']);
          await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
        } else {
          expect(reportWrites).toBe(0);
          expect(reportOrder).toEqual([]);
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
          if (alias && 'error' in outcome) expect(String(outcome.error)).toContain('alias');
        }
      }
    } finally {
      releaseWriter.resolve();
      arrive.resolve();
      firstWriterReady.resolve();
      await Promise.allSettled([...writers, ...(pending ? [pending] : [])]);
      fsFaults.open = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test('terminal binding rejects structural, replayed and retired capabilities without dispatch', async () => {
  const f = await fixture();
  let binding: object | undefined, attempt: object | undefined;
  try {
    expect(() => ownershipModule.recordAddressTerminalAttempt({}, terminalInput(f.repo))).toThrow(
      'forged worker',
    );
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async (lease) => {
        binding = ownershipModule.addressTerminalWorkerBinding(lease);
        attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        expect(() => ownershipModule.deferAddressTerminalAttempt({}, attempt!)).toThrow(
          'forged worker',
        );
        expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(false);
      },
    );
    await expect(
      ownershipModule.recordAddressTerminalAttempt(binding!, terminalInput(f.repo)),
    ).rejects.toThrow('after close');
    expect(() =>
      ownershipModule.addressTerminalWorkerBinding(
        {} as Parameters<typeof ownershipModule.addressTerminalWorkerBinding>[0],
      ),
    ).toThrow('forged worker lease');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['snapshot', 'total', 'receipts', 'report'] as const)(
  'terminal bounds refuse before retaining excess evidence or writing a report: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-bound-report.json'));
    try {
      if (mode === 'snapshot' || mode === 'total') {
        await f.repo.write(
          'src/a.ts',
          Buffer.alloc(4 * 1024 * 1024 + (mode === 'snapshot' ? 1 : 0), 65),
        );
        f.repo.commitAll('bounded raw baseline');
      }
      await expect(
        withAddressOwnership(
          {
            repoRoot: f.repo.root,
            git: f.run,
            source: 'local',
            production: false,
            signal: parent.signal,
          },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, report);
            const binding = ownershipModule.addressTerminalWorkerBinding(lease);
            if (mode === 'report') {
              report.reasons.push('x'.repeat(16 * 1024 * 1024 + 1));
              parent.abort();
              return ownershipModule.addressCancelledResult(lease);
            }
            const count = mode === 'receipts' ? 65 : mode === 'total' ? 9 : 1;
            for (let index = 0; index < count; index++)
              await ownershipModule.recordAddressTerminalAttempt(binding, terminalInput(f.repo));
            throw new Error('bound failed to refuse');
          },
        ),
      ).rejects.toThrow(/bound/);
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    } finally {
      await f.repo.cleanup();
    }
  },
);

test.each([
  'stdout',
  'stderr',
  'post-spawn-error',
  'spawn-failure',
  'timeout',
  'no-close',
] as const)(
  'terminal subprocess refusal retains registration until actual close: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-process-report.json'));
    const closeHeld = deferred(),
      releaseClose = deferred();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let child: ChildProcess | undefined,
      used = false,
      resultSettled = false;
    const longTimers: Array<() => void> = [];
    let timerSpy: { mockRestore(): void } | undefined;
    const actualSetTimeout = globalThis.setTimeout;
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'));
    let pending: Promise<unknown> | undefined;
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED partial bytes\n');
          if (mode === 'timeout' || mode === 'no-close')
            timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
              handler: (...args: unknown[]) => void,
              delay?: number,
              ...args: unknown[]
            ) => {
              if (typeof handler === 'function' && delay && delay > 59_000)
                longTimers.push(() => handler(...args));
              return actualSetTimeout(handler, delay, ...args);
            }) as unknown as typeof setTimeout);
          terminalProcessFaults.spawn = (_command, _args, options) => {
            if (used) return undefined;
            used = true;
            if (mode === 'spawn-failure') {
              closeHeld.resolve();
              throw new Error('fixed fixture synchronous spawn failure');
            }
            // These constant programs cannot access a provider or network. The
            // parent test delays observed close, never treats exit as settlement.
            const script =
              mode === 'stdout'
                ? 'process.stdout.write(Buffer.alloc(8*1024*1024+1,65));'
                : mode === 'stderr'
                  ? 'process.stderr.write(Buffer.alloc(64*1024+1,66));'
                  : 'setTimeout(()=>{},10000);';
            child = actual.spawn(process.execPath, ['-e', script], options);
            const emit = child.emit;
            child.emit = function (event: string | symbol, ...args: unknown[]): boolean {
              if (event === 'close') {
                closeHeld.resolve();
                void releaseClose.promise.then(
                  () => {
                    Reflect.apply(emit, this, [event, ...args]) as boolean;
                  },
                  () => undefined,
                );
                return true;
              }
              return Reflect.apply(emit, this, [event, ...args]) as boolean;
            };
            if (mode === 'timeout' || mode === 'no-close')
              queueMicrotask(() => longTimers.at(-1)!());
            if (mode === 'post-spawn-error')
              child.once('spawn', () => {
                child!.emit('error', new Error('fixed fixture post-spawn error'));
                child!.kill('SIGKILL');
              });
            return child;
          };
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      await closeHeld.promise;
      if (mode === 'no-close') {
        longTimers[0]!(); // Availability failure is not process settlement.
        expect(await outcome).toHaveProperty('error');
        const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        await expect(retry.withLock(async () => undefined)).rejects.toThrow(
          'active or quarantined',
        );
      }
      if (mode !== 'spawn-failure') {
        if (mode !== 'no-close') expect(resultSettled).toBe(false);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          'CANCELLED partial bytes\n',
        );
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe(
          '',
        );
      }
      releaseClose.resolve();
      const result = await outcome;
      expect(result).toHaveProperty('error');
      expect(
        (await authorityState(join(f.repo.root, '.git', 'cq-review-address-ownership.owner.json')))
          .state,
      ).not.toBe('quiescent');
      expect(await readFile(join(f.repo.root, 'src/a.ts'))).not.toEqual(baseline);
    } finally {
      terminalProcessFaults.spawn = undefined;
      releaseClose.resolve();
      timerSpy?.mockRestore();
      child?.kill('SIGKILL');
      await Promise.allSettled(pending ? [pending] : []);
      await new Promise<void>((done) => setImmediate(done));
      await f.repo.cleanup();
    }
  },
);

test('pending actual writer exceeds drain bound without terminal IO and late settle cannot reopen authority', async () => {
  const f = await fixture();
  const parent = new AbortController(),
    release = deferred(),
    entered = deferred();
  const report = terminalReport(join(f.root, 'pending-terminal-report.json'));
  let writer: Promise<unknown> | undefined,
    elapsed = 0;
  const actualNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + elapsed);
  try {
    await expect(
      withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          writer = lease.track(async () => {
            entered.resolve();
            await release.promise;
            await writeFile(join(f.root, 'late-finally'), 'settled');
          });
          await entered.promise;
          parent.abort();
          const cancelled = ownershipModule.addressCancelledResult(lease);
          elapsed = 60_001;
          return cancelled;
        },
      ),
    ).rejects.toThrow('actual writers/control arrivals unresolved');
    await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    release.resolve();
    await writer;
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    release.resolve();
    await writer;
    clock.mockRestore();
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  'closed participant stays immutable; late receipt cannot be reclaimed: %s',
  async (late) => {
    const f = await fixture();
    const parent = new AbortController();
    const closed = deferred(),
      entered = deferred(),
      arrive = deferred(),
      release = deferred(),
      secondReady = deferred();
    const reports = [
      terminalReport(join(f.root, 'closed-terminal.json')),
      terminalReport(join(f.root, 'open-terminal.json')),
    ];
    reports[0]!.reasons.push('already returned before cancellation');
    let actual: Promise<unknown> | undefined;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        const result = await withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            if (index === 0) {
              if (late) {
                const binding = ownershipModule.addressTerminalWorkerBinding(lease);
                const attempt = await ownershipModule.recordAddressTerminalAttempt(
                  binding,
                  terminalInput(f.repo),
                );
                actual = lease.track(async () => {
                  entered.resolve();
                  await release.promise;
                  ownershipModule.deferAddressTerminalAttempt(binding, attempt);
                });
                void actual.catch(() => undefined);
                await entered.promise;
              }
              await writeFile(reports[0]!.reportPath, 'immutable closed participant report');
              return {
                status: 'needs-human' as const,
                reason: 'already closed',
                report: reports[0]!,
              };
            }
            secondReady.resolve();
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease);
          },
        );
        if (index === 0) closed.resolve();
        return result;
      });
    let pending: Promise<unknown> | undefined;
    try {
      const owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      pending = owner.withLock(async () => {
        const first = owner.address(
          {
            pr: 7,
            head: f.prs[0].headRefOid,
            headRepo: 'fixture/base',
            headRefName: 'closed-seven',
          },
          { repoRoot: f.repo.root, source: 'pr:7' },
        );
        void first.catch(() => undefined);
        await closed.promise;
        const second = owner.address(
          { pr: 9, head: f.prs[1].headRefOid, headRepo: 'fixture/base', headRefName: 'open-nine' },
          { repoRoot: f.repo.root, source: 'pr:9' },
        );
        const outcomes = Promise.allSettled([first, second]);
        await secondReady.promise;
        parent.abort();
        arrive.resolve();
        release.resolve();
        const rows = await outcomes;
        const rejected = rows.find((row) => row.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        return rows;
      });
      const outcome = await pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(await readFile(reports[0]!.reportPath, 'utf8')).toBe(
        'immutable closed participant report',
      );
      expect(reports[0]!.reasons).toEqual(['already returned before cancellation']);
      if (late) {
        expect(outcome).toHaveProperty('error');
        await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('value');
        expect(
          (JSON.parse(await readFile(reports[1]!.reportPath, 'utf8')) as ReviewAddressReport)
            .reasons,
        ).toEqual(['parent cancelled']);
      }
    } finally {
      arrive.resolve();
      release.resolve();
      await Promise.allSettled([...(actual ? [actual] : []), ...(pending ? [pending] : [])]);
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test.each([
  'head',
  'index',
  'foreign-file',
  'path',
  'mode',
  'cancel-again',
  'restore-io',
  'cleanup-owner-loss',
] as const)(
  'terminal evidence guards preserve changed caller state or honest prior ref effects: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-identity-report.json'));
    const before = f.repo.git('rev-parse', 'HEAD').trim();
    let expectedHead = before;
    try {
      const pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW CANCELLED PARTIAL\n');
          if (mode === 'head') expectedHead = f.repo.commitAll('foreign head movement');
          if (mode === 'index') f.repo.git('add', '--', 'src/a.ts');
          if (mode === 'foreign-file')
            await writeFile(join(f.repo.root, 'README.md'), 'foreign bytes retained');
          if (mode === 'path') {
            await rename(join(f.repo.root, 'src/a.ts'), join(f.root, 'preserved-original-file'));
            await writeFile(join(f.repo.root, 'src/a.ts'), 'replacement bytes retained');
          }
          if (mode === 'mode') {
            const actual =
              await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            await actual.chmod(join(f.repo.root, 'src/a.ts'), 0o755);
          }
          if (mode === 'restore-io')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                throw new Error('terminal restore IO fault');
            };
          if (mode === 'cleanup-owner-loss')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                await damageGuard(
                  join(f.repo.root, '.git', 'cq-review-address-ownership.owner.json'),
                  'replace',
                );
            };
          if (mode === 'cancel-again')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                parent.abort();
            };
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      if (mode === 'cancel-again') {
        const result = await pending;
        expect(result.status).toBe('needs-human');
        expect(report.failed).toHaveLength(1);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      } else {
        await expect(pending).rejects.toThrow(/terminal|owner|authority/);
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          mode === 'path' ? 'replacement bytes retained' : 'RAW CANCELLED PARTIAL\n',
        );
        if (mode === 'restore-io' || mode === 'cleanup-owner-loss') {
          expect(report.failed).toHaveLength(1);
          expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
            'RAW CANCELLED PARTIAL\n',
          );
        } else expect(report.failed).toEqual([]);
      }
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(expectedHead);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'terminal-fixture/*')).toBe('');
    } finally {
      fsFaults.open = undefined;
      await f.repo.cleanup();
    }
  },
);

test('RAW terminal plumbing never invokes configured clean/smudge filters or hooks', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'raw-terminal-report.json'));
  const marker = join(f.root, 'forbidden-helper-marker');
  const helper = join(f.root, 'fixed-filter.cjs');
  try {
    await f.repo.write('.gitattributes', 'src/a.ts filter=terminalfixture\n');
    f.repo.commitAll('raw attribute fixture');
    await writeFile(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'helper invoked'); process.stdin.pipe(process.stdout);`,
    );
    f.repo.git('config', 'filter.terminalfixture.clean', `${process.execPath} ${helper}`);
    f.repo.git('config', 'filter.terminalfixture.smudge', `${process.execPath} ${helper}`);
    const hooks = join(f.root, 'configured-hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'post-index-change');
    await writeFile(
      hook,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'hook invoked');\n`,
    );
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actualFs.chmod(hook, 0o755);
    f.repo.git('config', 'core.hooksPath', hooks);
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW retained bytes\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('cat-file', 'blob', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
      'RAW retained bytes\n',
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.repo.cleanup();
  }
});

// Counter-bound fixtures use deterministic streams, not OS-child lifetime
// evidence. The separate fixed-Node cases above exercise real close/kill.
function boundedFixtureProcess(output: string, code = 0): ChildProcess {
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

test.each(['commands', 'ref-creations'] as const)(
  'terminal helper work has a finite per-receipt bound: %s',
  async (bound) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-command-bound.json'));
    let updates = 0,
      shows = 0;
    try {
      await expect(
        withAddressOwnership(
          {
            repoRoot: f.repo.root,
            git: f.run,
            source: 'local',
            production: false,
            signal: parent.signal,
          },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, report);
            const binding = ownershipModule.addressTerminalWorkerBinding(lease);
            const input = terminalInput(f.repo);
            const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
            await writeFile(join(f.repo.root, 'src/a.ts'), 'BOUNDED PARTIAL\n');
            terminalProcessFaults.spawn = (_command, args) => {
              if (bound === 'commands') {
                if (args.includes('for-each-ref')) {
                  const base = args.at(-1)!;
                  return boundedFixtureProcess(
                    Array.from({ length: 600 }, (_, index) => `${base}a${index + 1}`).join('\n'),
                  );
                }
                if (args.includes('show')) {
                  shows++;
                  const identity = Buffer.from(
                    JSON.stringify(['review', input.slug, input.finding]),
                  ).toString('base64url');
                  return boundedFixtureProcess(`Cq-Ref-Identity: ${identity}\n`);
                }
              } else {
                if (args.includes('update-ref')) {
                  updates++;
                  return boundedFixtureProcess('', 1);
                }
                if (args.includes('rev-parse') && args.includes('--verify'))
                  return boundedFixtureProcess(`${input.parent}\n`);
              }
              return undefined;
            };
            parent.abort();
            ownershipModule.deferAddressTerminalAttempt(binding, attempt);
            return ownershipModule.addressCancelledResult(lease);
          },
        ),
      ).rejects.toThrow(bound === 'commands' ? 'command/time bound' : 'branch collision limit');
      if (bound === 'commands') {
        expect(shows).toBeGreaterThan(400);
        expect(shows).toBeLessThan(512);
      } else expect(updates).toBe(32);
      expect(report.failed).toEqual([]);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BOUNDED PARTIAL\n');
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/terminal-fixture/'),
      ).toBe('');
    } finally {
      terminalProcessFaults.spawn = undefined;
      await f.repo.cleanup();
    }
  },
);

// Regression: a real sibling commit is allowed, but its source bytes are never restored.
test.each([false, true])(
  'cancelled edit accepts a verified sibling successor (unignored bookkeeping=%s)',
  async (bookkeeping) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'successor-cancel.json'));
    try {
      let successor = '';
      const result = await withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const input = terminalInput(f.repo);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
          const edited = deferred(),
            committed = deferred();
          await Promise.all([
            (async () => {
              await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
              edited.resolve();
              await committed.promise;
            })(),
            (async () => {
              await edited.promise;
              await writeFile(join(f.repo.root, 'src/sibling.ts'), 'VERIFIED SIBLING\n');
              f.repo.git('add', '--', 'src/sibling.ts');
              f.repo.git('commit', '-m', 'verified sibling');
              successor = f.repo.git('rev-parse', 'HEAD').trim();
              await ownershipModule.checkpointAddressTerminalWorker(
                binding,
                f.repo.root,
                successor,
              );
              committed.resolve();
            })(),
          ]);
          if (bookkeeping) {
            await mkdir(join(f.repo.root, '.cq'), { recursive: true });
            const entries = new Map<string, string>();
            for (const name of ['findings.json', 'ledger.json']) {
              const path = join(f.repo.root, '.cq', name);
              await writeFile(path, '{}\n');
              entries.set(path, createHash('sha256').update('{}\n').digest('hex'));
            }
            await ownershipModule.addressTerminalBookkeeping(lease, f.repo.root, entries);
          }
          parent.abort();
          ownershipModule.deferAddressTerminalAttempt(binding, attempt);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      expect(result.status).toBe('needs-human');
      expect(report.failed).toHaveLength(1);
      expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(await readFile(join(f.repo.root, 'src/sibling.ts'), 'utf8')).toBe(
        'VERIFIED SIBLING\n',
      );
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(successor);
      // A successful cancellation releases admission rather than quarantining it.
      await withAddressOwnership(
        { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
        async () => {},
      );
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('cancellation adopts the ordinary report and removes an owned candidate after admissions stop', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'ordinary-cancel.json'));
  const candidate = join(f.root, 'owned-candidate');
  try {
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        f.repo.git('worktree', 'add', '--detach', candidate, 'HEAD');
        await ownershipModule.addressTerminalCandidate(binding, f.repo.root, candidate, false);
        const bytes = JSON.stringify(report);
        // The abort lands before the ordinary write promise returns to finish().
        await writeFile(report.reportPath, bytes).then(() => parent.abort());
        await ownershipModule.addressOrdinaryReport(lease, report.reportPath, bytes);
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        await ownershipModule.addressTerminalCandidate(binding, f.repo.root, candidate, true);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(
      (JSON.parse(await readFile(report.reportPath, 'utf8')) as ReviewAddressReport).reasons,
    ).toContain('parent cancelled');
    await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain(candidate);
  } finally {
    await f.repo.cleanup();
  }
});
