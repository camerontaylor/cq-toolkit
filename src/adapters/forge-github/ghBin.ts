// The ONE gh-binary resolver for the forge adapter: CQ_GH_BIN (the
// review/merge families' test seam), else `gh`. The value comes from the
// entry point's CQ_* snapshot when one is passed; without one the environment
// is read at the call (invocation time), so SDK callers and CLI-driven tests
// that set CQ_GH_BIN after construction keep working.
//
// A RELATIVE bin path with a separator resolves against the PROCESS cwd:
// spawns may run with cwd=repoRoot, which would otherwise silently change
// which binary a relative CQ_GH_BIN names. Bare names keep PATH lookup;
// absolute paths pass through.
import { statSync } from 'node:fs';
import { isAbsolute, resolve as pathResolve, sep, win32, posix } from 'node:path';
import type { CqEnv } from '../../config/env.js';
import { currentCqEnv } from '../../config/run-env.js';

export function resolveGhBin(cqEnv?: CqEnv): string {
  const configured = (cqEnv ?? currentCqEnv()).values['CQ_GH_BIN'];
  const rawBin = typeof configured === 'string' ? configured : 'gh';
  return rawBin.includes('/') || rawBin.includes('\\')
    ? isAbsolute(rawBin)
      ? rawBin
      : pathResolve(process.cwd(), rawBin)
    : rawBin;
}

/** Merge explicit environment values using the platform's key semantics. */
export function ghMergeEnv(
  inherited: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...inherited };
  if (platform === 'win32' && overrides !== undefined) {
    const keys = new Set(Object.keys(overrides).map((key) => key.toUpperCase()));
    for (const key of Object.keys(result)) if (keys.has(key.toUpperCase())) delete result[key];
  }
  return { ...result, ...overrides };
}

/** Split Windows PATH the way libuv does: quoted entries may contain semicolons. */
function splitWindowsPath(path: string): string[] {
  const entries: string[] = [];
  let start = 0;
  while (start <= path.length) {
    const quote = path[start] === '"' || path[start] === "'" ? path[start] : undefined;
    const endQuote = quote === undefined ? -1 : path.indexOf(quote, start + 1);
    const separator =
      quote !== undefined && endQuote === -1
        ? -1
        : path.indexOf(';', endQuote === -1 ? start : endQuote + 1);
    const end = separator === -1 ? path.length : separator;
    let entry = path.slice(start, end);
    if (entry[0] === '"' || entry[0] === "'") entry = entry.slice(1);
    if (entry.at(-1) === '"' || entry.at(-1) === "'") entry = entry.slice(0, -1);
    entries.push(entry);
    if (separator === -1) break;
    start = separator + 1;
  }
  return entries;
}

/** Anchor PATH without collapsing components: symlinks can change the meaning of `..`. */
export function ghSpawnEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const result = { ...env };
  const windows = platform === 'win32';
  const key = Object.keys(result)
    .sort()
    .find((name) => (windows ? name.toUpperCase() === 'PATH' : name === 'PATH'));
  const path = key === undefined ? (windows ? '' : '/usr/bin:/bin') : (result[key] ?? '');
  const parts = windows ? splitWindowsPath(path) : path.split(':');
  const pathApi = windows ? win32 : posix;
  result[key ?? 'PATH'] = parts
    .map((entry) => {
      // Empty Windows PATH entries are skipped by libuv. POSIX treats them as cwd.
      if (windows && entry === '') return '';
      const rootedWithoutDrive = windows && /^[\\/](?![\\/])/.test(entry);
      const anchored = rootedWithoutDrive
        ? `${cwd.slice(0, 2)}${entry}`
        : entry === ''
          ? cwd
          : pathApi.isAbsolute(entry)
            ? entry
            : `${cwd}${pathApi.sep}${entry}`;
      return windows && anchored.includes(';') ? `"${anchored}"` : anchored;
    })
    .join(windows ? ';' : ':');
  return result;
}

/** Windows searches child cwd before PATH; resolve there using the caller's cwd instead. */
export function resolveWindowsCommand(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  callerEnv: NodeJS.ProcessEnv = {},
  cwd: string = process.cwd(),
  probe: (candidate: string) => boolean = (candidate) => statSync(candidate).isFile(),
): string | undefined {
  if (platform !== 'win32' || bin.includes('/') || bin.includes('\\')) return bin;
  const key = Object.keys(env)
    .sort()
    .find((name) => name.toUpperCase() === 'PATH');
  const paths = splitWindowsPath(key === undefined ? '' : (env[key] ?? '')).filter(
    (entry) => entry !== '',
  );
  const skipCwd = Object.keys(callerEnv).some(
    (name) => name.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH',
  );
  const names = [...(/\.[^.]+$/.test(bin) ? [bin] : []), `${bin}.com`, `${bin}.exe`];
  for (const dir of [...(skipCwd ? [] : [cwd]), ...paths]) {
    for (const name of names) {
      const candidate = `${dir}${dir.endsWith(sep) ? '' : sep}${name}`;
      try {
        if (probe(candidate)) return candidate;
      } catch {
        /* search the next candidate */
      }
    }
  }
  return undefined;
}
