import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { cp, glob, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
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
    filter: async (source, target) => {
      admit();
      // POSIX bin shims can embed paths relative to their original
      // directory. A private launcher preserves that location without
      // exposing the original shim to in-place writes through a link.
      if (process.platform !== 'win32' && dirname(source) === resolve(installed, '.bin')) {
        const stat = await lstat(source);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          const quoted = "'" + resolve(source).replaceAll("'", "'\\''") + "'";
          await writeFile(target, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: stat.mode & 0o777 });
          return false;
        }
      }
      return true;
    },
  });
  admit();
}

const DependencyManifest = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    peerDependenciesMeta: z.record(z.string(), z.unknown()).optional(),
    pnpm: z.record(z.string(), z.unknown()).optional(),
    packageManager: z.string().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    resolutions: z.record(z.string(), z.unknown()).optional(),
    workspaces: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
    bundledDependencies: z.union([z.boolean(), z.array(z.string())]).optional(),
    bundleDependencies: z.union([z.boolean(), z.array(z.string())]).optional(),
  })
  .passthrough();
const descriptiveManifestFields = new Set([
  'name',
  'version',
  'private',
  'description',
  'scripts',
  'license',
  'author',
  'contributors',
  'repository',
  'homepage',
  'bugs',
  'keywords',
  'funding',
]);
const installLifecycleScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
  'pnpm:devPreinstall',
]);

/** Compare installed-tree inputs without exposing package-manager credential bytes. */
export async function assertAddressDependencyMetadata(
  root: string,
  caller: string,
  admit: () => void,
): Promise<void> {
  const read = async (cwd: string, path: string) => {
    admit();
    try {
      const full = await realpath(resolve(cwd, path));
      if (!within(await realpath(cwd), full))
        throw new Error('dependency metadata escapes checkout');
      return await readFile(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const relevant = (text: string | null) => {
    if (text === null) return text;
    const parsed = DependencyManifest.parse(JSON.parse(text) as unknown);
    const fields = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !descriptiveManifestFields.has(key)),
    );
    if (Object.keys(parsed.scripts ?? {}).some((key) => installLifecycleScripts.has(key)))
      fields.scripts = parsed.scripts;
    return fields;
  };
  const compare = async (path: string, manifest = false) => {
    const a = await read(root, path);
    const b = await read(caller, path);
    if (!isDeepStrictEqual(manifest ? relevant(a) : a, manifest ? relevant(b) : b))
      throw new Error(
        'installed dependency root manifests/locks differ; install dependencies in the PR worktree',
      );
  };
  await compare('package.json', true);
  for (const path of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'bunfig.toml',
  ])
    await compare(path);

  const patterns: string[] = [];
  const pkg = DependencyManifest.parse(
    JSON.parse((await read(root, 'package.json')) ?? '{}') as unknown,
  );
  if (pkg.workspaces)
    patterns.push(
      ...z
        .array(z.string())
        .parse(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages),
    );
  const workspace = await read(root, 'pnpm-workspace.yaml');
  if (workspace !== null) {
    const parsed = z
      .object({ packages: z.array(z.string()).optional() })
      .parse(parseYaml(workspace) as unknown);
    patterns.push(...(parsed.packages ?? []));
  }
  for (const entry of patterns) {
    const pattern = entry.startsWith('!') ? entry.slice(1) : entry;
    if (!pattern || isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))
      throw new Error('workspace pattern escapes checkout or is ambiguous');
  }
  const include = patterns.filter((p) => !p.startsWith('!')).map((p) => `${p}/package.json`);
  const exclude = [
    '**/node_modules/**',
    '**/.git/**',
    ...patterns.filter((p) => p.startsWith('!')).map((p) => `${p.slice(1)}/package.json`),
  ];
  const members = new Set<string>();
  if (include.length)
    for (const cwd of [root, caller]) {
      let count = 0;
      for await (const path of glob(include, { cwd, exclude })) {
        admit();
        if (++count > 1000) throw new Error('workspace metadata enumeration cap exceeded');
        members.add(path);
      }
    }
  for (const path of [...members].sort()) {
    await compare(path, true);
    for (const config of ['.npmrc', '.yarnrc.yml', 'bunfig.toml'])
      await compare(`${dirname(path)}/${config}`);
  }
}
