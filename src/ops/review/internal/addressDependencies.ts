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
      if (process.platform !== 'win32' && resolve(dirname(source)) === resolve(installed, '.bin')) {
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
/** Lockfiles select dependency versions. A member lockfile can select a different
 * graph than the root lockfile when the shared workspace lockfile is disabled, so
 * every level of the workspace tree must be compared, not just the root. */
const dependencyLockfiles = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
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

/**
 * npm-run-all script patterns: `*` spans any characters and `?` exactly one.
 * Iterative two-pointer matching: no regex backtracking, so the cost stays
 * O(name x pattern) however many wildcards a lifecycle script spells.
 */
const matchesSegment = (name: string, pattern: string): boolean => {
  let nameIndex = 0;
  let patternIndex = 0;
  let star = -1;
  let mark = 0;
  while (nameIndex < name.length) {
    const token = pattern[patternIndex];
    if (token === '*') {
      star = patternIndex++;
      mark = nameIndex;
    } else if (patternIndex < pattern.length && (token === '?' || token === name[nameIndex])) {
      patternIndex++;
      nameIndex++;
    } else if (star !== -1) {
      patternIndex = star + 1;
      nameIndex = ++mark;
    } else return false;
  }
  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
};

/**
 * Whole-segment matching with `**` consuming one or more segments. Memoized on
 * (name index, pattern index), so any number of globstars costs at most
 * O(name^2 x pattern) instead of the exponential partition search.
 */
const matchesSegments = (name: string[], pattern: string[]): boolean => {
  const memo = new Map<number, boolean>();
  const walk = (nameIndex: number, patternIndex: number): boolean => {
    const key = nameIndex * (pattern.length + 1) + patternIndex;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const head = pattern[patternIndex];
    let result: boolean;
    if (head === undefined) result = nameIndex === name.length;
    else if (head === '**') {
      result = false;
      for (let take = 1; nameIndex + take <= name.length && !result; take++)
        result = walk(nameIndex + take, patternIndex + 1);
    } else {
      const first = name[nameIndex];
      result =
        first !== undefined && matchesSegment(first, head) && walk(nameIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
};

// npm-run-all treats repeated separators as one, so `build::deps` names `build:deps`.
const collapseColons = (value: string): string => value.replace(/:+/g, ':');

const matchesScriptPattern = (name: string, pattern: string): boolean =>
  matchesSegments(collapseColons(name).split(':'), collapseColons(pattern).split(':'));

const MAX_GLOBSTAR_SEGMENTS = 6;

/**
 * npm-run-all splits patterns on `:` and lets a whole-segment `**` consume zero
 * or more segments, so `build:**:deps` selects `build:deps`. Expand every
 * collapse combination of those segments; `null` means too many to expand and
 * the caller must stay conservative.
 */
const globstarVariants = (pattern: string): string[] | null => {
  const segments = collapseColons(pattern).split(':');
  const globstars = segments.filter((segment) => segment === '**').length;
  if (globstars > MAX_GLOBSTAR_SEGMENTS) return null;
  let variants: string[][] = [[]];
  for (const segment of segments) {
    variants =
      segment === '**'
        ? variants.flatMap((variant) => [variant, [...variant, segment]])
        : variants.map((variant) => [...variant, segment]);
  }
  return [...new Set(variants.map((variant) => variant.join(':')))];
};

/** Compare installed-tree inputs without exposing package-manager credential bytes. */
export async function assertAddressDependencyMetadata(
  root: string,
  caller: string,
  admit: () => void,
  prepared = false,
): Promise<void> {
  // Metadata is compared as raw bytes unless it must be parsed: decoding binary
  // lockfiles (e.g. bun.lockb) as UTF-8 replaces invalid sequences, so distinct
  // bytes could otherwise compare equal.
  const readBytes = async (cwd: string, path: string) => {
    admit();
    try {
      const full = await realpath(resolve(cwd, path));
      if (!within(await realpath(cwd), full))
        throw new Error('dependency metadata escapes checkout');
      return await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const read = async (cwd: string, path: string) => {
    const bytes = await readBytes(cwd, path);
    return bytes === null ? null : bytes.toString('utf8');
  };
  // Scripts npm actually executes when installation runs: every lifecycle key,
  // plus the scripts those lifecycle commands invoke (`npm run X` / `pnpm run X`)
  // and their implicit pre/post hooks. A change to any of these changes what
  // installation executes, even when every lifecycle key itself is identical.
  const invokedScripts = (scripts: Record<string, string>): Set<string> => {
    const selected = new Set<string>();
    const worklist = [...installLifecycleScripts].filter((key) => key in scripts);
    while (worklist.length > 0) {
      const key = worklist.pop();
      if (key === undefined || selected.has(key)) continue;
      selected.add(key);
      const command = scripts[key] ?? '';
      // Unquoted shell boundaries stay in the stream so a runner's task list ends there.
      // A word is any run of quoted and unquoted segments (`"build":deps`), decoded
      // together; a stray unmatched quote stays in the word and forces ambiguity.
      const raw = command.match(/[;&|()]+|(?:"[^"]*"|'[^']*'|[^\s;&|()"']|["'])+/g) ?? [];
      const boundary = raw.map((token) => /^[;&|()]+$/.test(token));
      const tokens = raw.map((token) =>
        token.replace(
          /"([^"]*)"|'([^']*)'/g,
          (_match, double?: string, single?: string) => double ?? single ?? '',
        ),
      );
      const literal = new Set<string>();
      // npm-run-all (run-s/run-p/npm-run-all) selects scripts by name pattern, so a
      // token like `build:*` runs `build:deps` even though the command never spells
      // that name. Record the patterns it names; unsupported/negative matching stays
      // ambiguous below so no actual install input is omitted.
      const patterns = new Set<string>();
      // Dynamic shell expressions and unsupported runner syntax stay conservative:
      // narrowing those to literal names could omit an actual install input.
      // A runner pattern whose targets cannot be established makes every script a
      // possible install input.
      let unresolved = false;
      let ambiguous =
        /[$`\\<>]/.test(command) ||
        tokens.includes('eval') ||
        tokens.some((token) => /[\s'"]/.test(token));
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index] ?? '';
        if (token.startsWith('npm:')) {
          const name = token.slice(4);
          if (!name || /[*?\[]/.test(name)) ambiguous = true;
          else literal.add(name);
        }
        const runner = token.split('/').at(-1) ?? '';
        // Normalize path-qualified .bin invocations (e.g. ./node_modules/.bin/run-s)
        // to the runner name so the npm-run-all family stays ambiguous, keeping
        // the scripts it names reachable.
        if (['npm-run-all', 'run-s', 'run-p'].includes(runner)) {
          ambiguous = true;
          for (let next = index + 1; next < tokens.length; next++) {
            const argument = tokens[next] ?? '';
            // The task list ends at a shell boundary or `--` (forwarded arguments).
            if (boundary[next] || argument === '--') break;
            // Options that take a separate value consume it so it is not read as a task.
            if (argument === '--max-parallel' || argument === '--npm-path') {
              next++;
              continue;
            }
            if (argument.startsWith('-')) continue;
            // Unsupported matcher syntax (negation, brackets, braces, shell expansion) stays
            // ambiguous; supported `*`/`?` patterns resolve to the scripts they
            // name so a pattern-selected script is still compared.
            // A quoted argument carries forwarded task arguments after the
            // pattern (`"build:* --mode=production"`): match the task alone.
            const task = collapseColons(argument.trim().split(/\s+/)[0] ?? '');
            if (/[!\[\]{}()+,|\\$`]/.test(task)) unresolved = true;
            else if (/[*?]/.test(task)) {
              const variants = globstarVariants(task);
              if (variants === null) unresolved = true;
              else for (const variant of variants) patterns.add(variant);
            } else if (task in scripts) literal.add(task);
            else ambiguous = true;
          }
        }
        if (!['npm', 'pnpm', 'yarn', 'bun'].includes(runner)) continue;
        let name = tokens[index + 1];
        if (name === 'run' || name === 'run-script') name = tokens[index + 2];
        else if (runner === 'npm') {
          ambiguous = true;
          continue;
        }
        if (!name || !(name in scripts) || name.startsWith('-') || /[*?\[]/.test(name))
          ambiguous = true;
        else literal.add(name);
      }
      if (unresolved) ambiguous = true;
      const resolved = [...patterns];
      for (const target of Object.keys(scripts)) {
        if (
          target === key ||
          selected.has(target) ||
          !(
            unresolved ||
            literal.has(target) ||
            (ambiguous && command.includes(target)) ||
            resolved.some((pattern) => matchesScriptPattern(target, pattern))
          )
        )
          continue;
        worklist.push(target);
      }
      for (const hook of [`pre${key}`, `post${key}`]) {
        if (hook in scripts && !selected.has(hook)) worklist.push(hook);
      }
    }
    return selected;
  };
  const relevant = (text: string | null) => {
    if (text === null) return text;
    const parsed = DependencyManifest.parse(JSON.parse(text) as unknown);
    const fields = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !descriptiveManifestFields.has(key)),
    );
    const scripts = parsed.scripts ?? {};
    const keep = new Set([...installLifecycleScripts].filter((key) => key in scripts));
    for (const name of invokedScripts(scripts)) {
      if (name in scripts) keep.add(name);
    }
    const lifecycle = Object.fromEntries(Object.entries(scripts).filter(([key]) => keep.has(key)));
    if (Object.keys(lifecycle).length) fields.scripts = lifecycle;
    return fields;
  };
  const compare = async (path: string, manifest = false) => {
    // Manifests are parsed, so they stay decoded text; every other metadata
    // file is byte-compared so binary lockfiles are never lossily decoded.
    const differs = manifest
      ? !isDeepStrictEqual(relevant(await read(root, path)), relevant(await read(caller, path)))
      : !isDeepStrictEqual(await readBytes(root, path), await readBytes(caller, path));
    if (differs)
      throw new Error(
        prepared
          ? 'prepared dependency root manifests/locks differ; provide a prepared root matching the PR metadata'
          : 'installed dependency root manifests/locks differ; install dependencies in the PR worktree',
      );
  };
  await compare('package.json', true);
  for (const path of [
    ...dependencyLockfiles,
    'pnpm-workspace.yaml',
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
    // A member lockfile (pnpm without a shared workspace lockfile, or a nested
    // project) selects versions this checkout's installed tree may not match.
    for (const config of [...dependencyLockfiles, '.npmrc', '.yarnrc.yml', 'bunfig.toml'])
      await compare(`${dirname(path)}/${config}`);
  }
}
