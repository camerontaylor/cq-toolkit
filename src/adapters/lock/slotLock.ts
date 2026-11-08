// Private coordination for cooperating review writers on local Linux/macOS disks.
// Never unlink these lock files, including during checkout removal.
import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

export class UnsupportedLockError extends Error {}
export class SlotBusyError extends Error {}
export class IncompleteSlotError extends Error {}

function nativeFlock(): (fd: number, operation: string) => void {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new UnsupportedLockError('Slot locks support local Linux/macOS disks only');
  }
  try {
    return (
      require('fs-ext') as {
        flockSync: (fd: number, operation: string) => void;
      }
    ).flockSync;
  } catch (cause) {
    throw new UnsupportedLockError('fs-ext native flock addon unavailable', { cause });
  }
}

/** Only close releases our reference: inherited writer descriptors must remain locked. */
export async function acquireFileLock(path: string) {
  const flock = nativeFlock();
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
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
      if (!named.isFile() || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) {
        throw new Error(`Slot lock inode replaced: ${path}`);
      }
    };
    await assertIdentity();
    return {
      fd: file.fd,
      path,
      assertIdentity,
      async close() {
        if (!closed) {
          closed = true;
          await file.close();
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
  const metadataPath = join(dirname(lock.path), `${name}.json`);
  const slot = {
    ...lock,
    metadataPath,
    async readMetadata(): Promise<SlotMetadata | undefined> {
      await lock.assertIdentity();
      try {
        return parseMetadata(await readFile(metadataPath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
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
