/**
 * Pure canonical handoff record construction for the crq finding inbox.
 *
 * Ports the receipt, `finding-event` and row mutation of
 * `finding_delivery.Inbox.handoff` (`apps/crq-python/finding_delivery.py:190-197`).
 * The ownership and identity decision is not made here. `alreadyHandedOff` is
 * an unverified caller-supplied input, normally the decision from the single
 * `canonicalHandoffRefusal`. This module does not establish authorization,
 * ownership, dispatch readiness or a successful handoff.
 *
 * Evaluation order follows the Python receipt literal: `ledger.digest(job)` is
 * computed before `job["job"]` is read, so a combined digest defect wins over a
 * missing job key. This differs from the earlier `current == job["job"]` guard
 * in `Inbox.handoff`, which the caller has already performed.
 *
 * No filesystem, clock, environment or spawn read.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerTypeError,
  ledgerDigestOf,
  ledgerEvent,
  ledgerPythonTypeName,
  ledgerSubscript,
} from './ledger.js';

export type FindingHandoffPlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'write';
      readonly receipt: JsonObject;
      readonly event: JsonObject;
      readonly row: JsonObject;
    };

export interface FindingHandoffPlanInput {
  readonly row: JsonObject;
  readonly findingId: string;
  readonly job: JsonObject;
  readonly at: string;
  /**
   * The caller's decision from the shared handoff precondition validator. The
   * planner neither derives nor verifies it. A true value returns `none`
   * without constructing the receipt or event.
   */
  readonly alreadyHandedOff: boolean;
}

/** Python's `str + value` refusal for the source-key concatenation. */
function pythonString(value: JsonValue): string {
  if (typeof value === 'string') return value;
  throw new LedgerTypeError(
    `can only concatenate str (not "${ledgerPythonTypeName(value)}") to str`,
  );
}

/** Python `row.update`: existing keys keep their place, missing keys append. */
function setKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/**
 * Construct the exact handoff receipt, event and direct-write row mutation.
 *
 * The direct write updates only `status`, `previous_event_id` and `receipt`.
 * It deliberately leaves `failure_class` and every other row field untouched.
 * Recovery of the same event is a different mutation and sets
 * `failure_class` from the event evidence.
 */
export function planFindingHandoff(input: FindingHandoffPlanInput): FindingHandoffPlan {
  if (input.alreadyHandedOff) return { kind: 'none' };

  // Python evaluates the receipt literal left to right: digest(job) first,
  // then job["job"].
  const acknowledgement = ledgerDigestOf(input.job);
  const jobId = ledgerSubscript(input.job, 'job');
  const receipt = new JsonObject([
    ['acknowledgement', acknowledgement],
    ['repair_task', jobId],
  ]);

  const sourceKey = 'prepared-delivery:' + input.findingId + ':' + pythonString(jobId);
  const reviewId = ledgerSubscript(input.row, 'review_id');
  const previousEventId = ledgerSubscript(input.row, 'previous_event_id');
  const event = ledgerEvent(
    'finding-event',
    sourceKey,
    input.at,
    new JsonObject([
      ['finding_id', input.findingId],
      ['review_id', reviewId],
      ['previous_event_id', previousEventId],
      ['action', 'delivered'],
      ['evidence', receipt],
      ['actor', 'crq-repair-preparation'],
    ]),
  );
  const eventId = ledgerSubscript(event, 'id');
  const row = setKeys(input.row, [
    ['status', 'delivered'],
    ['previous_event_id', eventId],
    ['receipt', receipt],
  ]);
  return { kind: 'write', receipt, event, row };
}
