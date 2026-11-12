// Session-log correlation (preservation plan items 1.3–1.5): the ONE place a
// lane's WorkCorrelation reaches the CQ_* child-env names. The driver
// transports (SDK, ACP) hand applyCorrelationEnv the child env they have
// already composed; the CLI path instead hands an overrides-only map that
// buildChildEnv composes later, so applyCorrelationEnv is the shared
// treatment for both shapes and a governed job's work identity reaches the
// harness however it is spawned. When a correlation is present it is
// authoritative: a field it lacks REMOVES any inherited value of that name
// (the names are allowlisted, so an outer run's CQ_ROLE/CQ_TASK would
// otherwise sit next to this job's CQ_WORK_ID). Absent correlation leaves
// the inherited identity alone EXCEPT for the M5b1 direct-op derivation: a
// direct op invocation (no runner minted a correlation) with no inherited
// CQ_WORK_ID and no inherited CQ_PARENT_WORK_ID gets the enclosing Paseo
// agent derived as CQ_PARENT_WORK_ID
// (see the undefined-correlation branch below).
//
// STAMP SCOPE (deliberate, one line): applyCorrelationEnv is called ONLY at
// the three transports' child-env composition sites (claude-code CLI, SDK,
// ACP) — each stamps the env of the child it is about to spawn, nothing
// wider.

import type { CqEnv } from '../config/env.js';
import type { WorkCorrelation } from './types.js';
import { paseoParentLinkFromAgentId } from '../shared/proc.js';

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
    // boundary — the SDK and ACP transports hand their composed child env
    // through this one function, and the CLI surface needs no second
    // precedence implementation (the CLI's overrides-only composition is
    // stamped by buildChildEnv instead, so this derivation is its backstop).
    // The derivation reads ONLY the passed env (never
    // process.env), so an explicit inherited CQ_WORK_ID or CQ_PARENT_WORK_ID
    // is respected and
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
  const paseoAgentId = env['PASEO_AGENT_ID'];
  return paseoParentLinkFromAgentId(paseoAgentId);
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

/**
 * Snapshot-aware {@link inboundParentWorkId}: the explicit CQ_* tiers come
 * from the entry/run `CqEnv` snapshot, so an ambient identity change after
 * entry can never move a run's recorded parent. `PASEO_AGENT_ID` is a
 * FOREIGN name (never part of the CQ_* registry), so its fallback stays a
 * live read of the caller-supplied foreign environment — that last
 * precedence tier is unchanged. Precedence and blank-as-absent semantics
 * are delegated to {@link inboundParentWorkId} so there is one
 * implementation.
 */
export function inboundParentWorkIdFromSnapshot(
  cqEnv: Pick<CqEnv, 'values'>,
  foreignEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const snapshotValue = (name: string): string | undefined => {
    const value = cqEnv.values[name];
    return typeof value === 'string' ? value : undefined;
  };
  return inboundParentWorkId({
    CQ_WORK_ID: snapshotValue('CQ_WORK_ID'),
    CQ_PARENT_WORK_ID: snapshotValue('CQ_PARENT_WORK_ID'),
    PASEO_AGENT_ID: foreignEnv['PASEO_AGENT_ID'],
  });
}
