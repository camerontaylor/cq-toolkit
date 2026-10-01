// RS-14 admission helpers — pure functions over the profile data in
// ./provider-profiles.js. No network, no clock, no driver, no seam types.
//
// Three jobs, all of them local and side-effect free:
//
// 1. `classifyProviderSignal` — turn one failure observation into an
//    `errorClass` plus a defer-until time. RS-14 §4's rules of record, in order:
//    a structured signal (HTTP status + provider error code) outranks message
//    text; the Claude unified-quota header set is checked BEFORE `retry-after`,
//    because a plan-window exhaustion carries both (the captured 429 had
//    `retry-after: 3741` and unified `-status: rejected`) and classifying it as a
//    throttle would busy-retry an exhausted plan for an hour.
// 2. `peakMultiplier` / `creditsForUsage` — model the Z.AI credit burn locally,
//    which is the only way a console-only quota lane can be reasoned about at
//    all. Both are exact functions of the profile data and an explicit instant.
// 3. `admissionVerdict` — the fail-closed ceiling: a lane is HARD-eligible only
//    when its limits are known, its observation channel is real, and nothing in
//    the profile is unknown. Anything else is ADVISORY, and an UNKNOWN profile is
//    ADVISORY too — never "unmetered".
import { providerProfile } from './provider-profiles.js';
import type { ProviderProfile } from './provider-profiles.js';
import type { Usage } from '../types.js';

/**
 * The classification vocabulary this module produces. `quota` is a funded
 * allowance that is exhausted (defer to a window reset, or a human); `rate-limit`
 * is a throttle that clears on its own; `provider-error` is anything the lane
 * cannot attribute — deliberately a distinct value so "we could not tell" can
 * never be silently priced as zero or silently retried.
 */
export type ProviderErrorClass = 'rate-limit' | 'quota' | 'provider-error';

/** One observed failure signal, as a lane can surface it. */
export interface ProviderSignal {
  readonly httpStatus?: number;
  /** The vendor's error code from the response body, when it publishes one. */
  readonly providerCode?: string;
  /** Parsed `retry-after`, in milliseconds. Absent means the header was absent. */
  readonly retryAfterMs?: number;
  /** Response headers, lowercased, as the lane saw them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Result text or error text. Never outranks a structured signal. */
  readonly message?: string;
}

/** A classification with the defer-until time it can support, if any. */
export interface ProviderSignalVerdict {
  readonly errorClass: ProviderErrorClass;
  /**
   * Epoch milliseconds after which a `quota` verdict may be retried, when the
   * observation carried a reset time. Absent when no reset was observable —
   * which makes the verdict a human/needs-human decision, never a silent retry.
   */
  readonly deferUntilMs?: number;
  /** Which rule fired, for narration and for audit. */
  readonly rule: string;
  /** Why the verdict is ADVISORY-shaped, when it is. */
  readonly advisoryReason?: string;
}

function headerValue(signal: ProviderSignal, name: string): string | undefined {
  return signal.headers?.[name.toLowerCase()];
}

