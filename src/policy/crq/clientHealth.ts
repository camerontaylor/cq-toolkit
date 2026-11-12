/**
 * Bounded, advisory runner health view (`client_health.snapshot`).
 *
 * The queue-v1 capability serves only the durable snapshot; the advisory issue
 * reconciliation (`client_health.record`/`advisory`) performs forge calls and
 * queue writes, so it belongs to the effects/adapter slice, not policy.
 */
import { isRecord, type CrqRecord } from './receiptIdentity.js';
import { parseUtc } from './utc.js';

/** Python `ValueError`/`AttributeError` analogue for an unreadable health record. */
export class ClientHealthError extends Error {
  override readonly name = 'ClientHealthError';
  readonly pythonError: 'ValueError' | 'AttributeError';

  constructor(message: string, pythonError: 'ValueError' | 'AttributeError') {
    super(message);
    this.pythonError = pythonError;
  }
}

export interface ClientHealthSnapshot {
  readonly lastCompletedTick: unknown;
  readonly ageSeconds: number | null;
  readonly discoveryComplete: unknown;
  readonly incompleteTicks: unknown;
  readonly pending: number;
  readonly blocked: number;
  readonly deployedSha: unknown;
}

/**
 * `client_health.snapshot`. `now` is epoch seconds; the Python function reads
 * the wall clock, and callers here pass it so the result is deterministic.
 */
export function clientHealthSnapshot(queue: CrqRecord, now: number): ClientHealthSnapshot {
  const health = get(queue, 'client_health', {});
  if (!isRecord(health)) {
    throw new ClientHealthError('client_health is not an object', 'AttributeError');
  }
  const completed = get(health, 'completed_at');
  let age: number | null = null;
  if (pyTruthy(completed)) {
    if (typeof completed !== 'string') {
      throw new ClientHealthError('completed_at is not a string', 'AttributeError');
    }
    const instant = parseUtc(completed);
    if (instant === null) throw new ClientHealthError('invalid completed_at', 'ValueError');
    age = Math.max(0, now - Number(instant.epochMicros) / 1_000_000);
  }
  const items = get(queue, 'items', []);
  if (!Array.isArray(items)) throw new ClientHealthError('items is not a list', 'AttributeError');
  const count = (state: string): number =>
    items.filter((item) => {
      if (!isRecord(item)) throw new ClientHealthError('item is not an object', 'AttributeError');
      return get(item, 'state') === state;
    }).length;
  return {
    lastCompletedTick: completed === undefined ? null : completed,
    ageSeconds: age,
    discoveryComplete: nullish(get(health, 'complete')),
    incompleteTicks: nullish(get(health, 'incomplete_ticks', 0)),
    pending: count('pending'),
    blocked: count('blocked'),
    deployedSha: nullish(get(health, 'sha')),
  };
}

function get(record: CrqRecord, key: string, fallback?: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function nullish(value: unknown): unknown {
  return value === undefined ? null : value;
}
