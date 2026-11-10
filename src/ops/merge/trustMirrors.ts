// Op-input mirrors of trust-boundary config (ADR-0009 "Op-input mirrors";
// ADR-0002 §B.1). Plan JSON and op input are never a source of trust
// config: a mirrored field is only accepted when it EQUALS the resolved
// value (or is absent). A difference is a pre-effect `config` failure.
import { DispatchError } from '../../driver/errors.js';
import { readCqEnv } from '../../config/env.js';
import { ASSOCIATIONS, stripRefsHeads } from '../../config/values.js';
import type { CqEnv } from '../../config/env.js';
import { SelfhostDefaults } from '../../selfhost/config.js';
import type { ClassifyPrConfig } from './classify.config.js';

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

const CLASSIFY_TRUST_DEFAULTS: Readonly<Record<ClassifyTrustField, readonly string[]>> = {
  trustedBots: [],
  trustedAssociations: ASSOCIATIONS,
  acceptReviewStates: ['APPROVED'],
};

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
    // A comma-only value parses to an empty list: the acceptance flow reads that as the
    // key being unset, so the classifier must too (an empty list never blanks a field).
    const raw = snapshot.values[key] as readonly string[] | undefined;
    if (raw !== undefined && raw.length > 0) raws[field] = raw;
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
    // Shape first: a wrong-shape list is a `config` error, never a TypeError below.
    if (!isStringArray(given)) {
      throw new DispatchError(
        'config',
        `${op}: input.config.${field} has the wrong shape (value not echoed)`,
      );
    }
    // With no key set, a restated list is accepted only if it equals the documented default
    // (stricter than the built-in legacy behaviour, so it supplies no authority).
    const want = effective[field] ?? CLASSIFY_TRUST_DEFAULTS[field];
    const norm = field === 'trustedBots' ? given : given.map((v) => v.toUpperCase());
    if (!sameSet(norm, want)) {
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

/**
 * How a plan/op-input classify `config` field combines with the host's value.
 * DENY BY DEFAULT: every `ClassifyPrConfig` field needs a rule here (the
 * `satisfies` below fails to compile when the type gains a field), and a plan
 * field whose rule is `deny` or that has no rule fails with `config`, naming
 * the field and never its value.
 *
 * - `max`: the larger of host and plan (a plan can only lengthen the wait).
 * - `union`: set union (a plan can only add exclusions).
 * - `host-wins`: a conflicting plan value is a `config` error; the host value is kept.
 * - `trust-list`: a trust list already checked by `resolveClassifyTrust`
 *   (equal to the resolved value); normalised to upper case when
 *   case-insensitive, then taken from the plan side.
 * - `deny`: not settable by plan data (code-owned patterns).
 */
type ClassifyFieldRule = 'max' | 'union' | 'host-wins' | 'trust-list' | 'trust-list-upper' | 'deny';
const CLASSIFY_FIELD_RULES = {
  settleWindowMs: 'max',
  allClearPattern: 'deny',
  skipPatterns: 'deny',
  trustedBots: 'trust-list',
  trustedAssociations: 'trust-list-upper',
  automationLogin: 'host-wins',
  excludedLogins: 'union',
  acceptReviewStates: 'trust-list-upper',
} as const satisfies Record<keyof ClassifyPrConfig, ClassifyFieldRule>;

/** The classify fields the rules table decides (a test pins this list). */
export const CLASSIFY_RULE_FIELDS: readonly string[] = Object.keys(CLASSIFY_FIELD_RULES);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Whether a plan value has the shape its rule expects (checked before any use). */
function hasShape(rule: ClassifyFieldRule, value: unknown): boolean {
  switch (rule) {
    case 'max':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'host-wins':
      return typeof value === 'string' || value === null;
    case 'union':
    case 'trust-list':
    case 'trust-list-upper':
      return isStringArray(value);
    case 'deny':
      return false;
  }
}

/**
 * Merge a plan/op-input classify `config` over the host's classify config so
 * that the plan can only NARROW trust (see CLASSIFY_FIELD_RULES). Everything
 * the host set and the plan does not name survives.
 */
export function mergeClassifyConfig<H extends object>(
  op: string,
  host: H,
  plan: Record<string, unknown> | undefined,
): H {
  if (plan === undefined) return host;
  const h = host as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...h };
  for (const [field, value] of Object.entries(plan)) {
    if (value === undefined) continue;
    const rule = Object.hasOwn(CLASSIFY_FIELD_RULES, field)
      ? (CLASSIFY_FIELD_RULES as Record<string, ClassifyFieldRule>)[field]
      : undefined;
    if (rule === undefined || rule === 'deny') {
      throw new DispatchError(
        'config',
        `${op}: input.config.${field} cannot be set by plan data or op input (value not echoed)`,
      );
    }
    if (!hasShape(rule, value)) {
      throw new DispatchError(
        'config',
        `${op}: input.config.${field} has the wrong shape (value not echoed)`,
      );
    }
    const hostValue = h[field];
    switch (rule) {
      case 'max':
        merged[field] =
          typeof hostValue === 'number' && typeof value === 'number'
            ? Math.max(hostValue, value)
            : (hostValue ?? value);
        break;
      case 'union':
        merged[field] = [
          ...new Set([...((hostValue as string[] | undefined) ?? []), ...(value as string[])]),
        ];
        break;
      case 'host-wins':
        if (hostValue !== undefined && value !== hostValue) {
          throw new DispatchError(
            'config',
            `${op}: input.config.${field} conflicts with the host's automation identity and cannot override it (value not echoed)`,
          );
        }
        merged[field] = hostValue ?? value;
        break;
      case 'trust-list':
        merged[field] = value;
        break;
      case 'trust-list-upper':
        merged[field] = (value as string[]).map((v) => v.toUpperCase());
        break;
    }
  }
  return merged as unknown as H;
}
