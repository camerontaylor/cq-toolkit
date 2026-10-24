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
    throw new Error('checks[].relatedArgs must include a standalone {files} token');
  }
  return {
    ...check,
    args:
      relatedArgs === undefined
        ? [...check.args, ...files]
        : relatedArgs.flatMap((arg) => (arg === '{files}' ? [...files] : [arg])),
  };
}
