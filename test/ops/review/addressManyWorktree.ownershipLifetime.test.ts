import {
  withAddressOwnership as withCheckoutOwnership,
  runAddressReviewLoop as runCheckoutReviewLoop,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import { runReviewLoop, type ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { FixReviewItemInputSchema } from '../../../src/ops/review/registry.js';
import {
  makeAddressOwnership,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';

import { NOW, authorityState, deferred, fixture } from './addressManyWorktree.helpers.js';

test('direct loop owns lifetime; only a live private bridge reenters and inherited callbacks cannot replay', async () => {
  for (const viaAddress of [false, true]) {
    const f = await fixture();
    try {
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
        registry: slotWorktreeRegistry(
          f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
        ),
        driver: { provider: 'test', model: 'test' },
        nowMs: NOW,
        dispatchLogPath: join(f.root, 'dispatch.jsonl'),
        beforeWorktreeResolve: async () => {
          visited = true;
          await expect(runReviewLoop(opts)).rejects.toThrow(/permit|busy/i);
          await withCheckoutOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async () => undefined,
          );
          throw new Error('stop before mutable resolution');
        },
      };
      if (viaAddress) {
        await expect(
          withCheckoutOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'pr:7', production: true },
            async (lease) => {
              stale = () => runCheckoutReviewLoop(lease, opts);
              await expect(runCheckoutReviewLoop({ ...lease }, opts)).rejects.toThrow(
                'forged loop lease',
              );
              await expect(runReviewLoop(opts)).rejects.toThrow(/busy/i);
              return runCheckoutReviewLoop(lease, opts);
            },
          ),
        ).rejects.toThrow('stop before mutable resolution');
        await expect(stale!()).rejects.toThrow(/inactive|admissions closed/);
      } else await expect(runReviewLoop(opts)).rejects.toThrow('stop before mutable resolution');
      expect(visited).toBe(true);
      await expect(runReviewLoop(opts)).rejects.toThrow(/incomplete/i);
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
      registry: slotWorktreeRegistry(
        f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
      ),
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
          const path = join(f.repo.root, '.git/cq-review/slots/pr-7.lock');
          await rename(path, path + '.replaced');
          await writeFile(path, 'foreign inode');
        }
        parent.abort();
        release.resolve();
        if (mode === 'parent-and-owner-loss') {
          await expect(pending).rejects.toThrow(/inode replaced/i);
          await expect(
            runReviewLoop({ ...opts, git: f.run, signal: new AbortController().signal }),
          ).rejects.toThrow(/busy|incomplete/i);
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
      await expect(pending).rejects.toThrow('checkout actual writer drain unresolved');
      expect(started).toBe(true);
      await expect(runReviewLoop(opts)).rejects.toThrow(/busy|incomplete/i);
      release.resolve();
      await finished.promise;
      expect(await readFile(join(checkout, 'late-write.txt'), 'utf8')).toBe('survivor edit\n');
      await expect(runReviewLoop(opts)).rejects.toThrow(/busy|incomplete/i);
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
