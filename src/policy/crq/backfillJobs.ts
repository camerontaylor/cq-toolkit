/** Lossless port of the enqueue and ownership policy in backfill_jobs.py. */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerKeyError,
  LedgerTypeError,
  LedgerTimestampError,
  ledgerTimestamp,
} from './ledger.js';
import { pyTruthy, pythonValueEqual, withObjectKeys } from './queueDoc.js';
import { compareCodePoints } from './pythonJson.js';
import { appendAdmission } from './admissionHistory.js';
import { parseUtc, UtcInstant } from './utc.js';

const empty = (): JsonObject => new JsonObject([]);
const required = (object: JsonObject, key: string): JsonValue => {
  const value = object.get(key);
  if (value === undefined) throw new LedgerKeyError(key);
  return value;
};
const object = (value: JsonValue | undefined, label: string): JsonObject => {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
};
const text = (value: JsonValue, label: string): string => {
  if (typeof value !== 'string') throw new LedgerTypeError(`${label} must be a string`);
  return value;
};

/** Vendor uncertainty or a recorded run continues to own an execution slot. */
export function isExecutionOwner(item: JsonObject): boolean {
  return (
    item.get('vendor_state') === 'live' ||
    item.get('vendor_state') === 'unknown' ||
    pyTruthy(item.get('run')) ||
    item.get('state') === 'reviewing' ||
    item.get('state') === 'launch-unknown'
  );
}

/** Pending and publication-pending jobs also own their scope. */
export function scopeOwner(item: JsonObject): boolean {
  return (
    isExecutionOwner(item) ||
    item.get('state') === 'pending' ||
    item.get('state') === 'publication-pending'
  );
}

/** Sorted distinct canonical path lineages for a job. */
export function units(item: JsonObject): string[] {
  const lineage = object(
    item.has('path_lineages') ? item.get('path_lineages') : empty(),
    'path_lineages',
  );
  const scope = item.has('scope') ? item.get('scope') : [];
  if (!Array.isArray(scope)) throw new LedgerTypeError('scope must be an array');
  const paths = scope.map((row) => {
    const path = text(required(object(row, 'scope row'), 'path'), 'path');
    return text(lineage.has(path) ? required(lineage, path) : path, 'lineage');
  });
  return [...new Set(paths)].sort(compareCodePoints);
}

export interface BackfillHistoryResult {
  readonly queue: JsonObject;
  readonly histories: readonly JsonObject[];
}

/** Create missing family and scope histories, retaining all existing values. */
export function history(queue: JsonObject, item: JsonObject): BackfillHistoryResult {
  const family = text(required(item, 'family'), 'family');
  let families = object(
    queue.has('backfill_families') ? queue.get('backfill_families') : empty(),
    'backfill_families',
  );
  let scopes = object(
    queue.has('backfill_scope_failures') ? queue.get('backfill_scope_failures') : empty(),
    'backfill_scope_failures',
  );
  const initial = (): JsonObject =>
    new JsonObject([
      ['failures', JsonNumber.int(0)],
      ['quarantined', false],
      ['next_eligible_at', null],
    ]);
  if (!families.has(family)) families = withObjectKeys(families, [[family, initial()]]);
  const histories = [object(families.get(family), 'family history')];
  for (const unit of units(item)) {
    if (!scopes.has(unit)) scopes = withObjectKeys(scopes, [[unit, initial()]]);
    histories.push(object(scopes.get(unit), 'scope history'));
  }
  return {
    queue: withObjectKeys(queue, [
      ['backfill_families', families],
      ['backfill_scope_failures', scopes],
    ]),
    histories,
  };
}

