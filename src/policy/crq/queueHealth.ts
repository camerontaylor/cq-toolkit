/**
 * Queue-v1 wire projection of `client_health.snapshot`.
 *
 * `clientHealth.ts` serves the human report, where a plain JS number is enough.
 * The capability wire re-encodes the projection with `review_receipt.canonical`,
 * whose bytes are part of the response contract: Python's `total_seconds()`
 * returns a float, so `ageSeconds` must stay a float (`12.0`, never `12`). This
 * projection therefore keeps lossless JSON numbers.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { isJsonRecord, pyTruthy, recordGet } from './queueDoc.js';
import { parseUtcDetailed } from './utc.js';

const MICROS_PER_SECOND = 1_000_000;

function field(health: JsonObject, key: string): JsonValue {
  const value = health.get(key);
  return value === undefined ? null : value;
}

function countStates(items: readonly JsonValue[]): { pending: number; blocked: number } {
  let pending = 0;
  let blocked = 0;
  for (const item of items) {
    if (!isJsonRecord(item)) throw new TypeError('invalid queue item');
    const state = recordGet(item, 'state');
    if (state === 'pending') pending += 1;
    if (state === 'blocked') blocked += 1;
  }
  return { pending, blocked };
}

/**
 * `client_health.snapshot(q)`: last completed tick, its age and the coarse queue
 * counts. `ageSeconds` is null until a tick completes and is clamped at zero.
 */
export function queueHealthSnapshot(queue: JsonObject, nowMicros: bigint): JsonObject {
  const healthValue = queue.get('client_health');
  const health = healthValue instanceof JsonObject ? healthValue : new JsonObject([]);
  const completed = field(health, 'completed_at');
  let ageSeconds: JsonValue = null;
  if (pyTruthy(completed)) {
    // Python: `datetime.fromisoformat(completed.replace("Z", "+00:00"))`.
    const completedMicros = parseUtcDetailed(completed);
    if (completedMicros === null) throw new TypeError('invalid completed_at timestamp');
    const seconds = Number(nowMicros - completedMicros) / MICROS_PER_SECOND;
    // `max(0, total_seconds())` keeps the int 0 when the diff is not positive.
    ageSeconds = seconds > 0 ? JsonNumber.float(seconds) : JsonNumber.int(0);
  }
  const itemsValue = queue.get('items');
  const items = Array.isArray(itemsValue) ? itemsValue : [];
  const counts = countStates(items);
  return new JsonObject([
    ['lastCompletedTick', completed],
    ['ageSeconds', ageSeconds],
    ['discoveryComplete', field(health, 'complete')],
    ['incompleteTicks', health.get('incomplete_ticks') ?? JsonNumber.int(0)],
    ['pending', JsonNumber.int(counts.pending)],
    ['blocked', JsonNumber.int(counts.blocked)],
    ['deployedSha', field(health, 'sha')],
  ]);
}
