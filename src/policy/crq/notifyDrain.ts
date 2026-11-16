/**
 * Pure port of the `review_notify` delivery decisions
 * (`apps/crq-python/review_notify.py`): destination validation, the bounded
 * at-least-once outbox selection and the attempt/receipt transitions the
 * publisher's notification drain applies under the queue lock.
 *
 * Not here, deliberately: `review_notify.update` (the admission-side
 * status/outbox maintenance that `review-update` runs) belongs to the
 * review-v1 server port; `destination`, `validation` and `message` are
 * exported so that port reuses these primitives instead of a second copy.
 *
 * Python parity, kept exactly:
 *
 * - `destination` requires exactly `paseo_agent_id` + `paseo_host` (the host
 *   key must be present and may be null), a full UUID agent id, a host that
 *   does not begin with `-`, matches `[A-Za-z0-9_.:-]+`, and appears in the
 *   configured `notify.hosts` list (membership by Python `==`, so a `None`
 *   entry admits a null host).
 * - A row is due when its state is `pending` and `next_at` (absent = `""`) is
 *   not lexicographically greater than the drain clock in Python `isoformat`
 *   spelling. Rows are taken in queue insertion order, at most `LIMIT` per
 *   drain, and only when the named `review_events` row is truthy.
 * - An attempt increments `attempts`; `sent` only on a delivered send,
 *   otherwise `error` at `MAX_ATTEMPTS` or for an unsupported destination,
 *   otherwise `pending`. `next_at` is always `now + min(240,
 *   error_backoff_min * 2 ** (attempts - 1))` minutes.
 * - `notify_status` is rewritten only for the request whose current `notify`
 *   value still equals this row's destination; a failed attempt records
 *   `delivery-failed`, or `unsupported-destination` when the destination is
 *   no longer accepted.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { ledgerValueEqual, pythonTruthy } from './ledger.js';
import { civilFromDays } from './utc.js';

/** `review_notify.LIMIT`: notifications per publisher run. */
export const NOTIFY_LIMIT = 4;

/** `review_notify.MAX_ATTEMPTS`: attempts before a row is a permanent error. */
export const NOTIFY_MAX_ATTEMPTS = 5;

/** Python's `uuid` fullmatch pattern minus the `re` flags dance. */
const NOTIFY_UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** Python's `review_notify` host grammar (`fullmatch`). */
const NOTIFY_HOST = /^[A-Za-z0-9_.:-]+$/;

/** `CONFIG["error_backoff_min"]`'s default when the key is absent. */
export const NOTIFY_DEFAULT_BACKOFF_MINUTES = 5;

/** Python's backoff cap `min(240, ...)` in minutes. */
const NOTIFY_BACKOFF_CAP_MINUTES = 240;

const MICROS_PER_DAY = 86_400n * 1_000_000n;

/**
 * Python `datetime.isoformat()` for an aware UTC instant: `+00:00` offset and
 * microseconds only when they are nonzero. The drain compares these strings
 * lexicographically, so the spelling is load-bearing.
 */
