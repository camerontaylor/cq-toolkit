import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import {
  makeAddressOwnership,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';
import { deferred, fixture } from './addressManyWorktree.helpers.js';

test('detached child work quarantines promptly and prevents another admission', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
    () => async (input) =>
      withAddressOwnership(
        { repoRoot: input.repoRoot, git: f.run, source: input.source, production: true },
        async (lease) => {
          const task = lease.track(async () => {
            entered.resolve();
            await release.promise;
          });
          void task.then(
            () => undefined,
            () => undefined,
          );
          await entered.promise;
          return { status: 'needs-human', reason: 'detached fixture' };
        },
      ),
  );
  const selection = {
    pr: 7,
    head: f.prs[0].headRefOid,
    headRepo: 'fixture/base',
    headRefName: 'feature/x',
  };
  const input = { repoRoot: f.repo.root, source: 'pr:7' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed: Promise<string> | undefined;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const outcome = owner.withLock(async () => {
      await expect(owner.address(selection, input)).rejects.toThrow('detached child work');
      await expect(owner.address(selection, input)).rejects.toThrow();
    });
    observed = outcome.then(
      () => 'fulfilled',
      () => 'quarantined',
    );
    const result = await Promise.race([
      observed,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('timed out'), 2000);
      }),
    ]);
    expect(result).toBe('quarantined');
    const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(next.withLock(async () => undefined)).rejects.toThrow('quarantined guard');
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
    await observed;
    factory.mockRestore();
    await f.repo.cleanup();
  }
});
