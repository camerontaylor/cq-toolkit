/** Backfill quota observation and rank-four gate, without selection or launch.
 *
 * The caller holds tick.lock for the whole operation. Effects own the real
 * usage refresh, durable state-event outbox and queue writer. An admitted gate
 * returns only after the event and queue save succeed, never a vendor spawn.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError, LedgerTypeError, ledgerTimestamp } from '../../policy/crq/ledger.js';
import { admission } from '../../policy/crq/backfillJobs.js';
import { pyTruthy, pythonValueEqual, withObjectKeys } from '../../policy/crq/queueDoc.js';

const empty = (): JsonObject => new JsonObject([]);
function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
}
function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new LedgerTypeError(`${label} must be an array`);
  return value;
}
function integer(value: JsonValue | undefined, label: string): bigint {
  if (!(value instanceof JsonNumber) || value.kind !== 'int' || value.integer === null)
    throw new LedgerTypeError(`${label} must be an integer`);
  return value.integer;
}
function epoch(value: JsonValue | undefined): number {
  ledgerTimestamp(value);
  return Date.parse(value as string);
}
function defaultMissing(value: JsonValue | undefined, fallback: JsonValue): JsonValue {
  return value === undefined ? fallback : value;
}

/** `backfill_runtime.usage_context`: bind a probe to holds and local starts. */
export function usageContext(
  queue: JsonObject,
  usage: JsonObject | null,
  reserved: readonly JsonValue[],
  at: string,
): JsonObject {
  const observed = epoch(at);
  let holds = object(
    defaultMissing(queue.get('backfill_reservations'), empty()),
    'backfill_reservations',
  );
  const initial = usage === null ? [] : defaultMissing(usage.get('reflected_reservations'), []);
  const reflected = [...array(initial, 'reflected_reservations')];
  if (usage !== null) {
    const windowValue = usage.get('rollingWindowMs');
    const window = pyTruthy(windowValue)
      ? windowValue instanceof JsonNumber
        ? Number(windowValue.integer ?? windowValue.float)
        : NaN
      : 3_600_000;
    if (!Number.isFinite(window)) throw new LedgerTypeError('invalid rollingWindowMs');
    const microseconds = window * 1000;
    if (!Number.isSafeInteger(Math.trunc(microseconds)))
      throw new LedgerTypeError('rollingWindowMs is outside the supported range');
    const lower = Math.floor(microseconds);
    const fraction = microseconds - lower;
    const roundedWindow =
      fraction === 0.5 ? lower + (Math.abs(lower) % 2) : Math.round(microseconds);
    for (const [key, value] of holds.entries) {
      const hold = object(value, 'reservation');
      const terminal = hold.get('terminal_at');
      if (!pyTruthy(terminal)) continue;
      const terminalTime = epoch(terminal);
      if ((observed - terminalTime) * 1000 >= roundedWindow) {
        holds = withObjectKeys(holds, [[key, withObjectKeys(hold, [['quota_state', 'expired']])]]);
      } else if (
        hold.get('quota_state') !== 'released' &&
        hold.get('quota_state') !== 'expired' &&
        terminalTime <= observed &&
        !reflected.some((entry) => pythonValueEqual(entry, key))
      )
        reflected.push(key);
    }
  }
  const items = array(defaultMissing(queue.get('items'), []), 'items');
  let represented = 0;
  for (const value of items) {
    const item = object(value, 'item');
    const attempt = item.get('attempt_id');
    if (typeof attempt !== 'string' || !holds.has(attempt)) continue;
    const rawRun = item.get('run');
    const run = pyTruthy(rawRun) ? object(rawRun, 'run') : empty();
    const started = run.get('started_at') ?? null;
    if (reserved.some((value) => pythonValueEqual(value, started))) represented++;
  }
  const remaining = usage === null ? 0n : integer(usage.get('remaining'), 'remaining');
  const adjusted = remaining - BigInt(Math.max(0, reserved.length - represented));
  const observation = new JsonObject([
    ['successful', usage !== null],
    ['remaining', JsonNumber.int(adjusted > 0n ? adjusted : 0n)],
    ['observed_at', at],
    ['reflected_reservations', reflected],
  ]);
  const updates: Array<readonly [string, JsonValue]> = [['backfill_usage', observation]];
  if (queue.has('backfill_reservations')) updates.push(['backfill_reservations', holds]);
  return withObjectKeys(queue, updates);
}

function age(at: string, value: JsonValue | undefined): number | null {
  try {
    return (epoch(at) - epoch(value)) / 1000;
  } catch {
    return null;
  }
}

/** The supplied effects must execute while the caller holds the shared tick flock. */
export interface Rank4GateEffects {
  now(): string;
  /** A failed probe retains the old observation and checkpoint. */
  refreshUsage?: (
    queue: JsonObject,
  ) => Promise<{ readonly queue: JsonObject; readonly successful: boolean }>;
  /** Spool the state event durably before returning the updated queue. */
  stateEvent(queue: JsonObject, item: JsonObject, at: string, reason: string): Promise<JsonObject>;
  /** Atomically persist the complete queue before returning. */
  saveQueue(queue: JsonObject): Promise<void>;
}