export function pythonIsoformatUtc(epochMicros: bigint): string {
  const days =
    epochMicros >= 0n
      ? epochMicros / MICROS_PER_DAY
      : -((-epochMicros + MICROS_PER_DAY - 1n) / MICROS_PER_DAY);
  let remainder = epochMicros - days * MICROS_PER_DAY;
  const { year, month, day } = civilFromDays(Number(days));
  const hour = Number(remainder / 3_600_000_000n);
  remainder %= 3_600_000_000n;
  const minute = Number(remainder / 60_000_000n);
  remainder %= 60_000_000n;
  const second = Number(remainder / 1_000_000n);
  const microsecond = Number(remainder % 1_000_000n);
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const fraction = microsecond === 0 ? '' : `.${pad(microsecond, 6)}`;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${fraction}+00:00`;
}

/** Python `str(value)` over the JSON domain (message interpolation). */
export function pythonStr(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (value instanceof JsonNumber) {
    if (value.integer !== null) return value.integer.toString();
    return String(value.float);
  }
  if (Array.isArray(value)) return `[${value.map(pythonStr).join(', ')}]`;
  if (value instanceof JsonObject) {
    return `{${value.entries.map(([key, entry]) => `'${key}': ${pythonStr(entry)}`).join(', ')}}`;
  }
  return String(value);
}

/**
 * Python's `config["notify"]` section plus the two fields the drain reads.
 * A malformed section is Python's empty list of hosts, never an error.
 */
function notifySection(config: JsonValue | undefined): {
  readonly hosts: readonly JsonValue[];
  readonly errorBackoffMin: number;
} {
  const section = config instanceof JsonObject ? config.get('notify') : undefined;
  const rawHosts =
    section instanceof JsonObject ? (section.get('hosts') ?? new JsonObject([])) : undefined;
  const hosts = Array.isArray(rawHosts) ? rawHosts : [];
  const rawBackoff = config instanceof JsonObject ? config.get('error_backoff_min') : undefined;
  let errorBackoffMin = NOTIFY_DEFAULT_BACKOFF_MINUTES;
  if (rawBackoff instanceof JsonNumber) {
    // Python accepts a float minute count here (`timedelta` handles it); an
    // integer is exact, a float keeps its value.
    const minutes = rawBackoff.integer === null ? rawBackoff.float : Number(rawBackoff.integer);
    if (minutes !== null) errorBackoffMin = minutes;
  } else if (typeof rawBackoff === 'number') {
    errorBackoffMin = rawBackoff;
  }
  return { hosts, errorBackoffMin };
}

/** The configured backoff minutes (`CONFIG["error_backoff_min"]`, default 5). */
export function notifyBackoffMinutes(config: JsonValue | undefined): number {
  return notifySection(config).errorBackoffMin;
}

/**
 * `review_notify.destination`: a normalized copy of an acceptable destination,
 * or undefined. Accepts only the exact two-key shape and a listed host.
 */
export function notifyDestination(
  value: JsonValue | undefined,
  config: JsonValue | undefined,
): JsonObject | undefined {
  if (!(value instanceof JsonObject)) return undefined;
  const keys = value.entries.map(([key]) => key).sort();
  if (keys.length !== 2 || keys[0] !== 'paseo_agent_id' || keys[1] !== 'paseo_host') {
    return undefined;
  }
  const agent = value.get('paseo_agent_id');
  const host = value.get('paseo_host');
  const { hosts } = notifySection(config);
  if (typeof agent !== 'string' || !NOTIFY_UUID.test(agent)) return undefined;
  if (
    host !== null &&
    (typeof host !== 'string' || host.startsWith('-') || !NOTIFY_HOST.test(host))
  ) {
    return undefined;
  }
  // Python `host not in hosts`: list membership by `==` over the JSON domain.
  const listed = hosts.some((entry) => ledgerValueEqual(entry, host as JsonValue));
  if (!listed) return undefined;
  // Python returns `copy.deepcopy(value)`: same keys in insertion order.
  return new JsonObject(value.entries.map(([key, entry]) => [key, entry] as const));
}

/** `review_notify.validation`: the status a request records for a destination. */
export function notifyValidation(
  value: JsonValue | undefined,
  config: JsonValue | undefined,
  required = true,
): JsonObject {
  if (notifyDestination(value, config) !== undefined) {
    return new JsonObject([['state', required ? 'pending' : 'not-required']]);
  }
  return new JsonObject([
    ['state', 'error'],
    ['reason', 'unsupported-destination'],
  ]);
}

/** `review_notify.message`: the exact delivered text (argv-only, fixed shape). */
export function notifyMessage(row: JsonObject, event: JsonObject): string {
  return (
    `Review request ${pythonStr(row.get('request_id'))}: item ${pythonStr(event.get('item'))}, ` +
    `state ${pythonStr(event.get('state'))}, result ${pythonStr(row.get('receipt_id'))}. ` +
    `event_id=${pythonStr(row.get('event_id'))}. ` +
    `cq review.result --requestId ${pythonStr(row.get('request_id'))}`
  );
}

/** One due outbox row and the event it announces. */
export interface NotifyRow {
  readonly key: string;
  readonly row: JsonObject;
  readonly event: JsonObject;
}

function requireObject(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) {
    throw new TypeError(`${what} must be an object`);
  }
  return value;
}

function requireString(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  return value;
}

/**
 * The drain's selection pass: due pending rows in insertion order, capped at
 * `limit`, each with its truthy `review_events` row. Malformed rows raise,
 * exactly as Python's subscript/compare would.
 */
export function selectNotifyRows(
  outbox: JsonValue | undefined,
  events: JsonValue | undefined,
  nowMicros: bigint,
  limit = NOTIFY_LIMIT,
): NotifyRow[] {
  const selected: NotifyRow[] = [];
  if (outbox === undefined || outbox === null) return selected;
  const table = requireObject(outbox, 'review_notify_outbox');
  const eventTable = events instanceof JsonObject ? events : new JsonObject([]);
  const nowIso = pythonIsoformatUtc(nowMicros);
  for (const [key, value] of table.entries) {
    if (selected.length >= limit) break;
    const row = requireObject(value, 'review_notify_outbox row');
    // Python `row["state"]`: a missing state is a KeyError that fails the
    // drain (main reports `retry-pending`), not a silently skipped row.
    const state = row.get('state');
    if (state === undefined) throw new TypeError('notify row state missing');
    if (state !== 'pending') continue;
    const nextAt = row.get('next_at');
    const nextText = nextAt === undefined ? '' : requireString(nextAt, 'notify next_at');
    if (nextText > nowIso) continue;
    const event = eventTable.get(requireString(row.get('event_id'), 'notify event_id'));
    if (!pythonTruthy(event)) continue;
    selected.push({ key, row, event: event as JsonObject });
  }
  return selected;
}

/** The attempt arithmetic Python applies inside the reconcile lock. */
export interface NotifyAttemptInput {
  /** `notify(accepted, message).get("paseo_send") == 0`. */
  readonly success: boolean;
  /** `destination(row["destination"], CONFIG) is None`: unsupported. */
  readonly unsupported: boolean;
  /** Clock reading in UTC microseconds. */
  readonly nowMicros: bigint;
  /** `CONFIG["error_backoff_min"]`. */
  readonly errorBackoffMin: number;
}

/** The updated row and the `notify_status` it drives. */
export interface NotifyAttempt {
  readonly row: JsonObject;
  readonly notifyStatus: JsonObject;
}

/**
 * `review_notify.drain`'s `reconcile` closure, minus the queue I/O: the row
 * attempt count/state/backoff and the request's status record.
 *
 * Python's `dict.update` keeps an existing key's position, so the row is
 * rebuilt with `state`, `attempts` and `next_at` replaced where they already
 * exist and appended in Python's keyword order where they do not.
 */
export function notifyAttempt(row: JsonObject, input: NotifyAttemptInput): NotifyAttempt {
  const attempts = attemptCount(row) + 1;
  const state = input.success
    ? 'sent'
    : attempts >= NOTIFY_MAX_ATTEMPTS || input.unsupported
      ? 'error'
      : 'pending';
  const backoff = Math.min(NOTIFY_BACKOFF_CAP_MINUTES, input.errorBackoffMin * 2 ** (attempts - 1));
  const nextAt = pythonIsoformatUtc(input.nowMicros + timedeltaMicros(backoff));
  const updates = new Map<string, JsonValue>([
    ['state', state],
    ['attempts', JsonNumber.int(attempts)],
    ['next_at', nextAt],
  ]);
  const entries: Array<readonly [string, JsonValue]> = row.entries.map(
    ([key, value]) => [key, updates.get(key) ?? value] as const,
  );
  for (const [key, value] of updates) {
    if (!row.has(key)) entries.push([key, value]);
  }
  const status: Array<readonly [string, JsonValue]> = [['state', state]];
  if (!input.success) {
    status.push(['reason', input.unsupported ? 'unsupported-destination' : 'delivery-failed']);
  }
  return { row: new JsonObject(entries), notifyStatus: new JsonObject(status) };
}

function attemptCount(row: JsonObject): number {
  const value = row.get('attempts');
  if (value === undefined) return 0;
  if (value instanceof JsonNumber && value.integer !== null) return Number(value.integer);
  throw new TypeError('notify attempts must be an integer');
}

/**
 * `timedelta(minutes=minutes).total_seconds() * 1e6` in microseconds: Python
 * rounds a fractional microsecond half to even, and `min(240, ...)` keeps the
 * value far below the point where this arithmetic would drift.
 */
function timedeltaMicros(minutes: number): bigint {
  const exact = minutes * 60_000_000;
  const floor = Math.floor(exact);
  const fraction = exact - floor;
  let micros = floor;
  if (fraction > 0.5 || (fraction === 0.5 && floor % 2 === 1)) micros = floor + 1;
  return BigInt(micros);
}

/**
 * The `reconcile` closure over the reloaded queue: re-check the row is still
 * current, then write the attempt and the request's `notify_status`.
 *
 * Returns the queue unchanged when the row moved on (a concurrent update won),
 * exactly Python's early `return True` without a save. A missing
 * `review_requests` entry raises Python's KeyError.
 */
export function reconcileNotifyAttempt(
  queue: JsonObject,
  key: string,
  row: JsonObject,
  input: NotifyAttemptInput,
): JsonObject {
  const outbox = queue.get('review_notify_outbox');
  if (!(outbox instanceof JsonObject)) return queue;
  const current = outbox.get(key);
  if (!(current instanceof JsonObject) || !ledgerValueEqual(current, row)) {
    return queue;
  }
  const attempt = notifyAttempt(row, input);
  const requests = queue.get('review_requests');
  const requestId = requireString(row.get('request_id'), 'notify request_id');
  if (!(requests instanceof JsonObject)) throw new TypeError('review_requests must be an object');
  const request = requests.get(requestId);
  if (!(request instanceof JsonObject)) throw new TypeError('review request not found');
  // The status record follows the attempt only while the request still names
  // this row's destination; a withdrawn or replaced destination keeps its own.
  // Python `request.get("notify") == row["destination"]`: an absent key reads
  // as None on both sides, and a missing destination is a KeyError.
  const destination = row.get('destination');
  if (destination === undefined) throw new TypeError('notify destination missing');
  const notify = request.get('notify');
  const sameDestination = ledgerValueEqual(notify ?? null, destination);
  const requestEntries: Array<readonly [string, JsonValue]> = [];
  let statusWritten = false;
  for (const [name, value] of request.entries) {
    if (sameDestination && name === 'notify_status') {
      requestEntries.push([name, attempt.notifyStatus]);
      statusWritten = true;
      continue;
    }
    requestEntries.push([name, value]);
  }
  if (sameDestination && !statusWritten) {
    requestEntries.push(['notify_status', attempt.notifyStatus]);
  }
  const updatedRequest = new JsonObject(requestEntries);
  const updatedOutbox = new JsonObject(
    outbox.entries.map(([name, value]) =>
      name === key ? ([name, attempt.row] as const) : ([name, value] as const),
    ),
  );
  const updatedRequests = new JsonObject(
    requests.entries.map(([name, value]) =>
      name === requestId ? ([name, updatedRequest] as const) : ([name, value] as const),
    ),
  );
  return new JsonObject(
    queue.entries.map(([name, value]) => {
      if (name === 'review_notify_outbox') return [name, updatedOutbox] as const;
      if (name === 'review_requests') return [name, updatedRequests] as const;
      return [name, value] as const;
    }),
  );
}