/** Defer a verified terminal quota refusal without refunding its reservation. */
export function deferTerminalQuota(
  queue: JsonObject,
  index: number,
  at: string,
  retrySeconds: number,
): BackfillEnqueueResult {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const item = object(items[index], 'item');
  const canonical = (value: JsonValue | undefined): string => {
    const t = ledgerTimestamp(value);
    return `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}T${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:${String(t.second).padStart(2, '0')}Z`;
  };
  const instant = parseUtc(canonical(at));
  const delay = Number.isSafeInteger(retrySeconds) && retrySeconds > 0 ? retrySeconds : 3600;
  if (instant === null) throw new LedgerIntegrityError('invalid quota cooldown');
  const formatted = new UtcInstant(instant.epochMicros + BigInt(delay) * 1000000n).iso;
  if (!/^\d{4}-/.test(formatted) || formatted.startsWith('0000'))
    throw new LedgerIntegrityError('quota cooldown overflows datetime');
  const histories = history(queue, item);
  const deadlines = [
    formatted.slice(0, 19) + 'Z',
    item.get('not_before'),
    queue.get('cooldown_until'),
    ...histories.histories.map((row) => row.get('next_eligible_at')),
  ];
  const present = deadlines.filter(pyTruthy);
  const deadline = present
    .map((value) => ({ value: text(value!, 'deadline'), key: canonical(value) }))
    .reduce((best, value) => (value.key > best.key ? value : best)).value;
  const holds = object(queue.get('backfill_reservations') ?? empty(), 'reservations');
  const attempt = item.get('attempt_id');
  const hold = typeof attempt === 'string' ? holds.get(attempt) : undefined;
  if (!pyTruthy(hold) || typeof attempt !== 'string')
    throw new LedgerIntegrityError('quota refusal requires retained reservation');
  const family = text(required(item, 'family'), 'family');
  const families = object(histories.queue.get('backfill_families'), 'families');
  const scopes = object(histories.queue.get('backfill_scope_failures'), 'scope histories');
  const updatedItem = withObjectKeys(item, [
    ['vendor_state', 'terminal'],
    ['run', null],
    ['state', 'pending'],
    ['not_before', deadline],
    ['last_error', 'verified quota refusal'],
  ]);
  return {
    item: updatedItem,
    queue: withObjectKeys(histories.queue, [
      [
        'backfill_reservations',
        withObjectKeys(holds, [
          [attempt, withObjectKeys(object(hold, 'reservation'), [['terminal_at', at]])],
        ]),
      ],
      [
        'backfill_families',
        withObjectKeys(families, [
          [family, withObjectKeys(histories.histories[0]!, [['next_eligible_at', deadline]])],
        ]),
      ],
      [
        'backfill_scope_failures',
        withObjectKeys(
          scopes,
          units(item).map(
            (path, i) =>
              [
                path,
                withObjectKeys(histories.histories[i + 1]!, [['next_eligible_at', deadline]]),
              ] as const,
          ),
        ),
      ],
      ['items', items.map((row, i) => (i === index ? updatedItem : row))],
    ]),
  };
}

export interface BackfillEnqueueResult {
  readonly queue: JsonObject;
  readonly item: JsonObject;
}

