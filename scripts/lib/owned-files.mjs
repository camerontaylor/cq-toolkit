import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const inside = (path) => {
  const rel = relative(ROOT, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Validate the whole list before either tool can mutate any file. */
export function ownedFiles(args) {
  if (args.length === 0) throw new Error('provide an explicit owned-file list');
  const files = [];
  for (const arg of args) {
    const path = resolve(arg);
    if (!inside(path)) throw new Error(`file is outside the repository: ${arg}`);
    const first = relative(ROOT, path).split(sep)[0];
    if (['.git', 'node_modules', '.agents', '.codex'].includes(first)) {
      throw new Error(`not an editable project file: ${arg}`);
    }
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Deletions are valid, but a missing leaf cannot bypass containment
      // through a parent symlink. Resolve the nearest existing ancestor.
      let parent = dirname(path);
      for (;;) {
        try {
          const real = realpathSync(parent);
          if (real !== ROOT && !inside(real))
            throw new Error(`file is outside the repository: ${arg}`);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          parent = dirname(parent);
        }
      }
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`expected a regular file: ${arg}`);
    if (!inside(realpathSync(path))) throw new Error(`file is outside the repository: ${arg}`);
    files.push(path);
  }
  return [...new Set(files)];
}

export function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`tool failed: ${result.error?.message ?? result.signal ?? 'no exit status'}`);
  }
  return result.status;
}

export const lintArgs = ['--config', resolve(ROOT, '.oxlintrc.json'), '--disable-nested-config'];
