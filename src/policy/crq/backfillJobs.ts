/** Lossless port of the enqueue and ownership policy in backfill_jobs.py. */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerKeyError,
  LedgerTypeError,
  ledgerTimestamp,
} from './ledger.js';
import { pyTruthy, pythonValueEqual, withObjectKeys } from './queueDoc.js';
import { compareCodePoints } from './pythonJson.js';

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
