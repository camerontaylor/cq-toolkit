import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { fileWorktreeRegistry, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import * as addressModule from '../../../src/ops/review/address.js';
import {
  makeAddressOwnership,
  runAddressReviewLoop,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';
import * as loopModule from '../../../src/plans/review-loop.js';

import { NOW, deferred, fixture } from './addressManyWorktree.helpers.js';

test.each(['unpublished', 'published', 'invalid-callback'] as const)(
  'child head advances only after publication callback: %s',
  async (publication) => {
    const f = await fixture();
    const pr = f.prs[0];
    const loop = vi.spyOn(loopModule, 'runReviewLoop').mockImplementation(async (opts) => {
      const checkout = await f.resolve(pr);
      await opts.onWorktreeResolved!(checkout);
      await writeFile(join(checkout.path, 'README.md'), 'round one fix\n');
      f.repo.git('-C', checkout.path, 'add', '--', 'README.md');
      f.repo.git('-C', checkout.path, 'commit', '-q', '-m', 'round one');
      const head = f.repo.git('-C', checkout.path, 'rev-parse', 'HEAD').trim();
      if (publication !== 'unpublished') {
        f.repo.git('-C', checkout.path, 'push', '-q', 'origin', `${head}:refs/heads/feature/x`);
        if (publication === 'invalid-callback') {
          await expect(opts.onPublished!(pr.headRefOid)).rejects.toThrow();
        } else {
          await opts.onPublished!(head);
        }
      }
      return {} as Awaited<ReturnType<typeof loopModule.runReviewLoop>>;
    });
    const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
      () => async (input) =>
        withAddressOwnership(
          { repoRoot: input.repoRoot, git: f.run, source: input.source, production: true },
          async (lease) => {
            let checkout: Awaited<ReturnType<typeof f.resolve>> | undefined;
            await runAddressReviewLoop(lease, {
              repoRoot: f.repo.root,
              git: f.run,
              onWorktreeResolved: async (info) => {
                checkout = info as Awaited<ReturnType<typeof f.resolve>>;
                await lease.claimCheckout({ ...info, head: pr.headRefOid });
              },
            } as Parameters<typeof runAddressReviewLoop>[1]);
            const head = f.repo.git('-C', checkout!.path, 'rev-parse', 'HEAD').trim();
            const second = lease.claimCheckout({ ...checkout!, head });
            if (publication === 'published') await expect(second).resolves.toBeUndefined();
            else await expect(second).rejects.toThrow('resolved identity changed');
            return { status: 'needs-human', reason: 'fixture' };
          },
        ),
    );
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await owner.withLock(() =>
        owner.address(
          {
            pr: pr.number,
            head: pr.headRefOid,
            headRepo: 'fixture/base',
            headRefName: 'feature/x',
          },
          { repoRoot: f.repo.root, source: 'pr:7' },
        ),
      );
    } finally {
      factory.mockRestore();
      loop.mockRestore();
      await f.repo.cleanup();
    }
  },
);

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
