import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import {
  makeAddressOwnership,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';

import {
  authorityState,
  authorityStore,
  damageGuard,
  deferred,
  fixture,
  preservedDamage,
} from './addressManyWorktree.helpers.js';

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
