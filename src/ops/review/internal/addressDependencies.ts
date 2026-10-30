import { cp, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Installed packages may be shared; source from another checkout may not. */
export async function assertAddressDependenciesIsolated(
  directory: string,
  checkoutRoots: string[],
  admit: () => void,
): Promise<void> {
  const installed = await realpath(directory);
  const roots = await Promise.all(checkoutRoots.map((root) => realpath(root)));
  const visited = new Set<string>();
  const checkoutCache = new Map<string, string | undefined>();
  let entries = 0;
  const checkout = async (path: string): Promise<string | undefined> => {
    if (checkoutCache.has(path)) return checkoutCache.get(path);
    admit();
    let found: string | undefined;
    try {
      await lstat(resolve(path, '.git'));
      found = path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent !== path) found = await checkout(parent);
    }
    checkoutCache.set(path, found);
    return found;
  };
  const assertInstalledTarget = async (target: string) => {
    const source = roots.find(
      (root) => within(root, target) && !within(resolve(root, 'node_modules'), target),
    );
    const owningCheckout = await checkout(
      (await lstat(target)).isDirectory() ? target : dirname(target),
    );
    if (source || (owningCheckout && !within(resolve(owningCheckout, 'node_modules'), target)))
      throw new Error('dependency link resolves into external checkout source');
  };
  // The installed directory itself can also be a link into workspace source.
  await assertInstalledTarget(installed);
  const walk = async (path: string): Promise<void> => {
    admit();
    if (++entries > 20000) throw new Error('dependency isolation inspection cap exceeded');
    const stat = await lstat(path);
    let target = path;
    if (stat.isSymbolicLink()) {
      target = await realpath(path);
      if (!within(installed, target)) await assertInstalledTarget(target);
    }
    if (visited.has(target)) return;
    visited.add(target);
    if (!(await lstat(target)).isDirectory()) return;
    const children = await readdir(target);
    if (children.length > 20000 - entries)
      throw new Error('dependency isolation inspection cap exceeded');
    for (const name of children) await walk(resolve(target, name));
  };
  await walk(installed);
}

/** Keep candidate package-manager metadata private while reusing installed package targets. */
export async function snapshotAddressDependencies(
  installed: string,
  destination: string,
  admit: () => void,
): Promise<void> {
  admit();
  await cp(installed, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: false,
    errorOnExist: true,
    force: false,
    filter: () => {
      admit();
      return true;
    },
  });
  admit();
}
