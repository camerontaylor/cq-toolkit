// The shared failure classifier for the Claude Code lane — Phase 1.9: ONE
// error-class cut order for BOTH transports (seam v2, ADR-0002 §2.2;
// RS-14 §4 rows). Consolidates the former subprocess and claude-agent
// classifiers, whose vendor-text tables and reset/retry parsers were
// duplicated verbatim — drift here was a matter of time.
//
// Every error verdict carries `errorClass`, classified ONLY from structured
// signals — the result-frame subtype/errors, the assistant frame's
// structured `error:"rate_limit"` field, the child's close cause
// (spawn error / death signal / non-zero exit), and the vendor's limit
// vocabulary where no structure exists (ANCHORED patterns only; the
// unanchored numeric-status style is banned — the stream surfaces expose no
// HTTP headers or status codes to read instead). Abort-shaped runs never
// reach this function (they are 'aborted', not errors).
// `providerSignals` rides ANY verdict, only with structurally present
// data — never invented.
//
// THE CUT ORDER (the union of both consolidated lanes' orders; every
// verdict either lane classified before classifies identically now):
//   1. an oversized output line is a protocol break → 'harness';
//   2. the funded-allowance code (`enforced_spend_limit_reached`) is
//      'quota' whatever wrapped it (ADR §2.2 rule 2);
//   3. the assistant's structured `error:'rate_limit'` field, or the CLI's
//      "You've hit your … limit · resets …" result → 'quota' (RS-14 §4
//      rule 3 — ahead of the retry-after rule), with the reset instant in
//      `providerSignals.windows[*].resetAt` when extractable;
//   4. the funded-allowance prose rows ("spend limit reached", "Insufficient
//      account funds") → 'quota';
//   5. `rate_limit_error` → 'rate-limit' WITH the vendor's anchored
//      retry-after in `providerSignals.retryAfterMs`; without a stated
//      retry-after it falls to 'provider-error' (the class contract:
//      "429 WITH retry-after"; ai-sdk bare-429 parity);
//   6. the throttle rows ("Server is temporarily limiting requests",
//      "Request rejected (429)") → 'rate-limit';
//   7. a result-frame error → 'provider-error';
//   8. a codex CLI that folded real usage and exited non-zero with no
//      result event surfaced the PROVIDER's failure → 'provider-error';
//   9. a spawn error, a signal death, any other non-zero exit, a silent
//      death, a dispatch throw → 'harness'.
// Anything unresolved is 'unknown' via the caller, NEVER a guessed
// 'transient'.
import { basename } from 'node:path';
import type { ProcessClose } from './process.js';
import type { ProviderSignals, WorkerErrorClass } from '../types.js';

/** Inputs to the lane failure classifier — structured signals only. */
export interface FailureClassInputs {
  /** Which channel reported the failure (the classifier's kind signal). */
  kind: 'result-frame' | 'dispatch-threw' | 'no-result' | 'close';
  /**
   * The substrate's cause texts: a failed result frame's result string /
   * joined errors / subtype, the thrown message (a dispatch throw), plus
   * the retained stderr tail. The wire surfaces expose no HTTP headers or
   * status codes, so the vendor rows below match ONLY through these
   * anchored patterns.
   */
  texts: readonly string[];
  /** The child flushed an oversized stdout/stderr line (a protocol break). */
  oversizedLine?: boolean;
  /** The child's settled close (spawn error / exit code / signal), when known. */
  close?: ProcessClose;
  /** A real usage measurement was folded (the codex row's evidence). */
  measuredUsage?: boolean;
  /** The spawned binary is a codex CLI (the codex row's structured signal). */
  codexBinary?: boolean;
  /** An assistant frame carried the structured `error: 'rate_limit'` field. */
  assistantRateLimit?: boolean;
}

/** The classifier's verdict: the frozen class plus any limit observations. */
export interface FailureClassification {
  errorClass: WorkerErrorClass;
  providerSignals?: ProviderSignals;
}

/**
 * The vendor limit texts, ANCHORED — never a bare numeric-status scan:
 *   - the claude CLI's session/weekly usage-limit result ("You've hit your
 *     … limit · resets …") — quota, reset when extractable;
 *   - gateway funded-allowance prose ("spend limit reached") and the
 *     opencode funded-balance row ("Insufficient account funds") — quota;
 *   - the throttle rows ("Server is temporarily limiting requests",
 *     "Request rejected (429)") — rate-limit.
 */
