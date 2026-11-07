import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeAddressOwnership } from '../../../src/ops/review/internal/addressOwnership.js';

import {
  FOREIGN_GUARD,
  authorityState,
  authorityStore,
  damageGuard,
  deferred,
  fixture,
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
  rename: undefined as
    | undefined
    | ((phase: 'before' | 'after', source: string, target: string) => Promise<void>),
  remove: undefined as undefined | ((path: string) => Promise<void>),
  mkdir: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await fsFaults.rename?.('before', String(args[0]), String(args[1]));
      await actual.rename(...args);
      await fsFaults.rename?.('after', String(args[0]), String(args[1]));
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await fsFaults.remove?.(String(args[0]));
      return actual.rm(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      fsFaults.effect?.();
      await fsFaults.mkdir?.(String(args[0]));
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
      if (!destination.endsWith('/000001.json')) return;
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
        (fault === 'prepare-sync' && path === join(store, 'pending-000001.json')) ||
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

test.each([
  'retired-delete',
  'store-rename-before',
  'store-rename-after',
  'guard-rename-before',
  'guard-rename-after',
  'rotation-dir-sync',
  'bootstrap-mkdir',
  'anchor-prepare',
  'anchor-link-before',
  'anchor-link-after',
  'anchor-store-sync',
  'bootstrap-dir-sync',
] as const)('rotation/bootstrap fault dispatches zero work: %s', async (fault) => {
  const f = await fixture();
  let dispatched = 0,
    hit = false;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => undefined);
    // Establish a real older retired generation for the deletion failure.
    await (
      await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
    ).withLock(async () => undefined);
    const store = authorityStore(owner.guardPath);
    const fail = () => {
      hit = true;
      throw new Error('rotation admission fault');
    };
    let rotated = false,
      anchorLinked = false;
    fsFaults.remove = async () => {
      if (fault === 'retired-delete') fail();
    };
    fsFaults.rename = async (phase, source) => {
      if (source === store && phase === 'after') rotated = true;
      if (fault === `${source === store ? 'store' : 'guard'}-rename-${phase}`) fail();
    };
    fsFaults.mkdir = async (path) => {
      if (fault === 'bootstrap-mkdir' && path === store) fail();
    };
    fsFaults.link = async (phase, _source, target) => {
      if (target !== owner.guardPath) return;
      if (phase === 'after') anchorLinked = true;
      if (fault === `anchor-link-${phase}`) fail();
    };
    fsFaults.sync = async (path) => {
      if (
        (fault === 'rotation-dir-sync' && rotated && path === owner.commonDir) ||
        (fault === 'anchor-prepare' && path === join(store, 'anchor.json')) ||
        (fault === 'anchor-store-sync' && anchorLinked && path === store) ||
        (fault === 'bootstrap-dir-sync' && anchorLinked && path === owner.commonDir)
      )
        fail();
    };
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow('rotation admission fault');
    expect(hit).toBe(true);
    expect(dispatched).toBe(0);
  } finally {
    fsFaults.rename = fsFaults.remove = fsFaults.mkdir = fsFaults.link = fsFaults.sync = undefined;
    await f.repo.cleanup();
  }
});
