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
import type { ErrorSignalFact, ProviderProfile } from './provider-profiles.js';
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
  /**
   * The wire endpoint the observation came from, as an opaque origin+path
   * identity with no credential in it (e.g. the Go usage/chat wire). Required
   * wherever two endpoints of the SAME provider answer a shared status with
   * opposite meanings - OpenCode Go is the documented case: a 402 from the Zen
   * pay-per-use wire means the Zen balance is empty, while a 402 from the Go
   * wire means the Go allowance is spent. Without this, a rule scoped to one
   * wire would admit the other's verdict.
   */
  readonly endpoint?: string;
  /** The vendor's error code from the response body, when it publishes one. */
  readonly providerCode?: string;
  /** Parsed `retry-after`, in milliseconds. Absent means the header was absent. */
  readonly retryAfterMs?: number;
  /** Response headers, lowercased, as the lane saw them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Result text or error text. Never outranks a structured signal. */
  readonly message?: string;
}

/**
 * A remaining-allowance observation from an endpoint rather than from response
 * headers.
 *
 * `window` is what makes such an observation usable on a windowed quota lane: a
 * bare `resetsAt` says a time but not WHICH window it releases, so it cannot
 * stand in for a blocking window's own reset — substituting it would reintroduce
 * the premature retry that header-based resolution exists to prevent. When the
 * blocking window is named here, the value IS tied to that window and is
 * admissible.
 */
export interface QuotaObservation {
  readonly resetsAt?: string;
  readonly window?: '5h' | '7d' | 'weekly' | 'monthly';
}

