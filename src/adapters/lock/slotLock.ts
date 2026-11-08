// Private coordination for cooperating review writers on local Linux/macOS disks.
// Never unlink these lock files, including during checkout removal. External inode
// replacement is detected at API calls, not continuously; this is advisory exclusion.
// Local storage is a caller precondition, not inferred from mount-type heuristics.
import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// A numeric fd does not keep a FileHandle alive. Pin until explicit close so
// a dropped slot cannot silently release exclusion through Node's GC finalizer.
const heldFiles = new Set<FileHandle>();

export class UnsupportedLockError extends Error {
  override name = 'UnsupportedLockError';
}
export class SlotBusyError extends Error {
  override name = 'SlotBusyError';
}
export class IncompleteSlotError extends Error {
  override name = 'IncompleteSlotError';
}

async function nativeFlock(): Promise<(fd: number, operation: string) => void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new UnsupportedLockError('Slot locks support local Linux/macOS disks only');
  }
  try {
    // Keep loading lazy while making the native dependency explicit to the
    // trusted selfhost closure walk now that its ops reach the slot owner.
    return (await import('fs-ext')).default.flockSync;
  } catch (cause) {
    throw new UnsupportedLockError('fs-ext native flock addon unavailable', { cause });
  }
}

/**
 * Retain the returned object and call close after actual writer drain. fd is a
 * borrowed descriptor for inheritance, never for caller close/unlock. The module
 * pins the FileHandle against GC, including if the caller accidentally drops it;
 * dropping the object therefore leaks exclusion until process exit, rather than
 * releasing it early. Inherited writer references survive our explicit close.
 */
export async function acquireFileLock(path: string) {
  const flock = await nativeFlock();
  let file: FileHandle;
  try {
    file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      throw new UnsupportedLockError(`Cannot open slot lock ${path}`, { cause });
    }
    throw cause;
  }
  try {
    try {
      flock(file.fd, 'exnb');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK')
        throw new SlotBusyError(`Slot busy: ${path}`);
      throw new UnsupportedLockError(`Cannot flock ${path}`, { cause });
    }
    let closed = false;
    const assertIdentity = async () => {
      if (closed) throw new Error('Slot lock is closed');
      const [held, named] = await Promise.all([file.stat(), lstat(path)]);
      if (!named.isFile()) throw new Error(`Slot lock path must be a regular file: ${path}`);
      if (held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) {
        throw new Error(`Slot lock inode replaced: ${path}`);
      }
    };
    await assertIdentity();
    heldFiles.add(file);
    return {
      fd: file.fd,
      path,
      assertIdentity,
      async close() {
        if (!closed) {
          closed = true;
          try {
            await file.close();
          } finally {
            heldFiles.delete(file);
          }
        }
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export type SlotMetadata = {
  version: 1;
  incomplete: boolean;
} & (
  | { state: 'unbound'; checkoutGitDir?: never; checkoutPath?: never }
  | { state: 'bound'; checkoutGitDir: string; checkoutPath: string }
);

function parseMetadata(text: string): SlotMetadata {
  const value = JSON.parse(text) as Partial<SlotMetadata> | null;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.incomplete !== 'boolean' ||
    !(value.state === 'unbound'
      ? !('checkoutGitDir' in value) && !('checkoutPath' in value)
      : value.state === 'bound' &&
        typeof value.checkoutGitDir === 'string' &&
        typeof value.checkoutPath === 'string')
  ) {
    throw new Error('Invalid slot metadata');
  }
  return value as SlotMetadata;
}

/** PR keys ignore branch names and custom checkout roots; local keys use the Git admin dir. */
export async function acquireSlot(commonDir: string, key: number | { checkoutGitDir: string }) {
  await nativeFlock(); // Refuse unsupported platforms/addons before creating the namespace.
  const common = await realpath(commonDir);
  let name: string;
  if (typeof key === 'number') {
    if (!Number.isSafeInteger(key) || key < 1) throw new Error('Invalid PR number');
    name = `pr-${key}`;
  } else {
    const gitDir = await realpath(key.checkoutGitDir);
    name = `checkout-${createHash('sha256').update(gitDir).digest('hex')}`;
  }
  const directory = join(common, 'cq-review', 'slots');
  await mkdir(directory, { recursive: true });
  for (const path of [common, dirname(directory)]) {
    const parent = await open(path, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  const lock = await acquireFileLock(join(await realpath(directory), `${name}.lock`));
  return attachSlotMetadata(lock);
}

/** Bounded, no-follow discovery reader. Missing metadata is a fresh hint only. */
export async function readSlotMetadata(metadataPath: string): Promise<SlotMetadata | undefined> {
  try {
    const input = await open(
      metadataPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await input.stat();
      if (!info.isFile()) throw new Error('Slot metadata must be a regular file');
      if (info.size > 16_384) throw new Error('Oversized slot metadata');
      const bytes = Buffer.alloc(16_385);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const part = await input.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > 16_384) throw new Error('Oversized slot metadata');
      return parseMetadata(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await input.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Attach the one metadata protocol to an already-held persistent lock inode. */
export function attachSlotMetadata(lock: Awaited<ReturnType<typeof acquireFileLock>>) {
  if (!lock.path.endsWith('.lock')) throw new Error('Slot lock path must end in .lock');
  const metadataPath = lock.path.replace(/\.lock$/, '.json');
  const slot = {
    ...lock,
    metadataPath,
    async readMetadata(): Promise<SlotMetadata | undefined> {
      await lock.assertIdentity();
      return readSlotMetadata(metadataPath);
    },
    // Call before checkout reuse/dispatch, after acquiring the slot. Acquisition alone
    // permits inspection/reconciliation; it does not authorize reuse of incomplete work.
    async assertReusable(): Promise<void> {
      if ((await slot.readMetadata())?.incomplete) {
        throw new IncompleteSlotError(`Incomplete slot requires reconciliation: ${metadataPath}`);
      }
    },
    // Caller must persist incomplete=true BEFORE dispatch, and false only AFTER actual drain.
    // An incomplete predecessor must be reconciled before any reuse; taking flock is not recovery.
    async writeMetadata(metadata: SlotMetadata): Promise<void> {
      await lock.assertIdentity();
      parseMetadata(JSON.stringify(metadata));
      const canonical =
        metadata.state === 'bound'
          ? {
              ...metadata,
              checkoutGitDir: await realpath(metadata.checkoutGitDir),
              checkoutPath: await realpath(metadata.checkoutPath),
            }
          : metadata;
      const temporary = `${metadataPath}.${randomUUID()}.tmp`;
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(`${JSON.stringify(canonical)}\n`);
        await output.sync();
        await output.close();
        await lock.assertIdentity();
        await rename(temporary, metadataPath);
        const dir = await open(dirname(metadataPath), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } finally {
        await output.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
  return slot;
}
