/**
 * Ownership preflight for `crq_repair.recover_job`'s `check_owner`
 * (apps/crq-python/crq_repair.py:1443-1485): the read-only decision whether a
 * failed repair job may still be recovered, taken from the tick-owned queue
 * record, the canonical finding's triage row, the retained publication events
 * and the prepared retry's job.
 *
 * DECISION ONLY. Nothing here locks, writes, spawns or reaches a provider. Every
 * fact is an injected read ({@link RepairRecoveryOwnerReads}), asked in Python's
 * order and lazily, so a refusal never asks a later question. Python runs the
 * closure twice under the tick lock (once up front, once before preparation);
 * the caller owns that lock and the repeat. Inactive: nothing imports this
 * outside tests, and the judge, recovery worktree, preparation and every ledger
 * write stay unported (docs/crq/tick-slot-missing-effects.md).
 *
 * Python raises a `ValueError` with a fixed message for each refusal. The
 * decision names it as a typed {@link RecoveryOwnerRefusal} and carries that
 * exact text as `reason`, so a caller can reproduce what the CLI reports.
 *
 * Failures the closure lets escape are not refusals and propagate from here as
 * `PyError`s of the same class, so a caller maps them as Python does:
 *
 * - a missing or unparsable triage row (`OSError`, `ValueError`), which Python
 *   never turns into a refusal;
 * - a shape Python would meet with `AttributeError` (`.get` on a non-dict) or
 *   `TypeError` (`in` over a non-container, an unhashable run key);
 * - a failed queue, retained-event or triage read: whatever the effect raises.
 *
 * Quirks mirrored deliberately:
 *
 * - `job_id not in record.get('jobs', [])` is Python's `in`: a list compares
 *   by `==`, a string by substring, a dict by key;
 * - item and event ids compare with Python `==`, whose list and dict members
 *   shortcut on identity: decoded `NaN` is one shared object, so `[NaN] == [NaN]`
 *   holds while a bare `NaN == NaN` does not;
 * - when the row's `previous_event_id` is absent and a retained event has no
 *   `id`, `None == None` selects that event;
 * - the prepared retry (`current` or the stale record's note) is read with
 *   `except (OSError, ValueError): pass`; any other failure escapes, and a
 *   non-string id is the `ValueError` `job_path` raises before any read;
 * - the retry must say `recovery_worktree is True`: a truthy `1` is refused;
 * - the stale note matches by `startswith`, so a note naming a non-grammar id
 *   is the same silent `ValueError` as an unreadable job.
 */
import { JsonNumber } from '../policy/crq/jsonValue.js';
import { isPyError, PyError } from './pyErrors.js';
import { pyEq } from './repairBackfill.js';

type Rec = Record<string, unknown>;

/** The prefix `staleMarkingFor` writes into a superseded record's `error`. */
const SUPERSEDED_PREFIX = 'superseded by prepared retry ';
const CANONICAL_FINDING = /^[0-9a-f]{64}$/;

export type RecoveryOwnerRefusal =
  /** `job lacks tick-owned repair record` */
  | 'not-tick-owned'
  /** `repair already published or superseded` */
  | 'already-published'
  /** `invalid canonical finding identity` */
  | 'invalid-canonical-identity'
  /** `finding requires an explicit owner decision` */
  | 'owner-decision-required'
  /** `canonical finding no longer belongs to this repair` */
  | 'canonical-finding-reassigned'
  /** `repair already superseded` */
  | 'already-superseded';

const REASONS: Readonly<Record<RecoveryOwnerRefusal, string>> = {
  'not-tick-owned': 'job lacks tick-owned repair record',
  'already-published': 'repair already published or superseded',
  'invalid-canonical-identity': 'invalid canonical finding identity',
  'owner-decision-required': 'finding requires an explicit owner decision',
  'canonical-finding-reassigned': 'canonical finding no longer belongs to this repair',
  'already-superseded': 'repair already superseded',
};

