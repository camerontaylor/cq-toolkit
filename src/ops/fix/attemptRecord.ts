// Attempt evidence normalization — T12 (ADR-0008).
//
// Every persisted text field is sanitized BEFORE journal/report persistence.
// Redaction runs BOTH before and after credential stripping: stripping can
// otherwise cut an environment secret mid-value (a `*_URL` secret survives as
// its stripped host form; a `*_PASSWORD` containing `@` or `:` leaks its
// tail), so the pre-pass removes whole known secret values first and the
// post-pass catches any value the stripping mangled. Each sanitized string is
// capped at MAX_SANITIZED_CHARS AFTER sanitizing; the credential scanner is
// linear even on uncapped input. Overflow is marked, never silently dropped. The
// archive repoId is a digest of the canonical credential-free `host/path`
// form, never the hostname/path itself. No journal writes here — writers land
// in T30/T31.
import { createHash } from 'node:crypto';
import { redactEnvSecrets } from '../../driver/error-text.js';
import {
  cutAuthorityUserinfo,
  redactUrlUserinfo,
  stripCredentialText,
} from '../../shared/urlRedact.js';
import type { ModelSpec } from '../../driver/types.js';
import type {
  AttemptError,
  AttemptFinishedPayload,
  AttemptStopClass,
  AttemptTimeout,
  AvailabilityRecord,
  AttemptBudget,
} from '../../kernel/types.js';
import { AttemptFinishedPayloadSchema } from '../../kernel/schema.js';

/**
 * Stop-code classification table (ADR-0008): fixed mapping, never inferred by
 * substring-matching human prose. Unrecognized codes become infrastructure
 * with stopCode `unclassified`. `write-denied` is intentionally absent: it is
 * produced only through the {@link FinishAttemptStop} writeDenied variant,
 * whose class follows the existing gate verdict rather than this table.
 */
export const STOP_CODE_CLASS: ReadonlyMap<string, AttemptStopClass> = new Map([
  ['spawn', 'infrastructure'],
  ['dns', 'infrastructure'],
  ['transport', 'infrastructure'],
  ['provider-outage', 'infrastructure'],
  ['unclassified', 'infrastructure'],
  ['wall-cap', 'budget'],
  ['token-cap', 'budget'],
  ['human-deferred', 'human'],
  ['approval-expired', 'human'],
  ['validation-failed', 'terminal'],
  ['model-output', 'terminal'],
  ['nochange', 'terminal'],
  ['completed', 'terminal'],
  ['provider-retryable', 'retriable'],
]);

/** Per-string cap for sanitized output; overflow is marked, not dropped. */
export const MAX_SANITIZED_CHARS = 64 * 1024;

/** Cap a sanitized string, marking (not hiding) the overflow size. */
function capSanitized(text: string): string {
  if (text.length <= MAX_SANITIZED_CHARS) return text;
  let end = MAX_SANITIZED_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  const overflow = text.length - end;
  return `${text.slice(0, end)} …[truncated ${overflow} chars]`;
}

/**
 * Sanitize a structured identifier: redact environment secrets and URLs, then cap it.
 * Identifier fields skip credential-prefix stripping because an `@`-versioned
 * handle (for example a Vertex model id) is identity, not the free-text
 * `user@host` shape {@link sanitizeObservation} fails closed on.
 */
function sanitizeIdentifier(text: string): string {
  return capSanitized(redactUrlUserinfo(redactEnvSecrets(text)));
}

/**
 * Recursively sanitize a persisted observation: redact environment secrets,
 * strip credential URL/SCP prefixes, then redact again so a secret the
 * stripping mangled cannot survive as a partial value. The strict stripper
 * deliberately treats a path at-sign as credential-like too (`https://h/a@b`
 * becomes `https://b`); observations prefer over-redaction to missed secrets.
 * The result is capped at
 * {@link MAX_SANITIZED_CHARS} per string. Sanitized objects and arrays use
 * null prototypes so `__proto__`-style keys pass through as data. Non-JSON
 * values are outside the observation contract and pass through.
 */
