// Op-input mirrors of trust-boundary config (ADR-0009 "Op-input mirrors";
// ADR-0002 §B.1). Plan JSON and op input are never a source of trust
// config: a mirrored field is only accepted when it EQUALS the resolved
// value (or is absent). A difference is a pre-effect `config` failure.
import { DispatchError } from '../../driver/errors.js';
import { DEFAULT_PROTECTED_BRANCH } from '../../adapters/forge-github/mergeEffects.js';
import { readCqEnv } from '../../config/env.js';
import type { CqEnv } from '../../config/env.js';
import { SelfhostDefaults } from '../../selfhost/config.js';

/** The resolved base branch: CQ_MERGE_BASE_BRANCH, else the built-in default. */
export function resolvedBaseBranch(cqEnv: CqEnv): string {
  return (cqEnv.values['CQ_MERGE_BASE_BRANCH'] as string | undefined) ?? SelfhostDefaults.baseBranch;
}

/**
 * Refuse a `protectedBranch` input that differs from the resolved one.
 * No env key resolves it today, so the resolved value is the built-in
 * default; the field is kept only so existing plans that restate it pass.
 */
export function assertProtectedBranchMirror(op: string, value: string | undefined): void {
  if (value === undefined || value === DEFAULT_PROTECTED_BRANCH) return;
  throw new DispatchError(
    'config',
    `${op}: input.protectedBranch ${JSON.stringify(value)} differs from the resolved protected branch ${JSON.stringify(DEFAULT_PROTECTED_BRANCH)} (built-in; no env key) — plan data cannot override trust config`,
  );
}

/** Refuse a queue `baseBranch` input that differs from CQ_MERGE_BASE_BRANCH's resolved value. */
export function assertBaseBranchMirror(op: string, value: string, cqEnv?: CqEnv): void {
  const resolved = resolvedBaseBranch(cqEnv ?? readCqEnv());
  if (value === resolved) return;
  throw new DispatchError(
    'config',
    `${op}: input.baseBranch ${JSON.stringify(value)} differs from the resolved CQ_MERGE_BASE_BRANCH ${JSON.stringify(resolved)} — plan data cannot override trust config`,
  );
}
