/**
 * Finding inbox ingestion and crash-recovery replay, behind an injected seam.
 *
 * Ports `finding_delivery.Inbox.ingest` and `Inbox.recover`. This is effect
 * orchestration for a future filesystem adapter: it holds the same
 * `findings.lock`, reads `triage/<id>.json`, applies the pure transition and
 * writes canonical row bytes. No real root is bound here, no lock file is
 * created and no outbox record is spooled.
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

/** The single triage-files seam. The real adapter is a later slice. */
export interface FindingInboxFiles {
  /** Hold Python's `findings.lock` for one read/write unit. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** `triage/<id>.json` bytes, or null when the file is absent. */
  readTriage(findingId: string): Promise<Uint8Array | null>;
  /** Atomically write `triage/<id>.json` with the supplied canonical bytes. */
  writeTriage(findingId: string, bytes: Uint8Array): Promise<void>;
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