/** Enqueue exactly once, or return an existing scope owner without modifying it. */
export function enqueue(
  queue: JsonObject,
  partition: JsonObject,
  at: string,
): BackfillEnqueueResult {
  ledgerTimestamp(at);
  const jid = required(partition, 'job_id');
  const rawItems = queue.has('items') ? queue.get('items') : [];
  if (!Array.isArray(rawItems)) throw new LedgerTypeError('items must be an array');
  const withItems = queue.has('items') ? queue : withObjectKeys(queue, [['items', rawItems]]);
  for (const raw of rawItems) {
    const item = object(raw, 'item');
    if (pythonValueEqual(item.get('job_id') ?? null, jid)) {
      if (
        !pythonValueEqual(item.get('scope_digest') ?? null, required(partition, 'scope_digest'))
      ) {
        throw new LedgerIntegrityError('job generation scope conflict');
      }
      return { queue: withItems, item };
    }
    if (
      scopeOwner(item) &&
      pythonValueEqual(item.get('target') ?? null, required(partition, 'target')) &&
      pythonValueEqual(item.get('scope_digest') ?? null, required(partition, 'scope_digest'))
    ) {
      return { queue: withItems, item };
    }
  }
  const generation = required(partition, 'generation');
  const partitionKind = required(partition, 'kind');
  const generationText =
    generation instanceof JsonNumber
      ? (generation.integer?.toString() ?? generation.raw)
      : String(generation);
  const prs = partition.get('prs');
  const pr = pyTruthy(prs) && Array.isArray(prs) ? (prs[0] ?? null) : JsonNumber.int(0);
  let job = withObjectKeys(partition, [
    ['id', `backfill-${text(required(partition, 'subject_id'), 'subject_id')}-g${generationText}`],
    ['kind', 'backfill'],
    ['tier', JsonNumber.int(4)],
    [
      'subject_kind',
      partition.has('subject_kind') ? required(partition, 'subject_kind') : partitionKind,
    ],
    [
      'tier_importance',
      partition.has('tier_importance')
        ? required(partition, 'tier_importance')
        : partition.has('tier')
          ? required(partition, 'tier')
          : 'T4',
    ],
    ['state', 'pending'],
    ['vendor_state', 'none'],
    ['attempt', JsonNumber.int(0)],
    ['failures', JsonNumber.int(0)],
    ['created_at', at],
    ['cycles', []],
    ['attempts', []],
    ['notes', []],
    ['pr', pr],
  ]);
  const result = history(withItems, job);
  let max: JsonNumber | null = null;
  for (const h of result.histories) {
    const failures = required(h, 'failures');
    if (!(failures instanceof JsonNumber)) throw new LedgerTypeError('failures must be a number');
    if (
      max === null ||
      (failures.integer !== null && max.integer !== null
        ? failures.integer > max.integer
        : Number(failures.integer ?? failures.float) > Number(max.integer ?? max.float))
    )
      max = failures;
  }
  job = withObjectKeys(job, [['family_failures', max ?? JsonNumber.int(0)]]);
  if (result.histories.some((h) => pyTruthy(required(h, 'quarantined'))))
    job = withObjectKeys(job, [['state', 'quarantined']]);
  return { queue: withObjectKeys(result.queue, [['items', [...rawItems, job]]]), item: job };
}

/** Eligibility creates the same missing family and lineage histories as Python. */
export function eligible(
  queue: JsonObject,
  item: JsonObject,
  at: string,
): {
  readonly queue: JsonObject;
  readonly eligible: boolean;
} {
  if (item.get('state') !== 'pending' || isExecutionOwner(item)) return { queue, eligible: false };
  ledgerTimestamp(at);
  const future = (value: JsonValue | undefined): boolean => {
    if (!pyTruthy(value)) return false;
    ledgerTimestamp(value);
    return (value as string) > at;
  };
  try {
    if (future(item.get('not_before')) || future(queue.get('cooldown_until')))
      return { queue, eligible: false };
  } catch (error) {
    if (error instanceof LedgerTypeError || error instanceof LedgerKeyError) throw error;
    if (error instanceof LedgerIntegrityError || error instanceof LedgerTimestampError)
      return { queue, eligible: false };
    throw error;
  }
  const result = history(queue, item);
  try {
    return {
      queue: result.queue,
      eligible: !result.histories.some(
        (row) => pyTruthy(required(row, 'quarantined')) || future(row.get('next_eligible_at')),
      ),
    };
  } catch (error) {
    if (error instanceof LedgerKeyError || error instanceof LedgerTypeError) throw error;
    if (error instanceof LedgerIntegrityError || error instanceof LedgerTimestampError)
      return { queue: result.queue, eligible: false };
    throw error;
  }
}

/** Decision and resulting queue; callers must durably save under tick.lock before launching. */
export interface BackfillAdmissionResult {
  readonly queue: JsonObject;
  readonly item: JsonObject;
  readonly decision: JsonObject;
}

