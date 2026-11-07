// Op-input mirrors of trust-boundary config (ADR-0009 "Op-input mirrors";
// ADR-0002 §B.1). Plan JSON and op input are never a source of trust
// config: a mirrored field is only accepted when it EQUALS the resolved
// value (or is absent). A difference is a pre-effect `config` failure.
import { DispatchError } from '../../driver/errors.js';
import { readCqEnv } from '../../config/env.js';
import type { CqEnv } from '../../config/env.js';
import { SelfhostDefaults } from '../../selfhost/config.js';

const SHOWN = 80;
/** A plan-supplied value echoed into an error: bounded, JSON-quoted. */
const shown = (v: string): string =>
  JSON.stringify(v.length > SHOWN ? `${v.slice(0, SHOWN)}...` : v);

/** The resolved base branch: CQ_MERGE_BASE_BRANCH, else the built-in default. */
export function resolvedBaseBranch(cqEnv: CqEnv): string {
  return (
    (cqEnv.values['CQ_MERGE_BASE_BRANCH'] as string | undefined) ?? SelfhostDefaults.baseBranch
  );
}

/** The resolved protected branch: CQ_MERGE_PROTECTED_BRANCH, else the built-in default. */
export function resolvedProtectedBranch(cqEnv: CqEnv): string {
  return (
    (cqEnv.values['CQ_MERGE_PROTECTED_BRANCH'] as string | undefined) ??
    SelfhostDefaults.protectedBranch
  );
}

/**
 * Refuse a `protectedBranch` input that differs from the resolved one and
 * return the resolved value, which is what effects must bind (never the input).
 */
export function assertProtectedBranchMirror(
  op: string,
  value: string | undefined,
  cqEnv?: CqEnv,
): string {
  const resolved = resolvedProtectedBranch(cqEnv ?? readCqEnv());
  if (value !== undefined && value !== resolved) {
    throw new DispatchError(
      'config',
      `${op}: input.protectedBranch ${shown(value)} differs from the resolved CQ_MERGE_PROTECTED_BRANCH ${JSON.stringify(resolved)} — plan data cannot override trust config`,
    );
  }
  return resolved;
}

/** Refuse a queue `baseBranch` input that differs from CQ_MERGE_BASE_BRANCH's resolved value. */
export function assertBaseBranchMirror(op: string, value: string, cqEnv?: CqEnv): void {
  const resolved = resolvedBaseBranch(cqEnv ?? readCqEnv());
  if (value === resolved) return;
  throw new DispatchError(
    'config',
    `${op}: input.baseBranch ${shown(value)} differs from the resolved CQ_MERGE_BASE_BRANCH ${JSON.stringify(resolved)} — plan data cannot override trust config`,
  );
}
