/**
 * Finding inbox ingestion, crash-recovery replay and canonical handoff,
 * behind an injected seam.
 *
 * Ports `finding_delivery.Inbox.ingest`, `Inbox.recover` and `Inbox.handoff`.
 * This is effect orchestration for a future filesystem adapter: it holds the
 * same `findings.lock`, reads `triage/<id>.json`, applies the pure transition
 * or handoff construction and writes canonical row bytes. No real root is
 * bound here, no lock file is created and no outbox record is spooled outside
 * the injected publication seam.
 */
import { JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerTypeError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerPythonTypeName,
  ledgerSubscript,
  ledgerValidate,
  ledgerValueEqual,
} from '../../../../policy/crq/ledger.js';
import {
  transitionFindingRow,
  pythonIterable,
  removeFirstEqual,
} from '../../../../policy/crq/findingDelivery.js';
import { planFindingHandoff } from '../../../../policy/crq/findingHandoff.js';
import { canonicalHandoffRefusal } from '../../../../policy/crq/repairGates.js';
import type { RepairRefusal } from '../../../../policy/crq/repairBinding.js';

/** The single triage-files seam. The real adapter is a later slice. */
export interface FindingInboxFiles {
  /** Hold Python's `findings.lock` for one read/write unit. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** `triage/<id>.json` bytes, or null when the file is absent. */
  readTriage(findingId: string): Promise<Uint8Array | null>;
  /** Atomically write `triage/<id>.json` with the supplied canonical bytes. */
  writeTriage(findingId: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The publication seam used by handoff. The publication adapter satisfies it
 * structurally: `retained` is recovery authority and `spool` writes one
 * durable event.
 */
export interface FindingPublication {
  retained(): Promise<JsonValue[]>;
  spool(value: JsonValue): Promise<string>;
}

export interface IngestEvidence {
  /** Fresh rows written, in review finding order. */
  readonly written: readonly string[];
  /** Rows already present with an equal occurrence, in review order. */
  readonly existing: readonly string[];
}

export interface RecoverEvidence {
  /** Event id values whose transition produced a row write, in write order. */
  readonly written: readonly JsonValue[];
  /** Event id values already owning the row, in removal order. */
  readonly alreadyApplied: readonly JsonValue[];
  /** Event values that could not be applied, in final input order. */
  readonly pending: readonly JsonValue[];
}

/**
 * Ordinary operation evidence, never persisted. Python's `Inbox.handoff`
 * returns `None` on both the write and idempotent paths; the port keeps the
 * distinction for observability without adding a state file.
 */
export type FindingHandoffResult =
  | {
      readonly kind: 'written';
      readonly eventId: JsonValue;
      readonly receipt: JsonObject;
      readonly recovery: RecoverEvidence;
    }
  | { readonly kind: 'already-handed-off'; readonly recovery: RecoverEvidence }
  | { readonly kind: 'refused'; readonly refusal: RepairRefusal };

type ApplyOutcome =
  | { readonly kind: 'written'; readonly eventId: JsonValue }
  | { readonly kind: 'already-applied'; readonly eventId: JsonValue }
  | { readonly kind: 'pending' };

function pythonPathComponent(value: JsonValue): string {
  if (typeof value !== 'string') {
    throw new LedgerTypeError(
      `unsupported operand type(s) for +: '${ledgerPythonTypeName(value)}' and 'str'`,
    );
  }
  return value;
}

/** Canonical rows are UTF-8; undecodable bytes are a typed unavailability. */
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeRowText(bytes: Uint8Array): string | undefined {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Python's retained-then-recover order (`finding_delivery.py:115-116,181`).
 * Module-private: a future triage consumer must reuse it rather than repeat
 * the two calls. Reading retained records takes no lock; `recover` takes its
 * own.
 */
async function recoverRetained(
  inbox: FindingInbox,
  publication: FindingPublication,
): Promise<RecoverEvidence> {
  return inbox.recover(await publication.retained());
}

export class FindingInbox {
  constructor(private readonly files: FindingInboxFiles) {}

  /**
   * `Inbox.ingest`: validate first, then one lock per finding. Python builds
   * the row value, including `payload.target`, before its existence check, so
   * a malformed target refuses even when the row already exists.
   */
  async ingest(review: JsonValue): Promise<IngestEvidence> {
    ledgerValidate(review);
    const payload = ledgerSubscript(review, 'payload');
    const findings = ledgerSubscript(payload, 'findings');
    const written: string[] = [];
    const existing: string[] = [];

    for (const finding of pythonIterable(findings)) {
      const findingId = pythonPathComponent(ledgerSubscript(finding, 'id'));
      await this.files.withLock(async () => {
        const row = new JsonObject([
          ['review_id', ledgerSubscript(review, 'id')],
          ['finding', finding],
          ['target', ledgerSubscript(payload, 'target')],
          ['canonical_id', findingId],
          ['previous_event_id', null],
          ['status', 'untriaged'],
        ]);
        const bytes = await this.files.readTriage(findingId);
        if (bytes !== null) {
          const old = ledgerLoads(bytes);
          if (
            !ledgerValueEqual(ledgerSubscript(old, 'review_id'), ledgerSubscript(review, 'id')) ||
            !ledgerValueEqual(ledgerSubscript(old, 'finding'), finding)
          ) {
            throw new LedgerIntegrityError('finding occurrence conflict');
          }
          existing.push(findingId);
          return;
        }
        await this.files.writeTriage(findingId, ledgerCanonicalBytes(row));
        written.push(findingId);
      });
    }

    return { written, existing };
  }

  /**
   * `Inbox.recover`: one lock, content-addressed events, repeated snapshot
   * passes. Removal uses Python list equality, not reference identity.
   */
  async recover(events: readonly JsonValue[]): Promise<RecoverEvidence> {
    return this.files.withLock(async () => {
      const remaining: JsonValue[] = [];
      for (const event of events) {
        if (ledgerSubscript(event, 'event_type') === 'finding-event') remaining.push(event);
      }

      const written: JsonValue[] = [];
      const alreadyApplied: JsonValue[] = [];
      while (remaining.length > 0) {
        let advanced = false;
        const snapshot = [...remaining];
        for (const event of snapshot) {
          const outcome = await this.applyEvent(event);
          if (outcome.kind === 'pending') continue;
          removeFirstEqual(remaining, event);
          advanced = true;
          if (outcome.kind === 'written') written.push(outcome.eventId);
          else alreadyApplied.push(outcome.eventId);
        }
        if (!advanced) break;
      }

      return { written, alreadyApplied, pending: [...remaining] };
    });
  }

  /**
   * `Inbox.handoff`: recover retained events, revalidate the locked row
   * through the single shared gate, then spool before the atomic row write.
   *
   * The gate is called twice with the same arguments: first with a withheld
   * row, so an identity mismatch refuses before recovery, then with the row
   * read under `findings.lock`. The first call's unavailability is
   * provisional, not authoritative. `sourceSha` is deliberately omitted: the
   * C1 read gate owns the pin binding and Python handoff never rechecks it.
   */
  async handoff(
    publication: FindingPublication,
    input: {
      readonly findingId: string;
      readonly previousTask: string;
      readonly preparedJobId: string;
      readonly job: JsonObject;
      readonly at: string;
    },
  ): Promise<FindingHandoffResult> {
    const identity = canonicalHandoffRefusal({
      rowText: undefined,
      job: input.job,
      findingId: input.findingId,
      previousTask: input.previousTask,
      preparedJobId: input.preparedJobId,
    });
    if (!identity.ok && identity.refusal !== 'canonical-handoff-unavailable') {
      return { kind: 'refused', refusal: identity.refusal };
    }

    const recovery = await recoverRetained(this, publication);

    return this.files.withLock<FindingHandoffResult>(async () => {
      const bytes = await this.files.readTriage(input.findingId);
      if (bytes === null) return { kind: 'refused', refusal: 'canonical-handoff-unavailable' };
      const rowText = decodeRowText(bytes);
      if (rowText === undefined) {
        return { kind: 'refused', refusal: 'canonical-handoff-unavailable' };
      }
      const decision = canonicalHandoffRefusal({
        rowText,
        job: input.job,
        findingId: input.findingId,
        previousTask: input.previousTask,
        preparedJobId: input.preparedJobId,
      });
      if (!decision.ok) return { kind: 'refused', refusal: decision.refusal };
      if (decision.alreadyHandedOff) return { kind: 'already-handed-off', recovery };

      const row = ledgerLoads(bytes);
      if (!(row instanceof JsonObject)) {
        return { kind: 'refused', refusal: 'canonical-handoff-unavailable' };
      }
      const plan = planFindingHandoff({
        row,
        findingId: input.findingId,
        job: input.job,
        at: input.at,
        alreadyHandedOff: false,
      });
      if (plan.kind !== 'write') {
        throw new Error('handoff plan was empty after an authoritative ownership decision');
      }
      // Durable event before the local transition, with Python's exact lock
      // order: `outbox.lock` nested inside the still-held `findings.lock`.
      await publication.spool(plan.event);
      await this.files.writeTriage(input.findingId, ledgerCanonicalBytes(plan.row));
      return {
        kind: 'written',
        eventId: ledgerSubscript(plan.event, 'id'),
        receipt: plan.receipt,
        recovery,
      };
    });
  }

  private async applyEvent(event: JsonValue): Promise<ApplyOutcome> {
    const payload = ledgerSubscript(event, 'payload');
    const findingId = pythonPathComponent(ledgerSubscript(payload, 'finding_id'));
    const bytes = await this.files.readTriage(findingId);
    if (bytes === null) return { kind: 'pending' };
    const transition = transitionFindingRow(ledgerLoads(bytes), event);
    if (transition.kind === 'already-applied') {
      return { kind: 'already-applied', eventId: transition.eventId };
    }
    if (transition.kind === 'predecessor-mismatch') return { kind: 'pending' };
    await this.files.writeTriage(findingId, ledgerCanonicalBytes(transition.row));
    return { kind: 'written', eventId: transition.eventId };
  }
}
