/**
 * Bounded closed-PR markers (`repair_tick.CLOSED_FIX_RECHECK`, `closed_marker_due`).
 *
 * A closed fix PR can be reopened upstream and still merge later at the
 * verified head, so neither the `fix_closed` stamp nor the `not_fixed` dict is
 * terminal: each lane rechecks its marker at most once per window.
 */
import { JsonObject } from './jsonValue.js';
import { parseUtc } from './utc.js';

/** `CLOSED_FIX_RECHECK = dt.timedelta(hours=24)`, in microseconds. */
export const CLOSED_FIX_RECHECK_MICROS = 24n * 3600n * 1_000_000n;

/**
 * `closed_marker_due(marker)`: true when a closed-PR marker owes its recheck.
 *
 * `marker` is a `fix_closed` timestamp or a `not_fixed` dict carrying an `at`
 * stamp. An unreadable stamp (missing, non-string, malformed, out of range) is
 * due: the recheck rewrites it, so a corrupt or pre-cadence marker never
 * silences a record permanently. A stamp in the future is not yet due.
 *
 * Two declared properties of the seam, both pinned in closedMarker.test.ts:
 * - `now` has millisecond precision here (Python reads microseconds), so a
 *   sub-millisecond stamp can read as not yet due up to 1 ms later than in
 *   Python. Production stamps are whole seconds, so this is harmless.
 * - An Invalid Date `now` throws `RangeError` (BigInt(NaN)); Python has no
 *   equivalent. Every producer is `new Date()` or an injected clock.
 */
export function closedMarkerDue(marker: unknown, now: Date): boolean {
  const stamp = parseUtc(marker instanceof JsonObject ? marker.get('at') : marker);
  if (stamp === null) return true;
  // The clock is read at microsecond precision in Python; ms is all JS has.
  const nowMicros = BigInt(now.getTime()) * 1000n;
  return nowMicros - stamp.epochMicros >= CLOSED_FIX_RECHECK_MICROS;
}
