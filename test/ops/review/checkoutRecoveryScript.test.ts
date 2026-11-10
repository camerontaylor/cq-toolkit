import { mkdtemp, mkdir, lstat, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  acquireFileLock,
  acquireSlot,
  attachSlotMetadata,
} from '../../../src/adapters/lock/slotLock.js';
// @ts-expect-error The recovery executable is plain JavaScript.
import { recoverReviewCheckout as untypedRecover } from '../../../scripts/recover-review-checkout.mjs';

const recoverReviewCheckout = untypedRecover as (
  env: Record<string, string | undefined>,
  io: Record<string, unknown>,
) => Promise<void>;

test('inspect holds the persistent inode and never clears incomplete metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-recovery-'));
  const dir = join(root, 'cq-review', 'slots');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'pr-7.lock');
  const initial = attachSlotMetadata(await acquireFileLock(path));
  await initial.writeMetadata({ version: 1, state: 'unbound', incomplete: true });
  await initial.close();
  let busy = false;
  await recoverReviewCheckout(
    { CQ_RECOVERY_LOCKS: JSON.stringify([path]), CQ_RECOVERY_CHECKOUT: join(root, 'gone') },
    {
      realpath,
      lstat,
      acquire: acquireFileLock,
      attach: attachSlotMetadata,
      print: () => {},
      shell: async () => {
        try {
          await acquireFileLock(path);
        } catch {
          busy = true;
        }
        return true;
      },
      acknowledge: async () => {
        throw new Error('inspect cannot acknowledge');
      },
    },
  );
  expect(busy).toBe(true);
  const held = attachSlotMetadata(await acquireFileLock(path));
  expect(await held.readMetadata()).toEqual({ version: 1, state: 'unbound', incomplete: true });
  await held.close();
});

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cq-recovery-'));
  const dir = join(root, 'cq-review', 'slots');
  await mkdir(dir, { recursive: true });
  const paths = [join(dir, 'pr-7.lock'), join(dir, `checkout-${'a'.repeat(64)}.lock`)];
  for (const path of paths) {
    const slot = attachSlotMetadata(await acquireFileLock(path));
    await slot.writeMetadata({ version: 1, state: 'unbound', incomplete: true });
    await slot.close();
  }
  const env = {
    CQ_RECOVERY_LOCKS: JSON.stringify(paths),
    CQ_RECOVERY_CHECKOUT: join(root, 'gone'),
    CQ_RECOVERY_MODE: 'removed',
  };
  const io = {
    realpath,
    lstat,
    acquire: acquireFileLock,
    attach: attachSlotMetadata,
    print: () => {},
    shell: async () => true,
    acknowledge: async () => 'quiescent-and-reconciled',
  };
  const read = async (path: string) => {
    const slot = attachSlotMetadata(await acquireFileLock(path));
    try {
      return await slot.readMetadata();
    } finally {
      await slot.close();
    }
  };
  return { paths, env, io, read };
}

test('busy lock leaves all metadata untouched', async () => {
  const f = await recoveryFixture();
  const busy = await acquireFileLock(f.paths[1]!);
  try {
    await expect(recoverReviewCheckout(f.env, f.io)).rejects.toThrow(/busy/i);
  } finally {
    await busy.close();
  }
  for (const path of f.paths) expect((await f.read(path))?.incomplete).toBe(true);
});

test('removed Git-dir recovery locks original persistent inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-recovery-'));
  const checkout = join(root, 'checkout'),
    gitDir = join(root, 'admin');
  await mkdir(checkout);
  await mkdir(gitDir);
  const slot = await acquireSlot(root, { checkoutGitDir: gitDir });
  await slot.writeMetadata({
    version: 1,
    state: 'bound',
    incomplete: true,
    checkoutPath: checkout,
    checkoutGitDir: gitDir,
  });
  const path = slot.path;
  const inode = (await lstat(path)).ino;
  await slot.close();
  await rename(checkout, join(root, 'saved-checkout'));
  await rename(gitDir, join(root, 'saved-admin'));
  await recoverReviewCheckout(
    {
      CQ_RECOVERY_LOCKS: JSON.stringify([path]),
      CQ_RECOVERY_CHECKOUT: checkout,
      CQ_RECOVERY_MODE: 'removed',
    },
    {
      realpath,
      lstat,
      acquire: acquireFileLock,
      attach: attachSlotMetadata,
      print: () => {},
      shell: async () => {
        await expect(acquireFileLock(path)).rejects.toThrow(/busy/i);
        return true;
      },
      acknowledge: async () => 'quiescent-and-reconciled',
    },
  );
  expect((await lstat(path)).ino).toBe(inode);
  const held = attachSlotMetadata(await acquireFileLock(path));
  expect(await held.readMetadata()).toEqual({ version: 1, state: 'unbound', incomplete: false });
  await held.close();
});