/** `backfill_jobs.admission`: one-slot reserve and shared rank-4 execution cap. */
export function admission(
  queue: JsonObject,
  itemIndex: number,
  at: string,
  observation: JsonObject | null,
  ordinaryEligible: boolean,
  reserve = true,
): BackfillAdmissionResult {
  ledgerTimestamp(at);
  const items = queue.has('items') ? queue.get('items') : [];
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const item = object(items[itemIndex], 'item');
  const id = text(required(item, 'id'), 'item id');
  const holds = object(
    queue.has('backfill_reservations') ? queue.get('backfill_reservations') : empty(),
    'backfill_reservations',
  );
  let resultQueue = queue.has('backfill_reservations')
    ? queue
    : withObjectKeys(queue, [['backfill_reservations', holds]]);
  let reason: string | null = null;
  let effective: bigint | null = null;
  if (ordinaryEligible) reason = 'ordinary-eligible';
  else if (observation === null || !pyTruthy(observation.get('successful')))
    reason = 'usage-unknown';
  else {
    let age = -1;
    try {
      const observed = observation.get('observed_at');
      ledgerTimestamp(observed);
      age = (Date.parse(at) - Date.parse(observed as string)) / 1000;
    } catch {
      // Invalid observation timestamps fail closed, as the oracle does.
    }
    const remaining = observation.get('remaining');
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > 180 ||
      !(remaining instanceof JsonNumber) ||
      remaining.kind !== 'int' ||
      remaining.integer === null ||
      remaining.integer < 0n
    )
      reason = 'usage-stale-or-invalid';
    else {
      const reflectedValue = observation.has('reflected_reservations')
        ? observation.get('reflected_reservations')
        : [];
      const iterable =
        typeof reflectedValue === 'string'
          ? [...reflectedValue]
          : reflectedValue instanceof JsonObject
            ? reflectedValue.entries.map(([key]) => key)
            : reflectedValue;
      if (!Array.isArray(iterable))
        throw new LedgerTypeError('reflected reservations must be an array');
      const reflected = new Set<string>();
      for (const value of iterable) {
        if (Array.isArray(value) || value instanceof JsonObject)
          throw new LedgerTypeError('unhashable reflected reservation');
        if (typeof value === 'string') reflected.add(value);
      }
      let unreflected = 0n;
      for (const [key, value] of holds.entries) {
        const hold = object(value, 'reservation');
        if (
          !reflected.has(key) &&
          hold.get('quota_state') !== 'released' &&
          hold.get('quota_state') !== 'expired'
        )
          unreflected++;
      }
      effective = remaining.integer - unreflected;
      if (effective < 2n) reason = 'one-slot-reserve';
    }
  }
  const inflight = items.filter((value) => {
    const row = object(value, 'item');
    return (
      (row.get('kind') === 'backfill' || row.get('kind') === 'coverage') && isExecutionOwner(row)
    );
  });
  if (reason === null && inflight.length >= 2) reason = 'rank4-inflight-cap';
  const decision = new JsonObject([
    ['at', at],
    ['item', id],
    ['ordinary_eligible', ordinaryEligible],
    ['observation', observation],
    ['reservations', holds],
    ['effective_remaining', effective === null ? null : JsonNumber.int(effective)],
    ['decision', reason ?? 'admit'],
  ]);
  const appended = appendAdmission(resultQueue, decision);
  resultQueue = appended.queue;
  // appendAdmission's plain-JSON projection normalizes a float such as 1.0 to
  // an integer. Preserve the three captured fields exactly in this queue path.
  let row = appended.row;
  if (observation !== null) {
    const fields = ['successful', 'observed_at', 'remaining'];
    const captured = new JsonObject(
      fields.filter((key) => observation.has(key)).map((key) => [key, required(observation, key)]),
    );
    row = withObjectKeys(row, [['observation', captured]]);
    const rows = resultQueue.get('backfill_admissions');
    if (!Array.isArray(rows)) throw new LedgerTypeError('backfill_admissions must be an array');
    resultQueue = withObjectKeys(resultQueue, [
      ['backfill_admissions', [...rows.slice(0, -1), row]],
    ]);
  }
  if (reason !== null || !reserve) return { queue: resultQueue, item, decision: row };
  const attempt = item.has('attempt') ? item.get('attempt') : JsonNumber.int(0);
  if (!(attempt instanceof JsonNumber) || attempt.kind !== 'int' || attempt.integer === null)
    throw new LedgerTypeError('attempt must be an integer');
  const nextAttempt = attempt.integer + 1n;
  const job = item.has('job_id') ? text(required(item, 'job_id'), 'job_id') : id;
  const attemptId = `${job}:${nextAttempt}`;
  const updatedItem = withObjectKeys(item, [
    ['attempt', JsonNumber.int(nextAttempt)],
    ['attempt_id', attemptId],
    ['vendor_state', 'unknown'],
    ['state', 'launch-unknown'],
  ]);
  const hold = new JsonObject([
    ['item', id],
    ['at', at],
    ['quota_state', 'reserved'],
    ['vendor_run_id', null],
  ]);
  const updatedItems = items.map((row, index) => (index === itemIndex ? updatedItem : row));
  resultQueue = withObjectKeys(resultQueue, [
    ['items', updatedItems],
    ['backfill_reservations', withObjectKeys(holds, [[attemptId, hold]])],
  ]);
  return { queue: resultQueue, item: updatedItem, decision: row };
}

