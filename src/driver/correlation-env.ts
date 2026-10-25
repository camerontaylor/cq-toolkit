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

/**
 * The CQ_* names a present correlation leaves UNSET — for a spawn boundary
 * that composes the final env itself from the parent (spawnManaged's
 * `envRemove`), where deleting from an overrides-only map has no effect.
 */
export function correlationEnvRemovals(correlation: WorkCorrelation | undefined): string[] {
  if (correlation === undefined) return [];
  return FIELDS.filter(([field]) => {
    const value = correlation[field];
    return value === undefined || value === '';
  }).map(([, name]) => name);
}

/**
 * The parent work id a governed run's jobs inherit from the env cq was
 * launched in (minted into every job's correlation by the runner). An
 * explicit CQ_* identity always wins: the launcher's own `CQ_WORK_ID` (the
 * run is a unit of that work), else a passed-through `CQ_PARENT_WORK_ID`.
 * With neither, a run launched inside a Paseo agent links to that agent as
 * `paseo:<PASEO_AGENT_ID>` (the id shape telemetry-ingest uses for Paseo
 * agents). Only the derived id rides on; `PASEO_AGENT_ID` itself is not
 * forwarded. Blank values count as absent.
 */
export function inboundParentWorkId(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const pick = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const explicit = pick('CQ_WORK_ID') ?? pick('CQ_PARENT_WORK_ID');
  if (explicit !== undefined) return explicit;
  const paseoAgentId = pick('PASEO_AGENT_ID');
  return paseoAgentId === undefined ? undefined : `paseo:${paseoAgentId}`;
}
