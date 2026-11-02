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
  if (correlation === undefined) {
    // Direct op invocation (measurement M5b1): no runner minted a
    // correlation, so derive the Paseo parent HERE at the shared driver
    // boundary — every transport composes its child env through this one
    // function, and the CLI surface needs no second precedence
    // implementation. The derivation reads ONLY the passed env (never
    // process.env), so an explicit inherited CQ_* identity is respected and
    // a Paseo agent id is translated to the `paseo:` parent-work shape the
    // governed path already uses. `PASEO_AGENT_ID` itself is never
    // forwarded (not on the child allowlist). The Paseo id is the LAST
    // precedence tier: an inherited CQ_WORK_ID or CQ_PARENT_WORK_ID is kept
    // as-is (blank counts as absent); with neither, the derived parent is
    // stamped and an env with no identity at all is left exactly as before.
    const pick = (name: string): string | undefined => {
      const value = env[name]?.trim();
      return value === undefined || value === '' ? undefined : value;
    };
    if (pick('CQ_WORK_ID') === undefined && pick('CQ_PARENT_WORK_ID') === undefined) {
      const paseoParent = paseoParentWorkId(env);
      if (paseoParent !== undefined) env['CQ_PARENT_WORK_ID'] = paseoParent;
    }
    return env;
  }
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
 * The PASEO fallback tier of `inboundParentWorkId` alone: the enclosing
 * Paseo agent as `paseo:<PASEO_AGENT_ID>`, or undefined with no agent id
 * (blank counts as absent). The direct-op path stamps THIS, and only this,
 * into the child env — an explicit inherited CQ_* identity is already on
 * the env and must not be second-guessed at the boundary.
 */
export function paseoParentWorkId(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const paseoAgentId = env['PASEO_AGENT_ID']?.trim();
  return paseoAgentId === undefined || paseoAgentId === '' ? undefined : `paseo:${paseoAgentId}`;
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
  return paseoParentWorkId(env);
}
