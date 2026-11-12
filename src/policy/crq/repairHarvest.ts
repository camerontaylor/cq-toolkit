/**
 * Pure canonical repair-outcome construction for the crq finding inbox.
 *
 * Ports the decision table, retry bound and idempotent event/row mutation of
 * `finding_delivery.Inbox.repair_outcome` (`apps/crq-python/finding_delivery.py:239-272`),
 * as called by `repair_tick.mark_finding_outcome` (`apps/crq-python/repair_tick.py:229-250`)
 * during `repair_tick.harvest`.
 *
 * The caller supplies the worker's typed disposition and failure class; this
 * module never reads reason prose, the artifact's summary key or a human
 * sentence. In particular:
 *
 * - a FAILED outcome without an `owner-decision` class is retriable
 *   (`needs-retriage`), not an owner decision;
 * - only a typed `owner-decision` class produces `needs-human`;
 * - `unchanged_with_reason` with verified source evidence is `dismissed`,
 *   while the same disposition without evidence is FAILED (`exhausted`);
 * - a pre-merge FIXED outcome writes nothing here: publication owns the
 *   `fixed` event.
 *
 * Idempotence is the canonical owned outcome key: the source key is
 * `repair-outcome:<digest({job, action, evidence})>` and an equal retained
 * event means no second write. The retry bound walks the retained event chain
 * from the row's `previous_event_id` and counts prior crq-written
 * `needs-human`/`needs-retriage` events whose class is not `owner-decision`.
 *
 * No filesystem, lock, clock, environment, spawn or network read. The caller
 * decides ownership and supplies the retained outbox view.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { ledgerDigestOf, ledgerEvent, ledgerSubscript } from './ledger.js';

/** Every crq-written failure class; `owner-decision` is the only escalation. */
export type RepairHarvestFailureClass =
  | 'transient'
  | 'exhausted'
  | 'evidence'
  | 'protected-path'
  | 'owner-decision';

const FAILURE_CLASSES: readonly RepairHarvestFailureClass[] = [
  'transient',
  'exhausted',
  'evidence',
  'protected-path',
  'owner-decision',
];

/** One verified source citation from an `unchanged_with_reason` contract. */
export interface RepairHarvestEvidence {
  readonly path: string;
  readonly line: number;
}

/**
 * The typed harvest verdict for one job. `failed` carries the class derived
 * from a typed op result; `stale` is the canonical-delivery refusal.
 */
export type RepairHarvestVerdict =
  | { readonly verdict: 'fixed'; readonly commits: readonly string[] }
  | {
      readonly verdict: 'not-fixed';
      readonly evidence: readonly RepairHarvestEvidence[];
      /** Typed class from the producing branch; defaults to `exhausted`. */
      readonly failureClass?: RepairHarvestFailureClass;
    }
  | {
      readonly verdict: 'failed';
      readonly failureClass: RepairHarvestFailureClass;
      readonly reason: string;
    }
  | { readonly verdict: 'stale'; readonly reason: string };

/** The canonical finding action; the ledger action enum is unchanged. */
export type RepairHarvestAction = 'fixed' | 'dismissed' | 'needs-retriage' | 'needs-human';

export type RepairHarvestNoneReason = 'preserved-newer-generation' | 'fixed-requires-merge';

export type RepairHarvestRefusal =
  | 'retry-history-incomplete'
  | 'finding-row-missing-review-id'
  | 'finding-row-missing-previous-event-id';

export type RepairHarvestPlan =
  /** Python's early return: the row is not owned by this job any more. */
  | { readonly kind: 'none'; readonly reason: 'preserved-newer-generation' }
  /** A pre-merge FIXED outcome; publication writes the `fixed` event. */
  | { readonly kind: 'none'; readonly reason: 'fixed-requires-merge' }
  /** This exact canonical outcome is already retained; no second write. */
  | { readonly kind: 'already-recorded'; readonly action: RepairHarvestAction }
  | {
      readonly kind: 'write';
      readonly action: RepairHarvestAction;
      readonly event: JsonObject;
      readonly row: JsonObject;
    }
  | { readonly kind: 'refused'; readonly refusal: RepairHarvestRefusal };

