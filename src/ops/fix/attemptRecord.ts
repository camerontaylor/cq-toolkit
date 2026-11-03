// Attempt evidence normalization — T12 (ADR-0008).
//
// Every persisted text field is sanitized BEFORE journal/report persistence.
// Redaction runs BOTH before and after credential stripping: stripping can
// otherwise cut an environment secret mid-value (a `*_URL` secret survives as
// its stripped host form; a `*_PASSWORD` containing `@` or `:` leaks its
// tail), so the pre-pass removes whole known secret values first and the
// post-pass catches any value the stripping mangled. The archive repoId is a
// digest of the canonical credential-free `host/path` form, never the
// hostname/path itself. No journal writes here — writers land in T30/T31.
import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../../driver/error-text.js';
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
 * with stopCode `unclassified`.
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
  ['write-denied', 'terminal'],
  ['provider-retryable', 'retriable'],
]);

/**
 * Strip URL userinfo/query/fragment and SCP-style (or bare email-like)
 * `user[:secret]@host` prefixes from a text fragment.
 *
 * Deliberate over-matching: a bare `name@host` in free text (an email
 * address) is also stripped, because a credential prefix and an email are
 * indistinguishable without scheme context and the sanitizer fails closed.
 */
function stripCredentialText(text: string): string {
  // Scheme authority: credentials live only inside the authority, which ends
  // at `/`, `?` or `#`. The userinfo is everything up to the LAST `@` (base64
  // padding `/` and `@`-bearing secrets may appear inside the userinfo), and
  // a newline inside the userinfo must not end the match.
  let out = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/gi,
    (_match, scheme: string, authority: string) => {
      const at = authority.lastIndexOf('@');
      return at === -1 ? scheme + authority : scheme + authority.slice(at + 1);
    },
  );
  // Query and fragment: run to a closing quote/bracket/brace/comma delimiter
  // or end of text, so a trailing sentence boundary survives.
  out = out.replace(/[?#][^)\]}'",]*/g, '');
  // SCP and free-text credential prefixes: `[user][:secret]@host`, including
  // `x-access-token:ghp_x@github.com:`, `=tok@host:`, `user+tag@host:` and
  // `user:token@host` with no trailing colon. The leading boundary character
  // is preserved.
  out = out.replace(
    /(^|[\s'"([{=,;])(?:[^\s@'"()[\]{},:]+(?::[^\s@'"()[\]{},:]*)?)@([\w.-]+(?::\d+)?)/g,
    (_match, boundary: string, host: string) => boundary + host,
  );
  return out;
}

/**
 * Recursively sanitize a persisted observation: redact environment secrets,
 * strip credential URL/SCP prefixes, then redact again so a secret the
 * stripping mangled cannot survive as a partial value. Sanitized objects and
 * arrays use null prototypes so `__proto__`-style keys pass through as data.
 * Non-JSON values are outside the observation contract and pass through.
 */
export function sanitizeObservation<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSensitiveText(stripCredentialText(redactSensitiveText(value))) as unknown as T;
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
  // Drop userinfo inside a scheme authority, then any query/fragment.
  rest = rest.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i,
    (_match, scheme: string, authority: string) => {
      const at = authority.lastIndexOf('@');
      return at === -1 ? scheme + authority : scheme + authority.slice(at + 1);
    },
  );
  rest = rest.replace(/[?#][^)\]}'",]*/g, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  let host: string;
  let path: string;
  if (scheme !== null) {
    rest = rest.slice(scheme[0].length);
    const split = /^([^/?#]+)(?:\/([\s\S]*))?$/.exec(rest);
    if (split === null) return null;
    host = split[1] ?? '';
    path = split[2] ?? '';
  } else {
    // SCP form: `[user@]host[:port]:path` (the host/path separator is `:`).
    const scp = /^(?:[^\s@/:]+@)?([\w.-]+(?::\d+)?):([\s\S]+)$/.exec(rest);
    if (scp === null) return null;
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  }
  host = host.toLowerCase().replace(/:\d+$/, '');
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  return path === '' ? host : `${host}/${path}`;
}

/**
 * Archive-safe repoId: `sha256:` + SHA-256 of the canonical credential-free
 * remote form (`host/path`: credentials stripped, scheme and port dropped,
 * host lowercased, trailing `/` and `.git` removed). https, ssh:// and SCP
 * spellings of the same repository hash identically and the raw remote —
 * hostname, path or credential — is never persisted. No remote gives null
 * (reported as unavailable with availability).
 */
export function repoIdFromRemote(remote: string | null | undefined): string | null {
  if (remote === null || remote === undefined) return null;
  const canonical = canonicalRepoPath(remote);
  if (canonical === null) return null;
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
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
  } else if ('completed' in input && input.completed === true) {
    stopCode = input.stopCode ?? 'completed';
    stopClass = STOP_CODE_CLASS.get(stopCode) ?? 'terminal';
  } else {
    const raw = (input as { stopCode?: string }).stopCode;
    const classified = raw !== undefined ? STOP_CODE_CLASS.get(raw) : undefined;
    if (raw !== undefined && classified !== undefined) {
      stopCode = raw;
      stopClass = classified;
    } else {
      // Unrecognized live error: infrastructure / unclassified with certainty
      // unknown; the sanitized raw code is preserved, never prose-matched.
      stopCode = 'unclassified';
      stopClass = 'infrastructure';
      const rawCode = error?.code ?? raw ?? '';
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
  return AttemptFinishedPayloadSchema.parse(sanitizeObservation(record));
}
