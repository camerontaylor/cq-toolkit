/** Lossless terminal transition from backfill_jobs.terminal. No IO. */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { LedgerIntegrityError, LedgerTypeError, ledgerTimestamp } from './ledger.js';
import { history, units, type BackfillEnqueueResult } from './backfillJobs.js';
import { pyTruthy, withObjectKeys } from './queueDoc.js';
import { UtcInstant, parseUtc } from './utc.js';

function obj(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
}
function count(value: JsonValue | undefined): bigint {
  if (!(value instanceof JsonNumber) || value.kind !== 'int' || value.integer === null)
    throw new LedgerTypeError('failure count must be an integer');
  return value.integer;
}
function putItem(queue: JsonObject, index: number, item: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  return withObjectKeys(queue, [['items', items.map((value, i) => (i === index ? item : value))]]);
}

/** Unknown vendor ownership stays owned; confirmed completion waits for publication.
 * Confirmed failures increment family and every scope history, applying capped
 * exponential cooldown and immediate or sixth-failure quarantine. Counters are
 * integer state, and retryAfter is integral seconds. These are stricter than
 * Python for malformed float-valued state.
 */
export function terminalBackfill(
  queue: JsonObject,
  index: number,
  at: string,
  outcome: string,
  vendorTerminal: boolean,
  retryAfter = 0,
  reason = '',
): BackfillEnqueueResult {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  let item = obj(items[index], 'item');
  if (!vendorTerminal) {
    item = withObjectKeys(item, [
      ['vendor_state', 'unknown'],
      ['state', 'launch-unknown'],
    ]);
    return { queue: putItem(queue, index, item), item };
  }
  item = withObjectKeys(item, [
    ['vendor_state', 'terminal'],
    ['run', null],
  ]);
  const holds =
    queue.get('backfill_reservations') === undefined
      ? new JsonObject([])
      : obj(queue.get('backfill_reservations'), 'reservations');
  const attempt = item.get('attempt_id');
  const hold = typeof attempt === 'string' ? holds.get(attempt) : undefined;
  if (pyTruthy(hold) && typeof attempt === 'string')
    queue = withObjectKeys(queue, [
      [
        'backfill_reservations',
        withObjectKeys(holds, [
          [attempt, withObjectKeys(obj(hold, 'reservation'), [['terminal_at', at]])],
        ]),
      ],
    ]);
  if (outcome === 'completed') {
    item = withObjectKeys(item, [['state', 'publication-pending']]);
    return { queue: putItem(queue, index, item), item };
  }
  ledgerTimestamp(at);
  const instant = parseUtc(at);
  if (instant === null || !Number.isSafeInteger(retryAfter))
    throw new LedgerIntegrityError('invalid terminal cooldown');
  const itemFailures =
    count(item.get('failures') === undefined ? JsonNumber.int(0) : item.get('failures')) + 1n;
  item = withObjectKeys(item, [
    ['retry', true],
    ['failures', JsonNumber.int(itemFailures)],
  ]);
  const histories = history(queue, item);
  queue = histories.queue;
  let families = obj(queue.get('backfill_families'), 'families');
  let scopes = obj(queue.get('backfill_scope_failures'), 'scope histories');
  const family = item.get('family');
  if (typeof family !== 'string') throw new LedgerTypeError('family must be a string');
  const paths = units(item);
  const immediate = ['auth', 'integrity', 'unsupported', 'secret-scan'].includes(outcome);
  const updates = histories.histories.map((row) => {
    const failures = count(row.get('failures')) + 1n;
    const exponent = failures - 1n < 5n ? failures - 1n : 5n;
    if (exponent < 0n) throw new LedgerIntegrityError('negative history failure count');
    const seconds = Math.max(retryAfter, Math.min(86400, 3600 * 2 ** Number(exponent)));
    const target = instant.epochMicros + BigInt(seconds) * 1000000n;
    const formatted = new UtcInstant(target).iso;
    if (!/^\d{4}-/.test(formatted) || formatted.startsWith('0000'))
      throw new LedgerIntegrityError('terminal cooldown overflows datetime');
    const next = formatted.slice(0, 19) + 'Z';
    const quarantined = pyTruthy(row.get('quarantined')) || immediate || failures >= 6n;
    return {
      failures,
      next,
      quarantined,
      row: withObjectKeys(row, [
        ['failures', JsonNumber.int(failures)],
        ['next_eligible_at', next],
        ['quarantined', quarantined],
      ]),
    };
  });
  families = withObjectKeys(families, [[family, updates[0]!.row]]);
  scopes = withObjectKeys(
    scopes,
    paths.map((path, i) => [path, updates[i + 1]!.row] as const),
  );
  queue = withObjectKeys(queue, [
    ['backfill_families', families],
    ['backfill_scope_failures', scopes],
  ]);
  const maxFailures = updates.reduce((max, row) => (row.failures > max ? row.failures : max), 0n);
  const next = updates
    .map((row) => row.next)
    .sort()
    .at(-1)!;
  item = withObjectKeys(item, [
    ['family_failures', JsonNumber.int(maxFailures)],
    [
      'state',
      updates.some((row) => row.quarantined)
        ? 'quarantined'
        : itemFailures >= 3n
          ? 'blocked'
          : 'pending',
    ],
    ['not_before', next],
    ['last_error', reason || outcome],
  ]);
  return { queue: putItem(queue, index, item), item };
}
