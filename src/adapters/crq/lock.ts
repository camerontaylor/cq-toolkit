import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { SlotBusyError, UnsupportedLockError } from '../lock/slotLock.js';

const require = createRequire(import.meta.url);

/** Hold the same persistent flock inode as Python for the entire callback. */
export async function withLock<T>(
  path: string,
  options: { wait: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new UnsupportedLockError('flock requires POSIX');
  let flock: (
    fd: number,
    operation: string,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => void;
  try {
    flock = (require('fs-ext') as { flock: typeof flock }).flock;
  } catch (cause) {
    throw new UnsupportedLockError('fs-ext native flock addon unavailable', { cause });
  }
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) =>
      flock(file.fd, options.wait ? 'ex' : 'exnb', (error) => {
        if (!error) resolve();
        else if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
          reject(new SlotBusyError(`Lock busy: ${path}`));
        else reject(error);
      }),
    );
    const [held, named] = await Promise.all([file.stat(), lstat(path)]);
    if (!named.isFile() || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino)
      throw new Error(`Lock inode replaced: ${path}`);
    return await fn();
  } finally {
    await file.close();
  }
}