/** Bind a reserved attempt to the observed vendor run without replacing an identity. */
export function bindRun(
  queue: JsonObject,
  itemIndex: number,
  vendorRunId: string,
): BackfillEnqueueResult {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const item = object(items[itemIndex], 'item');
  const attemptId = text(required(item, 'attempt_id'), 'attempt_id');
  const holds = object(required(queue, 'backfill_reservations'), 'backfill_reservations');
  const hold = object(required(holds, attemptId), 'reservation');
  const existing = required(hold, 'vendor_run_id');
  if (pyTruthy(existing) && existing !== vendorRunId)
    throw new LedgerIntegrityError('vendor identity conflict');
  const updatedItem = withObjectKeys(item, [
    ['vendor_state', 'live'],
    ['state', 'reviewing'],
  ]);
  return {
    item: updatedItem,
    queue: withObjectKeys(queue, [
      ['items', items.map((row, index) => (index === itemIndex ? updatedItem : row))],
      [
        'backfill_reservations',
        withObjectKeys(holds, [
          [attemptId, withObjectKeys(hold, [['vendor_run_id', vendorRunId]])],
        ]),
      ],
    ]),
  };
}

/** Release only a positively known pre-vendor refusal, never a recorded run. */
export function cancelBeforeVendor(queue: JsonObject, itemIndex: number): BackfillEnqueueResult {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const item = object(items[itemIndex], 'item');
  if (pyTruthy(item.get('run')))
    throw new LedgerIntegrityError('cannot cancel a run with recorded ownership');
  const holds = object(
    queue.has('backfill_reservations') ? queue.get('backfill_reservations') : empty(),
    'backfill_reservations',
  );
  const attemptId = item.get('attempt_id');
  const holdValue = typeof attemptId === 'string' ? holds.get(attemptId) : undefined;
  let nextQueue = queue;
  if (pyTruthy(holdValue) && typeof attemptId === 'string') {
    const hold = object(holdValue, 'reservation');
    nextQueue = withObjectKeys(queue, [
      [
        'backfill_reservations',
        withObjectKeys(holds, [[attemptId, withObjectKeys(hold, [['quota_state', 'released']])]]),
      ],
    ]);
  }
  const updatedItem = withObjectKeys(item, [['vendor_state', 'terminal']]);
  return {
    item: updatedItem,
    queue: withObjectKeys(nextQueue, [
      ['items', items.map((row, index) => (index === itemIndex ? updatedItem : row))],
    ]),
  };
}
