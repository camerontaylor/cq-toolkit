import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as addressModule from '../../../src/ops/review/address.js';
import { makeAddressOwnership } from '../../../src/ops/review/internal/addressOwnership.js';
import { authorityStore, deferred, fixture } from './addressManyWorktree.helpers.js';

const faults = vi.hoisted(() => ({
  afterStat: undefined as undefined | ((path: string) => Promise<void>),
  afterLink: undefined as undefined | ((source: string, target: string) => Promise<void>),
  afterRename: undefined as undefined | ((source: string, target: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      await faults.afterStat?.(String(args[0]));
      return stat;
    },
    link: async (source: string, target: string) => {
      await actual.link(source, target);
      await faults.afterLink?.(source, target);
    },
    rename: async (source: string, target: string) => {
      await actual.rename(source, target);
      await faults.afterRename?.(source, target);
    },
  };
});

test('sequential lifetimes beyond the record bound keep only one retired generation', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 80; i++) {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await owner.withLock(async () => owner.assertOwned());
    }
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const names = await readdir(owner.commonDir);
    expect(names.filter((name) => name.includes('.retired-'))).toHaveLength(2);
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['active', 'quarantined'])('%s authority is never rotated', async (state) => {
  const f = await fixture();
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const check = async () => {
      const before = await lstat(owner.guardPath);
      await expect(contender.withLock(async () => undefined)).rejects.toThrow();
      expect((await lstat(owner.guardPath)).ino).toBe(before.ino);
      expect((await readdir(owner.commonDir)).some((name) => name.includes('.retired-'))).toBe(
        false,
      );
    };
    if (state === 'active') await owner.withLock(check);
    else {
      await expect(
        owner.withLock(async () => {
          throw new Error('quarantine');
        }),
      ).rejects.toThrow('quarantine');
      await check();
    }
  } finally {
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  'rotation refuses a concurrent admitter: crash recovery=%s',
  async (crash) => {
    const f = await fixture();
    try {
      const first = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await first.withLock(async () => undefined);
      const anchor = JSON.parse(await readFile(first.guardPath, 'utf8')) as { anchor: string };
      const store = authorityStore(first.guardPath);
      if (crash) await rename(store, `${store}.retired-${anchor.anchor}`);
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      const entered = deferred(),
        release = deferred();
      faults.afterRename = async (source) => {
        if (source !== (crash ? first.guardPath : store)) return;
        faults.afterRename = undefined;
        entered.resolve();
        await release.promise;
      };
      const running = owner.withLock(async () => undefined);
      await entered.promise;
      try {
        const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        await expect(contender.withLock(async () => undefined)).rejects.toThrow();
      } finally {
        release.resolve();
      }
      await running;
      expect((await lstat(`${first.guardPath}.retired-${anchor.anchor}`)).ino).toBe(
        (await lstat(join(`${store}.retired-${anchor.anchor}`, 'anchor.json'))).ino,
      );
    } finally {
      faults.afterRename = undefined;
      await f.repo.cleanup();
    }
  },
);

test('a pre-existing full 64-record chain admits', async () => {
  const f = await fixture();
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => undefined);
    const store = authorityStore(owner.guardPath);
    let previous = createHash('sha256')
      .update(await readFile(join(store, '000002.json')))
      .digest('hex');
    const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
    let epoch = '';
    for (let sequence = 3; sequence <= 64; sequence++) {
      const bytes = JSON.stringify({
        version: 3,
        anchor: anchor.anchor,
        sequence,
        previous,
        epoch: sequence % 2 ? randomUUID() : epoch,
        state: sequence % 2 ? 'active' : 'quiescent',
        resources: [],
      });
      if (sequence % 2) epoch = (JSON.parse(bytes) as { epoch: string }).epoch;
      const name = `${String(sequence).padStart(6, '0')}.json`;
      await writeFile(join(store, `pending-${name}`), bytes);
      await link(join(store, `pending-${name}`), join(store, name));
      previous = createHash('sha256').update(bytes).digest('hex');
    }
    const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await next.withLock(async () => undefined);
  } finally {
    await f.repo.cleanup();
  }
});

test.each([1, 2])('completion across %i successor rotations', async (rotations) => {
  const f = await fixture();
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    faults.afterLink = async (source, target) => {
      if (!target.endsWith('000002.json')) return;
      const record = JSON.parse(await readFile(source, 'utf8')) as { state: string };
      if (record.state !== 'quiescent') return;
      faults.afterLink = undefined;
      for (let i = 0; i < rotations; i++) {
        const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        await next.withLock(async () => undefined);
      }
    };
    const completion = owner.withLock(async () => undefined);
    if (rotations === 1) await completion;
    else await expect(completion).rejects.toThrow('lost owner');
    const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await next.withLock(async () => {
      const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await expect(contender.withLock(async () => undefined)).rejects.toThrow();
    });
  } finally {
    faults.afterLink = undefined;
    await f.repo.cleanup();
  }
});

