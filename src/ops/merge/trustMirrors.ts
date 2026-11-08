// Op-input mirrors of trust-boundary config (ADR-0009 "Op-input mirrors";
// ADR-0002 §B.1). Plan JSON and op input are never a source of trust
// config: a mirrored field is only accepted when it EQUALS the resolved
// value (or is absent). A difference is a pre-effect `config` failure.
import { DispatchError } from '../../driver/errors.js';
import { readCqEnv } from '../../config/env.js';
import { ASSOCIATIONS, stripRefsHeads } from '../../config/values.js';
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
  if (value !== undefined && stripRefsHeads(value) !== resolved) {
    throw new DispatchError(
      'config',
      `${op}: input.protectedBranch ${shown(value)} differs from the resolved CQ_MERGE_PROTECTED_BRANCH ${shown(resolved)} — plan data cannot override trust config`,
    );
  }
  return resolved;
}

/**
 * Refuse a queue `baseBranch` input that differs from CQ_MERGE_BASE_BRANCH's
 * resolved value; returns the resolved value, which callers must use
 * downstream (an accepted `refs/heads/` spelling never reaches the planner raw).
 */
export function assertBaseBranchMirror(op: string, value: string, cqEnv?: CqEnv): string {
  const resolved = resolvedBaseBranch(snapshotFor(op, 'CQ_MERGE_BASE_BRANCH', cqEnv));
  if (stripRefsHeads(value) === resolved) return resolved;
  throw new DispatchError(
    'config',
    `${op}: input.baseBranch ${shown(value)} differs from the resolved CQ_MERGE_BASE_BRANCH ${shown(resolved)} — plan data cannot override trust config`,
  );
}

/** Classification trust fields and the registry keys that resolve them. */
const CLASSIFY_TRUST_KEYS = {
  trustedBots: 'CQ_MERGE_TRUSTED_BOTS',
  trustedAssociations: 'CQ_MERGE_TRUSTED_ASSOCIATIONS',
  acceptReviewStates: 'CQ_MERGE_ACCEPT_REVIEW_STATES',
} as const;
type ClassifyTrustField = keyof typeof CLASSIFY_TRUST_KEYS;

/** The classification trust set resolved from trusted config only. */
export interface ClassifyTrust {
  trustedBots?: string[];
  trustedAssociations?: string[];
  acceptReviewStates?: ('APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED')[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
};

/**
 * Who counts as a reviewer is a TRUST input: it is resolved only from
 * CQ_MERGE_TRUSTED_BOTS, CQ_MERGE_TRUSTED_ASSOCIATIONS and
 * CQ_MERGE_ACCEPT_REVIEW_STATES. When none is set the classifier keeps its
 * built-in behaviour (nothing returned). When ANY is set, policy mode is on
 * and each unset key INDEPENDENTLY takes its documented default (bots: none;
 * associations: OWNER, MEMBER, COLLABORATOR; states: APPROVED), so setting one
 * key never blanks another. A supplied `config` carrying a field is accepted
 * only when it equals the effective value (the in-process self-host twin
 * restates it); otherwise it fails with `config`, naming the field and never
 * echoing a value.
 */
export function resolveClassifyTrust(
  op: string,
  supplied: Partial<Record<ClassifyTrustField, readonly string[] | undefined>> | undefined,
  cqEnv?: CqEnv,
): ClassifyTrust {
  const snapshot = cqEnv ?? readCqEnv();
  const fields = Object.keys(CLASSIFY_TRUST_KEYS) as ClassifyTrustField[];
  const raws: Partial<Record<ClassifyTrustField, readonly string[]>> = {};
  for (const field of fields) {
    const key = CLASSIFY_TRUST_KEYS[field];
    const bad = snapshot.errors.filter((d) => d.name === key);
    if (bad.length > 0) {
      throw new DispatchError(
        'config',
        `${op}: invalid ${key} — ${bad.map((d) => d.message).join('; ')}`,
      );
    }
    const raw = snapshot.values[key] as readonly string[] | undefined;
    if (raw !== undefined) raws[field] = raw;
  }
  const anySet = fields.some((f) => raws[f] !== undefined);
  const effective: Partial<Record<ClassifyTrustField, string[]>> = {};
  if (anySet) {
    const up = (v: readonly string[]): string[] => v.map((x) => x.toUpperCase());
    effective.trustedBots = [...(raws.trustedBots ?? [])];
    effective.trustedAssociations =
      raws.trustedAssociations !== undefined ? up(raws.trustedAssociations) : [...ASSOCIATIONS];
    effective.acceptReviewStates =
      raws.acceptReviewStates !== undefined ? up(raws.acceptReviewStates) : ['APPROVED'];
  }
  for (const field of fields) {
    const given = supplied?.[field];
    if (given === undefined) continue;
    const want = effective[field];
    const norm = field === 'trustedBots' ? given : given.map((v) => v.toUpperCase());
    if (want === undefined || !sameSet(norm, want)) {
      throw new DispatchError(
        'config',
        `${op}: input.config.${field} is a trust input and cannot be set by plan data or op input; configure ${CLASSIFY_TRUST_KEYS[field]} instead (value not echoed)`,
      );
    }
  }
  return effective as ClassifyTrust;
}

/** The resolved base branch, refusing an invalid CQ_MERGE_BASE_BRANCH snapshot (no silent default). */
export function checkedBaseBranch(op: string, cqEnv?: CqEnv): string {
  return resolvedBaseBranch(snapshotFor(op, 'CQ_MERGE_BASE_BRANCH', cqEnv));
}

/** The resolved protected branch, refusing an invalid CQ_MERGE_PROTECTED_BRANCH snapshot. */
export function checkedProtectedBranch(op: string, cqEnv?: CqEnv): string {
  return assertProtectedBranchMirror(op, undefined, cqEnv);
}