export interface RepairHarvestInput {
  /** The current `triage/<id>.json` value. */
  readonly row: JsonObject;
  /** The canonical finding id the row belongs to. */
  readonly findingId: string;
  /** The prepared repair job id (`repair_task`). */
  readonly job: string;
  readonly verdict: RepairHarvestVerdict;
  /** Worker summary/reason, presentation text only. */
  readonly reason: string;
  /** Fixed timestamp for the event (`c.iso()` in the oracle). */
  readonly at: string;
  /** `repair.max_finding_retries`, defaulted by the caller. */
  readonly maxFindingRetries: number;
  /** Retained publication records, recovery authority and idempotence view. */
  readonly retained: readonly JsonValue[];
  /** The prepared job's pinned base commit. */
  readonly repairBase?: string;
  /** The merged/salvaged fix PR, when the caller has one. */
  readonly fixPr?: number | null;
  /**
   * The merged commit. Only a merged outcome may write `fixed`; an unmerged
   * FIXED artifact returns `fixed-requires-merge`.
   */
  readonly mergedCommit?: string;
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

/** Python truthiness for the values this module reads. */
function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? (value.integer as bigint) !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  return true;
}

function normalizedFailureClass(value: string): RepairHarvestFailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(value)
    ? (value as RepairHarvestFailureClass)
    : 'exhausted';
}

/**
 * Python's action table (`mark_finding_outcome`): `fixed` requires a merge;
 * STALE is retriable; FAILED is an owner decision only under the typed
 * `owner-decision` class; NOT-FIXED with evidence dismisses.
 */
function actionFor(
  verdict: RepairHarvestVerdict,
  failureClass: RepairHarvestFailureClass,
  mergedCommit: string | undefined,
): RepairHarvestAction | null {
  switch (verdict.verdict) {
    case 'fixed':
      return mergedCommit === undefined ? null : 'fixed';
    case 'stale':
      return 'needs-retriage';
    case 'failed':
      return failureClass === 'owner-decision' ? 'needs-human' : 'needs-retriage';
    case 'not-fixed':
      return verdict.evidence.length > 0
        ? 'dismissed'
        : failureClass === 'owner-decision'
          ? 'needs-human'
          : 'needs-retriage';
  }
}

function retainedEvents(retained: readonly JsonValue[]): Map<string, JsonObject> {
  const events = new Map<string, JsonObject>();
  for (const value of retained) {
    if (!(value instanceof JsonObject)) continue;
    if (value.get('event_type') !== 'finding-event') continue;
    const id = value.get('id');
    if (typeof id === 'string') events.set(id, value);
  }
  return events;
}

/**
 * Python's bounded retry walk. Returns the count of prior crq-written
 * retriable outcomes in this finding's chain, or `null` when the chain is
 * incomplete or cyclic (the oracle raises `ledger.IntegrityError`).
 */
function priorRetriableOutcomes(row: JsonObject, events: Map<string, JsonObject>): number | null {
  let previous = row.get('previous_event_id');
  let count = 0;
  const seen = new Set<string>();
  while (typeof previous === 'string' && events.has(previous)) {
    if (seen.has(previous)) return null;
    seen.add(previous);
    const payload = events.get(previous)?.get('payload');
    if (!(payload instanceof JsonObject)) return null;
    const evidence = payload.get('evidence');
    const failureClass = evidence instanceof JsonObject ? evidence.get('failure_class') : undefined;
    const actor = payload.get('actor');
    const action = payload.get('action');
    if (
      typeof actor === 'string' &&
      actor.startsWith('crq-') &&
      (action === 'needs-human' || action === 'needs-retriage') &&
      truthy(failureClass) &&
      failureClass !== 'owner-decision'
    ) {
      count += 1;
    }
    previous = payload.get('previous_event_id');
  }
  // A non-null chain end means the retained view lacks a referenced event.
  return previous === undefined || previous === null ? count : null;
}

/**
 * Build the exact canonical event and direct-write row mutation for one
 * harvested job, or return why no write is due.
 */
