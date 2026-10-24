import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fnv1a32Hex } from '../gates/fingerprint.js';
import type { AdapterName, CheckCommand, CheckFailure, FailureSet } from '../gates/checkRunner.js';

/** A task owns one failing file; static clustering can supply the same shape. */
export interface FixTask {
  id: string;
  /** Full static identity remains authoritative even if compact hashes collide. */
  signature?: string;
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

/** File-first static clusters reuse analyze's FNV-1a hash over a canonical JSON identity. */
export function staticTasksFromFailures(baseline: FailureSet): FixTask[] {
  const groups = new Map<string, CheckFailure[]>();
  for (const failure of baseline.failures) {
    const signature = JSON.stringify([baseline.tool, failure.file, failure.ruleId]);
    const group = groups.get(signature) ?? [];
    group.push(failure);
    groups.set(signature, group);
  }
  return [...groups]
    .map(([signature, failures]) => ({
      id: fnv1a32Hex(signature),
      signature,
      files: failures[0]?.file == null ? [] : [failures[0].file],
      failures: failures.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort(
      (a, b) =>
        (a.files[0] ?? '').localeCompare(b.files[0] ?? '') ||
        a.signature.localeCompare(b.signature),
    );
}

/** A sibling may clear this task; static siblings in the same file remain independent. */
export function taskHasFailures(task: FixTask, set: FailureSet, source = 'tests'): boolean {
  return set.failures.some(
    (failure) =>
      failure.file !== null &&
      task.files.includes(failure.file) &&
      (source !== 'static' || failure.ruleId === task.failures[0]?.ruleId),
  );
}

/** Static tsc retains its full project argv; ESLint requires an explicit scoped replacement. */
export function staticRelatedCheckCommand(
  check: CheckCommand,
  adapter: AdapterName,
  files: readonly string[],
  relatedArgs?: readonly string[],
): CheckCommand {
  if (adapter === 'tsc-lines') return { ...check, args: [...check.args] };
  if (adapter !== 'eslint-json' || files.length === 0 || !relatedArgs?.includes('{files}'))
    throw new Error(
      'static ESLint requires relatedArgs with a standalone {files} token and attributed task files',
    );
  return relatedCheckCommand(check, files, relatedArgs);
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