export function sanitizeObservation<T>(value: T): T {
  if (typeof value === 'string') {
    return capSanitized(
      redactUrlUserinfo(redactEnvSecrets(stripCredentialText(redactEnvSecrets(value)))),
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(sanitizeObservation(item));
    return out as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeObservation(item);
    return out as unknown as T;
  }
  return value;
}

/** Canonical archive form of a git remote: credential-free `host/path`. */
function canonicalRepoPath(remote: string): string | null {
  let rest = remote.trim();
  if (rest === '') return null;
  // Strip userinfo: scan the anchored scheme procedurally (linear, ReDoS-safe
  // — see stripCredentialText) and cut the authority at the LAST `@`.
  const schemeM = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (schemeM !== null) rest = cutAuthorityUserinfo(rest, schemeM);
  // Cut query/fragment.
  const q = /[?#]/.exec(rest);
  if (q !== null) rest = rest.slice(0, q.index);
  const hasScheme = schemeM !== null && /^[a-z][a-z0-9+.-]*:\/\//i.test(rest);
  let host: string;
  let path: string;
  if (hasScheme) {
    const afterScheme = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const split = /^([^/?#\s]+)(?:\/([\s\S]*))?$/.exec(afterScheme);
    if (split === null) return null;
    host = split[1] ?? '';
    path = split[2] ?? '';
  } else {
    // SCP form: `[user@]host[:port]:path` (the host/path separator is `:`).
    // Matched only at the start of the (whitespace-free) remote string.
    const scp = /^(?:[^\s@/:]+@)?([\w.-]+)(?::(\d+))?:([^\s]+)$/.exec(rest);
    if (scp === null) return null;
    host = scp[1] ?? '';
    path = scp[3] ?? '';
  }
  host = host.toLowerCase().replace(/:\d+$/, '');
  path = path
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return path === '' ? host : `${host}/${path}`;
}

/** Why no repoId was produced for a remote that was supplied. */
export type RepoIdFailure = 'no-remote' | 'unparseable-remote';

/**
 * Archive-safe repoId: `sha256:` + SHA-256 of the canonical credential-free
 * remote form (`host/path`: credentials stripped, scheme and port dropped,
 * host lowercased, repeated/trailing `/` and `.git` removed). https, ssh://
 * and SCP spellings of the same repository hash identically and the raw
 * remote — hostname, path or credential — is never persisted. No remote gives
 * `{ repoId: null, reason: 'no-remote' }`; a remote that exists but does not
 * parse gives `{ repoId: null, reason: 'unparseable-remote' }`, so absence is
 * never confused with a malformed value.
 */
export function repoIdFromRemote(
  remote: string | null | undefined,
): { repoId: string; reason?: undefined } | { repoId: null; reason: RepoIdFailure } {
  if (remote === null || remote === undefined) return { repoId: null, reason: 'no-remote' };
  if (remote.trim() === '') return { repoId: null, reason: 'no-remote' };
  const canonical = canonicalRepoPath(remote);
  if (canonical === null) return { repoId: null, reason: 'unparseable-remote' };
  return { repoId: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}` };
}

const NOT_COLLECTED: AvailabilityRecord = Object.freeze({
  state: 'not-collected',
  reason: 'not observed at the attempt boundary',
  source: null,
});

/** Budget window with no observed evidence: nulls, never invented zeros. */
const EMPTY_WINDOW: AttemptBudget['allowed'] = { tokens: null, wallMs: null };
const EMPTY_BUDGET: AttemptBudget = {
  allowed: EMPTY_WINDOW,
  spent: { tokens: null, wallMs: null },
  remaining: { tokens: null, wallMs: null },
};

/** How the attempt stopped; each variant carries only observed evidence. */
export type FinishAttemptStop =
  | {
      /** Observed completion; a terminal stopCode is kept when observed. */
      completed: true;
      stopCode?: 'nochange' | 'validation-failed' | 'model-output';
      stopReason?: string;
    }
  | {
      /** Budget expired; the tripped cap must be named, never guessed. */
      budgetExpired: true;
      budgetStopCode: 'wall-cap' | 'token-cap';
      stopReason?: string;
    }
  | {
      /** Write-path refusal; classification follows the existing gate verdict. */
      writeDenied: 'fail' | 'needs-human' | 'escalated-to-human';
      stopReason?: string;
    }
  | {
      /** Any other observed stop; the code is the stable classifier input. */
      completed?: false;
      stopCode: string;
      stopReason?: string;
    };

/** Inputs to {@link finishAttempt}; missing evidence lands null or not-collected. */
export interface FinishAttemptCommon {
  tier: 'worker' | 'rescue';
  invocation: string;
  model: ModelSpec | null;
  provider?: string;
  requestedModel?: string;
  servedModel?: string | null;
  tokens?: number | null;
  usageChannels?: Record<string, number | null>;
  requests?: number | null;
  wallMs?: number | null;
  modeledUsd?: number | null;
  priceTableRevision?: string | null;
  priceCoverage?: string | null;
  error?: AttemptError | null;
  timeout?: AttemptTimeout | null;
  budget?: AttemptBudget | null;
  availability?: Record<string, AvailabilityRecord>;
}
export type FinishAttemptInput = FinishAttemptStop & FinishAttemptCommon;

function availabilityWith(
  base: Record<string, AvailabilityRecord> | undefined,
  pointer: string,
): Record<string, AvailabilityRecord> {
  const out = Object.create(null) as Record<string, AvailabilityRecord>;
  for (const [key, row] of Object.entries(base ?? {})) out[key] = row;
  out[pointer] = NOT_COLLECTED;
  return out;
}

/**
 * Normalize one attempt boundary into the ADR-0008 `attempt-finished` payload
 * (strict `AttemptFinishedPayloadSchema`). Budget expiry takes precedence over
 * observed completion; a write denial follows its gate verdict (fail →
 * terminal, needs-human/escalated-to-human → human, escalated wins by the
 * gate's own value). Classification is by the fixed stop-code table only;
 * an unrecognized code becomes infrastructure / `unclassified` with certainty
 * `unknown`, preserving the sanitized raw code in `error.code`. All text is
 * sanitized and the result is schema-validated before it is returned.
 *
 * Throws: a ZodError when an input value (for example a negative or
 * non-integer count) fails the strict schema. Finally-path callers must catch
 * it so the original attempt error is not masked.
 */
export function finishAttempt(input: FinishAttemptInput): AttemptFinishedPayload {
  let stopCode: string;
  let stopClass: AttemptStopClass;
  let stopReason = input.stopReason ?? '';
  let error: AttemptError | null = input.error ?? null;
  let availability: Record<string, AvailabilityRecord> = input.availability ?? {};

  if ('budgetExpired' in input && input.budgetExpired === true) {
    stopCode = input.budgetStopCode;
    stopClass = STOP_CODE_CLASS.get(stopCode) ?? 'budget';
  } else if ('writeDenied' in input && input.writeDenied !== undefined) {
    stopCode = 'write-denied';
    stopClass = input.writeDenied === 'fail' ? 'terminal' : 'human';
  } else if (
    'completed' in input &&
    input.completed === true &&
    (input.stopCode === undefined || STOP_CODE_CLASS.get(input.stopCode) === 'terminal')
  ) {
    stopCode = input.stopCode ?? 'completed';
    stopClass = STOP_CODE_CLASS.get(stopCode) ?? 'terminal';
  } else {
    const raw = (input as { stopCode?: string }).stopCode;
    // Bare 'unclassified' also routes through the unknown-certainty branch so
    // its evidence shape matches every other unrecognized code.
    const classified =
      raw !== undefined && raw !== 'unclassified' ? STOP_CODE_CLASS.get(raw) : undefined;
    if (raw !== undefined && classified !== undefined) {
      stopCode = raw;
      stopClass = classified;
    } else {
      // Unrecognized live error: infrastructure / unclassified with certainty
      // unknown; the sanitized raw code is preserved, never prose-matched.
      // A bare 'unclassified' code takes this same branch (certainty unknown).
      stopCode = 'unclassified';
      stopClass = 'infrastructure';
      // The classifier input is the stable evidence of what was observed, so
      // it wins over the caller's error code when it is a real code.
      const rawCode =
        raw !== undefined && raw !== 'unclassified' ? raw : (error?.code ?? raw ?? '');
      error = {
        type: error?.type ?? null,
        code: rawCode === '' ? null : rawCode,
        providerFinishReason: error?.providerFinishReason ?? null,
        source: error?.source ?? '',
        certainty: 'unknown',
      };
      if (error.source === '') availability = availabilityWith(availability, '/error/source');
    }
  }

  let budget = input.budget ?? null;
  if (budget === null) {
    budget = EMPTY_BUDGET;
    availability = availabilityWith(availability, '/budget');
  }
  let provider = input.provider;
  if (provider === undefined) {
    provider = '';
    availability = availabilityWith(availability, '/provider');
  }
  let requestedModel = input.requestedModel;
  if (requestedModel === undefined) {
    requestedModel = '';
    availability = availabilityWith(availability, '/requestedModel');
  }
  if (stopReason === '') availability = availabilityWith(availability, '/stopReason');

  const record = {
    tier: input.tier,
    invocation: input.invocation,
    model: input.model,
    provider,
    requestedModel,
    servedModel: input.servedModel ?? null,
    tokens: input.tokens ?? null,
    usageChannels: input.usageChannels ?? {},
    requests: input.requests ?? null,
    wallMs: input.wallMs ?? null,
    modeledUsd: input.modeledUsd ?? null,
    priceTableRevision: input.priceTableRevision ?? null,
    priceCoverage: input.priceCoverage ?? null,
    stopReason,
    stopCode,
    class: stopClass,
    error,
    timeout: input.timeout ?? null,
    budget,
    availability,
  };
  // Prose and evidence fields take the full strip-and-redact pass; identifier
  // fields keep their `@` so persisted model attribution survives.
  const sanitized = sanitizeObservation(record);
  return AttemptFinishedPayloadSchema.parse({
    ...sanitized,
    invocation: sanitizeIdentifier(record.invocation),
    model:
      record.model === null
        ? null
        : {
            model: sanitizeIdentifier(record.model.model),
            provider: sanitizeIdentifier(record.model.provider),
          },
    provider: sanitizeIdentifier(record.provider),
    requestedModel: sanitizeIdentifier(record.requestedModel),
    servedModel: record.servedModel === null ? null : sanitizeIdentifier(record.servedModel),
    priceTableRevision:
      record.priceTableRevision === null ? null : sanitizeIdentifier(record.priceTableRevision),
    stopCode: sanitizeIdentifier(record.stopCode),
  });
}
