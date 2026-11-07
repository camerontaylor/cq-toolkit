// Op-input mirrors of trust-boundary config (ADR-0009 "Op-input mirrors";
// ADR-0002 §B.1). Plan JSON and op input are never a source of trust
// config: a mirrored field is only accepted when it EQUALS the resolved
// value (or is absent). A difference is a pre-effect `config` failure.
import { DispatchError } from '../../driver/errors.js';
import { readCqEnv } from '../../config/env.js';
import { bareBranch } from '../../config/values.js';
import type { CqEnv } from '../../config/env.js';
import { SelfhostDefaults } from '../../selfhost/config.js';

const SHOWN = 80;
/** A plan-supplied value echoed into an error: bounded, JSON-quoted. */
const shown = (v: string): string =>
  JSON.stringify(v.length > SHOWN ? `${v.slice(0, SHOWN)}...` : v);

/**
 * The snapshot to resolve from (the caller's, else the process env), refused
 * when it carries a parse error for `key`: an invalid trust value must never
 * fall back silently to the built-in default.
 */
function snapshotFor(op: string, key: string, cqEnv: CqEnv | undefined): CqEnv {
  const snapshot = cqEnv ?? readCqEnv();
  const bad = snapshot.errors.filter((d) => d.name === key);
  if (bad.length > 0) {
    throw new DispatchError(
      'config',
      `${op}: invalid ${key} — ${bad.map((d) => d.message).join('; ')}`,
    );
  }
  return snapshot;
}

/** The resolved base branch: CQ_MERGE_BASE_BRANCH, else the built-in default. */
export function resolvedBaseBranch(cqEnv: CqEnv): string {
  return bareBranch(
    (cqEnv.values['CQ_MERGE_BASE_BRANCH'] as string | undefined) ?? SelfhostDefaults.baseBranch,
  );
}

/** The resolved protected branch: CQ_MERGE_PROTECTED_BRANCH, else the built-in default. */
export function resolvedProtectedBranch(cqEnv: CqEnv): string {
  return bareBranch(
    (cqEnv.values['CQ_MERGE_PROTECTED_BRANCH'] as string | undefined) ??
      SelfhostDefaults.protectedBranch,
  );
}

/**
 * Refuse a `protectedBranch` input that differs from the resolved one (either
 * `refs/heads/` spelling compares equal) and return the resolved value, which
 * is what effects must bind (never the input).
 */
export function assertProtectedBranchMirror(
  op: string,
  value: string | undefined,
  cqEnv?: CqEnv,
): string {
  const resolved = resolvedProtectedBranch(snapshotFor(op, 'CQ_MERGE_PROTECTED_BRANCH', cqEnv));
  if (value !== undefined && bareBranch(value) !== resolved) {
    throw new DispatchError(
      'config',
      `${op}: input.protectedBranch ${shown(value)} differs from the resolved CQ_MERGE_PROTECTED_BRANCH ${shown(resolved)} — plan data cannot override trust config`,
    );
  }
  return resolved;
}

/** Refuse a queue `baseBranch` input that differs from CQ_MERGE_BASE_BRANCH's resolved value. */
export function assertBaseBranchMirror(op: string, value: string, cqEnv?: CqEnv): void {
  const resolved = resolvedBaseBranch(snapshotFor(op, 'CQ_MERGE_BASE_BRANCH', cqEnv));
  if (bareBranch(value) === resolved) return;
  throw new DispatchError(
    'config',
    `${op}: input.baseBranch ${shown(value)} differs from the resolved CQ_MERGE_BASE_BRANCH ${shown(resolved)} — plan data cannot override trust config`,
  );
}
