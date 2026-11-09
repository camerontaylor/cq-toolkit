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
import { delimiter, isAbsolute, resolve as pathResolve } from 'node:path';
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

/** Anchor PATH entries before any subprocess changes cwd, preserving native search semantics. */
export function ghSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  const key = Object.keys(result)
    .sort()
    .find((name) =>
      process.platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH',
    );
  const path =
    key === undefined ? (process.platform === 'win32' ? '' : '/usr/bin:/bin') : (result[key] ?? '');
  result[key ?? 'PATH'] = path
    .split(delimiter)
    .map((entry) => pathResolve(entry))
    .join(delimiter);
  return result;
}