export function planRepairHarvest(input: RepairHarvestInput): RepairHarvestPlan {
  // `mark_finding_outcome` returns before touching the inbox when a FIXED
  // artifact has no merge yet; publication owns that event.
  if (input.verdict.verdict === 'fixed' && input.mergedCommit === undefined) {
    return { kind: 'none', reason: 'fixed-requires-merge' };
  }

  const current = rowReceiptTask(input.row);
  if (current !== undefined && current !== null) {
    if (current !== input.job || input.row.get('status') !== 'delivered') {
      return { kind: 'none', reason: 'preserved-newer-generation' };
    }
  }

  const failureClass = normalizedFailureClass(
    input.verdict.verdict === 'failed'
      ? input.verdict.failureClass
      : input.verdict.verdict === 'not-fixed'
        ? (input.verdict.failureClass ?? 'exhausted')
        : 'exhausted',
  );
  const action = actionFor(
    input.verdict,
    failureClass,
    input.verdict.verdict === 'fixed' ? input.mergedCommit : undefined,
  );
  if (action === null) return { kind: 'none', reason: 'fixed-requires-merge' };

  const reviewIdValue = input.row.get('review_id');
  if (typeof reviewIdValue !== 'string') {
    return { kind: 'refused', refusal: 'finding-row-missing-review-id' };
  }
  const reviewId = reviewIdValue;
  if (input.row.get('previous_event_id') === undefined) {
    return { kind: 'refused', refusal: 'finding-row-missing-previous-event-id' };
  }

  const evidenceEntries: Array<readonly [string, JsonValue]> = [
    ['repair_task', input.job],
    ['reason', input.reason],
    [
      'fix_pr',
      input.fixPr === undefined || input.fixPr === null
        ? null
        : (JsonNumber.int(input.fixPr) as JsonValue),
    ],
  ];
  if (input.repairBase !== undefined) evidenceEntries.push(['repair_base', input.repairBase]);
  evidenceEntries.push(['failure_class', failureClass]);
  if (input.verdict.verdict === 'fixed' && input.mergedCommit !== undefined) {
    evidenceEntries.push(['fixing_commit', input.mergedCommit], ['verification', input.reason]);
  }
  if (input.verdict.verdict === 'not-fixed' && input.verdict.evidence.length > 0) {
    evidenceEntries.push([
      'source_evidence',
      input.verdict.evidence.map(
        (entry) =>
          new JsonObject([
            ['path', entry.path],
            ['line', JsonNumber.int(entry.line)],
          ]),
      ),
    ]);
  }
  const evidence = new JsonObject(evidenceEntries);
  let effectiveAction = action;
  if (effectiveAction === 'needs-retriage') {
    const events = retainedEvents(input.retained);
    const count = priorRetriableOutcomes(input.row, events);
    if (count === null) return { kind: 'refused', refusal: 'retry-history-incomplete' };
    if (count >= input.maxFindingRetries) effectiveAction = 'needs-human';
  }

  const token = ledgerDigestOf(
    new JsonObject([
      ['job', input.job],
      ['action', effectiveAction],
      ['evidence', evidence],
    ]),
  );
  const sourceKey = 'repair-outcome:' + token;
  for (const value of input.retained) {
    if (!(value instanceof JsonObject)) continue;
    if (value.get('event_type') === 'finding-event' && value.get('source_key') === sourceKey) {
      return { kind: 'already-recorded', action: effectiveAction };
    }
  }

  const previousEventId = input.row.get('previous_event_id') as JsonValue;
  const event = ledgerEvent(
    'finding-event',
    sourceKey,
    input.at,
    new JsonObject([
      ['finding_id', input.findingId],
      ['review_id', reviewId],
      ['previous_event_id', previousEventId],
      ['action', effectiveAction],
      ['evidence', evidence],
      ['actor', 'crq-repair'],
    ]),
  );
  const eventId = ledgerSubscript(event, 'id');
  const row = setKeys(input.row, [
    ['status', effectiveAction],
    ['previous_event_id', eventId],
    ['failure_class', evidence.get('failure_class') as JsonValue],
  ]);
  return { kind: 'write', action: effectiveAction, event, row };
}

function rowReceiptTask(row: JsonObject): JsonValue | undefined {
  const receipt = row.get('receipt');
  return receipt instanceof JsonObject ? receipt.get('repair_task') : undefined;
}
