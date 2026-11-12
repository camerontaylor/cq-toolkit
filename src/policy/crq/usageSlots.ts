/**
 * Offline slot arithmetic and bounded vendor observations
 * (`usage_slots.parse_usage`, `usage_slots.next_slot`).
 *
 * `parse_usage` reads the CodeRabbit CLI's NDJSON usage stream; `next_slot`
 * computes the earliest candidate wake. Neither grants permission to spend a
 * slot: every wake reads usage again before admitting work. The process probe
 * (`usage_slots.read_usage`) and the hint file writer stay in the adapter layer.
 *
 * Numbers are parsed with the lossless JSON reader because Python's
 * `type(value) is int` rejects `1.0` and `true`; `JSON.parse` would erase that
 * distinction before this module could apply the rule.
 */
import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  parseJsonValue,
  type JsonValue,
} from './jsonValue.js';
import { UtcInstant } from './utc.js';

/** Python `ValueError`/`TypeError` analogue for a refused slot computation. */
export class UsageSlotsError extends Error {
  override readonly name = 'UsageSlotsError';
  readonly pythonError: 'ValueError' | 'TypeError';

  constructor(message: string, pythonError: 'ValueError' | 'TypeError') {
    super(message);
    this.pythonError = pythonError;
  }
}

export interface VendorUsage {
  readonly remaining?: number;
  readonly limit?: number;
  readonly rollingWindowMs?: number;
  readonly fullCapacityInMs?: number;
}

const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_LIMIT = 10;
const FALLBACK_WAKE_MICROS = 60_000_000n;
const USAGE_OPTIONAL_FIELDS = ['limit', 'rollingWindowMs', 'fullCapacityInMs'] as const;

/**
 * `usage_slots.parse_usage`: the first trustworthy included-remaining
 * observation, or null. Partial usage is useful only when the remaining count
 * is a non-negative integer and an optional limit is consistent with it.
 */
export function parseUsage(stream: string): VendorUsage | null {
  for (const line of splitLines(stream)) {
    let event: JsonValue;
    try {
      event = parseJsonValue(line, { duplicates: 'last' });
    } catch (error) {
      if (error instanceof JsonParseError) continue;
      throw error;
    }
    if (!(event instanceof JsonObject)) continue;
    const included = event.get('includedReviews');
    if (!(included instanceof JsonObject)) continue;
    const state = included.get('state');
    if (state !== undefined && state !== null && state !== 'available') continue;
    const remaining = pythonInt(included.get('remaining'));
    if (remaining === null || remaining < 0n) continue;
    const rawLimit = included.get('limit');
    if (rawLimit !== undefined && rawLimit !== null) {
      const limit = pythonInt(rawLimit);
      if (limit === null || limit < remaining || limit <= 0n) continue;
    }
    const result: Record<string, number> = { remaining: Number(remaining) };
    for (const field of USAGE_OPTIONAL_FIELDS) {
      const value = pythonInt(included.get(field));
      if (value !== null && value >= 0n) result[field] = Number(value);
    }
    return result as VendorUsage;
  }
  return null;
}

/**
 * `usage_slots.next_slot`: the earliest candidate boundary, never permission to
 * spend. `fullCapacityInMs` is when ALL slots recover, not the next slot; it is
 * an upper-bound fallback when other consumers used slots we cannot date.
 */
export function nextSlot(
  starts: readonly (UtcInstant | null)[],
  at: UtcInstant,
  usage: VendorUsage | null | undefined,
): UtcInstant | null {
  const u: Partial<VendorUsage> = usage === null || usage === undefined ? {} : usage;
  const windowMs = truthy(u.rollingWindowMs) ? u.rollingWindowMs : DEFAULT_WINDOW_MS;
  const window = millisToMicros(windowMs, 'rollingWindowMs');
  const known: bigint[] = [];
  for (const start of starts) {
    if (start === null) throw new UsageSlotsError('start is not a datetime', 'TypeError');
    if (at.epochMicros - window < start.epochMicros && start.epochMicros <= at.epochMicros) {
      known.push(start.epochMicros);
    }
  }
  const candidates = known.map((start) => start + window);
  const full = u.fullCapacityInMs;
  if (truthy(full) && u.remaining === 0) {
    candidates.push(at.epochMicros + millisToMicros(full, 'fullCapacityInMs'));
  }
  const used = (u.limit ?? DEFAULT_LIMIT) - (u.remaining ?? 0);
  if (known.length === 0 || (usage !== null && usage !== undefined && used > known.length)) {
    // Unknown external starts, or local reservations that precede vendor
    // admission: full-capacity recovery cannot date the FIRST slot.
    candidates.push(at.epochMicros + FALLBACK_WAKE_MICROS);
  }
  if (candidates.length === 0) return null;
  let earliest = candidates[0] as bigint;
  for (const candidate of candidates) if (candidate < earliest) earliest = candidate;
  return new UtcInstant(earliest);
}

function pythonInt(value: JsonValue | undefined): bigint | null {
  return value instanceof JsonNumber && value.kind === 'int' ? value.integer : null;
}

function millisToMicros(value: unknown, field: string): bigint {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new UsageSlotsError(`${field} is not a number`, 'TypeError');
  }
  if (Number.isInteger(value)) return BigInt(value) * 1000n;
  // `timedelta(milliseconds=...)` keeps microsecond resolution.
  return BigInt(Math.round(value * 1000));
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** `str.splitlines()` separators, so CRLF and Unicode line breaks split alike. */
function splitLines(stream: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < stream.length; index += 1) {
    const code = stream.charCodeAt(index);
    if (!isLineBreak(code)) continue;
    lines.push(stream.slice(start, index));
    if (code === 0x0d && stream.charCodeAt(index + 1) === 0x0a) index += 1;
    start = index + 1;
  }
  lines.push(stream.slice(start));
  return lines;
}

function isLineBreak(code: number): boolean {
  return (
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x85 ||
    (code >= 0x1c && code <= 0x1e) ||
    code === 0x2028 ||
    code === 0x2029
  );
}