/** Normalize an observation's window label onto the Claude header window ids. */
function normalizedWindow(window: QuotaObservation['window']): string | undefined {
  return window === 'weekly' ? '7d' : window;
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

const CLAUDE_WINDOWS = [
  ['5h', 'anthropic-ratelimit-unified-5h-status', 'anthropic-ratelimit-unified-5h-utilization'],
  ['7d', 'anthropic-ratelimit-unified-7d-status', 'anthropic-ratelimit-unified-7d-utilization'],
] as const;

/** What the Claude unified-quota headers support as a defer time. */
type DeferResolution =
  | { readonly kind: 'definite'; readonly at: number; readonly blockingWindows: readonly string[] }
  | {
      readonly kind: 'unresolved-blocking';
      /** Blocking windows, at least one of which has no readable reset. */
      readonly blockingWindows: readonly string[];
    }
  | { readonly kind: 'none' };

/**
 * The defer time the Claude unified-quota headers support, or an explicit
 * statement that they support none.
 *
 * Reading the 5-hour reset unconditionally is wrong: the weekly window can be
 * exhausted while the 5-hour window still has room, and deferring to the 5-hour
 * reset then retries against a wall that has not moved. A window is treated as
 * blocking when its `-status` is `rejected` or its `-utilization` has reached
 * 1.0.
 *
 * EVERY blocking window must contribute a release time, and the defer is the MAX
 * across all of them, because all of them must clear before a retry is sound. A
 * window's time comes from its own `-*-reset` header, or from an endpoint
 * observation that NAMES that window. One blocking window with neither is
 * `unresolved-blocking`, never a substitute: the wall actually in the way is
 * precisely the one with no known release time, so no other time - a sibling
 * window's header reset, or an endpoint value belonging to a different window -
 * can stand in for it. That is a needs-human decision.
 *
 * When no window reports blocking, the LATER readable header reset is used, which
 * is the only choice that cannot produce an early retry.
 *
 * A caller that knows a reset is already in the past (a stale header) should
 * treat the result as needs-human too; the wall clock belongs to the runner, not
 * to this pure helper.
 */
function claudeDeferResolution(
  signal: ProviderSignal,
  observedQuota: QuotaObservation | undefined,
): DeferResolution {
  const blockingWindows: string[] = [];
  const blockingResets: number[] = [];
  const anyResetMs: number[] = [];
  const endpointWindow = normalizedWindow(observedQuota?.window);
  const endpointResetMs = isoResetMs(observedQuota?.resetsAt);
  for (const [window, statusHeader, utilizationHeader] of CLAUDE_WINDOWS) {
    const headerResetMs = epochSecondsMs(
      headerValue(signal, `anthropic-ratelimit-unified-${window}-reset`),
    );
    const status = headerValue(signal, statusHeader);
    const utilization = Number(headerValue(signal, utilizationHeader));
    const blocking = status === 'rejected' || (Number.isFinite(utilization) && utilization >= 1);
    if (!blocking) {
      if (headerResetMs !== undefined) anyResetMs.push(headerResetMs);
      continue;
    }
    blockingWindows.push(window);
    const resetMs = headerResetMs ?? (endpointWindow === window ? endpointResetMs : undefined);
    // This window has no known release time, so NO combination of other times is
    // a sound defer - not a sibling's header reset, not an endpoint value that
    // belongs to the other window.
    if (resetMs === undefined) return { kind: 'unresolved-blocking', blockingWindows };
    blockingResets.push(resetMs);
  }
  if (blockingResets.length > 0) {
    return { kind: 'definite', at: Math.max(...blockingResets), blockingWindows };
  }
  if (anyResetMs.length === 0) return { kind: 'none' };
  return { kind: 'definite', at: Math.max(...anyResetMs), blockingWindows };
}

function epochSecondsMs(raw: string | undefined): number | undefined {
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
  observedQuota?: QuotaObservation,
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
    const resolution = claudeDeferResolution(signal, observedQuota);
    const deferUntilMs =
      resolution.kind === 'definite'
        ? resolution.at
        : resolution.kind === 'unresolved-blocking'
          ? undefined
          : isoResetMs(observedQuota?.resetsAt);
    return {
      errorClass: marker.errorClass,
      ...(deferUntilMs === undefined ? {} : { deferUntilMs }),
      rule:
        marker.markerHeader !== undefined ? `marker-header:${marker.markerHeader}` : 'structured',
      // An exhausted allowance whose release time cannot be read is a HUMAN
      // decision, not a retry. Naming it here keeps "no defer time" from reading
      // as "forgot to compute one".
      ...(deferUntilMs === undefined && marker.errorClass === 'quota'
        ? {
            advisoryReason:
              'quota verdict with no usable reset time — the blocking window has none; needs-human, do not retry on a timer',
          }
        : {}),
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
  return { errorClass: 'provider-error', rule: 'unclassified' };
}

function firstMatchingMarker(
  profile: ProviderProfile,
  signal: ProviderSignal,
): ProviderProfile['errorSignals'][number] | undefined {
  // Most specific discriminators first. A rule matches only when EVERY
  // discriminator it declares matches, so a rule that names an endpoint or a
  // message shape is never reached by an observation that has neither.
  const order = [
    (fact: ErrorSignalFact): boolean => fact.providerCode !== undefined,
    (fact: ErrorSignalFact): boolean => fact.messagePrefix !== undefined,
    (fact: ErrorSignalFact): boolean => fact.endpointMatch !== undefined,
    (fact: ErrorSignalFact): boolean => fact.httpStatus !== undefined,
    (fact: ErrorSignalFact): boolean => fact.markerHeader !== undefined,
  ];
  for (const hasDiscriminator of order) {
    const match = profile.errorSignals.find(
      (fact) => hasDiscriminator(fact) && ruleMatches(fact, signal),
    );
    if (match !== undefined) return match;
  }
  return undefined;
}

/** Every discriminator a rule declares must match the observation. */
function ruleMatches(fact: ErrorSignalFact, signal: ProviderSignal): boolean {
  if (fact.providerCode !== undefined && fact.providerCode !== signal.providerCode) return false;
  if (fact.messagePrefix !== undefined && !startsWith(signal.message, fact.messagePrefix)) {
    return false;
  }
  if (fact.endpointMatch !== undefined && fact.endpointMatch !== signal.endpoint) return false;
  if (fact.httpStatus !== undefined && fact.httpStatus !== signal.httpStatus) return false;
  if (fact.markerHeader !== undefined && headerValue(signal, fact.markerHeader) === undefined) {
    return false;
  }
  return true;
}

/** Case-insensitive prefix test that treats an absent message as no match. */
function startsWith(message: string | undefined, prefix: string): boolean {
  return message !== undefined && message.trim().toLowerCase().startsWith(prefix.toLowerCase());
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
 * published formula: `(Input tokens × Input multiplier + Cached Input tokens ×
 * Cached Input multiplier + Output tokens × Output multiplier) / 10,000`, times
 * the peak/off-peak multiplier in force at the instant. The multipliers multiply
 * RAW TOKEN COUNTS — the formula is published exactly that way, and the vendor's
 * own "Estimated Token Allowance" table only reconciles with these numbers (see
 * test/driver/provider-profiles.test.ts), so any extra scaling factor here is a
 * silent under-count.
 *
 * Burn models are per MODEL: GLM-5.3 and GLM-5.3-Flash carry roughly 3×
 * different coefficients, so a model with no recorded formula yields `undefined`
 * rather than another model's rates.
 *
 * Cached input bills at the CACHED-INPUT multiplier, not the input one: a
 * cache-read token is not an input token.
 */
export function creditsForUsage(
  profile: ProviderProfile,
  model: string,
  usage: Usage,
  instantMs: number,
): number | undefined {
  const burn = profile.quota?.burnModels?.[model];
  if (burn === undefined) return undefined;
  const { tokenMultiplier, divisor } = burn;
  const tokens =
    usage.input * tokenMultiplier.input +
    usage.cacheRead * tokenMultiplier.cachedInput +
    usage.output * tokenMultiplier.output;
  return (tokens / divisor) * peakMultiplier(profile, instantMs);
}

/** The USD classification ceiling an admission decision may claim for a lane. */
export type AdmissionVerdict = 'hard' | 'advisory';

/** Why a lane cannot be HARD, when it cannot. */
export type AdvisoryReason =
  | 'unknown-profile'
  | 'limits-unknown'
  | 'unobservable-allowance'
  | 'no-native-cap'
  | 'model-limits-unverified'
  | 'no-observed-balance';

/** The evidence a HARD claim must bring with it. */
export interface AdmissionEvidence {
  /** The exact model id the claim is about. Absent ⇒ ADVISORY. */
  readonly model?: string;
  /**
   * The remaining allowance actually OBSERVED at decision time, in the profile's
   * own unit (credits, USD). Absent ⇒ ADVISORY: a channel that can report
   * remaining allowance is not the same thing as a channel that HAS reported it,
   * and "can be checked" must never be read as "is checked".
   */
  readonly observedRemaining?: number;
}

/**
 * The fail-closed admission ceiling for a lane.
 *
 * HARD requires ALL of:
 *   - a known profile;
 *   - `limitsKnown`;
 *   - a real observation channel (`headers` or `endpoint` — a console-only or
 *     interactive-TUI allowance cannot be checked by an unattended run);
 *   - a published native cap;
 *   - the claim's model carrying BOTH published token limits (`maxInputTokens`
 *     and `maxOutputTokens`). A profile-wide cap is not a model cap: without the
 *     per-model numbers, ADR-0003 §2.4 criterion 2 has no `W_max` input, so the
 *     claim is ADVISORY. Profiles whose limits this lane could not confirm
 *     against a vendor page (OpenAI, DeepSeek, OpenCode Go) therefore cannot
 *     claim HARD for ANY model;
 *   - an OBSERVED remaining allowance on a quota-accounted lane.
 *
 * Everything else is ADVISORY with a reason, which is the classification
 * ADR-0003 §2.4 requires. An unknown profile id is ADVISORY, never "unmetered".
 */
export function admissionVerdict(
  profileId: string | undefined,
  evidence: AdmissionEvidence = {},
): { readonly verdict: AdmissionVerdict; readonly reasons: readonly AdvisoryReason[] } {
  const profile = providerProfile(profileId);
  if (profile === undefined) return { verdict: 'advisory', reasons: ['unknown-profile'] };
  const reasons: AdvisoryReason[] = [];
  if (!profile.limitsKnown) reasons.push('limits-unknown');
  if (profile.observability.channel !== 'headers' && profile.observability.channel !== 'endpoint') {
    reasons.push('unobservable-allowance');
  }
  if (profile.cap.kind === 'none') reasons.push('no-native-cap');
  if (evidence.model === undefined) {
    reasons.push('model-limits-unverified');
  } else {
    const limits = profile.modelLimits?.[evidence.model];
    if (limits?.maxInputTokens === undefined || limits?.maxOutputTokens === undefined) {
      reasons.push('model-limits-unverified');
    }
  }
  if (
    profile.accounting === 'quota' &&
    (evidence.observedRemaining === undefined || !(evidence.observedRemaining > 0))
  ) {
    reasons.push('no-observed-balance');
  }
  return { verdict: reasons.length === 0 ? 'hard' : 'advisory', reasons };
}
