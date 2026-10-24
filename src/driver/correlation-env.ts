// Session-log correlation (preservation plan items 1.3–1.5): the ONE place a
// lane turns an invocation's WorkCorrelation into its child's CQ_* env.
// Every subprocess transport (claude-code CLI and SDK, ACP) applies it to
// the env it already composed, so a governed job's work identity reaches the
// harness however it is spawned. When a correlation is present it is
// authoritative: a field it lacks REMOVES any inherited value of that name
// (the names are allowlisted, so an outer run's CQ_ROLE/CQ_TASK would
// otherwise sit next to this job's CQ_WORK_ID). Absent correlation leaves
// the env untouched (un-governed callers behave exactly as before).

import type { WorkCorrelation } from './types.js';

const FIELDS: ReadonlyArray<readonly [keyof WorkCorrelation, string]> = [
  ['workId', 'CQ_WORK_ID'],
  ['role', 'CQ_ROLE'],
  ['task', 'CQ_TASK'],
  ['runId', 'CQ_RUN_ID'],
  ['parentWorkId', 'CQ_PARENT_WORK_ID'],
];

/** Stamp `correlation` onto `env` in place (and return it). */
export function applyCorrelationEnv(
  env: Record<string, string>,
  correlation: WorkCorrelation | undefined,
): Record<string, string> {
  if (correlation === undefined) return env;
  for (const [field, name] of FIELDS) {
    const value = correlation[field];
    if (value !== undefined && value !== '') env[name] = value;
    else delete env[name];
  }
  return env;
}
