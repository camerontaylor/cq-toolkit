import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Replace a file durably; the caller supplies its exact serialized bytes. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Caller must hold the same exclusive writer lock for this path throughout cleanup.
 * Only UUID-named adapter temps are removed by default. Python's eight-character
 * tempfile names require explicit opt-in because their namespace is less specific.
 */
export async function cleanupAtomicTemps(
  path: string,
  olderThan: number,
  options: { includePythonTemps?: boolean } = {},
): Promise<number> {
  if (!Number.isFinite(olderThan)) throw new Error('Invalid cleanup cutoff');
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  let removed = 0;
  for (const name of await readdir(dir)) {
    const adapterTemp =
      name.startsWith(prefix) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
        name.slice(prefix.length),
      );
    const pythonPrefix = `.${basename(path)}`;
    const pythonTemp =
      options.includePythonTemps === true &&
      name.startsWith(pythonPrefix) &&
      /^[a-z0-9_]{8}$/.test(name.slice(pythonPrefix.length));
    if (!adapterTemp && !pythonTemp) continue;
    const candidate = join(dir, name);
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.mtimeMs >= olderThan) continue;
      await unlink(candidate);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