test.each([false, true])('claim budget preserves completion: long resources=%s', async (long) => {
  const f = await fixture();
  const factory = vi
    .spyOn(addressModule, 'makeReviewAddress')
    .mockImplementation(() => async () => ({
      status: 'needs-human' as const,
      reason: 'claim fixture',
    }));
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let refused = false;
    await owner.withLock(async () => {
      for (let i = 0; i < 80; i++) {
        const pr = long ? i + 1 : 7;
        try {
          await owner.address(
            {
              pr,
              head: f.prs[0].headRefOid,
              headRepo: 'fixture/base',
              headRefName: long ? `${i}${'x'.repeat(1700)}` : 'feature/x',
            },
            { repoRoot: f.repo.root, source: `pr:${pr}` },
          );
        } catch (error) {
          expect(String(error)).toContain('mid-lifetime authority bound');
          refused = true;
          break;
        }
      }
      await owner.assertOwned();
    });
    expect(refused).toBe(long);
    const records = (await readdir(authorityStore(owner.guardPath))).filter((name) =>
      /^\d{6}\.json$/.test(name),
    );
    expect(records.length).toBeLessThanOrEqual(64);
    if (!long) expect(records).toHaveLength(3);
    const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await next.withLock(async () => undefined);
  } finally {
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  'fast pre-read tolerates rotation: guard also renamed=%s',
  async (both) => {
    const f = await fixture();
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await owner.withLock(async () => undefined);
      const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
      const store = authorityStore(owner.guardPath);
      faults.afterStat = async (path) => {
        if (path !== store) return;
        faults.afterStat = undefined;
        await rename(store, `${store}.retired-${anchor.anchor}`);
        if (both) await rename(owner.guardPath, `${owner.guardPath}.retired-${anchor.anchor}`);
      };
      const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await next.withLock(async () => undefined);
    } finally {
      faults.afterStat = undefined;
      await f.repo.cleanup();
    }
  },
);

test('redundant claims detect authority loss before installing claims', async () => {
  const f = await fixture();
  const factory = vi
    .spyOn(addressModule, 'makeReviewAddress')
    .mockImplementation(() => async () => ({
      status: 'needs-human' as const,
      reason: 'claim fixture',
    }));
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const selection = {
      pr: 7,
      head: f.prs[0].headRefOid,
      headRepo: 'fixture/base',
      headRefName: 'feature/x',
    };
    const input = { repoRoot: f.repo.root, source: 'pr:7' };
    let claimsAtFailure: number | undefined;
    await expect(
      owner.withLock(async () => {
        await owner.address(selection, input);
        let reads = 0;
        faults.afterStat = async (path) => {
          if (path !== authorityStore(owner.guardPath) || ++reads !== 5) return;
          faults.afterStat = undefined;
          // Two reads fence address admission, two fence claim entry; the fifth
          // begins the redundant-claim post-check, before any claims are installed.
          claimsAtFailure = (Reflect.get(owner, 'claims') as Map<string, unknown>).size;
          throw new Error('injected identity loss');
        };
        await owner.address(selection, input);
      }),
    ).rejects.toThrow('lost owner');
    expect(claimsAtFailure).toBe(0);
  } finally {
    faults.afterStat = undefined;
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test.each(['record', 'guard-link', 'active-tail'])(
  'interrupted rotation preserves damaged evidence: %s',
  async (damage) => {
    const f = await fixture();
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await owner.withLock(async () => undefined);
      const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
      const store = authorityStore(owner.guardPath),
        retired = `${store}.retired-${anchor.anchor}`;
      await rename(store, retired);
      const path = damage === 'guard-link' ? owner.guardPath : join(retired, '000002.json');
      if (damage === 'active-tail') {
        const value = JSON.parse(await readFile(path, 'utf8')) as { state: string };
        value.state = 'active';
        await writeFile(path, JSON.stringify(value));
      } else await writeFile(path, 'damaged evidence');
      const evidence = await readFile(path);
      const next = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await expect(
        next.withLock(async () => {
          throw new Error('must not dispatch');
        }),
      ).rejects.toThrow('attended recovery');
      expect(await readFile(path)).toEqual(evidence);
      await expect(lstat(store)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(retired)).isDirectory()).toBe(true);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('completion verifies retired store with live guard between rotation renames', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let successor: Promise<unknown> | undefined;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    faults.afterLink = async (_source, target) => {
      if (!target.endsWith('/000002.json')) return;
      faults.afterLink = undefined;
      faults.afterRename = async (source) => {
        if (source !== authorityStore(owner.guardPath)) return;
        faults.afterRename = undefined;
        entered.resolve();
        await release.promise;
      };
      successor = (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      );
      await entered.promise;
    };
    await owner.withLock(async () => 'confirmed');
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('could not acquire');
    release.resolve();
    await successor;
  } finally {
    release.resolve();
    await successor;
    faults.afterLink = faults.afterRename = undefined;
    await f.repo.cleanup();
  }
});
