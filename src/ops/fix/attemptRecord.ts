// Attempt evidence normalization — T12 (ADR-0008).
//
// Every persisted text field is sanitized BEFORE journal/report persistence:
// URL userinfo/query and SCP-style credential prefixes are stripped first,
// then `redactSensitiveText` removes environment-secret values. The archive
// repoId is a digest of the normalized credential-free remote, never the
// hostname/path itself. No journal writes here — writers land in T30/T31.
import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../../driver/error-text.js';

/** Attempt cause: null unless observed; stopCode is a stable kebab-case classifier. */
export interface AttemptErrorCause {
  type: string | null;
  code: string | null;
  providerFinishReason: string | null;
  source: string | null;
  certainty: 'observed' | 'unknown';
}

/** Timeout scope per ADR-0008: `P.timeout.{scope,boundMs,source}`. */
export interface AttemptTimeout {
  scope: 'token' | 'wall' | 'command';
  boundMs: number | null;
  source: string | null;
}

/** Budget fields per ADR-0008: only allowed/spent/remaining, no cap/used aliases. */
export interface AttemptBudgetWindow {
  tokens: number | null;
  wallMs: number | null;
}
export interface AttemptBudget {
  allowed: AttemptBudgetWindow;
  spent: AttemptBudgetWindow;
  remaining: AttemptBudgetWindow;
}

/** Availability row per ADR-0008; keyed by JSON Pointer relative to the payload. */
export interface AttemptAvailability {
  state: 'known-zero' | 'not-collected' | 'unavailable' | 'partial' | 'n-a' | 'known';
  reason: string;
  source: string | null;
}

/** Attempt payload per the ADR-0008 registry row (T12). */
export interface AttemptRecord {
  tier: 'worker' | 'rescue';
  attempt: number;
  invocation: 'edit' | 'feedback';
  model: string;
  provider: string | null;
  requestedModel: string | null;
  servedModel: string | null;
  tokens: number | null;
  usageChannels: string[] | null;
  requests: number | null;
  wallMs: number | null;
  modeledUsd: number | null;
  priceTableRevision: string | null;
  priceCoverage: number | null;
  stopReason: string | null;
  stopCode: string | null;
  class: 'infrastructure' | 'budget' | 'human' | 'terminal' | 'retriable' | null;
  reason: string | null;
  error: AttemptErrorCause | null;
  timeout: AttemptTimeout | null;
  budget: AttemptBudget | null;
  availability: Record<string, AttemptAvailability>;
}

const STOP_CLASS: Record<string, AttemptRecord['class']> = {
  spawn: 'infrastructure',
  dns: 'infrastructure',
  transport: 'infrastructure',
  'provider-outage': 'infrastructure',
  unclassified: 'infrastructure',
  'wall-cap': 'budget',
  'token-cap': 'budget',
  'human-deferred': 'human',
  'approval-expired': 'human',
  'validation-failed': 'terminal',
  'model-output': 'terminal',
  nochange: 'terminal',
  completed: 'terminal',
  'provider-retryable': 'retriable',
};

/** Strip URL userinfo/query and SCP-style user prefixes from a text fragment. */
function stripCredentialText(text: string): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/\S*?)\?\S*/gi, '$1');
  out = out.replace(/(^|[\s'"([])[\w.-]+@([\w.-]+):/g, '$1$2:');
  return out;
}

/**
 * Recursively sanitize a persisted observation: strip URL userinfo/query and
 * SCP-style credential prefixes, then redact environment-secret values via
 * `redactSensitiveText`. Non-string JSON values pass through structurally.
 */
export function sanitizeObservation<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSensitiveText(stripCredentialText(value)) as unknown as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(sanitizeObservation(item));
    return out as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeObservation(item);
    return out as unknown as T;
  }
  return value;
}

/**
 * Archive-safe repoId: `sha256:` + SHA-256 of the normalized credential-free
 * remote. The remote hostname/path itself is never persisted; no remote gives
 * null (reported as unavailable with availability).
 */
export function repoIdFromRemote(remote: string | null | undefined): string | null {
  if (remote === null || remote === undefined) return null;
  const normalized = stripCredentialText(remote.trim());
  if (normalized === '') return null;
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

/** Inputs to {@link finishAttempt}; undefined optional evidence is null in the record. */
export interface FinishAttemptInput {
  tier: 'worker' | 'rescue';
  attempt: number;
  invocation: 'edit' | 'feedback';
  model: string;
  provider?: string | null;
  requestedModel?: string | null;
  servedModel?: string | null;
  tokens?: number | null;
  usageChannels?: string[] | null;
  requests?: number | null;
  wallMs?: number | null;
  modeledUsd?: number | null;
  priceTableRevision?: string | null;
  priceCoverage?: number | null;
  stopReason?: string | null;
  stopCode?: string | null;
  reason?: string | null;
  error?: AttemptErrorCause | null;
  timeout?: AttemptTimeout | null;
  budget?: AttemptBudget | null;
  availability?: Record<string, AttemptAvailability>;
  /** Observed completion; budget expiry takes precedence over it per ADR-0008. */
  completed?: boolean;
  /** Budget expired mid-attempt; overrides any other stop evidence. */
  budgetExpired?: boolean;
  /** Which budget bound expired when {@link FinishAttemptInput.budgetExpired}. */
  budgetStopCode?: 'wall-cap' | 'token-cap';
}

/**
 * Normalize one attempt boundary into the ADR-0008 attempt payload. A
 * successful terminal attempt is terminal / `completed`; budget expiry takes
 * precedence over completion and every other stop. Classification is by the
 * stable stopCode table only — never by matching human prose. All text fields
 * are sanitized before the record is returned.
 */
export function finishAttempt(input: FinishAttemptInput): AttemptRecord {
  let stopCode: string | null;
  let stopReason: string | null;
  if (input.budgetExpired === true) {
    stopCode = input.budgetStopCode ?? 'token-cap';
    stopReason = input.stopReason ?? 'token or wall budget exhausted';
  } else if (input.completed === true) {
    stopCode = 'completed';
    stopReason = input.stopReason ?? 'completed';
  } else {
    stopCode = input.stopCode ?? null;
    stopReason = input.stopReason ?? null;
  }
  let attemptClass = stopCode === null ? null : (STOP_CLASS[stopCode] ?? 'infrastructure');
  if (attemptClass === 'infrastructure' && stopCode !== null && !(stopCode in STOP_CLASS)) {
    stopCode = 'unclassified';
  }
  const record: AttemptRecord = {
    tier: input.tier,
    attempt: input.attempt,
    invocation: input.invocation,
    model: input.model,
    provider: input.provider ?? null,
    requestedModel: input.requestedModel ?? null,
    servedModel: input.servedModel ?? null,
    tokens: input.tokens ?? null,
    usageChannels: input.usageChannels ?? null,
    requests: input.requests ?? null,
    wallMs: input.wallMs ?? null,
    modeledUsd: input.modeledUsd ?? null,
    priceTableRevision: input.priceTableRevision ?? null,
    priceCoverage: input.priceCoverage ?? null,
    stopReason,
    stopCode,
    class: attemptClass,
    reason: input.reason ?? null,
    error: input.error ?? null,
    timeout: input.timeout ?? null,
    budget: input.budget ?? null,
    availability: input.availability ?? {},
  };
  return sanitizeObservation(record);
}
