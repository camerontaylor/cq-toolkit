/**
 * File-backed reads for the repair harvest (repair_tick.py:422-578): the inbox
 * job, the result artifact and `Path.resolve()`. Inactive: nothing imports
 * this outside tests. Verification, worktrees, the finding ledger and
 * publication stay injected; they have no TS wiring yet.
 */
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseJsonValue, toPlainJson } from '../../policy/crq/jsonValue.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';

export interface FileRepairHarvestInput {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.WT_ROOT`. */
  readonly worktreeRoot: string;
}

export type FileRepairHarvestReads = Pick<
  RepairHarvestEffects,
  'readJob' | 'resultExists' | 'readResult' | 'resolvePath' | 'worktreeRoot'
>;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** A failed read is an `OSError`; a decode or parse failure is a `ValueError`. */
async function readJson(path: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new PyError('OSError', e instanceof Error ? e.message : String(e));
  }
  try {
    return toPlainJson(parseJsonValue(decoder.decode(bytes)), { bigints: true });
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

/** Marks "the symlink pushed below this has been resolved"; no path component can be NUL. */
const SYMLINK_RESOLVED = '\0resolved';

/**
 * CPython 3.14 `posixpath.realpath(strict=False)`, which `Path.resolve()`
 * calls. Components resolve in filesystem order, so a `..` after a symlink
 * climbs from the link's target, not from the link's own parent. A component
 * that cannot be inspected (missing, not a directory, a symlink loop) is kept
 * and the rest of the path resolves lexically. An embedded NUL is the one
 * error Python does not swallow.
 */
async function pyRealpath(filename: string): Promise<string> {
  if (filename.includes('\0'))
    throw new PyError('ValueError', 'lstat: embedded null character in path');
  const rest = filename.split('/').reverse();
  let partCount = rest.length;
  let path = filename.startsWith('/') ? '/' : process.cwd();
  // symlink path -> fully resolved target, or null while it is being resolved
  const seen = new Map<string, string | null>();
  while (partCount > 0) {
    const name = rest.pop();
    if (name === undefined) break;
    if (name === SYMLINK_RESOLVED) {
      seen.set(rest.pop() ?? '', path);
      continue;
    }
    partCount -= 1;
    if (name === '' || name === '.') continue;
    if (name === '..') {
      const slash = path.lastIndexOf('/');
      path = path.slice(0, slash) || '/';
      continue;
    }
    const next = path === '/' ? `/${name}` : `${path}/${name}`;
    let target: string;
    try {
      if (!(await lstat(next)).isSymbolicLink()) {
        path = next;
        continue;
      }
      if (seen.has(next)) {
        const resolved = seen.get(next) ?? null;
        path = resolved ?? next;
        continue;
      }
      target = await readlink(next);
    } catch {
      path = next;
      continue;
    }
    if (target.startsWith('/')) path = '/';
    seen.set(next, null);
    rest.push(next, SYMLINK_RESOLVED);
    const parts = target.split('/').reverse();
    rest.push(...parts);
    partCount += parts.length;
  }
  return path;
}

export function fileRepairHarvestReads(input: FileRepairHarvestInput): FileRepairHarvestReads {
  const repair = (...parts: string[]): string => join(input.stateRoot, 'repair', ...parts);
  return {
    worktreeRoot: input.worktreeRoot,
    readJob: (jobId) => readJson(repair('inbox', `${jobId}.json`)),
    readResult: (jobId) => readJson(repair(jobId, 'result.json')),
    resultExists: (jobId) =>
      stat(repair(jobId, 'result.json')).then(
        () => true,
        () => false,
      ),
    /** `Path.resolve()`: CPython 3.14 `posixpath.realpath(strict=False)`. */
    resolvePath: pyRealpath,
  };
}
