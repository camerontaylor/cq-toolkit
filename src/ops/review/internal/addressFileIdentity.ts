import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
export type Identity = { ino: number; dev: number };
export const same = (a: Identity, b: Identity) => a.ino === b.ino && a.dev === b.dev;

/** Open the actual inode, bound allocation, then verify the pathname still names it. */
export async function boundedFile(path: string, limit: number, links: number) {
  if (!constants.O_NOFOLLOW) throw new Error('address ownership: no-follow unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== links) throw new Error('unsafe authority file');
    if (before.size > limit) throw new Error('address ownership: authority store bound reached');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('short authority read');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (
      !same(before, after) ||
      !same(before, named) ||
      !named.isFile() ||
      after.size !== before.size ||
      named.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.nlink !== links
    )
      throw new Error('authority changed during read');
    return { bytes, identity: before };
  } finally {
    await file.close();
  }
}
