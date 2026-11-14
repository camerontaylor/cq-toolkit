/**
 * Admission and pacing arithmetic for the crq tick/slot port
 * (`crq.read_slot_usage`, `crq.admit_available` up to the first launch).
 *
 * This module answers exactly two questions, both before any item is planned
 * or launched:
 *
 * 1. Which review reservations may still be holding a slot? A detached review
 *    whose CLI has produced no vendor evidence is a promise the vendor may or
 *    may not have counted yet, so it is subtracted from an observed usage
 *    snapshot. Positive local progress is bounded evidence (`vendor_progress`);
 *    a pid, a `review_context` or a launch timestamp alone is not.
 * 2. Does this tick admit work at all, and how many starts may it attempt?
 *    Paused, cooldown, exhausted slots and the in-flight ceiling are reported
 *    as one ordered gate, exactly as Python reports them, and the operator
 *    log lines are produced here so a shadow plan can compare them.
 *
 * The caller still owns every effect: reading usage, probing run directories,
 * launching, journaling reservations and writing the next deadline. `spent` is
 * always zero here because no launch happens in this slice; Python's
 * `remaining = max(0, slots - spent)` therefore stays with the launcher.
 *
 * Errors follow the oracle: a malformed `starts` or `cooldown_until` timestamp
 * raises in Python (`strptime` `ValueError`), so it raises
 * {@link TickAdmissionError} here rather than silently admitting work.
 */
import { isRecord, type CrqRecord } from './receiptIdentity.js';
import { inflight, startsLastHour } from './tickSchedule.js';
import { UtcParseError, parseIso } from './utc.js';
import type { VendorUsage } from './usageSlots.js';

/** The pacing knobs `admit_available` reads from `config.json`. */
export interface AdmissionConfig {
  /** `config.max_starts_per_hour`, Python's `.get(..., 5)`. */
  readonly maxStartsPerHour: number;
  /** `config.max_starts_per_tick`, Python's `.get(..., 10)`. */
  readonly maxStartsPerTick: number;
  /** `config.max_inflight`, Python's `.get(..., 10)`. */
  readonly maxInflight: number;
}

/** Raised when an admission input cannot be read the way Python reads it. */
export class TickAdmissionError extends Error {
  override readonly name = 'TickAdmissionError';

  constructor(message: string) {
    super(message);
  }
}

/** One reservation the usage snapshot must be reduced by. */
export interface ReservationHold {
  /** Index into `queue.items`, so the caller can report the exact item. */
  readonly itemIndex: number;
  /** The run id, when the item recorded one. */
  readonly runId: string | null;
  /** `run.started_at`, which may be missing or malformed in legacy state. */
  readonly startedAt: unknown;
}

/** A reservation whose local review produced bounded positive vendor progress. */
export interface ObservedReservation {
  readonly itemIndex: number;
  readonly runId: string;
  readonly run: Record<string, unknown>;
}

/** The result of `read_slot_usage` before the usage read is applied. */
export interface ReservationScan {
  readonly held: ReservationHold[];
  readonly observed: ObservedReservation[];
}

/**
 * `crq.read_slot_usage`'s reservation scan. A reviewing item with
 * `run.vendor_observed` is already reflected and is skipped; otherwise its run
 * directory answers `vendor_progress`. `usage !== null` is the caller's
 * question after this scan: only an observed usage snapshot may retire the
 * observed holds (by marking `vendor_observed`), and an unavailable snapshot
 * folds them back into the held list.
 */
export function scanReservations(
  queue: CrqRecord,
  vendorProgress: (runId: string) => boolean,
): ReservationScan {
  const items = queue.items;
  if (!Array.isArray(items)) throw new TickAdmissionError('queue.items must be an array');
  const held: ReservationHold[] = [];
  const observed: ObservedReservation[] = [];
  items.forEach((rawItem, itemIndex) => {
    if (!isRecord(rawItem) || rawItem.kind === 'promotion') return;
    if (rawItem.state !== 'reviewing') return;
    const run = isRecord(rawItem.run) ? rawItem.run : {};
    if (run.vendor_observed === true) return;
    const runId = typeof run.run_id === 'string' ? run.run_id : null;
    if (runId !== null && vendorProgress(runId)) {
      observed.push({ itemIndex, runId, run: { ...run } });
    } else {
      held.push({ itemIndex, runId, startedAt: run.started_at });
    }
  });
  return { held, observed };
}

/**
 * The effective held list `admit_available` receives: observed reservations
 * count as held until a successful usage read proves the vendor counted them.
 */