test('removed recovery accepts a missing checkout parent while holding the original slot', async () => {
  const f = await recoveryFixture();
  const parent = join(dirname(dirname(dirname(f.paths[0]!))), 'removed-parent');
  const checkout = join(parent, 'checkout');
  const gitDir = join(parent, 'admin');
  await mkdir(checkout, { recursive: true });
  await mkdir(gitDir);
  const slot = attachSlotMetadata(await acquireFileLock(f.paths[0]!));
  await slot.writeMetadata({
    version: 1,
    state: 'bound',
    incomplete: true,
    checkoutPath: checkout,
    checkoutGitDir: gitDir,
  });
  await slot.close();
  await rename(parent, `${parent}-saved`);
  await recoverReviewCheckout({ ...f.env, CQ_RECOVERY_CHECKOUT: checkout }, f.io);
  expect(await f.read(f.paths[0]!)).toEqual({ version: 1, state: 'unbound', incomplete: false });
});

test('missing acknowledgement preserves incomplete metadata', async () => {
  const f = await recoveryFixture();
  await expect(
    recoverReviewCheckout(f.env, { ...f.io, acknowledge: async () => '' }),
  ).rejects.toThrow('Acknowledgement absent');
  for (const path of f.paths) expect((await f.read(path))?.incomplete).toBe(true);
});

test('failed recovery shell reports non-clearing result', async () => {
  const f = await recoveryFixture();
  await expect(recoverReviewCheckout(f.env, { ...f.io, shell: async () => false })).rejects.toThrow(
    'Recovery shell exited unsuccessfully',
  );
  for (const path of f.paths) expect((await f.read(path))?.incomplete).toBe(true);
});

test.each(['existing', 'dangling'] as const)(
  'removed recovery refuses a %s ancestor alias even when descendants are missing',
  async (kind) => {
    const f = await recoveryFixture();
    const base = dirname(dirname(dirname(f.paths[0]!)));
    const alias = join(base, 'alias');
    await symlink(kind === 'existing' ? base : join(base, 'missing'), alias);
    await expect(
      recoverReviewCheckout(
        { ...f.env, CQ_RECOVERY_CHECKOUT: join(alias, 'missing', 'checkout') },
        f.io,
      ),
    ).rejects.toThrow(
      kind === 'existing' ? 'Checkout parent alias refused:' : 'Unresolvable path alias:',
    );
    for (const path of f.paths) expect((await f.read(path))?.incomplete).toBe(true);
  },
);

test('removed mode refuses a different bound checkout', async () => {
  const f = await recoveryFixture();
  const checkout = join(dirname(f.paths[0]!), 'existing-checkout');
  const gitDir = join(dirname(f.paths[0]!), 'existing-admin');
  await mkdir(checkout);
  await mkdir(gitDir);
  const slot = attachSlotMetadata(await acquireFileLock(f.paths[0]!));
  await slot.writeMetadata({
    version: 1,
    state: 'bound',
    incomplete: true,
    checkoutPath: checkout,
    checkoutGitDir: gitDir,
  });
  await slot.close();
  await expect(recoverReviewCheckout(f.env, f.io)).rejects.toThrow(/does not match/);
  for (const path of f.paths) expect((await f.read(path))?.incomplete).toBe(true);
});

test('partial clear fault leaves remaining entries incomplete', async () => {
  const f = await recoveryFixture();
  await expect(
    recoverReviewCheckout(f.env, {
      ...f.io,
      attach: (lock: Awaited<ReturnType<typeof acquireFileLock>>) => {
        const slot = attachSlotMetadata(lock);
        return lock.path === f.paths[0]
          ? {
              ...slot,
              writeMetadata: async () => {
                throw new Error('injected fault');
              },
            }
          : slot;
      },
    }),
  ).rejects.toThrow(f.paths[0]!.replace(/\.lock$/, '.json'));
  expect((await f.read(f.paths[0]!))?.incomplete).toBe(true);
  expect((await f.read(f.paths[1]!))?.incomplete).toBe(false);
});
