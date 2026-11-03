import { constants } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import { makeAddressOwnership } from '../../../src/ops/review/internal/addressOwnership.js';

import { FOREIGN_GUARD, authorityStore, fixture } from './addressManyWorktree.helpers.js';

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