/** Epoch seconds from a unified-quota `-*-reset` header, when present and sane. */
function claudeResetMs(signal: ProviderSignal): number | undefined {
  const raw =
    headerValue(signal, 'anthropic-ratelimit-unified-5h-reset') ??
    headerValue(signal, 'anthropic-ratelimit-unified-7d-reset');
  if (raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Epoch milliseconds from an ISO `resetsAt` field, when present and sane. */
function isoResetMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Classify one failure signal against a profile.
 *
 * Rule order (RS-14 §4, and the G1 reconciliation fold that put the Claude
 * unified-header rule ahead of `retry-after`):
 *   1. a profile rule keyed on the provider error code, the most specific
 *      structured signal;
 *   2. the marker-header rule, whose PRESENCE discriminates a plan window from a
 *      throttle — checked before `retry-after` because the captured Claude 429
 *      carries BOTH a `rejected` unified status and `retry-after: 3741`, and
 *      calling an exhausted plan a throttle busy-retries it for an hour;
 *   3. `retry-after` present ⇒ rate-limit: a vendor that hands back a retry time
 *      is telling us the condition clears on its own;
 *   4. a profile rule keyed on the HTTP status alone;
 *   5. an endpoint-supplied `resetsAt` ⇒ quota, defer-until-reset;
 *   6. otherwise ⇒ provider-error (never a silent zero, never a silent retry).
 */
export function classifyProviderSignal(
  profileId: string | undefined,
  signal: ProviderSignal,
  observedQuota?: { readonly resetsAt?: string },
): ProviderSignalVerdict {
  const profile = providerProfile(profileId);
  if (profile === undefined) {
    return {
      errorClass: 'provider-error',
      rule: 'unknown-profile',
      advisoryReason: `no profile for '${profileId ?? '<none>'}'; unknown limits stay ADVISORY`,
    };
  }
  const marker = firstMatchingMarker(profile, signal);
  if (marker !== undefined) {
    const deferUntilMs = claudeResetMs(signal) ?? isoResetMs(observedQuota?.resetsAt);
    return {
      errorClass: marker.errorClass,
      ...(deferUntilMs === undefined ? {} : { deferUntilMs }),
      rule:
        marker.markerHeader !== undefined ? `marker-header:${marker.markerHeader}` : 'structured',
    };
  }
  const resetsAt = isoResetMs(observedQuota?.resetsAt);
  if (signal.retryAfterMs !== undefined) {
    return {
      errorClass: 'rate-limit',
      rule: 'retry-after',
    };
  }
  const byStatus = profile.errorSignals.find(
    (fact) => fact.httpStatus !== undefined && fact.httpStatus === signal.httpStatus,
  );
  if (byStatus !== undefined) {
    return {
      errorClass: byStatus.errorClass,
      ...(resetsAt === undefined ? {} : { deferUntilMs: resetsAt }),
      rule: 'structured',
    };
  }
  if (resetsAt !== undefined) {
    return {
      errorClass: 'quota',
      deferUntilMs: resetsAt,
      rule: 'quota-resets-at',
    };
  }
  if (signal.retryAfterMs !== undefined) {
    return {
      errorClass: 'rate-limit',
      rule: 'retry-after',
    };
  }
  return { errorClass: 'provider-error', rule: 'unclassified' };
}

function firstMatchingMarker(
  profile: ProviderProfile,
  signal: ProviderSignal,
): ProviderProfile['errorSignals'][number] | undefined {
  // 1. provider error code, the most specific structured signal.
  const byCode = profile.errorSignals.find(
    (fact) => fact.providerCode !== undefined && fact.providerCode === signal.providerCode,
  );
  if (byCode !== undefined) return byCode;
  // 2. marker-header presence, which discriminates a plan window from a throttle.
  return profile.errorSignals.find((fact) => {
    const name = fact.markerHeader;
    return name !== undefined && headerValue(signal, name) !== undefined;
  });
}

/**
 * The credit multiplier in force at `instantMs` for a profile with a documented
 * peak window. Peak ⇒ the profile's multiplier; otherwise the off-peak one.
 * A profile with no peak window is always at its base multiplier (1), because an
 * absent window is an absence of evidence, not a discount.
 */
export function peakMultiplier(profile: ProviderProfile, instantMs: number): number {
  const peak = profile.quota?.peak;
  if (peak === undefined) return 1;
  // Asia/Singapore is a fixed +08:00 offset, so the local clock is derivable
  // without a timezone database (and without depending on the host's zone).
  const localMs = instantMs + 8 * 60 * 60 * 1000;
  const localDay = new Date(localMs).getUTCDay(); // 0 = Sunday
  const localHour = new Date(localMs).getUTCHours();
  const isWeekday = localDay >= 1 && localDay <= 5;
  const inPeak = isWeekday && localHour >= peak.startHour && localHour < peak.endHour;
  return inPeak ? peak.multiplier : peak.offPeakMultiplier;
}

/**
 * Plan credits a usage observation burns on a quota lane, per the provider's own
 * published formula. `undefined` when the profile publishes no burn model — the
 * caller then has no local burn figure and must stay ADVISORY.
 *
 * Cached input is billed at the CACHED-INPUT multiplier, not the input one; a
 * cache-read token is not an input token.
 */
export function creditsForUsage(
  profile: ProviderProfile,
  usage: Usage,
  instantMs: number,
): number | undefined {
  const burn = profile.quota?.burnModel;
  if (burn === undefined) return undefined;
  const { perMillion, divisor } = burn;
  const tokens =
    (usage.input * perMillion.input +
      usage.cacheRead * perMillion.cachedInput +
      usage.output * perMillion.output) /
    1_000_000;
  return (tokens / divisor) * peakMultiplier(profile, instantMs);
}

/** The USD classification ceiling an admission decision may claim for a lane. */
export type AdmissionVerdict = 'hard' | 'advisory';

/** Why a lane cannot be HARD, when it cannot. */
export type AdvisoryReason =
  | 'unknown-profile'
  | 'limits-unknown'
  | 'unobservable-allowance'
  | 'no-native-cap';

/**
 * The fail-closed admission ceiling for a profile.
 *
 * HARD requires ALL of: a known profile, `limitsKnown`, a real observation
 * channel (`headers` or `endpoint` — a console-only or interactive-TUI allowance
 * cannot be checked by an unattended run), and a published native cap. Anything
 * else is ADVISORY with a reason, which is the classification ADR-0003 §2.4
 * requires; an unknown profile id is ADVISORY, never "unmetered".
 */
export function admissionVerdict(profileId: string | undefined): {
  readonly verdict: AdmissionVerdict;
  readonly reasons: readonly AdvisoryReason[];
} {
  const profile = providerProfile(profileId);
  if (profile === undefined) return { verdict: 'advisory', reasons: ['unknown-profile'] };
  const reasons: AdvisoryReason[] = [];
  if (!profile.limitsKnown) reasons.push('limits-unknown');
  if (profile.observability.channel !== 'headers' && profile.observability.channel !== 'endpoint') {
    reasons.push('unobservable-allowance');
  }
  if (profile.cap.kind === 'none') reasons.push('no-native-cap');
  return { verdict: reasons.length === 0 ? 'hard' : 'advisory', reasons };
}
