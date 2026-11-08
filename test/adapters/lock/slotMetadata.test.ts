import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSlot,
  acquireFileLock,
  attachSlotMetadata,
  readSlotMetadata,
} from '../../../src/adapters/lock/slotLock.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'cq-metadata-'));
  roots.push(path);
  return path;
}

test('bounded discovery refuses oversized valid JSON (mutation: omit 16 KiB bound)', async () => {
  const path = join(await root(), 'slot.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      state: 'unbound',
      incomplete: false,
      padding: 'x'.repeat(16_384),
    }),
  );
  const before = await readFile(path);
  await expect(readSlotMetadata(path)).rejects.toThrow(/oversized/i);
  expect(await readFile(path)).toEqual(before);
});

test('existing lock attachment uses persistent metadata sibling (mutation: attach to a different metadata path)', async () => {
  const common = await root();
  const slot = await acquireSlot(common, 1);
  await writeFile(
    join(common, 'cq-review', 'slots', 'pr-1.json'),
    JSON.stringify({ version: 1, state: 'unbound', incomplete: true }),
  );
  const inode = (await stat(slot.path)).ino;
  await slot.close();
  const recovered = attachSlotMetadata(await acquireFileLock(slot.path));
  try {
    expect((await stat(recovered.path)).ino).toBe(inode);
    expect(await recovered.readMetadata()).toEqual({
      version: 1,
      state: 'unbound',
      incomplete: true,
    });
    await recovered.writeMetadata({ version: 1, state: 'unbound', incomplete: false });
    expect(await readSlotMetadata(slot.metadataPath)).toEqual({
      version: 1,
      state: 'unbound',
      incomplete: false,
    });
  } finally {
    await recovered.close();
  }
});

test('attachment refuses a path without .lock and preserves exclusion (mutation: omit suffix validation)', async () => {
  const path = join(await root(), 'slot');
  const lock = await acquireFileLock(path);
  try {
    const before = await stat(path);
    const bytes = await readFile(path);
    expect(() => attachSlotMetadata(lock)).toThrow(/must end in \.lock/);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(bytes);
    await lock.assertIdentity();
    await expect(acquireFileLock(path)).rejects.toThrow(/Slot busy/);
  } finally {
    await lock.close();
  }
});
