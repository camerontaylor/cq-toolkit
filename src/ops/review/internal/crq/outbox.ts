/**
 * Durable publication outbox, behind an injected filesystem seam.
 *
 * Ports `review_ledger.Outbox` exactly: a validated record is spooled with its
 * canonical bytes under `outbox.lock`, an identical replay is idempotent, a
 * different payload under the same id is refused, retained records remain the
 * recovery authority after local state loss, and an acknowledgement is only
 * written for an id the remote ledger acknowledged.
 *
 * This module performs no I/O itself. `OutboxFiles` is the single filesystem
 * seam (the adapter binds Python's `pending/`, `ack/` and `outbox.lock`
 * layout); `ArtifactVerifier` is the separately provisioned durable store.
 */
import { JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerValidate,
  ledgerValueEqual,
} from '../../../../policy/crq/ledger.js';

/** The outbox filesystem seam. Paths are relative to the configured outbox root. */
export interface OutboxFiles {
  /** Hold Python's `outbox.lock` for the spool check-and-write. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Retained ids in lexicographic filename order (Python's sorted glob). */
  listPending(): Promise<readonly string[]>;
  /** Raw retained bytes, or null when the record is absent. */
  readPending(id: string): Promise<Uint8Array | null>;
  /** Atomically write `pending/<id>.json` with the supplied canonical bytes. */
  writePending(id: string, bytes: Uint8Array): Promise<void>;
  /** Whether `ack/<id>.json` exists. */
  hasAck(id: string): Promise<boolean>;
  /** Atomically write `ack/<id>.json`. */
  writeAck(id: string, bytes: Uint8Array): Promise<void>;
}

/** The separately provisioned durable artifact store. */
export interface ArtifactVerifier {
  verify(reference: JsonValue): Promise<void>;
}

function record(value: JsonValue): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerIntegrityError('record is not an object');
  return value;
}

function idOf(value: JsonValue): string {
  const id = record(value).get('id');
  if (typeof id !== 'string') throw new LedgerIntegrityError('record id is not a string');
  return id;
}

function artifactsOf(value: JsonValue): readonly JsonValue[] {
  const payload = record(value).get('payload');
  if (!(payload instanceof JsonObject))
    throw new LedgerIntegrityError('record payload is not an object');
  const artifacts = payload.get('artifacts');
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new LedgerIntegrityError('record artifacts is not an array');
  return artifacts;
}

/**
 * A durable publication outbox. Every method is safe to call repeatedly: a
 * spool replay compares Python-equal parsed records, pending is a pure
 * projection of retained and acknowledged ids, and an acknowledgement keeps
 * its file.
 */
export class Outbox {
  constructor(
    private readonly files: OutboxFiles,
    private readonly artifacts: ArtifactVerifier,
  ) {}

  /**
   * `Outbox.spool`: validate, verify referenced artifacts, then atomically
   * persist canonical bytes. A replay of the same record returns the same id;
   * a different record under that id is an integrity error.
   */
  async spool(value: JsonValue): Promise<string> {
    ledgerValidate(value);
    for (const reference of artifactsOf(value)) await this.artifacts.verify(reference);
    const id = idOf(value);
    return this.files.withLock(async () => {
      const existing = await this.files.readPending(id);
      if (existing !== null) {
        const saved = ledgerLoads(existing);
        // Python compares the parsed record (`loads(existing) != value`), not
        // canonical bytes, so key order and `False` vs `0` are not conflicts.
        if (!ledgerValueEqual(saved, value))
          throw new LedgerIntegrityError('outbox replay conflict');
      }
      await this.files.writePending(id, ledgerCanonicalBytes(value));
      return id;
    });
  }

  /** `Outbox.retained`: acknowledged records remain recovery authority too. */
  async retained(): Promise<JsonValue[]> {
    const ids = await this.files.listPending();
    const values: JsonValue[] = [];
    // Python reads retained records sequentially; an acknowledged id stays in
    // `pending/`, so an unbounded fan-out would exhaust a filesystem adapter.
    for (const id of ids) values.push(ledgerLoads(await this.read(id)));
    return values;
  }

  /** `Outbox.pending`: retained records with no acknowledgement file. */
  async pending(): Promise<JsonValue[]> {
    const retained = await this.retained();
    const pending: JsonValue[] = [];
    for (const value of retained) {
      if (!(await this.files.hasAck(idOf(value)))) pending.push(value);
    }
    return pending;
  }

  /**
   * `Outbox.acknowledge`: only a remotely acknowledged id may be marked. The
   * remote id set must come from a fresh validated fetch, never from a push
   * outcome.
   */
  async acknowledge(value: JsonValue, remoteIds: ReadonlySet<string>): Promise<void> {
    const id = idOf(value);
    if (!remoteIds.has(id)) {
      throw new LedgerIntegrityError('publication requires remote acknowledgement');
    }
    await this.files.writeAck(id, ledgerCanonicalBytes(new JsonObject([['id', id]])));
  }

  private async read(id: string): Promise<Uint8Array> {
    const bytes = await this.files.readPending(id);
    if (bytes === null) throw new LedgerIntegrityError('outbox record disappeared');
    return bytes;
  }
}