export function heldReservations(
  scan: ReservationScan,
  usage: VendorUsage | null,
): ReservationHold[] {
  if (usage !== null) return scan.held;
  return [
    ...scan.held,
    ...scan.observed.map((entry) => ({
      itemIndex: entry.itemIndex,
      runId: entry.runId,
      startedAt: entry.run.started_at,
    })),
  ];
}

/** One admission observation: the queue, the usage answer and the clock. */
export interface AdmissionInput {
  readonly queue: CrqRecord;
  /** `usage_slots.read_usage`'s answer, or null when the probe was unavailable. */
  readonly usage: VendorUsage | null;
  /** `heldReservations(scanReservations(...), usage)`. */
  readonly held: readonly ReservationHold[];
  readonly config: AdmissionConfig;
  /** `crq.now()` in epoch microseconds. */
  readonly nowMicros: bigint;
}

/** `crq.admit_available`'s decision, before any launch is attempted. */
export interface AdmissionDecision {
  /** `max(0, usage.remaining - held)` or the conservative start-log fallback. */
  readonly slots: number;
  /** `min(slots, max_starts_per_tick, max_inflight - inflight)`. */
  readonly admissions: number;
  /** The first failing global gate, in Python's order; `null` when open. */
  readonly gate: 'paused' | 'cooldown' | 'slots' | 'inflight' | null;
  /** `len(crq.inflight(queue))`. */
  readonly inflight: number;
  /** `crq.starts_last_hour(queue)`, read for the usage-unavailable fallback. */
  readonly startsLastHour: number;
  /** Python's operator log lines for this gate, in order. */
  readonly log: string[];
}

/** Python's `str()` for the JSON values an f-string prints here. */
function pythonText(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function parseStamp(value: unknown, field: string): bigint | null {
  try {
    const instant = parseIso(value);
    return instant === null ? null : instant.epochMicros;
  } catch (error) {
    if (error instanceof UtcParseError) {
      throw new TickAdmissionError(`${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * `crq.admit_available` up to the selection loop. Gate order is the oracle's:
 * pause, cooldown, slots, in-flight. `usage === null` keeps the conservative
 * start-log fallback, which also protects undated outstanding promises older
 * than the local rolling hour.
 */
export function admissionDecision(input: AdmissionInput): AdmissionDecision {
  const { queue, usage, held, config } = input;
  const log: string[] = [];
  let slots: number;
  if (usage !== null) {
    const remaining = usage.remaining;
    // Python reads `usage["remaining"]`; a snapshot without it is a KeyError
    // there and a refusal here, never a silent zero capacity.
    if (remaining === undefined) {
      throw new TickAdmissionError('usage is missing remaining');
    }
    slots = Math.max(0, remaining - held.length);
  } else {
    const cutoff = input.nowMicros - 3_600_000_000n;
    let oldHolds = 0;
    for (const hold of held) {
      const stamp = hold.startedAt;
      if (!pythonTruthy(stamp)) {
        oldHolds += 1;
        continue;
      }
      const instant = parseStamp(stamp, 'queue.starts');
      if (instant !== null && instant <= cutoff) oldHolds += 1;
    }
    const recentStarts = startsLastHour(queue, input.nowMicros);
    slots = Math.max(0, config.maxStartsPerHour - recentStarts - oldHolds);
  }
  const inFlightCount = inflight(queue).length;
  const admissions = Math.min(
    slots,
    config.maxStartsPerTick,
    Math.max(0, config.maxInflight - inFlightCount),
  );
  let gate: AdmissionDecision['gate'] = null;
  const paused = pythonTruthy(queue.paused);
  const cooldownUntil = queue.cooldown_until;
  const cooldown =
    pythonTruthy(cooldownUntil) &&
    (parseStamp(cooldownUntil, 'queue.cooldown_until') ?? 0n) > input.nowMicros;
  if (paused) {
    gate = 'paused';
    log.push(`queue paused: ${pythonText(queue.pause_reason)}`);
  } else if (cooldown) {
    gate = 'cooldown';
    log.push(`rate-limit cooldown until ${pythonText(cooldownUntil)}`);
  } else if (slots <= 0) {
    gate = 'slots';
    log.push(
      usage !== null
        ? 'included review slots exhausted'
        : 'hourly cap reached (usage unavailable; conservative start-log fallback)',
    );
  } else if (inFlightCount >= config.maxInflight) {
    gate = 'inflight';
    log.push(`${inFlightCount} review(s) in flight (max ${config.maxInflight})`);
  }
  return {
    slots,
    admissions,
    gate,
    inflight: inFlightCount,
    startsLastHour: startsLastHour(queue, input.nowMicros),
    log,
  };
}

/** Python truthiness for the JSON values admission reads. */
function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}