export type RecoveryOwnerDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: RecoveryOwnerRefusal;
      /** Python's `ValueError` message. */
      readonly reason: string;
    };

const refuse = (refusal: RecoveryOwnerRefusal): RecoveryOwnerDecision => ({
  ok: false,
  refusal,
  reason: REASONS[refusal],
});

/**
 * Read-only questions answered by the caller. Values are parsed JSON as
 * Python's `json.loads` yields them; supply `toPlainJsonRetainingNumbers` output
 * when the int/float kind of a malformed value must reach an error message.
 */
export interface RepairRecoveryOwnerReads {
  /** `c.load_queue()`: the whole queue document. */
  loadQueue(): Promise<unknown>;
  /**
   * `json.loads((STATE/backfill/findings/triage/<id>.json).read_text())`. A
   * missing or unreadable file rejects with `PyError('OSError')`, a decode or
   * parse failure with `PyError('ValueError')`; neither is swallowed here.
   */
  readTriageRow(findingId: string): Promise<unknown>;
  /**
   * `repair_tick.finding_inbox(c).publication.retained()`: every retained
   * publication event. A missing ledger configuration rejects (Python raises
   * `ValueError` building the inbox); the error propagates.
   */
  retainedEvents(): Promise<readonly unknown[]>;
  /**
   * `json.loads(job_path(ROOT, jobId).read_text())`. A grammar, symlink or
   * relocation refusal is `PyError('ValueError')`, an unreadable file
   * `PyError('OSError')`; both mean "no such job" to the ownership check.
   */
  readJob(jobId: string): Promise<unknown>;
}

export interface RepairRecoveryOwnerRequest {
  /** `json.loads(job_path(ROOT, job_id).read_text())`, read before the check. */
  readonly job: unknown;
  /** The explicit `--recover-job` id. */
  readonly jobId: string;
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  return Array.isArray(value) ? 'list' : 'dict';
}

const isDict = (value: unknown): value is Rec =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof JsonNumber);

/** Python `bool(value)` over parsed JSON. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value as Rec).length > 0;
}

/**
 * `value.get(key, default)`: a missing key answers `fallback`, a present one
 * its value (even `None`), and a non-dict receiver is `AttributeError`.
 */
function get(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) {
    throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `needle in container` for a `str` needle. */
function contains(container: unknown, needle: string): boolean {
  if (typeof container === 'string') return container.includes(needle);
  if (Array.isArray(container)) return container.some((member) => member === needle);
  if (isDict(container)) return Object.hasOwn(container, needle);
  throw new PyError('TypeError', `argument of type '${pyTypeName(container)}' is not iterable`);
}

/** A decoded `NaN`: `json` hands every parse the one shared `float('nan')` object. */
const isNaNFloat = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isNaN(value)) ||
  (value instanceof JsonNumber && value.kind === 'float' && Number.isNaN(value.float));

/**
 * Python `a == b`. A top-level `NaN == NaN` is false, but list and dict equality
 * compare members with an identity shortcut, and every decoded `NaN` is the same
 * object, so `[NaN] == [NaN]` is true. `pyEq` alone would say false.
 */
export function pyEqual(a: unknown, b: unknown): boolean {
  const member = (x: unknown, y: unknown): boolean =>
    (isNaNFloat(x) && isNaNFloat(y)) || pyEqual(x, y);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => member(value, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && member(a[key], b[key]))
    );
  }
  return pyEq(a, b);
}

