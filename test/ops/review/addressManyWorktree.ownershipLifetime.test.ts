import { lstat, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  withAddressOwnership,
  runAddressReviewLoop,
  isAddressOwnershipAdmissionRefusal,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { FixReviewItemInputSchema } from '../../../src/ops/review/registry.js';
import { runReviewLoop, type ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import { NOW, deferred, fixture } from './addressManyWorktree.helpers.js';

test('pre-admission cancellation preserves its reason without dispatch', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new Error('cancelled before admission');
  controller.abort(reason);
  let dispatched = false;
  try {
    const error = await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false, controller },
      async () => {
        dispatched = true;
      },
    ).catch((value: unknown) => value);
    expect(error).toBe(reason);
    expect(isAddressOwnershipAdmissionRefusal(error)).toBe(false);
    expect(dispatched).toBe(false);
    await expect(lstat(join(f.repo.root, '.git', 'cq-review', 'slots'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await f.repo.cleanup();
  }
});

test('checkout ownership excludes aliases through the actual writer lifetime', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  const alias = join(f.root, 'alias');
  await symlink(f.repo.root, alias, 'dir');
  const opts = { repoRoot: f.repo.root, git: f.run, source: 'local', production: false };
  const pending = withAddressOwnership(opts, async (lease) => {
    await lease.track(async () => {
      entered.resolve();
      await release.promise;
    });
  });
  try {
    await entered.promise;
    let dispatched = false;
    await expect(
      withAddressOwnership({ ...opts, repoRoot: alias }, async () => {
        dispatched = true;
      }),
    ).rejects.toThrow(/busy/i);
    expect(dispatched).toBe(false);
    release.resolve();
    await pending;
    await withAddressOwnership({ ...opts, repoRoot: alias }, async (lease) => lease.assertOwned());
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await f.repo.cleanup();
  }
});

test('detached writer leaves checkout incomplete after it settles', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let actual: Promise<unknown> | undefined;
  const opts = { repoRoot: f.repo.root, git: f.run, source: 'local', production: false };
  try {
    await expect(
      withAddressOwnership(opts, async (lease) => {
        actual = lease.track(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
      }),
    ).rejects.toThrow();
    await expect(withAddressOwnership(opts, async () => undefined)).rejects.toThrow(
      /busy|incomplete/i,
    );
    release.resolve();
    await actual;
    await expect(withAddressOwnership(opts, async () => undefined)).rejects.toThrow(
      /busy|incomplete/i,
    );
  } finally {
    release.resolve();
    await actual;
    await f.repo.cleanup();
  }
});

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
          await withAddressOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async () => undefined,
          );
          throw new Error('stop before mutable resolution');
        },
      };
      if (viaAddress) {
        await expect(
          withAddressOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'pr:7', production: true },
            async (lease) => {
              stale = () => runAddressReviewLoop(lease, opts);
              await expect(runAddressReviewLoop({ ...lease }, opts)).rejects.toThrow(
                'forged loop lease',
              );
              await expect(runReviewLoop(opts)).rejects.toThrow(/busy/i);
              return runAddressReviewLoop(lease, opts);
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
