/**
 * Deterministic publication planning for the crq review-ledger outbox.
 *
 * This is the pure half of `review_ledger.GitLedger.publish`: causal ordering
 * of pending records, acknowledgement of ids the remote ledger already holds,
 * and import/enrollment batch grouping. It performs no I/O and constructs no
 * commit, push, lock or signer effect.
 *
 * The effect order is observable and must stay Python's:
 *
 * 1. validate the fetched remote history,
 * 2. order pending records by causal dependency (refusing a missing or forked
 *    predecessor before any acknowledgement),
 * 3. acknowledge records the remote already holds,
 * 4. group the remaining records for publication.
 *
 * Python then verifies artifacts, creditable reviews and the batch extension
 * immediately before each batch's effects. That per-batch work is deliberately
 * absent here: validating a later batch early would suppress prior accepted
 * batches and acknowledge states Python has not reached.
 *
 * Sizes are canonical UTF-8 byte lengths, never JavaScript string lengths.
 * `review_ledger.publish` bounds a record at 1 MiB and a batch at 64 records
 * and 4 MiB.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerIntegrityError,
  independentImport,
  initialInventoryEnrollment,
  ledgerCanonicalBytes,
  ledgerValidateSequence,
} from './ledger.js';

export const PUBLICATION_BATCH_RECORDS = 64;
export const PUBLICATION_BATCH_BYTES = 4 * 1024 * 1024;
export const PUBLICATION_RECORD_BYTES = 1024 * 1024;
export const PUBLICATION_ATTEMPTS = 3;

/**
 * A planning refusal raised after Python would already have acknowledged
 * remote-held records encountered earlier in causal order. The carried acks
 * are the exact prefix Python wrote before its refusal; the publisher writes
 * that prefix and then rethrows. A missing/forked causal dependency is raised
 * before any acknowledgement and therefore never produces this error.
 */
export class PublicationPlanError extends LedgerIntegrityError {
  readonly acks: readonly JsonValue[];

  constructor(message: string, acks: readonly JsonValue[]) {
    super(message);
    this.acks = [...acks];
  }
}

/** One planned batch, with the canonical bytes the oracle hashed. */
export interface PublicationBatch {
  readonly values: readonly JsonValue[];
  readonly bytes: number;
}

export interface PublicationPlan {
  /**
   * Already-published pending records to acknowledge, in causal order. Python
   * writes these acknowledgements while planning, before any batch effect.
   */
  readonly acks: readonly JsonValue[];
  /** Remaining records grouped exactly as Python would commit them. */
  readonly batches: readonly PublicationBatch[];
}

export interface PublicationPlanInput {
  /** Validated remote history from `fetch()`. */
  readonly ledgerValues: readonly JsonValue[];
  /**
   * `Outbox.pending()` output. Python's `pending()` lists retained ids in
   * lexicographic filename order and the planner preserves that order.
   */
  readonly pending: readonly JsonValue[];
}

function record(value: JsonValue): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerIntegrityError('record is not an object');
  return value;
}

function payloadOf(value: JsonValue): JsonObject {
  const payload = record(value).get('payload');
  if (!(payload instanceof JsonObject))
    throw new LedgerIntegrityError('record payload is not an object');
  return payload;
}

function idOf(value: JsonValue): string {
  const id = record(value).get('id');
  if (typeof id !== 'string') throw new LedgerIntegrityError('record id is not a string');
  return id;
}

function eventType(value: JsonValue): string {
  const kind = record(value).get('event_type');
  if (typeof kind !== 'string') throw new LedgerIntegrityError('record event_type is not a string');
  return kind;
}

/**
 * `GitLedger.publish`'s dependency edges: a finding event follows its review
 * and predecessor, an import result follows its review or duplicate. All other
 * record kinds are independent.
 */
function dependencies(value: JsonValue): readonly (string | null)[] {
  const payload = payloadOf(value);
  const field = (name: string): string | null => {
    const raw = payload.get(name);
    return typeof raw === 'string' ? raw : raw === null || raw === undefined ? null : String(raw);
  };
  switch (eventType(value)) {
    case 'finding-event':
      return [field('review_id'), field('previous_event_id')];
    case 'import-result':
      return [field('review_id'), field('duplicate_id')];
    default:
      return [];
  }
}

/**
 * Causal order for pending records. Python repeatedly appends every record
 * whose dependencies are already satisfied, preserving pending order within
 * each pass; a pass with no ready record is a missing/forked dependency.
 */
function causalOrder(pending: readonly JsonValue[], available: Set<string>): JsonValue[] {
  const remaining = [...pending];
  const ordered: JsonValue[] = [];
  while (remaining.length > 0) {
    const ready: JsonValue[] = [];
    const still: JsonValue[] = [];
    for (const value of remaining) {
      const readyNow = dependencies(value).every(
        (dependency) => dependency === null || available.has(dependency),
      );
      (readyNow ? ready : still).push(value);
    }
    if (ready.length === 0) {
      throw new LedgerIntegrityError('outbox has missing/forked causal dependencies');
    }
    for (const value of ready) {
      ordered.push(value);
      available.add(idOf(value));
    }
    remaining.length = 0;
    remaining.push(...still);
  }
  return ordered;
}

/**
 * Plan one publication attempt over the current remote ledger and outbox.
 *
 * The remote history is validated here so an invalid fetch fails before any
 * acknowledgement. The plan is pure: re-running it on the same inputs returns
 * the same order, batches and byte sizes.
 */
export function planPublication(input: PublicationPlanInput): PublicationPlan {
  const ids = ledgerValidateSequence(input.ledgerValues);
  const available = new Set<string>(ids.keys());
  const ordered = causalOrder(input.pending, available);

  const seenJobs = new Set<string>();
  for (const value of input.ledgerValues) {
    if (eventType(value) === 'job-state') {
      const jobId = payloadOf(value).get('job_id');
      if (typeof jobId === 'string') seenJobs.add(jobId);
    }
  }

  interface DraftBatch {
    values: JsonValue[];
    bytes: number;
    kind: string | null;
  }

  const acks: JsonValue[] = [];
  const batches: DraftBatch[] = [];

  for (const value of ordered) {
    try {
      const id = idOf(value);
      if (ids.has(id)) {
        acks.push(value);
        continue;
      }
      const bytes = ledgerCanonicalBytes(value).byteLength;
      if (bytes > PUBLICATION_RECORD_BYTES) {
        throw new LedgerIntegrityError('ledger record exceeds validation bound');
      }
      let kind: string | null = independentImport(value) ? 'import' : null;
      if (initialInventoryEnrollment(value)) {
        const jobId = payloadOf(value).get('job_id');
        if (typeof jobId === 'string' && !seenJobs.has(jobId)) kind = 'enrollment';
      }
      if (eventType(value) === 'job-state') {
        const jobId = payloadOf(value).get('job_id');
        if (typeof jobId === 'string') seenJobs.add(jobId);
      }
      const last = batches.at(-1);
      if (
        last !== undefined &&
        kind !== null &&
        last.kind === kind &&
        last.values.length < PUBLICATION_BATCH_RECORDS &&
        last.bytes + bytes <= PUBLICATION_BATCH_BYTES
      ) {
        last.values.push(value);
        last.bytes += bytes;
      } else {
        batches.push({ values: [value], bytes, kind });
      }
    } catch (error) {
      if (error instanceof LedgerIntegrityError) {
        throw new PublicationPlanError(error.message, acks);
      }
      throw error;
    }
  }

  return {
    acks,
    batches: batches.map(({ values, bytes }) => ({ values, bytes })),
  };
}