const CLI_LIMIT_TEXT = /you(?:'ve| have) hit your [a-z ]{1,32}limit · resets /i;
const RATE_LIMIT_TEXTS: ReadonlyArray<RegExp> = [
  /server is temporarily limiting requests/i,
  /request rejected \(429\)/i,
];
const QUOTA_TEXTS: ReadonlyArray<RegExp> = [
  /\bspend limit reached\b/i,
  /\bInsufficient account funds\b/,
];

/** The class of a Claude Code lane failure (header cut order). */
export function classifyFailure(inputs: FailureClassInputs): FailureClassification {
  if (inputs.oversizedLine === true) {
    return { errorClass: 'harness' };
  }
  const joined = inputs.texts.join('\n');
  // Cut 2: funded-allowance exhaustion is quota at any status.
  if (/\benforced_spend_limit_reached\b/.test(joined)) {
    return { errorClass: 'quota' };
  }
  // Cut 3: the structured assistant field and the CLI usage-limit result —
  // quota, ahead of the retry-after rule.
  if (inputs.assistantRateLimit === true || CLI_LIMIT_TEXT.test(joined)) {
    return quotaWithResetSignal(joined);
  }
  // Cut 4: the gateway/opencode funded-allowance prose rows.
  if (QUOTA_TEXTS.some((pattern) => pattern.test(joined))) {
    return { errorClass: 'quota' };
  }
  // Cut 5: the API's rate-limit error type is 'rate-limit' only WITH a
  // stated retry-after (the class contract: "429 WITH retry-after",
  // types.ts; the ai-sdk lane's bare-429 row is the parity) — a bare 429
  // carries no backoff to honor, so it is a permanent provider failure.
  if (/\brate_limit_error\b/.test(joined)) {
    const retryAfterMs = retryAfterMsFromText(joined);
    if (retryAfterMs !== undefined) {
      return { errorClass: 'rate-limit', providerSignals: { retryAfterMs } };
    }
    return { errorClass: 'provider-error' };
  }
  // Cut 6: the throttle rows.
  if (RATE_LIMIT_TEXTS.some((pattern) => pattern.test(joined))) {
    return { errorClass: 'rate-limit' };
  }
  // Cut 7: a result frame that failed for its own (provider-side) reason.
  if (inputs.kind === 'result-frame') {
    return { errorClass: 'provider-error' };
  }
  // Cut 8: the codex row — the CLI reported usage, then died before the
  // result event: the provider's failure, surfaced through the CLI.
  const close = inputs.close;
  const exitFailure =
    close !== undefined &&
    close.spawnError === undefined &&
    close.signal === null &&
    close.code !== 0;
  if (inputs.codexBinary === true && exitFailure && inputs.measuredUsage === true) {
    return { errorClass: 'provider-error' };
  }
  // Cut 9: the substrate's own failure surfaces are local (harness) — a
  // spawn/exit/crash dispatch throw, or a death with no result event at all.
  return { errorClass: 'harness' };
}

/** Whether the spawned binary is a codex CLI: the basename of the binary template's first element (a CONFIG field, not free text). */
export function isCodexBinary(binary: string): boolean {
  return /^codex/i.test(basename(binary));
}

/** Quota + the claude unified-window reset observation, when extractable. */
function quotaWithResetSignal(text: string): FailureClassification {
  const resetAt = resetAtFromLimitText(text);
  return {
    errorClass: 'quota',
    ...(resetAt !== undefined
      ? { providerSignals: { windows: [{ id: unifiedWindowIdOf(text), resetAt }] } }
      : {}),
  };
}

/**
 * The unified-limit window id for a claude limit text: the vendor names the
 * window ('use limit'/'session limit' = the 5h unified window, 'weekly
 * limit' = the 7d one); anything else is honestly bucketed 'unified' rather
 * than guessed.
 */
function unifiedWindowIdOf(text: string): string {
  if (/\b(?:weekly|7d)\b/i.test(text)) return '7d';
  if (/\b(?:use|session|5h)\b/i.test(text)) return '5h';
  return 'unified';
}

/**
 * A retry-after stated in the vendor's error text → milliseconds. ANCHORED
 * forms only ("Try again in 25 seconds.", "retry after 30s") — the SDK
 * exposes no header structure to read instead.
 */
function retryAfterMsFromText(text: string): number | undefined {
  const seconds = /try again in (\d+) seconds?/i.exec(text) ?? /retry[- ]after (\d+)s?/i.exec(text);
  const value = seconds?.[1];
  return value === undefined ? undefined : Number(value) * 1000;
}

/**
 * The reset instant from a claude limit text's "· resets <when>" tail, when
 * the vendor's form is parseable: an absolute date, a relative duration
 * ('1h30m'), or the CLI's wall-clock form ("3pm (Asia/Singapore)" — resolved
 * against the named IANA zone). Anything ambiguous (bare digits, a zoneless
 * wall clock) is left OUT — never invent a reset.
 */
export function resetAtFromLimitText(text: string): string | undefined {
  // The capture stops at the line end: the classifier may join several
  // cause texts (result frame + subtype + stderr) into one string.
  const tail = /· resets ([^\n]+)/i.exec(text)?.[1]?.trim();
  if (tail === undefined || tail === '' || /^\d+$/.test(tail)) return undefined;
  const parsed = Date.parse(tail);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const duration =
    /^((?<days>\d+)d)?((?<hours>\d+)h)?((?<minutes>\d+)m)?((?<seconds>\d+)s)?$/i.exec(tail);
  if (duration?.groups !== undefined) {
    const { days, hours, minutes, seconds } = duration.groups;
    const totalMs =
      Number(days ?? 0) * 86_400_000 +
      Number(hours ?? 0) * 3_600_000 +
      Number(minutes ?? 0) * 60_000 +
      Number(seconds ?? 0) * 1000;
    return totalMs > 0 ? new Date(Date.now() + totalMs).toISOString() : undefined;
  }
  const wall =
    /^(?:(?<date>\d{4}-\d{2}-\d{2})\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?\s*\((?<zone>[^)]+)\)$/i.exec(
      tail,
    );
  if (wall?.groups === undefined) return undefined;
  const { date, hour, minute, meridiem, zone } = wall.groups;
  if (zone === undefined) return undefined; // a zoneless wall clock is no instant
  let hours = Number(hour);
  const minutes = Number(minute ?? '0');
  if (!Number.isInteger(hours) || hours <= 0 || hours > 23) return undefined;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return undefined;
  if (meridiem !== undefined) {
    if (hours > 12) return undefined;
    hours = (hours % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  return instantOfWallClock(hours, minutes, zone.trim(), date);
}

/**
 * The UTC instant of the NEXT occurrence of `hour:minute` wall-clock time in
 * `zone` (or of the named calendar date in that zone), best effort: the
 * zone's offset is read through Intl and corrected twice for DST edges. An
 * unknown zone yields undefined — a reset is never invented.
 */
function instantOfWallClock(
  hour: number,
  minute: number,
  zone: string,
  date: string | undefined,
): string | undefined {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const offsetAt = (at: number): number => {
      const parts: Record<string, number> = {};
      for (const part of formatter.formatToParts(new Date(at))) {
        if (part.type !== 'literal') parts[part.type] = Number(part.value);
      }
      return (
        Date.UTC(
          parts['year'] ?? 1970,
          (parts['month'] ?? 1) - 1,
          parts['day'] ?? 1,
          parts['hour'] ?? 0,
          parts['minute'] ?? 0,
          parts['second'] ?? 0,
        ) -
        Math.floor(at / 1000) * 1000
      );
    };
    const DAY_MS = 86_400_000;
    const timeOfDay = hour * 3_600_000 + minute * 60_000;
    // The wall-clock midnight of the target date as-if-UTC, then the target
    // instant: solve midnightInstant + offset(midnightInstant) === U twice.
    const midnightAsUtc =
      date === undefined
        ? Math.floor((Date.now() + offsetAt(Date.now())) / DAY_MS) * DAY_MS
        : (() => {
            const parsed = Date.parse(`${date}T00:00:00Z`);
            return Number.isFinite(parsed) ? parsed : Number.NaN;
          })();
    if (!Number.isFinite(midnightAsUtc)) return undefined;
    let midnight = midnightAsUtc;
    midnight -= offsetAt(midnight);
    midnight = midnightAsUtc - offsetAt(midnight);
    let target = midnight + timeOfDay;
    if (date === undefined && target <= Date.now() - 60_000) {
      // Already past today: the reset means tomorrow (best effort — across a
      // DST edge the roll may be off by the shift; it is an observation, not
      // a contract).
      const tomorrow = midnightAsUtc + DAY_MS;
      let next = tomorrow;
      next -= offsetAt(next);
      next = tomorrow - offsetAt(next);
      target = next + timeOfDay;
    }
    return new Date(target).toISOString();
  } catch {
    return undefined; // unknown zone — no reset invented
  }
}