/** `backfill_runtime.rank4_gate`; caller owns ordinary eligibility and tick.lock. */
export async function rank4Gate(
  initial: JsonObject,
  itemIndex: number,
  ordinaryEligible: boolean,
  dry: boolean,
  effects: Rank4GateEffects,
): Promise<{ readonly queue: JsonObject; readonly admitted: boolean }> {
  let queue = initial;
  const checkAt = effects.now();
  const original = queue.get('backfill_usage');
  const observation = pyTruthy(original) ? object(original, 'backfill_usage') : null;
  const observationAge = observation === null ? null : age(checkAt, observation.get('observed_at'));
  const probeAge = age(checkAt, queue.get('backfill_usage_probe_at'));
  if (
    !ordinaryEligible &&
    effects.refreshUsage !== undefined &&
    (observation === null ||
      !pyTruthy(observation.get('successful')) ||
      observationAge === null ||
      observationAge > 60) &&
    (probeAge === null || probeAge < 0 || probeAge > 60)
  ) {
    queue = withObjectKeys(queue, [['backfill_usage_probe_at', effects.now()]]);
    const refreshed = await effects.refreshUsage(queue);
    queue = refreshed.queue;
    if (refreshed.successful) {
      const starts = array(defaultMissing(queue.get('starts'), []), 'starts');
      queue = withObjectKeys(queue, [
        ['backfill_starts_at_observation', JsonNumber.int(starts.length)],
      ]);
    }
  }
  const rawObservation = queue.get('backfill_usage');
  let current =
    rawObservation === undefined || rawObservation === null
      ? null
      : object(rawObservation, 'backfill_usage');
  if (
    current !== null &&
    pyTruthy(current) &&
    age(effects.now(), current.get('observed_at')) !== null
  ) {
    const remaining = current.get('remaining');
    if (remaining instanceof JsonNumber && remaining.kind === 'int' && remaining.integer !== null) {
      const starts = array(defaultMissing(queue.get('starts'), []), 'starts');
      const checkpoint = queue.get('backfill_starts_at_observation');
      let ordinary =
        BigInt(starts.length) -
        (checkpoint === undefined
          ? BigInt(starts.length)
          : integer(checkpoint, 'backfill_starts_at_observation'));
      const holds = object(
        defaultMissing(queue.get('backfill_reservations'), empty()),
        'backfill_reservations',
      );
      const observedAt = current.get('observed_at');
      if (typeof observedAt !== 'string') throw new LedgerIntegrityError('invalid observed_at');
      for (const [, value] of holds.entries) {
        const at = object(value, 'reservation').get('at');
        if (typeof at !== 'string') throw new LedgerTypeError('reservation at must be a string');
        if (at >= observedAt) ordinary--;
      }
      if (ordinary < 0n) ordinary = 0n;
      const adjusted = remaining.integer - ordinary;
      current = withObjectKeys(current, [
        ['remaining', JsonNumber.int(adjusted > 0n ? adjusted : 0n)],
      ]);
    }
  }
  const result = admission(queue, itemIndex, effects.now(), current, ordinaryEligible, !dry);
  queue = result.queue;
  const decision = result.decision.get('decision');
  if (decision !== 'admit') {
    if (typeof decision !== 'string') throw new LedgerIntegrityError('invalid admission decision');
    const items = array(queue.get('items'), 'items');
    const updated = withObjectKeys(result.item, [['wait_reason', decision]]);
    return {
      queue: withObjectKeys(queue, [
        ['items', items.map((item, i) => (i === itemIndex ? updated : item))],
      ]),
      admitted: false,
    };
  }
  if (!dry) {
    queue = await effects.stateEvent(
      queue,
      result.item,
      effects.now(),
      'atomic quota reservation before launch',
    );
    const dayKey = effects.now().slice(0, 10);
    const capacity = object(
      defaultMissing(queue.get('backfill_daily_capacity'), empty()),
      'backfill_daily_capacity',
    );
    const day = object(
      defaultMissing(
        capacity.get(dayKey),
        new JsonObject([
          ['spare_admissions', JsonNumber.int(0)],
          ['completed_partitions', JsonNumber.int(0)],
        ]),
      ),
      'daily capacity',
    );
    const count = integer(day.get('spare_admissions'), 'spare_admissions');
    queue = withObjectKeys(queue, [
      [
        'backfill_daily_capacity',
        withObjectKeys(capacity, [
          [dayKey, withObjectKeys(day, [['spare_admissions', JsonNumber.int(count + 1n)]])],
        ]),
      ],
    ]);
    await effects.saveQueue(queue);
  }
  return { queue, admitted: true };
}