/** `for member in value`: a list yields its members, a dict its keys, a str its characters. */
function iterate(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not iterable`);
}

/**
 * `successor = json.loads(job_path(ROOT, id).read_text())` inside
 * `except (OSError, ValueError): pass`: absent on a refusal or unreadable file,
 * and a non-string id is the `ValueError` `job_path` raises before any read.
 */
async function readCandidate(
  reads: RepairRecoveryOwnerReads,
  id: unknown,
): Promise<unknown | undefined> {
  if (typeof id !== 'string') return undefined;
  try {
    return await reads.readJob(id);
  } catch (e) {
    if (isPyError(e, 'OSError', 'ValueError')) return undefined;
    throw e;
  }
}

/** `candidate and candidate.get('origin_job') == job_id and candidate.get('recovery_worktree') is True`. */
function isPreparedRetry(candidate: unknown, jobId: string): boolean {
  if (!truthy(candidate)) return false;
  return get(candidate, 'origin_job') === jobId && get(candidate, 'recovery_worktree') === true;
}

/**
 * Decide whether `check_owner()` would let `recover_job(config, job_id)`
 * proceed. Every probe is read-only and lazy; the order matches Python's.
 */
export async function decideRecoveryOwner(
  request: RepairRecoveryOwnerRequest,
  reads: RepairRecoveryOwnerReads,
): Promise<RecoveryOwnerDecision> {
  const { job, jobId } = request;
  const queue = await reads.loadQueue();

  // `next((i for i in queue.get('items', []) if i.get('id') == job.get('item')), None)`:
  // lazy, so a malformed item after the match is never touched. `load_queue`
  // only iterates `q["items"]`, so an empty dict or string reaches the check and
  // matches nothing, while a non-empty one yields keys or characters that have
  // no `.get`.
  let item: unknown = null;
  for (const candidate of iterate(get(queue, 'items', []))) {
    if (pyEqual(get(candidate, 'id'), get(job, 'item'))) {
      item = candidate;
      break;
    }
  }
  const runs = get(truthy(item) ? item : {}, 'repair_runs', {});
  // `runs.get(run)`: the receiver is checked before the key is evaluated, a
  // key from JSON can only match as a string, and a list or dict is unhashable.
  if (!isDict(runs)) get(runs, '');
  const run = get(job, 'run');
  if (Array.isArray(run) || isDict(run)) {
    throw new PyError('TypeError', `unhashable type: '${pyTypeName(run)}'`);
  }
  const record = typeof run === 'string' ? get(runs, run) : null;
  if (!truthy(record) || !contains(get(record, 'jobs', []), jobId)) {
    return refuse('not-tick-owned');
  }
  const state = get(record, 'state');
  if (truthy(get(record, 'fix_pr')) || state === 'published' || state === 'done') {
    return refuse('already-published');
  }

  const findingId = get(job, 'canonical_finding_id');
  if (truthy(findingId)) {
    if (typeof findingId !== 'string' || !CANONICAL_FINDING.test(findingId)) {
      return refuse('invalid-canonical-identity');
    }
    const row = await reads.readTriageRow(findingId);
    const current = get(get(row, 'receipt', {}), 'repair_task');
    if (get(row, 'status') === 'needs-human') {
      const previous = get(row, 'previous_event_id');
      let event: unknown = null;
      for (const retained of await reads.retainedEvents()) {
        if (pyEqual(get(retained, 'id'), previous)) {
          event = retained;
          break;
        }
      }
      const payload = get(truthy(event) ? event : {}, 'payload', {});
      if (
        get(payload, 'actor') !== 'crq-repair' ||
        get(payload, 'finding_id') !== findingId ||
        get(get(payload, 'evidence', {}), 'repair_task') !== jobId
      ) {
        return refuse('owner-decision-required');
      }
    }
    let successor: unknown;
    if (truthy(current) && current !== jobId) successor = await readCandidate(reads, current);
    const status = get(row, 'status');
    if (
      (status !== 'delivered' && status !== 'needs-human') ||
      (current !== jobId && !isPreparedRetry(successor, jobId))
    ) {
      return refuse('canonical-finding-reassigned');
    }
  }

  if (state === 'stale') {
    const note = get(record, 'error', '');
    let candidate: unknown;
    if (typeof note === 'string' && note.startsWith(SUPERSEDED_PREFIX)) {
      candidate = await readCandidate(reads, note.slice(SUPERSEDED_PREFIX.length));
    }
    if (!isPreparedRetry(candidate, jobId)) return refuse('already-superseded');
  }
  return { ok: true };
}
