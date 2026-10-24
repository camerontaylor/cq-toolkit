import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CheckCommand, CheckFailure, FailureSet } from '../gates/checkRunner.js';

/** A task owns one failing file; static clustering can supply the same shape. */
export interface FixTask {
  id: string;
  files: string[];
  failures: CheckFailure[];
}

/** Unattributed failures remain explicit tasks; they cannot silently disappear. */
export function tasksFromFailures(baseline: FailureSet): FixTask[] {
  const groups = new Map<string, CheckFailure[]>();
  for (const failure of baseline.failures) {
    const key = failure.file ?? '(unattributed)';
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, failures]) => ({
      id,
      files: failures[0]?.file == null ? [] : [id],
      failures,
    }));
}

/** relatedArgs replaces the whole argv; {files} expands as separate arguments. */
export function relatedCheckCommand(
  check: CheckCommand,
  files: readonly string[],
  relatedArgs?: readonly string[],
): CheckCommand {
  if (relatedArgs !== undefined && !relatedArgs.includes('{files}')) {
    throw new Error('relatedArgs must include a standalone {files} token');
  }
  return {
    ...check,
    args:
      relatedArgs === undefined
        ? [...check.args, ...files.map((file) => (file.startsWith('-') ? './' + file : file))]
        : relatedArgs.flatMap((arg) => (arg === '{files}' ? [...files] : [arg])),
  };
}

/** Resolve existing ancestors too: a reporter may name a file removed by the fix. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonicalPath(parent), basename(path));
  }
}

/** Canonical task/fingerprint paths are relative to the checkout, never check.cwd. */
export function normalizeFailurePaths(
  set: FailureSet,
  workspace: string,
  checkCwd = workspace,
): FailureSet {
  const root = canonicalPath(resolve(workspace));
  return {
    ...set,
    failures: set.failures.map((failure) => {
      if (failure.file === null) return failure;
      const file = relative(root, canonicalPath(resolve(checkCwd, failure.file)));
      if (file === '..' || file.startsWith('../') || isAbsolute(file))
        throw new Error('check failure path escapes the workspace');
      return { ...failure, file };
    }),
  };
}
