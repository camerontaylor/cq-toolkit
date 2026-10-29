import { readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
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
        await expect(stale!()).rejects.toThrow('owner inactive');
        await expect(owner.withLock(async () => undefined)).rejects.toThrow(
          'lifetime already consumed',
        );
      } else {
        await expect(runReviewLoop(opts)).rejects.toThrow('stop before mutable resolution');
      }
      expect(visited).toBe(true);
      expect((JSON.parse(await readFile(owner.guardPath, 'utf8')) as { state: string }).state).toBe(
        'quarantined',
      );
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
    expect((JSON.parse(await readFile(owner.guardPath, 'utf8')) as { state: string }).state).toBe(
      'quarantined',
    );
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
    expect((JSON.parse(await readFile(owner.guardPath, 'utf8')) as { state: string }).state).toBe(
      'quarantined',
    );
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

test('parent abort and replaced ownership guard refuse subsequent tracked mutations', async () => {
  for (const fault of ['abort', 'guard'] as const) {
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
          await owner.lease().track(async () => {
            mutations++;
          });
        }),
      ).rejects.toThrow(/parent fixture cancelled|lost owner/);
      expect(mutations).toBe(0);
      const guard = JSON.parse(await readFile(owner.guardPath, 'utf8')) as {
        state: string;
        epoch: string;
      };
      expect(guard.state).toBe(fault === 'abort' ? 'quarantined' : 'active');
      if (fault === 'guard') expect(guard.epoch).toBe('foreign');
      const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    } finally {
      await f.repo.cleanup();
    }
  }
});

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
